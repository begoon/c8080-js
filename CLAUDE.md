# Working notes for agents on c8080-js

TypeScript port of Aleksey Morozov's c8080 compiler (C → Intel 8080).
`MANUAL.md` is upstream's Russian reference, vendored verbatim — treat it
as the authoritative spec for language semantics, the `__global` ABI,
CMM, and the tape formats (§5 / §11 / §14 are the most-cited sections).

## Layout

```
bin/c8080.ts              CLI entry (shebang #!/usr/bin/env node)
src/
  cli.ts                  arg parsing, OutputFormat, formatExtension
  frontend/
    tokenizer.ts          character-level tokenizer
    preprocessor.ts       #include, #define, #if (c8080-faithful macro
                          semantics: raw-text substitution, no pre-
                          expansion of args — preserve)
    lex.ts                token stream with lookahead
    parser.ts             recursive-descent C parser, __link capture,
                          tracks variadic on CFunction
    symbols.ts            scoped symbol table
    ast.ts                CNode / CType / CVariable / CFunction
    fs.ts                 FileSystem interface + MemoryFileSystem
    node-fs.ts            NodeFileSystem (separate so browser bundle
                          doesn't pull node:fs — do NOT merge back)
  codegen/i8080/compile.ts   AST → Intel-syntax 8080 asm (single file)
  runtime/
    printf.ts             embedded mini printf/sprintf C source string
    link.ts               auto-injects printf source when printf is
                          called but not user-defined; called by
                          compileProgram before codegen
  formats/
    rks.ts                custom Specialist tape envelope
    wrap.ts               dispatches to wrapRks / asm8080's wrapRk86File
docs/                     browser playground (index.html, style.css,
                          playground.ts → playground.js). conf.js holds
                          an optional `window.c8080EmulatorUrl` override
                          for same-origin emulators.
test/                     bun:test e2e (compile + asm8080 + sim) + unit
```

## How to run things

```
just test          # bun test + tsc --noEmit — CI runs exactly this
just build         # bun build → dist/c8080.js (published binary)
just build-playground
just serve-playground  # http://localhost:8733
just publish [patch|minor|major]   # bumps + npm publish + tag push
```

The CLI is published to npm as `c8080` and works on plain Node (no Bun
required) — only dist/c8080.js ships. Don't reintroduce any
`import { $ } from "bun"` or `bunx` subprocess calls in runtime code;
use the `asm8080` JS API (`asm()`, `AsmError`, `wrapRk86File`).

## ABI facts you need to know

- **`__global` (default).** Every function gets fixed static slots:
  `__s_<func>`, `__a_N_<func>`, `__l_N_<func>`. Caller writes args
  `0..N-2` via `SHLD __a_K_callee`, puts the last in `HL`, then `CALL`.
  Callee prologue `SHLD`s `HL` into the last-param slot. Small and fast
  but cannot recurse (slots are static).
- **`__stack`.** Recursion-capable. Callee body is unchanged from
  `__global` — recursion is enforced at the caller: `LHLD+PUSH` every
  `__a_*` and `__l_*` slot, fill new args, `CALL`, `XCHG` to stash the
  return value, `POP`/`SHLD` slots back in LIFO order, `XCHG` return
  into `HL`. Word-sized params/locals only; larger emits a warning and
  skips the call.
- **Variadic (`...`).** Caller stashes extras into a global
  `__va_args[]` word array before CALL; declared params still follow
  the `__global` convention. Mini printf / sprintf use this.

## Divergences from upstream c8080

Record any new divergence here so the reason survives refactors.

- **Tokenizer `...` operator (src/frontend/tokenizer.ts).** Upstream's
  `ctokenizer.cpp:202` uses `||` where it should use `&&`, making
  `o.i.a` tokenise as `o .i. a` (real c8080 fails with "unexpected
  '.i.'"). We diverge with `&&` so nested struct member access parses.

## Conventions

- **No `Co-Authored-By:` trailers** in commit messages. Ever.
- **Tests are the contract.** Every codegen change lands with an e2e
  test that assembles (via asm8080) and runs on `test/codegen/sim8080.ts`.
  If the codegen emits a new opcode, teach sim8080 about it in the same
  commit.
- **Indent instructions 4 spaces, labels column 0** in emitted asm.
  `formatOperands` adds `, ` after every comma. Inline-asm blocks are
  re-indented to 4 spaces except for bareword labels.
- **asm8080 quirks.** Intel hex literals look like `0F818h` (digit-
  prefixed). The parseAsm tokenizer has special handling to keep
  adjacent tokens un-split so that form survives.
- **Commit trailers: none.** Just the body.

## Known gaps (see project memory for priority order)

- 8-bit register-direct codegen (perf; correctness already fine)
- Variadic > 8 args (fixed `__va_args[8]`)
- Struct pass-by-value / return-by-value in function signatures
- `__stack` with byte/struct/array locals (warns + skips today)
- `__init` / bss zeroing from `include/c8080/internal.c` not wired in
- Signed-arithmetic overflow edges
