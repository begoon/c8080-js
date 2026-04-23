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

function runWithOutput(src: string): { hl: number; output: string } {
  const { bin } = build(src);
  const r = simulate(bin);
  return { hl: r.hl, output: r.output };
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

  test("putchar prints a single character", () => {
    const r = runWithOutput(`
      int main(void) {
        putchar('A');
        return 0;
      }
    `);
    expect(r.output).toBe("A");
  });

  test("puts prints a string", () => {
    const r = runWithOutput(`
      int main(void) {
        puts("hello");
        return 0;
      }
    `);
    expect(r.output).toBe("hello");
  });

  test("multiple putchars via loop", () => {
    const r = runWithOutput(`
      int main(void) {
        int i;
        for (i = 0; i < 3; i = i + 1) putchar('*');
        return 0;
      }
    `);
    expect(r.output).toBe("***");
  });

  test("multiply via runtime helper", () => {
    expect(run(`
      int mul(int a, int b) { return a * b; }
      int main(void) { return mul(7, 13); }
    `)).toBe(91);
  });

  test("square via multiply", () => {
    expect(run(`
      int main(void) { int x = 12; return x * x; }
    `)).toBe(144);
  });

  test("multiply in expression", () => {
    expect(run(`
      int main(void) { return 3 + 4 * 5; }
    `)).toBe(23);
  });

  test("divide via runtime helper", () => {
    expect(run(`
      int divFn(int a, int b) { return a / b; }
      int main(void) { return divFn(100, 7); }
    `)).toBe(14);
  });

  test("modulo via runtime helper", () => {
    expect(run(`
      int modFn(int a, int b) { return a % b; }
      int main(void) { return modFn(100, 7); }
    `)).toBe(2);
  });

  test("shift left by constant", () => {
    expect(run(`
      int main(void) { return 1 << 10; }
    `)).toBe(1024);
  });

  test("byte array: read and write via subscript", () => {
    const r = runWithOutput(`
      char buf[5];
      int main(void) {
        buf[0] = 'a';
        buf[1] = 'b';
        buf[2] = 'c';
        buf[3] = 'd';
        buf[4] = 'e';
        putchar(buf[3]);
        putchar(buf[1]);
        putchar(buf[0]);
        return 0;
      }
    `);
    expect(r.output).toBe("dba");
  });

  test("walk a C string with a char pointer", () => {
    const r = runWithOutput(`
      int strlen_(char *s) {
        int n = 0;
        while (*s != 0) { n = n + 1; s = s + 1; }
        return n;
      }
      int main(void) { return strlen_("hello!"); }
    `);
    expect(r.hl).toBe(6);
  });

  test("print digit sequence via /,%", () => {
    const r = runWithOutput(`
      int main(void) {
        int n = 123;
        putchar('0' + n / 100);
        putchar('0' + (n / 10) % 10);
        putchar('0' + n % 10);
        return 0;
      }
    `);
    expect(r.output).toBe("123");
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
