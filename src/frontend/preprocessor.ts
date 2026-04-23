import { Tokenizer, type TokenKind } from "./tokenizer.ts";
import { findIncludeFile, type FileSystem } from "./fs.ts";

export type PPToken = {
  readonly kind: TokenKind;
  readonly text: string;
  readonly fileName: string;
  readonly line: number;
  readonly column: number;
  readonly integer?: bigint;
  readonly float?: number;
};

export class PreprocessorError extends Error {
  constructor(
    message: string,
    readonly fileName: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(`${fileName}:${line}:${column}: ${message}`);
  }
}

type Macro = {
  readonly name: string;
  readonly body: string;
  readonly args: readonly string[] | null;
  readonly variadic: "none" | "va_last";
  disabled: boolean;
  readonly prev: Macro | null;
};

type Frame = {
  readonly tokenizer: Tokenizer;
  readonly kind: "file" | "macro";
  endifCounter: number;
  readonly activeMacro: Macro | null;
  readonly argNames: readonly string[];
};

type DTok = {
  readonly kind: TokenKind;
  readonly text: string;
  readonly line: number;
  readonly column: number;
  readonly start: number;
  readonly end: number;
  readonly integer?: bigint;
  readonly float?: number;
};

export type PreprocessorOptions = {
  readonly fs: FileSystem;
  readonly includeDirs?: readonly string[];
  readonly defines?: readonly string[];
};

export class Preprocessor {
  private readonly fs: FileSystem;
  private readonly includeDirs: string[];
  private readonly frames: Frame[] = [];
  private readonly macros = new Map<string, Macro>();
  private readonly pragmaOnce = new Set<string>();

  constructor(opts: PreprocessorOptions) {
    this.fs = opts.fs;
    this.includeDirs = [...(opts.includeDirs ?? [])];
    for (const d of opts.defines ?? []) this.defineFromCli(d);
  }

  openFile(path: string): void {
    const resolved = this.fs.resolve(path);
    const text = this.fs.readText(resolved);
    if (text === null) throw new Error(`file not found: ${path}`);
    this.pushFrame(text, resolved, "file", null, []);
  }

  openSource(source: string, fileName: string): void {
    this.pushFrame(source, fileName, "file", null, []);
  }

  defineMacro(name: string, body = ""): void {
    this.addMacroInternal(name, body, null, "none");
  }

  hasMacro(name: string): boolean {
    return this.macros.has(name);
  }

  currentFileName(): string {
    return this.top().tokenizer.fileName;
  }

  isDefinedForIf(name: string): boolean {
    if (name === "__has_include") return true;
    return this.macros.has(name);
  }

  hasIncludeCheck(name: string, currentFile: string, quoted: boolean): boolean {
    const localDir = quoted ? this.fs.dirname(currentFile) : null;
    return findIncludeFile(this.fs, name, localDir, this.includeDirs) !== null;
  }

  next(): PPToken {
    while (this.frames.length > 0) {
      const frame = this.top();
      frame.tokenizer.next();
      const kind = frame.tokenizer.kind;

      if (kind === "eof") {
        this.leave();
        continue;
      }
      if (kind === "remark" || kind === "eol") continue;

      if (kind === "operator" && frame.tokenizer.tokenText === "#") {
        this.handleDirective(frame);
        continue;
      }

      if (kind === "ident") {
        const name = frame.tokenizer.tokenText;
        const m = this.macros.get(name);
        if (m !== undefined && !m.disabled) {
          if (m.args === null) {
            m.disabled = true;
            this.pushFrame(m.body, name, "macro", m, []);
            continue;
          }
          // Function-like: must be followed immediately by '('.
          const src = frame.tokenizer.source;
          if (src.charCodeAt(frame.tokenizer.tokenEnd) !== 0x28) {
            return this.toPPToken(frame);
          }
          frame.tokenizer.next(); // consume '('
          const argNames = this.captureMacroArgs(frame, m);
          m.disabled = true;
          this.pushFrame(m.body, name, "macro", m, argNames);
          continue;
        }
      }

      return this.toPPToken(frame);
    }
    return { kind: "eof", text: "", fileName: "<eof>", line: 0, column: 0 };
  }

  private toPPToken(frame: Frame): PPToken {
    const t = frame.tokenizer;
    const base = {
      kind: t.kind,
      text: t.tokenText,
      fileName: t.fileName,
      line: t.tokenLine,
      column: t.tokenColumn,
    };
    if (t.kind === "integer") return { ...base, integer: t.tokenInteger };
    if (t.kind === "float") return { ...base, float: t.tokenFloat };
    return base;
  }

  private pushFrame(
    source: string,
    fileName: string,
    kind: "file" | "macro",
    activeMacro: Macro | null,
    argNames: readonly string[],
  ): void {
    const tokenizer = new Tokenizer(source, fileName);
    this.frames.push({ tokenizer, kind, endifCounter: 0, activeMacro, argNames });
  }

  private top(): Frame {
    const f = this.frames[this.frames.length - 1];
    if (!f) throw new Error("preprocessor: no active frame");
    return f;
  }

  private leave(): void {
    const frame = this.frames.pop();
    if (!frame) return;
    if (frame.endifCounter !== 0) this.error(frame, "unterminated #if");
    if (frame.kind === "macro" && frame.activeMacro !== null) {
      frame.activeMacro.disabled = false;
      for (const arg of frame.argNames) this.deleteMacroInternal(arg);
    }
  }

  // ---------- Directives ----------

  private handleDirective(frame: Frame): void {
    const startLine = frame.tokenizer.tokenLine;
    const startColumn = frame.tokenizer.tokenColumn;
    const bodyStart = frame.tokenizer.tokenEnd;
    const tokens = this.readDirectiveTokens(frame);
    const bodyEnd = frame.tokenizer.tokenStart;
    const rawBody = frame.tokenizer.source.slice(bodyStart, bodyEnd);

    const r = new DirectiveReader(tokens, rawBody, frame.tokenizer.fileName, startLine, startColumn);
    if (r.atEnd()) return;

    const name = r.takeIdent();
    switch (name) {
      case "include": return this.dirInclude(frame, r);
      case "define": return this.dirDefine(r);
      case "undef": return this.dirUndef(r);
      case "if": return this.dirIf(frame, r);
      case "ifdef": return this.dirIfdef(frame, r, false);
      case "ifndef": return this.dirIfdef(frame, r, true);
      case "else": return this.dirElse(frame, r);
      case "endif": return this.dirEndif(frame, r);
      case "pragma": return this.dirPragma(frame, r);
      case "error": throw new PreprocessorError(`#error ${r.restText().trim()}`, r.fileName, r.line, r.column);
      case "warning": { r.restText(); return; }
      default:
        throw new PreprocessorError(`invalid preprocessing directive #${name}`, r.fileName, startLine, startColumn);
    }
  }

  private readDirectiveTokens(frame: Frame): DTok[] {
    const t = frame.tokenizer;
    const tokens: DTok[] = [];
    for (;;) {
      t.next();
      if (t.kind === "eof" || t.kind === "eol") return tokens;
      if (t.kind === "remark") continue;
      const base: DTok = {
        kind: t.kind,
        text: t.tokenText,
        line: t.tokenLine,
        column: t.tokenColumn,
        start: t.tokenStart,
        end: t.tokenEnd,
        ...(t.kind === "integer" ? { integer: t.tokenInteger } : {}),
        ...(t.kind === "float" ? { float: t.tokenFloat } : {}),
      };
      tokens.push(base);
    }
  }

  // #include
  private dirInclude(frame: Frame, r: DirectiveReader): void {
    const first = r.take();
    if (!first) r.fail("expected filename after #include");
    let name: string;
    let quoted: boolean;
    if (first.kind === "string2" && first.text.length >= 2) {
      name = first.text.slice(1, -1);
      quoted = true;
    } else if (first.text === "<") {
      let buf = "";
      for (;;) {
        const nx = r.take();
        if (!nx) r.fail("expected '>'");
        if (nx.text === ">") break;
        buf += nx.text;
      }
      name = buf;
      quoted = false;
    } else {
      r.fail('#include expects "FILENAME" or <FILENAME>');
    }

    const localDir = quoted ? this.fs.dirname(frame.tokenizer.fileName) : null;
    const fullPath = findIncludeFile(this.fs, name, localDir, this.includeDirs);
    if (fullPath === null) r.fail(`file "${name}" not found`);
    if (this.pragmaOnce.has(fullPath)) return;
    const text = this.fs.readText(fullPath);
    if (text === null) r.fail(`file "${name}" not readable`);
    this.pushFrame(text, fullPath, "file", null, []);
  }

  // #define NAME body  or  #define NAME(args) body
  private dirDefine(r: DirectiveReader): void {
    const nameTok = r.take();
    if (!nameTok || nameTok.kind !== "ident") r.fail("expected identifier");
    const name = nameTok.text;
    const next = r.peek();
    const functionLike = next !== null && next.text === "(" && next.start === nameTok.end;

    let args: string[] | null = null;
    let variadic: "none" | "va_last" = "none";
    if (functionLike) {
      r.take(); // consume '('
      args = [];
      if (r.peek()?.text !== ")") {
        for (;;) {
          const argTok = r.take();
          if (!argTok) r.fail("expected identifier or ')'");
          if (argTok.text === "...") {
            args.push("__VA_ARGS__");
            variadic = "va_last";
            break;
          }
          if (argTok.kind !== "ident") r.fail("expected identifier");
          args.push(argTok.text);
          if (r.peek()?.text === "...") {
            r.take();
            variadic = "va_last";
            break;
          }
          if (!r.consumeIfText(",")) break;
        }
      }
      if (!r.consumeIfText(")")) r.fail("expected ')'");
    }

    const body = r.restText();
    this.addMacroInternal(name, body, args, variadic);
  }

  private dirUndef(r: DirectiveReader): void {
    const name = r.takeIdent();
    r.expectEnd();
    this.deleteMacroInternal(name);
  }

  private dirIfdef(frame: Frame, r: DirectiveReader, negate: boolean): void {
    const name = r.takeIdent();
    r.expectEnd();
    const cond = this.isDefinedForIf(name);
    this.enterIf(frame, negate ? !cond : cond);
  }

  private dirIf(frame: Frame, r: DirectiveReader): void {
    const value = new IfExpr(r, this).parse();
    r.expectEnd();
    this.enterIf(frame, value !== 0n);
  }

  private dirElse(frame: Frame, r: DirectiveReader): void {
    r.expectEnd();
    if (frame.endifCounter === 0) r.fail("#else without #if");
    // skipUntil decrements endifCounter when it finds the matching #endif.
    this.skipUntil(frame, ["endif"]);
  }

  private dirEndif(frame: Frame, r: DirectiveReader): void {
    r.expectEnd();
    if (frame.endifCounter === 0) r.fail("#endif without #if");
    frame.endifCounter--;
  }

  private dirPragma(frame: Frame, r: DirectiveReader): void {
    const name = r.takeIdent();
    if (name === "once") {
      r.expectEnd();
      this.pragmaOnce.add(frame.tokenizer.fileName);
      return;
    }
    r.restText();
  }

  // ---------- Conditional compilation ----------

  private enterIf(frame: Frame, cond: boolean): void {
    frame.endifCounter++;
    if (!cond) this.skipUntil(frame, ["else", "endif"]);
  }

  private skipUntil(frame: Frame, stopAt: readonly string[]): void {
    const t = frame.tokenizer;
    let depth = 1;
    outer: for (;;) {
      for (;;) {
        t.next();
        const k: TokenKind = t.kind;
        if (k === "eof") { this.error(frame, "unterminated #if"); return; }
        if (k === "operator" && t.tokenText === "#") break;
      }
      let directive = "";
      for (;;) {
        t.next();
        const k: TokenKind = t.kind;
        if (k === "eof" || k === "eol") break;
        if (k === "remark") continue;
        if (k === "ident") { directive = t.tokenText; }
        break;
      }
      for (;;) {
        const k: TokenKind = t.kind;
        if (k === "eof" || k === "eol") break;
        t.next();
      }

      if (directive === "if" || directive === "ifdef" || directive === "ifndef") {
        depth++;
        continue outer;
      }
      if (directive === "endif") {
        depth--;
        if (depth === 0) { frame.endifCounter--; return; }
        continue outer;
      }
      if (directive === "else" && depth === 1 && stopAt.includes("else")) return;
    }
  }

  // ---------- Macro helpers ----------

  private addMacroInternal(
    name: string,
    body: string,
    args: readonly string[] | null = null,
    variadic: "none" | "va_last" = "none",
  ): void {
    const prev = this.macros.get(name) ?? null;
    this.macros.set(name, { name, body, args, variadic, disabled: false, prev });
  }

  private deleteMacroInternal(name: string): void {
    const cur = this.macros.get(name);
    if (!cur) return;
    if (cur.prev) this.macros.set(name, cur.prev);
    else this.macros.delete(name);
  }

  private defineFromCli(def: string): void {
    const eq = def.indexOf("=");
    if (eq === -1) this.addMacroInternal(def, "1", null, "none");
    else this.addMacroInternal(def.slice(0, eq), def.slice(eq + 1), null, "none");
  }

  private captureMacroArgs(frame: Frame, m: Macro): string[] {
    const argNames = m.args ?? [];
    const t = frame.tokenizer;
    const captured: string[] = [];

    if (argNames.length === 0) {
      if (!this.expectCloseParen(t)) this.errorT(t, "macro takes no arguments");
      return [];
    }

    let prevEnd = t.tokenEnd;
    let depth = 0;
    let argText = "";
    let sawCloseParen = false;
    let handledEmptyCall = false;

    // Special case: empty call like F() for a macro that takes >=1 args — C++ treats
    // this as one empty argument for the first parameter.
    if (t.source.charCodeAt(t.tokenEnd) === 0x29 /* ) */) {
      // intentional: we'll let the normal loop detect `)`
    }

    const flushArg = (): void => {
      captured.push(argText);
      argText = "";
    };

    for (;;) {
      t.next();
      if (t.kind === "eof") this.errorT(t, "unterminated macro argument list");
      if (t.kind === "remark") { prevEnd = t.tokenEnd; continue; }

      const isOp = t.kind === "operator";
      const text = t.tokenText;

      if (isOp && text === "(") {
        depth++;
      } else if (isOp && text === ")") {
        if (depth === 0) { sawCloseParen = true; break; }
        depth--;
      } else if (isOp && text === "," && depth === 0) {
        const isLastVariadic = m.variadic === "va_last" && captured.length + 1 === argNames.length;
        if (!isLastVariadic) {
          flushArg();
          prevEnd = t.tokenEnd;
          handledEmptyCall = true;
          continue;
        }
      } else if (isOp && text === "#") {
        this.errorT(t, "can't use # here");
      }

      argText += t.source.slice(prevEnd, t.tokenEnd);
      prevEnd = t.tokenEnd;
    }

    if (sawCloseParen) {
      if (argText.length > 0 || handledEmptyCall || captured.length > 0) flushArg();
    }

    while (captured.length < argNames.length) {
      if (m.variadic === "va_last" && captured.length === argNames.length - 1) captured.push("");
      else this.errorT(t, "not enough parameters in macro");
    }
    if (captured.length > argNames.length) this.errorT(t, "extra parameters in macro");

    // Add each arg as a temp macro.
    for (let i = 0; i < argNames.length; i++) {
      this.addMacroInternal(argNames[i]!, captured[i] ?? "", null, "none");
    }
    return [...argNames];
  }

  private expectCloseParen(t: Tokenizer): boolean {
    t.next();
    while (t.kind === "remark") t.next();
    return t.kind === "operator" && t.tokenText === ")";
  }

  private errorT(t: Tokenizer, message: string): never {
    throw new PreprocessorError(message, t.fileName, t.tokenLine || t.line, t.tokenColumn || t.column);
  }

  private error(frame: Frame, message: string): never {
    throw new PreprocessorError(message, frame.tokenizer.fileName, frame.tokenizer.line, frame.tokenizer.column);
  }
}

// ---------- Directive token reader ----------

class DirectiveReader {
  private readonly tokens: DTok[];
  readonly rawBody: string;
  private pos = 0;
  readonly fileName: string;
  readonly line: number;
  readonly column: number;

  constructor(tokens: DTok[], rawBody: string, fileName: string, line: number, column: number) {
    this.tokens = tokens;
    this.rawBody = rawBody;
    this.fileName = fileName;
    this.line = line;
    this.column = column;
  }

  atEnd(): boolean { return this.pos >= this.tokens.length; }
  peek(offset = 0): DTok | null { return this.tokens[this.pos + offset] ?? null; }
  take(): DTok | null { return this.tokens[this.pos++] ?? null; }

  takeIdent(): string {
    const t = this.take();
    if (!t || t.kind !== "ident") this.fail("expected identifier");
    return t.text;
  }

  consumeIfText(text: string): boolean {
    const t = this.peek();
    if (t && t.text === text) { this.pos++; return true; }
    return false;
  }

  expectEnd(): void {
    if (!this.atEnd()) this.fail("extra tokens at end of directive");
  }

  restText(): string {
    if (this.atEnd()) return "";
    // Slice from first unread token's position in raw body.
    // For simplicity, just join texts with spaces. This is used for #define bodies
    // (where whitespace loss is acceptable for MVP) and #error messages.
    let out = "";
    for (let i = this.pos; i < this.tokens.length; i++) {
      if (out !== "") out += " ";
      out += this.tokens[i]!.text;
    }
    this.pos = this.tokens.length;
    return out;
  }

  fail(message: string): never {
    throw new PreprocessorError(message, this.fileName, this.line, this.column);
  }
}

// ---------- #if expression evaluator ----------

class IfExpr {
  constructor(
    private readonly r: DirectiveReader,
    private readonly pp: Preprocessor,
  ) {}

  parse(): bigint { return this.ternary(); }

  private ternary(): bigint {
    const cond = this.logicalOr();
    if (this.r.consumeIfText("?")) {
      const t = this.ternary();
      if (!this.r.consumeIfText(":")) this.r.fail("expected ':' in ternary");
      const f = this.ternary();
      return cond !== 0n ? t : f;
    }
    return cond;
  }

  private logicalOr(): bigint {
    let v = this.logicalAnd();
    while (this.r.consumeIfText("||")) {
      const rhs = this.logicalAnd();
      v = v !== 0n || rhs !== 0n ? 1n : 0n;
    }
    return v;
  }
  private logicalAnd(): bigint {
    let v = this.bitOr();
    while (this.r.consumeIfText("&&")) {
      const rhs = this.bitOr();
      v = v !== 0n && rhs !== 0n ? 1n : 0n;
    }
    return v;
  }
  private bitOr(): bigint {
    let v = this.bitXor();
    while (this.r.consumeIfText("|")) v = v | this.bitXor();
    return v;
  }
  private bitXor(): bigint {
    let v = this.bitAnd();
    while (this.r.consumeIfText("^")) v = v ^ this.bitAnd();
    return v;
  }
  private bitAnd(): bigint {
    let v = this.equality();
    while (this.r.consumeIfText("&")) v = v & this.equality();
    return v;
  }
  private equality(): bigint {
    let v = this.relational();
    for (;;) {
      if (this.r.consumeIfText("==")) v = v === this.relational() ? 1n : 0n;
      else if (this.r.consumeIfText("!=")) v = v !== this.relational() ? 1n : 0n;
      else break;
    }
    return v;
  }
  private relational(): bigint {
    let v = this.shift();
    for (;;) {
      if (this.r.consumeIfText("<=")) v = v <= this.shift() ? 1n : 0n;
      else if (this.r.consumeIfText(">=")) v = v >= this.shift() ? 1n : 0n;
      else if (this.r.consumeIfText("<")) v = v < this.shift() ? 1n : 0n;
      else if (this.r.consumeIfText(">")) v = v > this.shift() ? 1n : 0n;
      else break;
    }
    return v;
  }
  private shift(): bigint {
    let v = this.additive();
    for (;;) {
      if (this.r.consumeIfText("<<")) v = v << this.additive();
      else if (this.r.consumeIfText(">>")) v = v >> this.additive();
      else break;
    }
    return v;
  }
  private additive(): bigint {
    let v = this.multiplicative();
    for (;;) {
      if (this.r.consumeIfText("+")) v = v + this.multiplicative();
      else if (this.r.consumeIfText("-")) v = v - this.multiplicative();
      else break;
    }
    return v;
  }
  private multiplicative(): bigint {
    let v = this.unary();
    for (;;) {
      if (this.r.consumeIfText("*")) v = v * this.unary();
      else if (this.r.consumeIfText("/")) {
        const y = this.unary();
        if (y === 0n) this.r.fail("division by zero in preprocessor expression");
        v = v / y;
      } else if (this.r.consumeIfText("%")) {
        const y = this.unary();
        if (y === 0n) this.r.fail("division by zero in preprocessor expression");
        v = v % y;
      } else break;
    }
    return v;
  }
  private unary(): bigint {
    if (this.r.consumeIfText("+")) return this.unary();
    if (this.r.consumeIfText("-")) return -this.unary();
    if (this.r.consumeIfText("!")) return this.unary() === 0n ? 1n : 0n;
    if (this.r.consumeIfText("~")) return ~this.unary();
    return this.primary();
  }
  private primary(): bigint {
    const t = this.r.take();
    if (!t) this.r.fail("unexpected end of expression");
    if (t.kind === "integer") return t.integer ?? 0n;
    if (t.text === "(") {
      const v = this.parse();
      if (!this.r.consumeIfText(")")) this.r.fail("expected ')'");
      return v;
    }
    if (t.kind === "ident") {
      if (t.text === "defined") return this.parseDefined();
      if (t.text === "__has_include") return this.parseHasInclude();
      return 0n;
    }
    this.r.fail(`unexpected token '${t.text}' in preprocessor expression`);
  }

  private parseDefined(): bigint {
    const needClose = this.r.consumeIfText("(");
    const id = this.r.takeIdent();
    if (needClose && !this.r.consumeIfText(")")) this.r.fail("expected ')'");
    return this.pp.isDefinedForIf(id) ? 1n : 0n;
  }

  private parseHasInclude(): bigint {
    if (!this.r.consumeIfText("(")) this.r.fail("expected '(' after __has_include");
    let name = "";
    let quoted = false;
    const first = this.r.take();
    if (!first) this.r.fail("expected filename in __has_include");
    if (first.kind === "string2" && first.text.length >= 2) {
      name = first.text.slice(1, -1);
      quoted = true;
    } else if (first.text === "<") {
      for (;;) {
        const nx = this.r.take();
        if (!nx) this.r.fail("expected '>'");
        if (nx.text === ">") break;
        name += nx.text;
      }
    } else {
      this.r.fail('__has_include expects "FILE" or <FILE>');
    }
    if (!this.r.consumeIfText(")")) this.r.fail("expected ')'");
    return this.pp.hasIncludeCheck(name, this.pp.currentFileName(), quoted) ? 1n : 0n;
  }
}
