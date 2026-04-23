import { describe, expect, test } from "bun:test";
import { MemoryFileSystem } from "../../src/frontend/fs.ts";
import { Preprocessor, type PPToken } from "../../src/frontend/preprocessor.ts";

function makePP(files: Record<string, string>, includeDirs: string[] = [], defines: string[] = []): Preprocessor {
  return new Preprocessor({ fs: new MemoryFileSystem(files), includeDirs, defines });
}

function collect(pp: Preprocessor): PPToken[] {
  const out: PPToken[] = [];
  for (;;) {
    const t = pp.next();
    out.push(t);
    if (t.kind === "eof") return out;
  }
}

function texts(tokens: PPToken[]): string[] {
  return tokens.filter((t) => t.kind !== "eof").map((t) => t.text);
}

describe("preprocessor — passthrough", () => {
  test("no directives — identical token stream", () => {
    const pp = makePP({ "/a.c": "int main() { return 0; }" });
    pp.openFile("/a.c");
    expect(texts(collect(pp))).toEqual(["int", "main", "(", ")", "{", "return", "0", ";", "}"]);
  });

  test("eof returned repeatedly", () => {
    const pp = makePP({ "/a.c": "" });
    pp.openFile("/a.c");
    expect(pp.next().kind).toBe("eof");
    expect(pp.next().kind).toBe("eof");
  });
});

describe("preprocessor — #define and macro expansion", () => {
  test("object-like macro expands", () => {
    const pp = makePP({ "/a.c": "#define X 42\nX + 1" });
    pp.openFile("/a.c");
    expect(texts(collect(pp))).toEqual(["42", "+", "1"]);
  });

  test("redefine shadows, #undef restores", () => {
    const pp = makePP({ "/a.c": "#define X 1\n#define X 2\n#undef X\nX" });
    pp.openFile("/a.c");
    expect(texts(collect(pp))).toEqual(["1"]);
  });

  test("macro does not expand itself recursively", () => {
    const pp = makePP({ "/a.c": "#define X X + 1\nX" });
    pp.openFile("/a.c");
    expect(texts(collect(pp))).toEqual(["X", "+", "1"]);
  });

  test("cli -D defines", () => {
    const pp = makePP({ "/a.c": "FOO" }, [], ["FOO=123"]);
    pp.openFile("/a.c");
    expect(texts(collect(pp))).toEqual(["123"]);
  });

  test("cli -D without value defines to 1", () => {
    const pp = makePP({ "/a.c": "FOO" }, [], ["FOO"]);
    pp.openFile("/a.c");
    expect(texts(collect(pp))).toEqual(["1"]);
  });
});

describe("preprocessor — function-like macros", () => {
  test("single-arg expansion", () => {
    const pp = makePP({ "/a.c": `#define SQ(x) ((x)*(x))\nSQ(3)` });
    pp.openFile("/a.c");
    expect(texts(collect(pp))).toEqual(["(", "(", "3", ")", "*", "(", "3", ")", ")"]);
  });

  test("multi-arg expansion", () => {
    const pp = makePP({ "/a.c": `#define ADD(a,b) (a+b)\nADD(1,2)` });
    pp.openFile("/a.c");
    expect(texts(collect(pp))).toEqual(["(", "1", "+", "2", ")"]);
  });

  test("paren-body object-like NOT treated as function-like", () => {
    const pp = makePP({ "/a.c": `#define NULL ((void *)0)\nNULL` });
    pp.openFile("/a.c");
    expect(texts(collect(pp))).toEqual(["(", "(", "void", "*", ")", "0", ")"]);
  });

  test("function-like macro name without call emits as-is", () => {
    const pp = makePP({ "/a.c": `#define SQ(x) ((x)*(x))\nSQ + 1` });
    pp.openFile("/a.c");
    expect(texts(collect(pp))).toEqual(["SQ", "+", "1"]);
  });

  test("nested calls in args — outer macro stays disabled (c8080 quirk)", () => {
    // c8080 substitutes raw arg text into the body, then tokenizes with the outer macro
    // still disabled — unlike standard C which expands args before substitution.
    const pp = makePP({ "/a.c": `#define ADD(a,b) a+b\nADD(ADD(1,2), 3)` });
    pp.openFile("/a.c");
    expect(texts(collect(pp))).toEqual(["ADD", "(", "1", ",", "2", ")", "+", "3"]);
  });

  test("nested calls via different macros are expanded", () => {
    const pp = makePP({
      "/a.c": `#define INC(x) (x+1)\n#define DBL(x) (x*2)\nDBL(INC(5))`,
    });
    pp.openFile("/a.c");
    expect(texts(collect(pp))).toEqual(["(", "(", "5", "+", "1", ")", "*", "2", ")"]);
  });

  test("args may contain expressions with commas in parens", () => {
    const pp = makePP({ "/a.c": `#define F(x) [x]\nF((1,2,3))` });
    pp.openFile("/a.c");
    expect(texts(collect(pp))).toEqual(["[", "(", "1", ",", "2", ",", "3", ")", "]"]);
  });

  test("no self-recursion", () => {
    const pp = makePP({ "/a.c": `#define F(x) F(x+1)\nF(0)` });
    pp.openFile("/a.c");
    expect(texts(collect(pp))).toEqual(["F", "(", "0", "+", "1", ")"]);
  });
});

describe("preprocessor — #include", () => {
  test("quoted include resolves local", () => {
    const pp = makePP({
      "/src/a.c": `#include "b.h"\nint x;`,
      "/src/b.h": `int y;`,
    });
    pp.openFile("/src/a.c");
    expect(texts(collect(pp))).toEqual(["int", "y", ";", "int", "x", ";"]);
  });

  test("angle-bracket include uses include dirs", () => {
    const pp = makePP(
      {
        "/src/a.c": `#include <b.h>\nint x;`,
        "/usr/include/b.h": `int y;`,
      },
      ["/usr/include"],
    );
    pp.openFile("/src/a.c");
    expect(texts(collect(pp))).toEqual(["int", "y", ";", "int", "x", ";"]);
  });

  test("#pragma once prevents double-inclusion", () => {
    const pp = makePP({
      "/a.c": `#include "h.h"\n#include "h.h"\n`,
      "/h.h": `#pragma once\nint y;`,
    });
    pp.openFile("/a.c");
    expect(texts(collect(pp))).toEqual(["int", "y", ";"]);
  });

  test("missing include errors", () => {
    const pp = makePP({ "/a.c": `#include "missing.h"` });
    pp.openFile("/a.c");
    expect(() => collect(pp)).toThrow(`file "missing.h" not found`);
  });
});

describe("preprocessor — #ifdef / #ifndef / #else / #endif", () => {
  test("#ifdef taken", () => {
    const pp = makePP({ "/a.c": `#define X\n#ifdef X\nA\n#else\nB\n#endif\nC` });
    pp.openFile("/a.c");
    expect(texts(collect(pp))).toEqual(["A", "C"]);
  });

  test("#ifdef not-taken, #else taken", () => {
    const pp = makePP({ "/a.c": `#ifdef X\nA\n#else\nB\n#endif\nC` });
    pp.openFile("/a.c");
    expect(texts(collect(pp))).toEqual(["B", "C"]);
  });

  test("#ifndef inverted", () => {
    const pp = makePP({ "/a.c": `#ifndef X\nA\n#endif` });
    pp.openFile("/a.c");
    expect(texts(collect(pp))).toEqual(["A"]);
  });

  test("nested #ifdef", () => {
    const pp = makePP({
      "/a.c": `#ifdef X\n#ifdef Y\nXY\n#else\nX_noY\n#endif\n#else\nnoX\n#endif`,
    });
    pp.openFile("/a.c");
    expect(texts(collect(pp))).toEqual(["noX"]);
  });

  test("#ifdef inside skipped branch doesn't consume outer #endif", () => {
    const pp = makePP({
      "/a.c": `#ifdef X\n#ifdef Y\nA\n#endif\nB\n#endif\nC`,
    });
    pp.openFile("/a.c");
    expect(texts(collect(pp))).toEqual(["C"]);
  });
});

describe("preprocessor — #if expression evaluator", () => {
  test("literal numeric conditions", () => {
    const pp = makePP({ "/a.c": `#if 1+2*3 == 7\nA\n#endif\n#if 1+2*3 == 8\nB\n#endif\nC` });
    pp.openFile("/a.c");
    expect(texts(collect(pp))).toEqual(["A", "C"]);
  });

  test("defined(X) and defined X", () => {
    const pp = makePP({
      "/a.c": `#define X\n#if defined(X) && !defined(Y)\nA\n#endif\n#if defined Y\nB\n#endif\nC`,
    });
    pp.openFile("/a.c");
    expect(texts(collect(pp))).toEqual(["A", "C"]);
  });

  test("__has_include", () => {
    const pp = makePP(
      {
        "/src/a.c": `#if __has_include(<b.h>)\nYES\n#else\nNO\n#endif`,
        "/inc/b.h": `/* exists */`,
      },
      ["/inc"],
    );
    pp.openFile("/src/a.c");
    expect(texts(collect(pp))).toEqual(["YES"]);
  });

  test("ternary and bitwise", () => {
    const pp = makePP({ "/a.c": `#if (1 ? 0xF : 0) & 0x1\nA\n#endif` });
    pp.openFile("/a.c");
    expect(texts(collect(pp))).toEqual(["A"]);
  });

  test("unresolved identifier evaluates to 0", () => {
    const pp = makePP({ "/a.c": `#if UNDEFINED\nA\n#else\nB\n#endif` });
    pp.openFile("/a.c");
    expect(texts(collect(pp))).toEqual(["B"]);
  });

  test("&& still consumes RHS tokens when LHS is false", () => {
    const pp = makePP({ "/a.c": `#if 0 && (1 + 2)\nA\n#else\nB\n#endif` });
    pp.openFile("/a.c");
    expect(texts(collect(pp))).toEqual(["B"]);
  });

  test("|| still consumes RHS tokens when LHS is true", () => {
    const pp = makePP({ "/a.c": `#if 1 || defined(FOO)\nA\n#endif` });
    pp.openFile("/a.c");
    expect(texts(collect(pp))).toEqual(["A"]);
  });
});

describe("preprocessor — #error", () => {
  test("#error throws", () => {
    const pp = makePP({ "/a.c": `#error bad news` });
    pp.openFile("/a.c");
    expect(() => collect(pp)).toThrow("#error bad news");
  });
});

describe("preprocessor — position metadata", () => {
  test("tokens carry original file name", () => {
    const pp = makePP({
      "/src/a.c": `#include "b.h"\nmain`,
      "/src/b.h": `included`,
    });
    pp.openFile("/src/a.c");
    const toks = collect(pp).filter((t) => t.kind === "ident");
    expect(toks.map((t) => t.text)).toEqual(["included", "main"]);
    expect(toks[0]!.fileName).toBe("/src/b.h");
    expect(toks[1]!.fileName).toBe("/src/a.c");
  });
});
