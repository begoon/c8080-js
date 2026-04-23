import { describe, expect, test } from "bun:test";
import { Tokenizer, type TokenKind } from "../../src/frontend/tokenizer.ts";

type Expected = {
  kind: TokenKind;
  text?: string;
  integer?: bigint;
  float?: number;
  line?: number;
  column?: number;
};

function tokenize(src: string): Array<Expected & { text: string }> {
  const t = new Tokenizer(src, "<test>");
  const out: Array<Expected & { text: string }> = [];
  for (;;) {
    t.next();
    const row: Expected & { text: string } = {
      kind: t.kind,
      text: t.tokenText,
      line: t.tokenLine,
      column: t.tokenColumn,
    };
    if (t.kind === "integer") row.integer = t.tokenInteger;
    if (t.kind === "float") row.float = t.tokenFloat;
    out.push(row);
    if (t.kind === "eof") break;
  }
  return out;
}

function kinds(src: string): TokenKind[] {
  return tokenize(src).map((t) => t.kind);
}

describe("tokenizer — basics", () => {
  test("empty source", () => {
    expect(kinds("")).toEqual(["eof"]);
  });

  test("identifier", () => {
    const t = tokenize("hello_world ABC __x1");
    expect(t.map((x) => x.kind)).toEqual(["ident", "ident", "ident", "eof"]);
    expect(t.slice(0, 3).map((x) => x.text)).toEqual(["hello_world", "ABC", "__x1"]);
  });

  test("decimal, hex, octal integers", () => {
    const t = tokenize("0 123 0xFF 0xff 077 0X10");
    expect(t.filter((x) => x.kind === "integer").map((x) => x.integer)).toEqual([
      0n, 123n, 255n, 255n, 63n, 16n,
    ]);
  });

  test("float literals", () => {
    const t = tokenize("1.0 3.14 1e2 1.5E-3 2e+0");
    const floats = t.filter((x) => x.kind === "float").map((x) => x.float);
    expect(floats).toEqual([1.0, 3.14, 100, 0.0015, 2]);
  });

  test("strings single and double", () => {
    const t = tokenize(`'a' "hello" "with \\"escape"`);
    expect(t[0]).toMatchObject({ kind: "string1", text: "'a'" });
    expect(t[1]).toMatchObject({ kind: "string2", text: `"hello"` });
    expect(t[2]).toMatchObject({ kind: "string2", text: `"with \\"escape"` });
  });
});

describe("tokenizer — operators", () => {
  test("multi-char operators coalesce", () => {
    const cases: Array<[string, string]> = [
      ["==", "=="], ["!=", "!="], ["<=", "<="], [">=", ">="],
      ["<<", "<<"], [">>", ">>"], ["<<=", "<<="], [">>=", ">>="],
      ["+=", "+="], ["-=", "-="], ["*=", "*="], ["/=", "/="],
      ["%=", "%="], ["^=", "^="], ["|=", "|="], ["&=", "&="],
      ["++", "++"], ["--", "--"], ["->", "->"],
      ["&&", "&&"], ["||", "||"],
      ["...", "..."],
    ];
    for (const [src, text] of cases) {
      const t = tokenize(src);
      expect(t[0]).toMatchObject({ kind: "operator", text });
    }
  });

  test("single-char operators", () => {
    const t = tokenize("( ) { } [ ] ; , ~ ? :");
    const ops = t.filter((x) => x.kind === "operator").map((x) => x.text);
    expect(ops).toEqual(["(", ")", "{", "}", "[", "]", ";", ",", "~", "?", ":"]);
  });
});

describe("tokenizer — comments and EOL", () => {
  test("line comment", () => {
    const t = tokenize("a // comment\nb");
    expect(t.map((x) => x.kind)).toEqual(["ident", "remark", "eol", "ident", "eof"]);
  });

  test("block comment", () => {
    const t = tokenize("a /* multi\nline */ b");
    expect(t.map((x) => x.kind)).toEqual(["ident", "remark", "ident", "eof"]);
  });

  test("unterminated block comment throws", () => {
    expect(() => tokenize("/* open")).toThrow("unterminated comment");
  });

  test("unterminated string throws", () => {
    expect(() => tokenize(`"no close`)).toThrow(`missing terminating " character`);
  });

  test("backslash-newline is a REMARK (line continuation)", () => {
    const t = tokenize("a\\\nb");
    expect(t.map((x) => x.kind)).toEqual(["ident", "remark", "ident", "eof"]);
  });

  test("EOL token appears between lines", () => {
    const t = tokenize("a\nb");
    expect(t.map((x) => x.kind)).toEqual(["ident", "eol", "ident", "eof"]);
  });
});

describe("tokenizer — position tracking", () => {
  test("line and column advance", () => {
    const t = tokenize("abc\n  def");
    expect(t[0]).toMatchObject({ line: 1, column: 1, text: "abc" });
    expect(t[2]).toMatchObject({ line: 2, column: 3, text: "def" });
  });

  test("hello world program shape", () => {
    const t = tokenize("int main(void) { return 0; }");
    const kinds = t.map((x) => x.kind);
    expect(kinds).toEqual([
      "ident", "ident", "operator", "ident", "operator", "operator",
      "ident", "integer", "operator", "operator", "eof",
    ]);
  });
});
