import type {
  CNode,
  CProgram,
  CType,
  CVariable,
  CFunction,
  SrcPos,
  BinaryOp,
  UnaryOp,
  InitializerValue,
  StructField,
} from "./ast.ts";
import { Lex } from "./lex.ts";
import { SymbolTable } from "./symbols.ts";

const BASE_TYPE_KEYWORDS = new Set([
  "void", "char", "short", "int", "long", "signed", "unsigned", "_Bool", "float", "double",
]);

const STORAGE_KEYWORDS = new Set(["extern", "static", "auto", "register", "__global", "__stack"]);

const TYPE_QUAL_KEYWORDS = new Set(["const", "volatile"]);

type TypeSpec = {
  base: CType;
  storage: "auto" | "extern" | "static" | "global" | "stack";
};

export class Parser {
  readonly symbols = new SymbolTable();
  // Per-declaration link info: keyed by the function name, value is the link
  // file path (relative) and the source file where the __link attribute was
  // encountered. We resolve against sourceFile's dir first for c8080 semantics.
  readonly functionLinks = new Map<string, { rel: string; sourceFile: string }>();
  private currentFunctionLocals: CVariable[] = [];
  private lastDeclaredName: string | null = null;

  constructor(private readonly lex: Lex) {}

  parseProgram(): CProgram {
    const globals: CVariable[] = [];
    const functions: CFunction[] = [];
    while (!this.lex.atEnd()) this.parseTopLevel(globals, functions);
    return { globals, functions, cmm: false };
  }

  // ---------- top-level ----------

  private parseTopLevel(globals: CVariable[], functions: CFunction[]): void {
    const pos = this.pos();
    if (this.lex.peekIdent("typedef")) {
      this.parseTypedef();
      return;
    }
    if (this.lex.peekIdent("asm")) {
      // Top-level asm(" ... "); directive — attach to program via a synthetic function? For now, parse and discard.
      this.parseAsm();
      return;
    }
    const ts = this.parseDeclSpec();
    if (this.lex.ifText(";")) return; // bare struct/type declaration
    // First declarator — might be a function or a variable.
    const starCount = this.parsePointers();
    const name = this.lex.needIdent();

    if (this.lex.ifText("(")) {
      this.parseFunction(pos, ts, starCount, name, functions);
      return;
    }

    const firstType = this.wrapArrayBounds(this.wrapPointers(ts.base, starCount));
    this.skipTrailingAttributes();
    let firstInit: InitializerValue | null = null;
    if (this.lex.ifText("=")) firstInit = this.parseInitializer();
    const firstVar: CVariable = {
      name, type: firstType, pos,
      storage: ts.storage === "auto" ? "global" : ts.storage,
      address: null, linkFile: null, initializer: firstInit,
    };
    globals.push(firstVar);
    this.symbols.declareVariable(firstVar);

    while (this.lex.ifText(",")) {
      const morePos = this.pos();
      const moreStars = this.parsePointers();
      const moreName = this.lex.needIdent();
      const moreType = this.wrapArrayBounds(this.wrapPointers(ts.base, moreStars));
      this.skipTrailingAttributes();
      let moreInit: InitializerValue | null = null;
      if (this.lex.ifText("=")) moreInit = this.parseInitializer();
      const moreVar: CVariable = {
        name: moreName, type: moreType, pos: morePos,
        storage: ts.storage === "auto" ? "global" : ts.storage,
        address: null, linkFile: null, initializer: moreInit,
      };
      globals.push(moreVar);
      this.symbols.declareVariable(moreVar);
    }
    this.lex.needText(";");
  }

  private wrapArrayBounds(base: CType): CType {
    const dims: Array<number | null> = [];
    while (this.lex.ifText("[")) {
      let length: number | null = null;
      if (!this.lex.peekText("]")) {
        const expr = this.parseAssign();
        const folded = foldConstNode(expr);
        if (folded !== null) length = Number(folded);
      }
      this.lex.needText("]");
      dims.push(length);
    }
    // Build array types from innermost to outermost: T[a][b] ≡ array-of(array-of(T, b), a).
    let t = base;
    for (let i = dims.length - 1; i >= 0; i--) t = { kind: "array", of: t, length: dims[i]! };
    return t;
  }

  private parseTypedef(): void {
    this.lex.advance(); // consume 'typedef'
    const ts = this.parseDeclSpec();
    const stars = this.parsePointers();
    const name = this.lex.needIdent();
    this.lex.needText(";");
    this.symbols.declareTypedef(name, this.wrapPointers(ts.base, stars));
  }

  private parseFunction(
    pos: SrcPos, ts: TypeSpec, retStars: number, name: string, functions: CFunction[],
  ): void {
    const retType = this.wrapPointers(ts.base, retStars);
    const params = this.parseParamList();
    this.lastDeclaredName = name;
    this.skipTrailingAttributes();
    this.lastDeclaredName = null;
    const funcType: CType = {
      kind: "function",
      ret: retType,
      params: params.map((p) => p.type),
    };
    const func: CFunction = {
      name, type: funcType, params,
      locals: [], body: null,
      storage: ts.storage === "stack" ? "stack" : "global",
      pos,
    };

    if (this.lex.ifText(";")) {
      this.symbols.declareFunction(func);
      functions.push(func);
      return;
    }
    this.lex.needText("{");

    // Declare the function first so it can be called recursively.
    this.symbols.declareFunction(func);

    this.symbols.pushScope();
    this.currentFunctionLocals = [];
    for (const p of params) if (p.name) this.symbols.declareVariable(p);
    const body = this.parseBlock(pos);
    const locals = this.currentFunctionLocals;
    this.currentFunctionLocals = [];
    this.symbols.popScope();

    const finished: CFunction = { ...func, body, locals };
    functions.push(finished);
    this.symbols.declareFunction(finished); // replace with the version that has body+locals
  }

  private parseParamList(): CVariable[] {
    const params: CVariable[] = [];
    if (this.lex.ifText(")")) return params;
    // (void) alone means "no params"; (void *p) means one void-pointer param.
    if (this.lex.peekIdent("void") && this.lex.peekText(")", 1)) {
      this.lex.advance();
      this.lex.advance();
      return params;
    }
    for (;;) {
      if (this.lex.ifText("...")) break; // variadic marker
      const pos = this.pos();
      const ts = this.parseDeclSpec();
      const stars = this.parsePointers();
      const pname = this.lex.ifIdent() ?? "";
      // For parameters, T[N] decays to T* so we consume the brackets but ignore the size.
      while (this.lex.ifText("[")) {
        while (!this.lex.ifText("]")) {
          if (this.lex.atEnd()) this.lex.throwHere("unterminated array bounds");
          this.lex.advance();
        }
      }
      const ptype = this.wrapPointers(ts.base, stars);
      params.push({
        name: pname, type: ptype, pos,
        storage: "auto", address: null, linkFile: null, initializer: null,
      });
      if (!this.lex.ifText(",")) break;
    }
    this.lex.needText(")");
    return params;
  }

  // ---------- types ----------

  private parseDeclSpec(): TypeSpec {
    let storage: TypeSpec["storage"] = "auto";
    const baseParts: string[] = [];
    let typedefType: CType | null = null;
    let structType: CType | null = null;
    for (;;) {
      const t = this.lex.text;
      if (this.lex.kind !== "ident") break;
      if (STORAGE_KEYWORDS.has(t)) {
        if (t === "__global") storage = "global";
        else if (t === "__stack") storage = "stack";
        else if (t === "extern") storage = "extern";
        else if (t === "static") storage = "static";
        this.lex.advance();
        continue;
      }
      if (TYPE_QUAL_KEYWORDS.has(t)) {
        this.lex.advance();
        continue;
      }
      if (BASE_TYPE_KEYWORDS.has(t)) {
        baseParts.push(t);
        this.lex.advance();
        continue;
      }
      if (t === "struct" || t === "union") {
        structType = this.parseStructRef();
        continue;
      }
      if (t === "enum") {
        this.parseEnumSpec();
        baseParts.push("int"); // enum is int
        continue;
      }
      if (baseParts.length === 0 && typedefType === null && this.symbols.hasTypedef(t)) {
        typedefType = this.symbols.lookupTypedef(t)!;
        this.lex.advance();
        continue;
      }
      break;
    }
    if (baseParts.length === 0 && typedefType === null && structType === null) {
      this.lex.throwUnexpected("expected a type");
    }
    const base = structType ?? typedefType ?? this.composeBaseType(baseParts);
    return { base, storage };
  }

  private skipTrailingAttributes(): void {
    for (;;) {
      if (this.lex.peekIdent("__link")) {
        const sourceFile = this.lex.fileName;
        this.lex.advance();
        this.lex.needText("(");
        if (this.lex.kind === "string2") {
          const rel = this.lex.text.slice(1, -1);
          if (this.lastDeclaredName !== null) {
            this.functionLinks.set(this.lastDeclaredName, { rel, sourceFile });
          }
          this.lex.advance();
        }
        this.lex.needText(")");
        continue;
      }
      if (this.lex.peekIdent("__attribute__") || this.lex.peekIdent("__address")) {
        this.lex.advance();
        this.lex.needText("(");
        let depth = 1;
        while (depth > 0) {
          if (this.lex.atEnd()) this.lex.throwHere("unterminated attribute");
          if (this.lex.ifText("(")) { depth++; continue; }
          if (this.lex.ifText(")")) { depth--; continue; }
          this.lex.advance();
        }
        continue;
      }
      break;
    }
  }

  private parseEnumSpec(): void {
    this.lex.advance(); // 'enum'
    // Optional tag name.
    if (this.lex.kind === "ident" && !this.lex.peekText("{")) this.lex.advance();
    if (!this.lex.ifText("{")) return;
    let next = 0n;
    while (!this.lex.ifText("}")) {
      if (this.lex.atEnd()) this.lex.throwHere("unterminated enum");
      const name = this.lex.needIdent();
      let value = next;
      if (this.lex.ifText("=")) {
        const expr = this.parseAssign();
        const folded = foldConstNode(expr);
        if (folded === null) this.lex.throwHere(`enum value for '${name}' is not a constant`);
        value = folded;
      }
      this.symbols.defineEnumConstant(name, value);
      next = value + 1n;
      if (!this.lex.ifText(",")) { this.lex.needText("}"); break; }
    }
  }

  private parseStructRef(): CType {
    this.lex.advance(); // 'struct' or 'union'
    let name = "";
    if (this.lex.kind === "ident" && !this.lex.peekText("{")) name = this.lex.needIdent();

    if (this.lex.ifText("{")) {
      const fields: StructField[] = [];
      let offset = 0;
      while (!this.lex.ifText("}")) {
        if (this.lex.atEnd()) this.lex.throwHere("unterminated struct body");
        const fts = this.parseDeclSpec();
        for (;;) {
          const stars = this.parsePointers();
          const fname = this.lex.needIdent();
          const ftype = this.wrapArrayBounds(this.wrapPointers(fts.base, stars));
          const size = Math.max(fieldTypeSize(ftype), 1);
          fields.push({ name: fname, type: ftype, offset });
          offset += size;
          if (!this.lex.ifText(",")) break;
        }
        this.lex.needText(";");
      }
      const type: CType = { kind: "struct", name, fields, size: offset };
      if (name !== "") this.symbols.declareStruct(name, type);
      return type;
    }

    // Forward reference: lookup prior full definition; else stub.
    if (name !== "") {
      const prior = this.symbols.lookupStruct(name);
      if (prior) return prior;
    }
    return { kind: "struct", name, fields: null, size: 0 };
  }

  private composeBaseType(parts: string[]): CType {
    const has = (s: string): boolean => parts.includes(s);
    const countLong = parts.filter((p) => p === "long").length;
    if (has("void")) return { kind: "base", base: "void" };
    if (has("_Bool")) return { kind: "base", base: "bool" };
    if (has("char")) {
      if (has("signed")) return { kind: "base", base: "schar" };
      if (has("unsigned")) return { kind: "base", base: "uchar" };
      return { kind: "base", base: "char" };
    }
    if (has("float")) return { kind: "base", base: "float" };
    if (has("double")) return { kind: "base", base: "double" };
    if (has("short")) return { kind: "base", base: has("unsigned") ? "ushort" : "short" };
    if (countLong >= 2) return { kind: "base", base: has("unsigned") ? "ullong" : "llong" };
    if (countLong === 1) return { kind: "base", base: has("unsigned") ? "ulong" : "long" };
    if (has("unsigned")) return { kind: "base", base: "uint" };
    if (has("signed") || has("int")) return { kind: "base", base: "int" };
    return { kind: "base", base: "int" };
  }

  private parsePointers(): number {
    let n = 0;
    for (;;) {
      if (this.lex.ifText("*")) { n++; continue; }
      const t = this.lex.text;
      if (this.lex.kind === "ident" && (STORAGE_KEYWORDS.has(t) || TYPE_QUAL_KEYWORDS.has(t))) {
        this.lex.advance();
        continue;
      }
      break;
    }
    return n;
  }

  private wrapPointers(base: CType, stars: number): CType {
    let t: CType = base;
    for (let i = 0; i < stars; i++) t = { kind: "pointer", to: t };
    return t;
  }

  // ---------- statements ----------

  private parseBlock(pos: SrcPos): CNode {
    const stmts: CNode[] = [];
    this.symbols.pushScope();
    while (!this.lex.ifText("}")) {
      if (this.lex.atEnd()) this.lex.throwHere("unexpected end of file, expected '}'");
      stmts.push(this.parseStatement());
    }
    this.symbols.popScope();
    return { kind: "block", pos, stmts };
  }

  private parseStatement(): CNode {
    const pos = this.pos();
    if (this.lex.ifText(";")) return { kind: "block", pos, stmts: [] };
    if (this.lex.ifText("{")) return this.parseBlock(pos);
    if (this.lex.peekIdent("return")) return this.parseReturn();
    if (this.lex.peekIdent("if")) return this.parseIf();
    if (this.lex.peekIdent("while")) return this.parseWhile();
    if (this.lex.peekIdent("do")) return this.parseDoWhile();
    if (this.lex.peekIdent("for")) return this.parseFor();
    if (this.lex.peekIdent("switch")) return this.parseSwitch();
    if (this.lex.peekIdent("push_pop")) return this.parsePushPop();
    if (this.lex.peekIdent("asm")) return this.parseAsm();
    if (this.lex.peekIdent("break")) { this.lex.advance(); this.lex.needText(";"); return { kind: "break", pos }; }
    if (this.lex.peekIdent("continue")) { this.lex.advance(); this.lex.needText(";"); return { kind: "continue", pos }; }
    if (this.lex.peekIdent("goto")) {
      this.lex.advance();
      const label = this.lex.needIdent();
      this.lex.needText(";");
      return { kind: "goto", pos, label };
    }
    if (this.lex.peekIdent("case")) {
      this.lex.advance();
      const value = this.parseExpression();
      this.lex.needText(":");
      return { kind: "case", pos, value };
    }
    if (this.lex.peekIdent("default")) {
      this.lex.advance();
      this.lex.needText(":");
      return { kind: "default", pos };
    }
    // Label: IDENT ':'
    if (this.lex.kind === "ident" && this.lex.at(1).text === ":") {
      const name = this.lex.needIdent();
      this.lex.advance();
      return { kind: "label", pos, name };
    }
    if (this.isDeclStart()) return this.parseLocalDecl();
    const e = this.parseExpression();
    this.lex.needText(";");
    return e;
  }

  private isDeclStart(): boolean {
    const t = this.lex.text;
    if (this.lex.kind !== "ident") return false;
    if (BASE_TYPE_KEYWORDS.has(t)) return true;
    if (STORAGE_KEYWORDS.has(t)) return true;
    if (TYPE_QUAL_KEYWORDS.has(t)) return true;
    if (t === "struct" || t === "union" || t === "enum" || t === "typedef") return true;
    if (this.symbols.hasTypedef(t)) return true;
    return false;
  }

  private parseLocalDecl(): CNode {
    const pos = this.pos();
    const ts = this.parseDeclSpec();
    if (this.lex.ifText(";")) return { kind: "block", pos, stmts: [] };
    const stmts: CNode[] = [];
    for (;;) {
      const declPos = this.pos();
      const stars = this.parsePointers();
      const name = this.lex.needIdent();
      const type = this.wrapArrayBounds(this.wrapPointers(ts.base, stars));
      const local: CVariable = {
        name, type, pos: declPos,
        storage: ts.storage === "auto" ? "auto" : ts.storage,
        address: null, linkFile: null, initializer: null,
      };
      this.symbols.declareVariable(local);
      this.currentFunctionLocals.push(local);
      let initExpr: CNode | null = null;
      if (this.lex.ifText("=")) {
        const init = this.parseInitializer();
        if (init.kind === "expr") initExpr = init.expr;
        // list-initializers for locals not yet supported in codegen — drop.
      }
      if (initExpr !== null) {
        const target: CNode = { kind: "var", pos: declPos, name, resolved: local };
        stmts.push({ kind: "assign", pos: declPos, target, value: initExpr });
      }
      if (!this.lex.ifText(",")) break;
    }
    this.lex.needText(";");
    return { kind: "block", pos, stmts };
  }

  private parseInitializer(): InitializerValue {
    if (this.lex.ifText("{")) {
      const items: InitializerValue[] = [];
      if (!this.lex.ifText("}")) {
        for (;;) {
          items.push(this.parseInitializer());
          if (this.lex.ifText(",")) {
            if (this.lex.ifText("}")) break;
            continue;
          }
          this.lex.needText("}");
          break;
        }
      }
      return { kind: "list", items };
    }
    return { kind: "expr", expr: this.parseAssign() };
  }

  private parseSwitch(): CNode {
    const pos = this.pos();
    this.lex.advance();
    this.lex.needText("(");
    const expr = this.parseExpression();
    this.lex.needText(")");
    const body = this.parseStatement();
    return { kind: "switch", pos, expr, body };
  }

  private parseAsm(): CNode {
    const pos = this.pos();
    this.lex.advance(); // 'asm'
    // Optional parenthesised form: asm("text"); — gcc-style.
    if (this.lex.ifText("(")) {
      const parts: string[] = [];
      while (!this.lex.ifText(")")) {
        if (this.lex.atEnd()) this.lex.throwHere("unterminated asm(...)");
        parts.push(this.lex.text);
        this.lex.advance();
      }
      this.lex.ifText(";");
      return { kind: "asm", pos, text: parts.join(" ") };
    }
    this.lex.needText("{");
    const parts: string[] = [];
    let depth = 1;
    let lastLine = this.lex.line;
    let lastFile = this.lex.fileName;
    while (depth > 0) {
      if (this.lex.atEnd()) this.lex.throwHere("unterminated asm { ... }");
      if (this.lex.peekText("{")) depth++;
      else if (this.lex.peekText("}")) { depth--; if (depth === 0) break; }
      const sep = (this.lex.line !== lastLine || this.lex.fileName !== lastFile) ? "\n" : " ";
      parts.push(sep, this.lex.text);
      lastLine = this.lex.line;
      lastFile = this.lex.fileName;
      this.lex.advance();
    }
    this.lex.advance(); // closing '}'
    return { kind: "asm", pos, text: parts.join("").trimStart() };
  }

  private parseReturn(): CNode {
    const pos = this.pos();
    this.lex.advance();
    let value: CNode | null = null;
    if (!this.lex.peekText(";")) value = this.parseExpression();
    this.lex.needText(";");
    return { kind: "return", pos, value };
  }

  private parseIf(): CNode {
    const pos = this.pos();
    this.lex.advance();
    this.lex.needText("(");
    const cond = this.parseExpression();
    this.lex.needText(")");
    const then = this.parseStatement();
    let els: CNode | null = null;
    if (this.lex.peekIdent("else")) {
      this.lex.advance();
      els = this.parseStatement();
    }
    return { kind: "if", pos, cond, then, else: els };
  }

  private parseWhile(): CNode {
    const pos = this.pos();
    this.lex.advance();
    this.lex.needText("(");
    const cond = this.parseExpression();
    this.lex.needText(")");
    const body = this.parseStatement();
    return { kind: "while", pos, cond, body };
  }

  private parseDoWhile(): CNode {
    const pos = this.pos();
    this.lex.advance();
    const body = this.parseStatement();
    if (!this.lex.peekIdent("while")) this.lex.throwUnexpected("expected 'while'");
    this.lex.advance();
    this.lex.needText("(");
    const cond = this.parseExpression();
    this.lex.needText(")");
    this.lex.needText(";");
    return { kind: "do", pos, body, cond };
  }

  private parseFor(): CNode {
    const pos = this.pos();
    this.lex.advance();
    this.lex.needText("(");
    let init: CNode | null = null;
    if (!this.lex.ifText(";")) {
      if (this.isDeclStart()) init = this.parseLocalDecl(); // consumes trailing ';'
      else { init = this.parseExpressionWithComma(); this.lex.needText(";"); }
    }
    let cond: CNode | null = null;
    if (!this.lex.ifText(";")) { cond = this.parseExpressionWithComma(); this.lex.needText(";"); }
    let step: CNode | null = null;
    if (!this.lex.peekText(")")) step = this.parseExpressionWithComma();
    this.lex.needText(")");
    const body = this.parseStatement();
    return { kind: "for", pos, init, cond, step, body };
  }

  private parseExpressionWithComma(): CNode {
    let e = this.parseExpression();
    while (this.lex.peekText(",")) {
      const pos = this.pos();
      this.lex.advance();
      const rhs = this.parseExpression();
      e = { kind: "binary", pos, op: "comma", lhs: e, rhs };
    }
    return e;
  }

  private parsePushPop(): CNode {
    const pos = this.pos();
    this.lex.advance();
    this.lex.needText("(");
    const regs: CNode[] = [];
    if (!this.lex.ifText(")")) {
      for (;;) {
        regs.push(this.parseAssign());
        if (this.lex.ifText(")")) break;
        this.lex.needText(",");
      }
    }
    this.lex.needText("{");
    const body = this.parseBlock(pos);
    return { kind: "pushPop", pos, regs, body };
  }

  // ---------- expressions (precedence ladder, lowest first) ----------

  private parseExpression(): CNode {
    return this.parseAssign();
  }

  private parseAssign(): CNode {
    const pos = this.pos();
    const lhs = this.parseTernary();
    if (this.lex.ifText("=")) {
      const rhs = this.parseAssign();
      return { kind: "assign", pos, target: lhs, value: rhs };
    }
    for (const [op, bop] of COMPOUND_ASSIGN) {
      if (this.lex.ifText(op)) {
        const rhs = this.parseAssign();
        const combined: CNode = { kind: "binary", pos, op: bop, lhs, rhs };
        return { kind: "assign", pos, target: lhs, value: combined };
      }
    }
    return lhs;
  }

  private parseTernary(): CNode {
    const pos = this.pos();
    const cond = this.parseLogicalOr();
    if (this.lex.ifText("?")) {
      const a = this.parseAssign();
      this.lex.needText(":");
      const b = this.parseAssign();
      return { kind: "ternary", pos, cond, then: a, else: b };
    }
    return cond;
  }

  private parseLogicalOr(): CNode { return this.parseLeftAssoc("logor", ["||"], () => this.parseLogicalAnd()); }
  private parseLogicalAnd(): CNode { return this.parseLeftAssoc("logand", ["&&"], () => this.parseBitOr()); }
  private parseBitOr(): CNode { return this.parseLeftAssoc("or", ["|"], () => this.parseBitXor()); }
  private parseBitXor(): CNode { return this.parseLeftAssoc("xor", ["^"], () => this.parseBitAnd()); }
  private parseBitAnd(): CNode { return this.parseLeftAssoc("and", ["&"], () => this.parseEquality()); }
  private parseEquality(): CNode {
    return this.parseLeftAssocMap([["==", "eq"], ["!=", "ne"]], () => this.parseRelational());
  }
  private parseRelational(): CNode {
    return this.parseLeftAssocMap([["<=", "le"], [">=", "ge"], ["<", "lt"], [">", "gt"]], () => this.parseShift());
  }
  private parseShift(): CNode {
    return this.parseLeftAssocMap([["<<", "shl"], [">>", "shr"]], () => this.parseAdditive());
  }
  private parseAdditive(): CNode {
    return this.parseLeftAssocMap([["+", "add"], ["-", "sub"]], () => this.parseMultiplicative());
  }
  private parseMultiplicative(): CNode {
    return this.parseLeftAssocMap([["*", "mul"], ["/", "div"], ["%", "mod"]], () => this.parseUnary());
  }

  private parseLeftAssoc(op: BinaryOp, tokens: string[], next: () => CNode): CNode {
    let lhs = next();
    for (;;) {
      const pos = this.pos();
      const match = tokens.find((t) => this.lex.peekText(t));
      if (match === undefined) break;
      this.lex.advance();
      const rhs = next();
      lhs = { kind: "binary", pos, op, lhs, rhs };
    }
    return lhs;
  }

  private parseLeftAssocMap(map: Array<[string, BinaryOp]>, next: () => CNode): CNode {
    let lhs = next();
    outer: for (;;) {
      const pos = this.pos();
      for (const [tok, op] of map) {
        if (this.lex.peekText(tok)) {
          this.lex.advance();
          const rhs = next();
          lhs = { kind: "binary", pos, op, lhs, rhs };
          continue outer;
        }
      }
      break;
    }
    return lhs;
  }

  private parseUnary(): CNode {
    const pos = this.pos();
    for (const [tok, op] of UNARY_OPS) {
      if (this.lex.ifText(tok)) {
        const arg = this.parseUnary();
        return { kind: "unary", pos, op, arg };
      }
    }
    if (this.lex.peekText("(") && this.peekIsTypeAfterParen()) {
      this.lex.advance();
      this.parseDeclSpec();
      this.parsePointers();
      this.lex.needText(")");
      return this.parseUnary(); // cast ignored (type-checking comes later)
    }
    return this.parsePostfix();
  }

  private peekIsTypeAfterParen(): boolean {
    const t1 = this.lex.at(1);
    if (t1.kind !== "ident") return false;
    const name = t1.text;
    if (BASE_TYPE_KEYWORDS.has(name)) return true;
    if (TYPE_QUAL_KEYWORDS.has(name)) return true;
    if (name === "struct" || name === "union" || name === "enum") return true;
    if (this.symbols.hasTypedef(name)) return true;
    return false;
  }

  private isTypeStart(): boolean {
    const t = this.lex.text;
    if (this.lex.kind !== "ident") return false;
    if (BASE_TYPE_KEYWORDS.has(t)) return true;
    if (TYPE_QUAL_KEYWORDS.has(t)) return true;
    if (t === "struct" || t === "union" || t === "enum") return true;
    if (this.symbols.hasTypedef(t)) return true;
    return false;
  }

  private parsePostfix(): CNode {
    let node = this.parsePrimary();
    for (;;) {
      const pos = this.pos();
      if (this.lex.ifText("(")) {
        const args: CNode[] = [];
        if (!this.lex.ifText(")")) {
          for (;;) {
            args.push(this.parseAssign());
            if (!this.lex.ifText(",")) break;
          }
          this.lex.needText(")");
        }
        node = { kind: "call", pos, target: node, args };
        continue;
      }
      if (this.lex.ifText("[")) {
        const index = this.parseExpression();
        this.lex.needText("]");
        // Model as *(node + index).
        const plus: CNode = { kind: "binary", pos, op: "add", lhs: node, rhs: index };
        node = { kind: "unary", pos, op: "deref", arg: plus };
        continue;
      }
      if (this.lex.peekText(".") || this.lex.peekText("->")) {
        const arrow = this.lex.peekText("->");
        this.lex.advance();
        const field = this.lex.needIdent();
        node = { kind: "member", pos, object: node, field, arrow };
        continue;
      }
      if (this.lex.ifText("++")) { node = { kind: "unary", pos, op: "postinc", arg: node }; continue; }
      if (this.lex.ifText("--")) { node = { kind: "unary", pos, op: "postdec", arg: node }; continue; }
      break;
    }
    return node;
  }

  private parsePrimary(): CNode {
    const pos = this.pos();
    if (this.lex.kind === "integer") {
      const value = this.lex.token.integer ?? 0n;
      this.lex.advance();
      return { kind: "const", pos, type: { kind: "base", base: "int" }, value };
    }
    if (this.lex.kind === "string2") {
      let raw = this.lex.text.slice(1, -1);
      this.lex.advance();
      while (this.lex.kind === "string2") {
        raw += this.lex.text.slice(1, -1);
        this.lex.advance();
      }
      return { kind: "const", pos, type: { kind: "pointer", to: { kind: "base", base: "char" } }, value: raw };
    }
    if (this.lex.kind === "string1") {
      const text = this.lex.text;
      this.lex.advance();
      const value = decodeCharLiteral(text);
      return { kind: "const", pos, type: { kind: "base", base: "int" }, value };
    }
    if (this.lex.ifText("(")) {
      const e = this.parseExpressionWithComma();
      this.lex.needText(")");
      return e;
    }
    if (this.lex.peekIdent("sizeof")) {
      this.lex.advance();
      let size = 2;
      if (this.lex.ifText("(")) {
        if (this.isTypeStart()) {
          const ts = this.parseDeclSpec();
          const stars = this.parsePointers();
          let t = this.wrapPointers(ts.base, stars);
          t = this.wrapArrayBounds(t);
          size = Math.max(fieldTypeSize(t), 1);
        } else {
          const inner = this.parseExpressionWithComma();
          size = sizeofExpr(inner);
        }
        this.lex.needText(")");
      } else {
        const inner = this.parseUnary();
        size = sizeofExpr(inner);
      }
      return { kind: "const", pos, type: { kind: "base", base: "uint" }, value: BigInt(size) };
    }
    if (this.lex.kind === "ident") {
      const name = this.lex.text;
      this.lex.advance();
      const enumValue = this.symbols.lookupEnumConstant(name);
      if (enumValue !== null) {
        return { kind: "const", pos, type: { kind: "base", base: "int" }, value: enumValue };
      }
      const resolved = this.symbols.lookupVariable(name);
      return { kind: "var", pos, name, resolved };
    }
    this.lex.throwUnexpected("expected expression");
  }

  // ---------- helpers ----------

  private pos(): SrcPos {
    return { file: this.lex.fileName, line: this.lex.line, column: this.lex.column };
  }
}

function sizeofExpr(n: CNode): number {
  if (n.kind === "var" && n.resolved) return Math.max(fieldTypeSize(n.resolved.type), 1);
  if (n.kind === "const" && typeof n.value === "string") return n.value.length + 1;
  if (n.kind === "const") return 2; // default int-like
  return 2;
}

function fieldTypeSize(t: CType): number {
  if (t.kind === "base") {
    switch (t.base) {
      case "char": case "schar": case "uchar": case "bool": return 1;
      case "short": case "ushort": case "int": case "uint": return 2;
      case "long": case "ulong": return 4;
      case "llong": case "ullong": return 8;
      case "float": return 4;
      case "double": return 8;
      case "void": return 0;
    }
  }
  if (t.kind === "pointer") return 2;
  if (t.kind === "array") return fieldTypeSize(t.of) * (t.length ?? 0);
  if (t.kind === "struct") return t.size;
  return 0;
}

function foldConstNode(n: CNode): bigint | null {
  if (n.kind === "const") return typeof n.value === "bigint" ? n.value : null;
  if (n.kind === "unary") {
    const v = foldConstNode(n.arg);
    if (v === null) return null;
    switch (n.op) {
      case "neg": return -v;
      case "not": return v === 0n ? 1n : 0n;
      case "bnot": return ~v;
      default: return null;
    }
  }
  if (n.kind === "binary") {
    const l = foldConstNode(n.lhs);
    const r = foldConstNode(n.rhs);
    if (l === null || r === null) return null;
    switch (n.op) {
      case "add": return l + r;
      case "sub": return l - r;
      case "mul": return l * r;
      case "div": return r === 0n ? null : l / r;
      case "mod": return r === 0n ? null : l % r;
      case "shl": return l << r;
      case "shr": return l >> r;
      case "and": return l & r;
      case "or":  return l | r;
      case "xor": return l ^ r;
      default: return null;
    }
  }
  return null;
}

const COMPOUND_ASSIGN: Array<[string, BinaryOp]> = [
  ["+=", "add"], ["-=", "sub"], ["*=", "mul"], ["/=", "div"], ["%=", "mod"],
  ["<<=", "shl"], [">>=", "shr"], ["&=", "and"], ["|=", "or"], ["^=", "xor"],
];

const UNARY_OPS: Array<[string, UnaryOp]> = [
  ["++", "preinc"], ["--", "predec"],
  ["-", "neg"], ["!", "not"], ["~", "bnot"],
  ["*", "deref"], ["&", "addr"],
];

function decodeCharLiteral(text: string): bigint {
  // text includes the surrounding single quotes.
  const inner = text.slice(1, -1);
  if (inner.length === 0) return 0n;
  if (inner[0] === "\\" && inner.length >= 2) {
    const esc = inner[1]!;
    switch (esc) {
      case "n": return 10n;
      case "r": return 13n;
      case "t": return 9n;
      case "0": return 0n;
      case "\\": return 92n;
      case "'": return 39n;
      case '"': return 34n;
      case "a": return 7n;
      case "b": return 8n;
      case "f": return 12n;
      case "v": return 11n;
      case "x": {
        const hex = inner.slice(2);
        return BigInt("0x" + hex);
      }
      default:
        if (esc >= "0" && esc <= "7") return BigInt("0o" + inner.slice(1));
        return BigInt(esc.charCodeAt(0));
    }
  }
  return BigInt(inner.charCodeAt(0));
}
