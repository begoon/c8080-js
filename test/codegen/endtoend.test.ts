// End-to-end tests: C source → assembled binary → simulated 8080.
// Verifies program behaviour, not just code shape.

import { describe, expect, test } from "bun:test";
import { MemoryFileSystem } from "../../src/frontend/fs.ts";
import { Preprocessor } from "../../src/frontend/preprocessor.ts";
import { Lex } from "../../src/frontend/lex.ts";
import { Parser } from "../../src/frontend/parser.ts";
import { compileProgram } from "../../src/codegen/i8080/compile.ts";
import { simulate } from "./sim8080.ts";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function build(src: string): { bin: Uint8Array; asm: string } {
  const pp = new Preprocessor({ fs: new MemoryFileSystem({ "/a.c": src }) });
  pp.openFile("/a.c");
  const program = new Parser(new Lex(pp)).parseProgram();
  const { asm } = compileProgram(program, { org: 0x0100 });

  const dir = mkdtempSync(join(tmpdir(), "c8080-e2e-"));
  const asmPath = join(dir, "a.asm");
  const binPath = join(dir, "a.bin");
  writeFileSync(asmPath, asm);

  const r = spawnSync("bunx", ["asm8080", "a.asm", "-o", dir], { cwd: dir });
  if (r.status !== 0) {
    throw new Error(`asm8080 failed:\n--- asm ---\n${asm}\n--- stderr ---\n${r.stderr?.toString() ?? ""}\n--- stdout ---\n${r.stdout?.toString() ?? ""}`);
  }
  const bin = new Uint8Array(readFileSync(binPath));
  return { bin, asm };
}

function run(src: string): number {
  const { bin } = build(src);
  return simulate(bin).hl;
}

describe("codegen — end-to-end", () => {
  test("return constant", () => {
    expect(run(`int main(void) { return 42; }`)).toBe(42);
  });

  test("add(3,4) = 7", () => {
    expect(run(`
      int add(int a, int b) { return a + b; }
      int main(void) { return add(3, 4); }
    `)).toBe(7);
  });

  test("while: sum 1..10 = 55", () => {
    expect(run(`
      int sum(int n) {
        int total = 0;
        int i = 1;
        while (i <= n) {
          total = total + i;
          i = i + 1;
        }
        return total;
      }
      int main(void) { return sum(10); }
    `)).toBe(55);
  });

  test("for loop: sum of squares-via-adds", () => {
    // No multiplication yet; compute sum of 1..5 via an accumulator.
    expect(run(`
      int main(void) {
        int total = 0;
        int i;
        for (i = 1; i <= 5; i = i + 1) total = total + i;
        return total;
      }
    `)).toBe(15);
  });

  test("if/else branching", () => {
    expect(run(`
      int abs(int x) { if (x < 0) return 0 - x; else return x; }
      int main(void) { return abs(0 - 17); }
    `)).toBe(17);
  });

  test("iterative fibonacci(10) = 55", () => {
    // Recursive fib requires __stack storage mode (c8080's default __global
    // mode uses fixed param addresses, so recursion corrupts the frame —
    // documented constraint in manual.md §5).
    expect(run(`
      int fib(int n) {
        int a = 0;
        int b = 1;
        int i = 0;
        while (i < n) {
          int t = a + b;
          a = b;
          b = t;
          i = i + 1;
        }
        return a;
      }
      int main(void) { return fib(10); }
    `)).toBe(55);
  });
});
