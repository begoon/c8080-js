import type { PPToken, Preprocessor } from "./preprocessor.ts";
import type { TokenKind } from "./tokenizer.ts";

export class ParserError extends Error {
  constructor(
    message: string,
    readonly fileName: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(`${fileName}:${line}:${column}: ${message}`);
  }
}

export class Lex {
  private readonly buffer: PPToken[] = [];
  private cursor = 0;

  constructor(private readonly pp: Preprocessor) {}

  get token(): PPToken { return this.at(0); }
  get kind(): TokenKind { return this.at(0).kind; }
  get text(): string { return this.at(0).text; }
  get line(): number { return this.at(0).line; }
  get column(): number { return this.at(0).column; }
  get fileName(): string { return this.at(0).fileName; }

  at(offset: number): PPToken {
    while (this.buffer.length <= this.cursor + offset) {
      this.buffer.push(this.pp.next());
    }
    return this.buffer[this.cursor + offset]!;
  }

  advance(): void { this.cursor++; }

  atEnd(): boolean { return this.at(0).kind === "eof"; }

  ifText(text: string): boolean {
    if (this.at(0).text === text) { this.advance(); return true; }
    return false;
  }

  needText(text: string): void {
    if (!this.ifText(text)) this.throwUnexpected(`expected '${text}'`);
  }

  ifKind(kind: TokenKind): boolean {
    if (this.at(0).kind === kind) { this.advance(); return true; }
    return false;
  }

  ifIdent(): string | null {
    if (this.at(0).kind !== "ident") return null;
    const t = this.at(0).text;
    this.advance();
    return t;
  }

  needIdent(): string {
    const id = this.ifIdent();
    if (id === null) this.throwUnexpected("expected identifier");
    return id;
  }

  ifInteger(): bigint | null {
    if (this.at(0).kind !== "integer") return null;
    const v = this.at(0).integer ?? 0n;
    this.advance();
    return v;
  }

  peekText(text: string, offset = 0): boolean {
    return this.at(offset).text === text;
  }

  peekIdent(name: string, offset = 0): boolean {
    const t = this.at(offset);
    return t.kind === "ident" && t.text === name;
  }

  throwHere(message: string): never {
    throw new ParserError(message, this.at(0).fileName, this.at(0).line, this.at(0).column);
  }

  throwUnexpected(expected: string): never {
    const t = this.at(0);
    this.throwHere(`${expected}, got '${t.text || t.kind}'`);
  }
}
