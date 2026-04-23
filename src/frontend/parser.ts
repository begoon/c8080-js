import type {
  CNode,
  CProgram,
  CType,
  CVariable,
  CFunction,
  SrcPos,
  BinaryOp,
  UnaryOp,
} from "./ast.ts";
import { Lex } from "./lex.ts";

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
    const ts = this.parseDeclSpec();
    const starCount = this.parsePointers();
    const name = this.lex.needIdent();

    if (this.lex.ifText("(")) {
      this.parseFunction(pos, ts, starCount, name, functions);
      return;
    }

    const type = this.wrapPointers(ts.base, starCount);
    this.lex.needText(";");
    globals.push({
      name, type, pos,
      storage: ts.storage === "auto" ? "global" : ts.storage,
      address: null, linkFile: null,
    });
  }

  private parseFunction(
    pos: SrcPos, ts: TypeSpec, retStars: number, name: string, functions: CFunction[],
  ): void {
    const retType = this.wrapPointers(ts.base, retStars);
    const params = this.parseParamList();
    let body: CNode | null = null;
    if (this.lex.ifText(";")) {
      // forward declaration — swallow
    } else {
      this.lex.needText("{");
      body = this.parseBlock(pos);
    }
    const funcType: CType = {
      kind: "function",
      ret: retType,
      params: params.map((p) => p.type),
    };
    functions.push({
      name, type: funcType, params,
      locals: [], body,
      storage: ts.storage === "stack" ? "stack" : "global",
      pos,
    });
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
      const pos = this.pos();
      const ts = this.parseDeclSpec();
      const stars = this.parsePointers();
      const pname = this.lex.ifIdent() ?? "";
      const ptype = this.wrapPointers(ts.base, stars);
      params.push({
        name: pname, type: ptype, pos,
        storage: "auto", address: null, linkFile: null,
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
      break;
    }
    if (baseParts.length === 0) this.lex.throwUnexpected("expected a type");
    return { base: this.composeBaseType(baseParts), storage };
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
    while (this.lex.ifText("*")) n++;
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
    while (!this.lex.ifText("}")) {
      if (this.lex.atEnd()) this.lex.throwHere("unexpected end of file, expected '}'");
      stmts.push(this.parseStatement());
    }
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
    if (this.lex.peekIdent("break")) { this.lex.advance(); this.lex.needText(";"); return { kind: "break", pos }; }
    if (this.lex.peekIdent("continue")) { this.lex.advance(); this.lex.needText(";"); return { kind: "continue", pos }; }
    // Expression statement (or would-be local declaration — declarations deferred).
    const e = this.parseExpression();
    this.lex.needText(";");
    return e;
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
    if (!this.lex.ifText(";")) { init = this.parseExpression(); this.lex.needText(";"); }
    let cond: CNode | null = null;
    if (!this.lex.ifText(";")) { cond = this.parseExpression(); this.lex.needText(";"); }
    let step: CNode | null = null;
    if (!this.lex.peekText(")")) step = this.parseExpression();
    this.lex.needText(")");
    const body = this.parseStatement();
    return { kind: "for", pos, init, cond, step, body };
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
      return { kind: "if", pos, cond, then: a, else: b };
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
    return this.parsePostfix();
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
      const text = this.lex.text;
      this.lex.advance();
      const raw = text.slice(1, -1);
      return { kind: "const", pos, type: { kind: "pointer", to: { kind: "base", base: "char" } }, value: raw };
    }
    if (this.lex.ifText("(")) {
      const e = this.parseExpression();
      this.lex.needText(")");
      return e;
    }
    if (this.lex.kind === "ident") {
      const name = this.lex.text;
      this.lex.advance();
      return { kind: "var", pos, name };
    }
    this.lex.throwUnexpected("expected expression");
  }

  // ---------- helpers ----------

  private pos(): SrcPos {
    return { file: this.lex.fileName, line: this.lex.line, column: this.lex.column };
  }
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
