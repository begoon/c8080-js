# c8080-js

Intel 8080 C compiler in TypeScript, running on Bun. A port-in-progress of
[c8080](https://github.com/alexey-f-morozov/c8080) (Aleksey Morozov's C++
compiler for i8080 / КР580ВМ80А platforms).

## Status

End-to-end pipeline: **C source → preprocess → parse → codegen → asm →
[asm8080](https://www.npmjs.com/package/asm8080) → binary**. Compiled
programs actually run on an in-process 8080 simulator, which intercepts
CP/M BDOS calls at `0x0005` for I/O.

```bash
bun install
bun test           # 113 tests, including 20 end-to-end (compile + simulate)
bun run typecheck  # tsc --noEmit
bun bin/c8080.ts [-V] [-Ocpm|-Orks] [-I<dir>] [-D<name>] [-o<bin>] file.c
```

### What compiles today

Programs using these features produce correct bytecode:

- **Types**: `char`, `unsigned char`, `int`, `unsigned`, `short`, `long`
  (parsed; codegen treats all integers as 16-bit), pointers, arrays,
  `typedef`
- **Statements**: blocks, `if/else`, `while`, `do…while`, `for`, `break`,
  `continue`, `return`, `goto`, `switch/case/default`, inline `asm { … }`
- **Expressions**: full C precedence ladder, assignment + compound
  (`+=`, `-=`, `*=`, etc.), ternary `?:`, unary `-!~*&++--` (pre and post),
  `[] . ->`, function calls, casts, string + char literals
- **Arithmetic**: `+ - * / % << >> & | ^`. Multiply/divide/shifts go
  through shipped runtime helpers (`__o_mul_u16`, `__o_div_u16`,
  `__o_shl_u16`, `__o_shr_u16`). Element-size scaling is done for
  pointer arithmetic so `int arr[N]; arr[i]` reads the correct slot.
- **I/O**: built-in `putchar` and `puts` that call BDOS function 2;
  user-defined versions win. String literals interned into the binary
  as `DB`-encoded NUL-terminated bytes.
- **Preprocessor** (full): `#include` (both forms), `#define` with
  object-like and function-like macros (variadic `...` supported),
  `#undef`, `#if`/`#ifdef`/`#ifndef`/`#else`/`#endif` with full C
  integer-expression evaluator including `defined(X)` and
  `__has_include(...)`, `#pragma once`, `#error`, CLI `-D`.

### Examples that work

```c
int main(void) { return 42; }
```

```c
int add(int a, int b) { return a + b; }
int main(void) { return add(3, 4); }       // returns 7
```

```c
int main(void) {
  int total = 0, i = 1;
  while (i <= 10) { total = total + i; i = i + 1; }
  return total;                             // returns 55
}
```

```c
char buf[16];
void reverse(char *s, int len) {
  int i = 0, j = len - 1;
  while (i < j) {
    char t; t = s[i]; s[i] = s[j]; s[j] = t;
    i = i + 1; j = j - 1;
  }
}
int main(void) {
  buf[0]='h'; buf[1]='e'; buf[2]='l'; buf[3]='l'; buf[4]='o'; buf[5]=0;
  reverse(buf, 5);
  puts(buf);                                // prints "olleh"
  return 0;
}
```

### What doesn't work yet

- **Struct fields** — parser captures `struct S` as an opaque type name,
  but `.x` / `->x` fall through as placeholder calls; no member layout.
- **Enums** — not parsed.
- **Global initializers** — globals get `DS <size>` with no
  compile-time-populated data (`int x = 5;` allocates 2 bytes of zero).
- **`__stack` mode / recursion** — c8080's default `__global` convention
  uses fixed param addresses, so recursive calls corrupt the frame
  (documented in `manual.md` §5). Iterative patterns work fine.
- **8-bit register path** — even `char` ops go through 16-bit HL; tighter
  8-bit codegen via A is a future optimization.
- **Signed arithmetic edge cases** — comparisons use sign of SBB result,
  which ignores signed-overflow cases at the edges of int16 range.
  Multiply/divide/shift runtime helpers are unsigned.
- **CP/M runtime integration** — the c8080 `include/c8080/internal.c`
  (bss zeroing, stack init) is not wired in. Our programs work under CP/M
  because they never touch bss and CP/M sets up SP for us.
- **`__address(N)` / `__link("file.c")`** attributes — parsed and
  discarded.
- **`#pragma codepage`** — parsed and discarded.

### Project layout

```
src/
  frontend/
    tokenizer.ts      port of ctokenizer.cpp
    preprocessor.ts   #include / #define / #if machinery
    fs.ts             filesystem abstraction (Node + in-memory)
    lex.ts            token-stream wrapper with arbitrary lookahead
    ast.ts            CNode / CType / CVariable discriminated unions
    parser.ts         recursive-descent C parser
    symbols.ts        scoped symbol table (vars, typedefs, struct tags)
  codegen/
    i8080/compile.ts  walks AST → Intel-syntax 8080 assembly
  formats/rks.ts      RK86/Specialist tape envelope (byte-exact match
                      with c8080's output on three reference .rks files)
  util/dump.ts        human-readable AST dump (used by -V)
bin/c8080.ts          CLI: preprocess → parse → (-V dump | codegen →
                      asm8080 → .bin or -Orks wrap)
test/
  frontend/ codegen/ formats/ util/    unit tests
  codegen/sim8080.ts                   minimal 8080 simulator for e2e
  codegen/endtoend.test.ts             20 C programs: compile and run
```

### Build verification

`bun test` preprocesses and parses **37 of 41** real c8080 source files
from the reference compiler's tree (including `game2048.c`, `color_lines`,
`kosoban`, `micro80.c`, `nc.c`). The 4 that don't parse are all
context-dependent (missing arch-specific headers or needing `__CMM`
flag) — not parser bugs.

### Why this exists

A TypeScript rewrite of a C++ compiler for a 45-year-old 8-bit CPU.
The goal is parity with the reference compiler, not a new design. Where
c8080 has quirks (raw-text macro argument substitution, no-recursion in
`__global` mode, no-space-before-paren for function-like macros), we
reproduce them faithfully.

### License

GPLv3 (inherited from c8080).
