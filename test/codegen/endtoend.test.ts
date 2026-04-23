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

  test("global scalar initializer", () => {
    expect(run(`
      int ANSWER = 42;
      int main(void) { return ANSWER; }
    `)).toBe(42);
  });

  test("global int array initializer", () => {
    expect(run(`
      int primes[] = {2, 3, 5, 7, 11};
      int main(void) { return primes[0] + primes[2] + primes[4]; }
    `)).toBe(18);
  });

  test("global char array string initializer", () => {
    const r = runWithOutput(`
      char msg[] = "hi!";
      int main(void) { puts(msg); return 0; }
    `);
    expect(r.output).toBe("hi!");
  });

  test("global byte initializer", () => {
    expect(run(`
      char c = 65;
      int main(void) { return c; }
    `)).toBe(65);
  });

  test("initialized lookup table", () => {
    expect(run(`
      char digits[] = "0123456789";
      int main(void) { return digits[7]; }
    `)).toBe('7'.charCodeAt(0));
  });

  test("int array: read/write with element-size scaling", () => {
    expect(run(`
      int arr[5];
      int main(void) {
        arr[0] = 10;
        arr[1] = 20;
        arr[2] = 30;
        arr[3] = 40;
        arr[4] = 50;
        return arr[0] + arr[2] + arr[4];
      }
    `)).toBe(90);
  });

  test("string reversal in place", () => {
    const r = runWithOutput(`
      char buf[16];
      void reverse(char *s, int len) {
        int i = 0;
        int j = len - 1;
        while (i < j) {
          char t;
          t = s[i];
          s[i] = s[j];
          s[j] = t;
          i = i + 1;
          j = j - 1;
        }
      }
      int main(void) {
        buf[0] = 'h'; buf[1] = 'e'; buf[2] = 'l'; buf[3] = 'l'; buf[4] = 'o';
        buf[5] = 0;
        reverse(buf, 5);
        puts(buf);
        return 0;
      }
    `);
    expect(r.output).toBe("olleh");
  });

  test("enum values resolve as integer constants", () => {
    expect(run(`
      enum Color { RED, GREEN, BLUE };
      int main(void) { return RED + GREEN + BLUE; }
    `)).toBe(3); // 0 + 1 + 2
  });

  test("enum with explicit values", () => {
    expect(run(`
      enum { A = 100, B, C = 200, D };
      int main(void) { return A + B + C + D; }
    `)).toBe(602); // 100 + 101 + 200 + 201
  });

  test("enum used as return/argument type", () => {
    expect(run(`
      enum Op { ADD, SUB };
      int apply(enum Op op, int a, int b) {
        if (op == ADD) return a + b;
        return a - b;
      }
      int main(void) { return apply(ADD, 10, 3); }
    `)).toBe(13);
  });

  test("struct: global with two int fields, read/write", () => {
    expect(run(`
      struct Point { int x; int y; };
      struct Point p;
      int main(void) {
        p.x = 100;
        p.y = 200;
        return p.x + p.y;
      }
    `)).toBe(300);
  });

  test("struct pointer: arrow access", () => {
    expect(run(`
      struct Box { int w; int h; };
      struct Box global_box;
      int area(struct Box *b) { return b->w * b->h; }
      int main(void) {
        global_box.w = 7;
        global_box.h = 8;
        return area(&global_box);
      }
    `)).toBe(56);
  });

  test("struct with mixed-size fields", () => {
    expect(run(`
      struct Rec { char tag; int value; };
      struct Rec r;
      int main(void) {
        r.tag = 42;
        r.value = 1234;
        return r.tag + r.value;
      }
    `)).toBe(1276);
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
