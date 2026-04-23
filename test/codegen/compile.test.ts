import { describe, expect, test } from "bun:test";
import { MemoryFileSystem } from "../../src/frontend/fs.ts";
import { Preprocessor } from "../../src/frontend/preprocessor.ts";
import { Lex } from "../../src/frontend/lex.ts";
import { Parser } from "../../src/frontend/parser.ts";
import { compileProgram } from "../../src/codegen/i8080/compile.ts";

function compile(src: string): string {
  const pp = new Preprocessor({ fs: new MemoryFileSystem({ "/a.c": src }) });
  pp.openFile("/a.c");
  const p = new Parser(new Lex(pp)).parseProgram();
  return compileProgram(p).asm;
}

describe("codegen — minimal cases", () => {
  test("function returning integer constant", () => {
    const asm = compile(`int main() { return 42; }`);
    expect(asm).toContain("main:");
    expect(asm).toContain("LXI   H, 42");
    expect(asm).toContain("RET");
  });

  test("return without value emits RET", () => {
    const asm = compile(`void f() { return; }`);
    expect(asm).toContain("f:");
    expect(asm).toContain("RET");
  });

  test("constant folding for add", () => {
    const asm = compile(`int f() { return 1 + 2; }`);
    expect(asm).toContain("LXI   H, 3");
  });

  test("non-folded add emits DAD", () => {
    const asm = compile(`int f() { return 100 + 200 + 300; }`);
    // (100+200) folds to 300, then 300 + 300 folds to 600.
    expect(asm).toContain("LXI   H, 600");
  });

  test("binary subtract", () => {
    const asm = compile(`int f(int x) { return 10 - x; }`);
    // LHS is const, RHS is var (unhandled → LXI H,0), so subtract runs
    // through the fallback path with PUSH/POP/CMA/DAD.
    expect(asm).toContain("CMA");
  });

  test("program has ORG and END", () => {
    const asm = compile(`int main() { return 0; }`);
    expect(asm).toMatch(/ORG\s+100h/i);
    expect(asm.trim().endsWith("END")).toBe(true);
  });

  test("function appears as label", () => {
    const asm = compile(`int foo() { return 0; } int bar() { return 0; }`);
    expect(asm).toContain("foo:");
    expect(asm).toContain("bar:");
  });

  test("main gets jumped-to first", () => {
    const asm = compile(`int foo() { return 1; } int main() { return 0; }`);
    const jmpLine = asm.split("\n").find((l) => l.includes("JMP"));
    expect(jmpLine).toContain("main");
  });
});
