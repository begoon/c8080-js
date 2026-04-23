# c8080-js

Intel 8080 C compiler in TypeScript, running on Bun. A port-in-progress of
[c8080](https://github.com/alexey-f-morozov/c8080) (Aleksey Morozov's C++
compiler for i8080 / КР580ВМ80А platforms).

## Status

End-to-end pipeline: **C source → preprocess → parse → demand-link
(`__link`) → codegen → asm → [asm8080](https://www.npmjs.com/package/asm8080)
→ binary**. Compiled programs actually run on an in-process 8080 simulator
that intercepts CP/M BDOS calls at `0x0005` for I/O.

```bash
bun install
bun test           # 131 unit + 37 end-to-end tests (compile + simulate)
bun run typecheck  # tsc --noEmit
bun bin/c8080.ts [-V] [-Ocpm|-Orks] [-I<dir>] [-D<name>] [-o<bin>] file.c
```

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
| Structs | named fields with byte-offset layout; `.` and `->` member read/write for both byte and word fields |
| I/O | built-in `putchar` / `puts` via BDOS; user-defined versions win. String literals interned into the binary |
| Preprocessor (full) | `#include` (both forms), `#define` (object- and function-like macros, variadic `...`), `#undef`, `#if`/`#ifdef`/`#ifndef`/`#else`/`#endif` with C integer-expression evaluator + `defined(X)` + `__has_include(...)`, `#pragma once`, `#error`, CLI `-D` |
| `__link("file.c")` | demand-linked: only files whose functions are reachable from the call graph are parsed. Parse failures of unreachable links are non-fatal |
| Global initializers | scalars, strings (as DB), array list-initializers (as DW with padding) |
| Runtime helpers | `__o_mul_u16`, `__o_div_u16`, `__o_shl_u16`, `__o_shr_u16`, `putchar`, `puts` — emitted only when referenced |

### End-to-end tests (all run on the simulator)

```
return 42, add(3,4)=7, sum 1..10 via while=55, sum 1..5 via for=15,
abs(-17)=17, mul(7,13)=91, 12*12=144, 3+4*5=23, 100/7=14, 100%7=2,
1<<10=1024, print "123" via /,%, putchar 'A', puts "hello", loop '***',
strlen_("hello!")=6, byte array r/w, int array[5] r/w, string reversal
"hello"→"olleh", char array init with string literal, int array list init,
enum constants RED+GREEN+BLUE=3, explicit enum values, enum as param,
struct Point.x+.y, struct Box*->w*->h, struct with mixed field sizes,
++i + ++i, i++ post-inc, while (--i >= 0), *s++ string walk,
switch dispatches correct case, switch default,
iterative fib(10)=55, global scalar init, int[] init, char[] init,
single char init, lookup table digits[7]
```

### Known gaps

- **`__stack` mode / recursion** — c8080's default `__global` convention
  uses fixed param addresses, so recursive calls corrupt the frame
  (documented in `manual.md` §5). Iterative patterns work fine.
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
- **Member access on arbitrary lvalues** — currently handles `var.x`,
  `var->x`, and `(*ptr).x`; more complex expressions (e.g. `a[i].x`)
  fall through as a warning.
- **Struct value copy / pass-by-value** — assignment between struct
  values not supported; pass by pointer.
- **Ternary in expression position** — parsed as an `if` AST node; the
  codegen path for that as an expression is incomplete.
- **Short-circuit `&&` / `||` codegen** — currently emits a simplified
  (non-short-circuiting) implementation.

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
