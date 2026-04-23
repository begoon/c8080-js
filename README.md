# c8080

> **Credits.** The original c8080 compiler — its design, its C-dialect
> extensions (`__global`, `__stack`, `__link`, `__address`, the
> `__a_N_<func>` calling convention), the CMM sublanguage, the RK86
> tape formats, and the vendored Russian-language
> [`MANUAL.md`](MANUAL.md) — are © Алексей Фёдорович Морозов
> (Aleksey F. Morozov), distributed under **GPL-3.0** (compiler) and
> **Apache-2.0** (standard library). Upstream:
> <https://github.com/alexey-f-morozov/c8080>.
>
> This repository is an independent TypeScript port of that compiler.
> It reproduces the language and ABI; all behaviour-defining decisions
> come from the upstream design. The port inherits **GPL-3.0**.

Intel 8080 C compiler in TypeScript. Port of
[c8080](https://github.com/alexey-f-morozov/c8080) (Aleksey Morozov's C++
compiler for i8080 / КР580ВМ80А platforms). Runs on Node 18+ and Bun.

Upstream reference manual (Russian) is checked in as
[`MANUAL.md`](MANUAL.md) — §5 covers the `__global` / `__stack`
convention, §11 the output-file formats (`rks`, `rk`, `rkr`, `pki`,
`gam`), §14 the RK86 tape layout our wrappers produce.

## Install

```bash
npm install -g c8080          # exposes `c8080`
# or one-shot without install:
npx c8080 file.c
```

## Use

```bash
c8080 [-V] [-Ocpm|-Orks] [-I<dir>] [-D<name>] [-o<bin>] file.c
```

`-Ocpm` (default) emits a `.bin` loadable at CP/M TPA (`ORG 0x0100`).
`-Orks` emits a Radio-86RK / Specialist tape envelope.

## Develop

```bash
bun install
bun test           # 164 tests (end-to-end compile + simulate)
bun run typecheck  # tsc --noEmit
bun run build      # bundle → dist/c8080.js (for npm publish)
bun bin/c8080.ts file.c   # run from source
```

## Status

End-to-end pipeline: **C source → preprocess → parse → demand-link
(`__link`) → codegen → asm → [asm8080](https://www.npmjs.com/package/asm8080)
→ binary**. Compiled programs actually run on an in-process 8080 simulator
that intercepts CP/M BDOS calls at `0x0005` for I/O.

### Real-c8080-stdlib demo

```c
#include <stdio.h>
int main(void) { puts("Hello from real c8080 stdlib!"); return 0; }
```

```bash
$ bun bin/c8080.ts -I/path/to/c8080/include demo.c
Done
```

The compiler follows `__link("stdio_h/puts.c")` from `stdio.h`, parses it,
and merges its `puts` definition into the program. Demand-linking means
`printf` etc. are only pulled in if actually called.

### What compiles today

| Feature | Notes |
|---|---|
| Types | char, short, int, long, long long, signed/unsigned, pointers, arrays, struct, enum, typedef |
| Statements | blocks, if/else, while, do-while, for, break, continue, return, goto, switch/case/default, `asm { … }` with preserved line structure |
| Expressions | full C precedence ladder, assignment + compound (`+=` etc.), ternary, unary `-!~*&++--` (pre+post), `[] . ->`, casts, sizeof, comma operator, string + char literals |
| Arithmetic | `+ - * / % << >> & \| ^` (mul/div/shifts via shipped runtime helpers; pointer arithmetic scales by element size) |
| Comparisons | signed 16-bit `== != < <= > >=` |
| Control flow | conditional jumps with fresh-labels; switch is a linear compare-and-branch dispatcher |
| Structs | named fields with byte-offset layout, nested structs, `.` and `->` member read/write for byte/word/array/struct fields (array/struct fields decay to their address) |
| Struct initializers | per-field list initializers including char[] inside struct (`{ { "ab", 10 }, ... }`); zero-fills missing tail fields |
| I/O | built-in `putchar` / `puts` via BDOS; user-defined versions win. String literals interned into the binary. Mini `printf` / `sprintf` (%d, %s, %c, %%) auto-linked when called; they share an output-routing layer so either can be called without the other |
| Preprocessor (full) | `#include` (both forms), `#define` (object- and function-like macros, variadic `...`), `#undef`, `#if`/`#ifdef`/`#ifndef`/`#else`/`#endif` with C integer-expression evaluator + `defined(X)` + `__has_include(...)`, `#pragma once`, `#error`, CLI `-D` |
| `__link("file.c")` | demand-linked: only files whose functions are reachable from the call graph are parsed. Parse failures of unreachable links are non-fatal |
| `__stack` | recursion-enabled calling convention: the caller saves the callee's `__a_*` / `__l_*` slots on the CPU stack around the `CALL`, fills the new args, calls, then restores. Works for mutual recursion too. Word-sized params and locals only for now |
| Variadic (`...`) | callsite stashes extras into a `__va_args[]` buffer; used by the mini printf. Declared-param args still follow c8080's `__a_N_<func>` convention |
| Global initializers | scalars, strings (`char[]` → DB, `char*` → DW to interned copy), array list-initializers (as DW with padding) |
| String escapes | `\n \r \t \0 \\ \' \" \a \b \f \v \xNN \nnn` (octal) in both char and string literals |
| Runtime helpers | `__o_mul_u16`, `__o_div_u16`, `__o_shl_u16`, `__o_shr_u16`, `putchar`, `puts` — emitted only when referenced |

### End-to-end tests

Each case in [`test/codegen/endtoend.test.ts`](test/codegen/endtoend.test.ts) compiles a C snippet, assembles it with asm8080, and runs it on the in-process 8080 simulator — authoritative list of what works today.

### Known gaps

- **8-bit register path** — even `char` ops go through 16-bit HL where
  a tighter A-register path would save instructions.
- **Signed arithmetic edge cases** — comparisons use sign of SBB result,
  which ignores signed-overflow cases at the edges of int16 range.
  Multiply/divide/shift runtime helpers are unsigned.
- **CP/M runtime integration** — `__init`/bss zeroing from c8080's
  `include/c8080/internal.c` is not wired in. Our programs work because
  CP/M sets up SP and we don't rely on bss being zero.
- **c8080 stdlib with inline sjasmplus asm** — most of the
  `include/string_h/*.c` files are hand-written sjasmplus assembly inside
  `asm { }` blocks. sjasmplus and asm8080 disagree on syntax (e.g.
  `label = value` vs `label: EQU value`), so those don't assemble. Pure
  C stdlib sources (`puts.c`, etc.) work fine.
- **Struct pass-by-value / return-by-value** — neither argument passing
  nor returning structs by value is supported; pass pointers. Plain
  struct assignment `a = b` (incl. `g = local`, `s = *p`) does copy.

### Project layout

```
src/
  frontend/
    tokenizer.ts      port of ctokenizer.cpp
    preprocessor.ts   #include / #define / #if
    fs.ts             Node + in-memory FS
    lex.ts            token-stream with arbitrary lookahead
    ast.ts            CNode / CType / CVariable union
    parser.ts         recursive-descent C parser + __link capture
    symbols.ts        scoped symbol table (vars, typedefs, struct tags, enums)
  codegen/
    i8080/compile.ts  AST → Intel-syntax 8080 assembly
  formats/rks.ts      RK86/Specialist tape envelope
  util/dump.ts        human-readable AST dump (used by -V)
bin/c8080.ts          CLI: preprocess + parse + __link walk + codegen + asm8080
test/
  codegen/sim8080.ts  minimal 8080 simulator + BDOS hooks
  codegen/endtoend.test.ts   37 C programs: compile + run + assert output
```

### Build verification

The preprocessor handles 37 of 41 real c8080 sources (the 4 failures are
all context-dependent — missing arch-specific headers or needing `__CMM`
flag — not parser bugs). The parser reaches all of these too.

### License

GPLv3 (inherited from c8080).
