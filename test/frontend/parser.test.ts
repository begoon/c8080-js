import { describe, expect, test } from "bun:test";
import { MemoryFileSystem } from "../../src/frontend/fs.ts";
import { Preprocessor } from "../../src/frontend/preprocessor.ts";
import { Lex } from "../../src/frontend/lex.ts";
import { Parser } from "../../src/frontend/parser.ts";
import type { CProgram, CNode } from "../../src/frontend/ast.ts";

function parse(src: string): CProgram {
  const pp = new Preprocessor({ fs: new MemoryFileSystem({ "/a.c": src }) });
  pp.openFile("/a.c");
  return new Parser(new Lex(pp)).parseProgram();
}

function expectBase(n: CNode, expected: string): void {
  if (n.kind !== "const") throw new Error(`expected const, got ${n.kind}`);
  expect(String(n.value)).toBe(expected);
}

describe("parser — function definitions", () => {
  test("empty body", () => {
    const p = parse(`int main() {}`);
    expect(p.functions).toHaveLength(1);
    const f = p.functions[0]!;
    expect(f.name).toBe("main");
    expect(f.type.kind).toBe("function");
    expect(f.params).toEqual([]);
    expect(f.body?.kind).toBe("block");
  });

  test("(void) parameter list", () => {
    const p = parse(`int main(void) {}`);
    expect(p.functions[0]!.params).toEqual([]);
  });

  test("multiple parameters", () => {
    const p = parse(`int add(int a, int b) { return a + b; }`);
    const f = p.functions[0]!;
    expect(f.params.map((p) => p.name)).toEqual(["a", "b"]);
    expect(f.params.map((p) => (p.type.kind === "base" ? p.type.base : null))).toEqual(["int", "int"]);
  });

  test("forward declaration produces a stub with no body", () => {
    const p = parse(`int foo(void);`);
    expect(p.functions[0]!.body).toBeNull();
  });

  test("multiple functions", () => {
    const p = parse(`int a() { return 1; } int b() { return 2; }`);
    expect(p.functions.map((f) => f.name)).toEqual(["a", "b"]);
  });
});

describe("parser — statements", () => {
  test("return with value", () => {
    const p = parse(`int f() { return 42; }`);
    const body = p.functions[0]!.body!;
    if (body.kind !== "block") throw new Error("expected block");
    const ret = body.stmts[0]!;
    if (ret.kind !== "return") throw new Error("expected return");
    expect(ret.value).not.toBeNull();
    expectBase(ret.value!, "42");
  });

  test("return without value", () => {
    const p = parse(`void f() { return; }`);
    const body = p.functions[0]!.body!;
    if (body.kind !== "block") throw new Error("expected block");
    const ret = body.stmts[0]!;
    if (ret.kind !== "return") throw new Error("expected return");
    expect(ret.value).toBeNull();
  });

  test("if/else", () => {
    const p = parse(`int f() { if (1) return 1; else return 0; }`);
    const body = p.functions[0]!.body!;
    if (body.kind !== "block") throw new Error();
    expect(body.stmts[0]!.kind).toBe("if");
  });

  test("while loop", () => {
    const p = parse(`void f() { while (1) break; }`);
    const body = p.functions[0]!.body!;
    if (body.kind !== "block") throw new Error();
    expect(body.stmts[0]!.kind).toBe("while");
  });

  test("do-while loop", () => {
    const p = parse(`void f() { do { continue; } while (0); }`);
    const body = p.functions[0]!.body!;
    if (body.kind !== "block") throw new Error();
    expect(body.stmts[0]!.kind).toBe("do");
  });

  test("for loop", () => {
    const p = parse(`void f() { for (;;) break; }`);
    const body = p.functions[0]!.body!;
    if (body.kind !== "block") throw new Error();
    const forNode = body.stmts[0]!;
    expect(forNode.kind).toBe("for");
  });
});

describe("parser — expressions", () => {
  test("binary precedence: 1 + 2 * 3 == 7", () => {
    const p = parse(`int f() { return 1 + 2 * 3; }`);
    const body = p.functions[0]!.body!;
    if (body.kind !== "block") throw new Error();
    const ret = body.stmts[0]!;
    if (ret.kind !== "return" || !ret.value) throw new Error();
    const add = ret.value;
    if (add.kind !== "binary" || add.op !== "add") throw new Error();
    expectBase(add.lhs, "1");
    if (add.rhs.kind !== "binary" || add.rhs.op !== "mul") throw new Error();
  });

  test("function call", () => {
    const p = parse(`int f() { return g(1, 2); }`);
    const body = p.functions[0]!.body!;
    if (body.kind !== "block") throw new Error();
    const ret = body.stmts[0]!;
    if (ret.kind !== "return" || !ret.value) throw new Error();
    const call = ret.value;
    if (call.kind !== "call") throw new Error();
    if (call.target.kind !== "var" || call.target.name !== "g") throw new Error();
    expect(call.args).toHaveLength(2);
  });

  test("assignment and compound assignment", () => {
    const p = parse(`void f() { x = 1; x += 2; }`);
    const body = p.functions[0]!.body!;
    if (body.kind !== "block") throw new Error();
    const [a, b] = body.stmts;
    if (a?.kind !== "assign" || b?.kind !== "assign") throw new Error();
    if (b.value.kind !== "binary" || b.value.op !== "add") throw new Error();
  });

  test("unary operators", () => {
    const p = parse(`int f() { return -x + !y + ~z; }`);
    const body = p.functions[0]!.body!;
    if (body.kind !== "block") throw new Error();
    const ret = body.stmts[0]!;
    if (ret.kind !== "return" || !ret.value) throw new Error();
    // Just verify it parses without error.
    expect(ret.value.kind).toBe("binary");
  });

  test("string literal", () => {
    const p = parse(`void f() { puts("hello"); }`);
    const body = p.functions[0]!.body!;
    if (body.kind !== "block") throw new Error();
    const call = body.stmts[0]!;
    if (call.kind !== "call") throw new Error();
    const arg = call.args[0]!;
    if (arg.kind !== "const" || typeof arg.value !== "string") throw new Error();
    expect(arg.value).toBe("hello");
  });

  test("ternary", () => {
    const p = parse(`int f() { return x ? 1 : 0; }`);
    const body = p.functions[0]!.body!;
    if (body.kind !== "block") throw new Error();
    const ret = body.stmts[0]!;
    if (ret.kind !== "return" || !ret.value) throw new Error();
    expect(ret.value.kind).toBe("ternary");
  });

  test("post-increment", () => {
    const p = parse(`void f() { x++; }`);
    const body = p.functions[0]!.body!;
    if (body.kind !== "block") throw new Error();
    const e = body.stmts[0]!;
    if (e.kind !== "unary" || e.op !== "postinc") throw new Error();
  });
});

describe("parser — types", () => {
  test("unsigned char", () => {
    const p = parse(`unsigned char x;`);
    expect(p.globals[0]!.type).toEqual({ kind: "base", base: "uchar" });
  });

  test("long long", () => {
    const p = parse(`long long x;`);
    expect(p.globals[0]!.type).toEqual({ kind: "base", base: "llong" });
  });

  test("unsigned long long", () => {
    const p = parse(`unsigned long long x;`);
    expect(p.globals[0]!.type).toEqual({ kind: "base", base: "ullong" });
  });

  test("pointer", () => {
    const p = parse(`char *s;`);
    expect(p.globals[0]!.type).toEqual({ kind: "pointer", to: { kind: "base", base: "char" } });
  });

  test("pointer to pointer", () => {
    const p = parse(`int **pp;`);
    const t = p.globals[0]!.type;
    expect(t).toEqual({
      kind: "pointer",
      to: { kind: "pointer", to: { kind: "base", base: "int" } },
    });
  });
});
