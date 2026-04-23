export type TokenKind =
  | "eof"
  | "eol"
  | "ident"
  | "integer"
  | "float"
  | "operator"
  | "string1"
  | "string2"
  | "remark";

export type Token = {
  readonly kind: TokenKind;
  readonly line: number;
  readonly column: number;
  readonly start: number;
  readonly end: number;
  readonly integer?: bigint;
  readonly float?: number;
};

export class TokenizerError extends Error {
  constructor(
    message: string,
    readonly fileName: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(`${fileName}:${line}:${column}: ${message}`);
  }
}

const TAB_SIZE = 4;

function tab(column: number): number {
  return ((column + TAB_SIZE) & ~TAB_SIZE) + 1;
}

function isIdentStart(c: number): boolean {
  return c === 0x5f || (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a);
}

function isIdentCont(c: number): boolean {
  return isIdentStart(c) || (c >= 0x30 && c <= 0x39);
}

function isHexDigit(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);
}

function isOctDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x37;
}

function isDecDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

export class Tokenizer {
  readonly source: string;
  readonly fileName: string;
  private cursor = 0;
  line = 1;
  column = 1;

  kind: TokenKind = "eof";
  tokenLine = 0;
  tokenColumn = 0;
  tokenStart = 0;
  tokenEnd = 0;
  tokenInteger = 0n;
  tokenFloat = 0;

  constructor(source: string, fileName: string) {
    this.source = source;
    this.fileName = fileName;
  }

  get tokenText(): string {
    return this.source.slice(this.tokenStart, this.tokenEnd);
  }

  snapshot(): Token {
    const t: Token = {
      kind: this.kind,
      line: this.tokenLine,
      column: this.tokenColumn,
      start: this.tokenStart,
      end: this.tokenEnd,
      ...(this.kind === "integer" ? { integer: this.tokenInteger } : {}),
      ...(this.kind === "float" ? { float: this.tokenFloat } : {}),
    };
    return t;
  }

  next(): void {
    this.skipTrivia();

    this.tokenLine = this.line;
    this.tokenColumn = this.column;
    this.tokenStart = this.cursor;

    this.kind = this.scan();

    this.tokenEnd = this.cursor;
    this.advanceColumns(this.tokenStart, this.tokenEnd);
  }

  private skipTrivia(): void {
    for (;;) {
      const c = this.source.charCodeAt(this.cursor);
      if (c === 0x09) {
        this.cursor++;
        this.column = tab(this.column);
      } else if (c === 0x20) {
        this.cursor++;
        this.column++;
      } else if (c === 0x0d) {
        this.cursor++;
      } else {
        break;
      }
    }
  }

  private advanceColumns(from: number, to: number): void {
    for (let i = from; i < to; i++) {
      const c = this.source.charCodeAt(i);
      if (c === 0x09) this.column = tab(this.column);
      else if (c === 0x0d) continue;
      else if (c === 0x0a) {
        this.line++;
        this.column = 1;
      } else {
        this.column++;
      }
    }
  }

  private throwHere(message: string): never {
    throw new TokenizerError(message, this.fileName, this.tokenLine || this.line, this.tokenColumn || this.column);
  }

  private peek(offset = 0): number {
    return this.source.charCodeAt(this.cursor + offset);
  }

  private scan(): TokenKind {
    const c0 = this.peek();
    this.cursor++;

    if (isIdentStart(c0)) {
      while (isIdentCont(this.peek())) this.cursor++;
      return "ident";
    }

    if (isDecDigit(c0)) {
      this.cursor--;
      this.scanNumber();
      if (this.kind === "float") return "float";
      return "integer";
    }

    switch (c0) {
      case Number.NaN:
      case 0:
        this.cursor--;
        return "eof";
      case 0x0a:
        return "eol";
      case 0x27:
        return this.scanQuoted(0x27, "string1");
      case 0x22:
        return this.scanQuoted(0x22, "string2");
      case 0x21: // !
      case 0x3d: // =
      case 0x25: // %
      case 0x5e: // ^
        if (this.peek() === 0x3d) this.cursor++;
        return "operator";
      case 0x2f: // /
        return this.scanSlash();
      case 0x2a: // *
        if (this.peek() === 0x2f || this.peek() === 0x3d) this.cursor++;
        return "operator";
      case 0x2e: // .
        if (this.peek() === 0x2e || this.peek(1) === 0x2e) this.cursor += 2;
        return "operator";
      case 0x2b: // +
        if (this.peek() === 0x2b || this.peek() === 0x3d) this.cursor++;
        return "operator";
      case 0x2d: // -
        if (this.peek() === 0x2d || this.peek() === 0x3d || this.peek() === 0x3e) this.cursor++;
        return "operator";
      case 0x3c: // <
        return this.scanAngle(0x3c);
      case 0x3e: // >
        return this.scanAngle(0x3e);
      case 0x7c: // |
        if (this.peek() === 0x7c || this.peek() === 0x3d) this.cursor++;
        return "operator";
      case 0x26: // &
        if (this.peek() === 0x26 || this.peek() === 0x3d) this.cursor++;
        return "operator";
      case 0x5c: // \
        if (this.peek() === 0x0a) {
          this.cursor++;
          return "remark";
        }
        if (this.peek() === 0x0d && this.peek(1) === 0x0a) {
          this.cursor += 2;
          return "remark";
        }
        return "operator";
      default:
        if (Number.isNaN(c0)) {
          this.cursor--;
          return "eof";
        }
        return "operator";
    }
  }

  private scanNumber(): void {
    const start = this.cursor;
    let end = start;
    let radix: 10 | 16 | 8 = 10;

    if (this.source.charCodeAt(start) === 0x30 && (this.peek(1) === 0x78 || this.peek(1) === 0x58)) {
      end = start + 2;
      while (isHexDigit(this.source.charCodeAt(end))) end++;
      if (end === start + 2) this.throwHere("number out of range");
      radix = 16;
      this.cursor = end;
      this.tokenInteger = BigInt(this.source.slice(start, end));
    } else if (this.source.charCodeAt(start) === 0x30) {
      end = start + 1;
      while (isOctDigit(this.source.charCodeAt(end))) end++;
      radix = 8;
      this.cursor = end;
      this.tokenInteger = BigInt("0o" + (end === start + 1 ? "0" : this.source.slice(start + 1, end)));
    } else {
      end = start;
      while (isDecDigit(this.source.charCodeAt(end))) end++;
      if (end === start) this.throwHere("number out of range");
      this.cursor = end;
      this.tokenInteger = BigInt(this.source.slice(start, end));
    }

    if (radix === 10) {
      const peek0 = this.source.charCodeAt(this.cursor);
      if (peek0 === 0x2e || peek0 === 0x65 || peek0 === 0x45) {
        let i = this.cursor;
        if (peek0 === 0x2e) {
          i++;
          while (isDecDigit(this.source.charCodeAt(i))) i++;
        }
        const e = this.source.charCodeAt(i);
        if (e === 0x65 || e === 0x45) {
          i++;
          const sign = this.source.charCodeAt(i);
          if (sign === 0x2b || sign === 0x2d) i++;
          const expStart = i;
          while (isDecDigit(this.source.charCodeAt(i))) i++;
          if (i === expStart) this.throwHere("number out of range");
        }
        const text = this.source.slice(start, i);
        const f = Number.parseFloat(text);
        if (!Number.isFinite(f)) this.throwHere("number out of range");
        this.tokenFloat = f;
        this.cursor = i;
        this.kind = "float";
        return;
      }
    }

    this.kind = "integer";
  }

  private scanQuoted(quote: number, kind: "string1" | "string2"): TokenKind {
    const quoteName = quote === 0x27 ? "'" : '"';
    for (;;) {
      const c = this.peek();
      if (Number.isNaN(c) || c === 0 || c === 0x0a) this.throwHere(`missing terminating ${quoteName} character`);
      this.cursor++;
      if (c === quote) return kind;
      if (c === 0x5c) {
        const c1 = this.peek();
        if (Number.isNaN(c1) || c1 === 0 || c1 === 0x0a) this.throwHere(`missing terminating ${quoteName} character`);
        this.cursor++;
      }
    }
  }

  private scanSlash(): TokenKind {
    const next = this.peek();
    if (next === 0x3d) {
      this.cursor++;
      return "operator";
    }
    if (next === 0x2f) {
      this.cursor++;
      for (;;) {
        const c = this.peek();
        if (Number.isNaN(c) || c === 0) break;
        if (c === 0x0a && this.source.charCodeAt(this.cursor - 2) !== 0x5c) break;
        this.cursor++;
      }
      return "remark";
    }
    if (next === 0x2a) {
      this.cursor++;
      let c = this.peek();
      if (Number.isNaN(c) || c === 0) this.throwHere("unterminated comment");
      this.cursor++;
      for (;;) {
        const c1 = this.peek();
        if (Number.isNaN(c1) || c1 === 0) this.throwHere("unterminated comment");
        this.cursor++;
        if (c === 0x2a && c1 === 0x2f) break;
        c = c1;
      }
      return "remark";
    }
    return "operator";
  }

  private scanAngle(lead: number): TokenKind {
    if (this.peek() === 0x3d) {
      this.cursor++;
      return "operator";
    }
    if (this.peek() === lead) {
      this.cursor++;
      if (this.peek() === 0x3d) this.cursor++;
    }
    return "operator";
  }
}
