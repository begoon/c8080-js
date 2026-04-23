#!/usr/bin/env node
import { parseArgs } from "../src/cli.ts";
import { NodeFileSystem } from "../src/frontend/node-fs.ts";
import { Preprocessor } from "../src/frontend/preprocessor.ts";
import { Lex } from "../src/frontend/lex.ts";
import { Parser } from "../src/frontend/parser.ts";
import { dumpProgram } from "../src/util/dump.ts";
import { compileProgram } from "../src/codegen/i8080/compile.ts";
import { wrapRks } from "../src/formats/rks.ts";
import { dirname, resolve as pathResolve, basename } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { asm, AsmError } from "asm8080";

function usage(): void {
  console.log(`Usage: c8080 [options] file1.c file2.c ...
Options:
  -m         Compile CMM language
  -I<path>   Add include directory
  -Ocpm      Make binary file for CP/M (default)
  -Oi1080    Make binary file for Iskra 1080 Tartu
  -Orks      Make binary file for Specialist / Radio-86RK
  -D<define> Set #define
  -o<file>   Set name for output binary file
  -a<file>   Set name for output assembler file
  -V         Print expression tree after parsing
  -W         Print expression tree after compilation
  --         Last option`);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) { usage(); return 0; }

  try {
    const opts = parseArgs(argv);
    if (opts.sources.length === 0) { usage(); return 0; }

    const selfDir = dirname(fileURLToPath(import.meta.url));
    const bundledInclude = pathResolve(selfDir, "..", "include");
    const includeDirs = [...opts.includeDirs];
    if (existsSync(bundledInclude)) includeDirs.push(bundledInclude);

    // Auto-add include/arch/<arch> for first -DARCH_* define.
    for (const d of opts.defines) {
      const match = /^ARCH_([A-Za-z0-9_]+)(?:=.*)?$/.exec(d);
      if (match && existsSync(bundledInclude)) {
        const archDir = pathResolve(bundledInclude, "arch", match[1]!.toLowerCase());
        if (existsSync(archDir)) { includeDirs.push(archDir); break; }
      }
    }

    const defines = [...opts.defines, "__C8080_COMPILER"];
    if (opts.cmm) defines.push("__CMM");

    const pp = new Preprocessor({ fs: new NodeFileSystem(), includeDirs, defines });
    for (const src of opts.sources) pp.openFile(src);
    const parser = new Parser(new Lex(pp));
    const program = parser.parseProgram();

    // Follow __link("file.c") attributes — parse those files too and merge their
    // functions/globals into the program.
    const seen = new Set<string>(opts.sources.map((s) => pathResolve(s)));
    const allFns = [...program.functions];
    const allGlobals = [...program.globals];
    const allLinks = new Map<string, { rel: string; sourceFile: string }>(parser.functionLinks);
    // Functions already defined (have a body) — don't re-link.
    const defined = new Set(program.functions.filter((f) => f.body !== null).map((f) => f.name));
    // Collect called names from the AST.
    const called = collectCalledNames(program);
    const queue = [...called];
    const considered = new Set<string>();
    while (queue.length > 0) {
      const name = queue.shift()!;
      if (considered.has(name)) continue;
      considered.add(name);
      if (defined.has(name)) continue;
      const link = allLinks.get(name);
      if (!link) continue;
      const resolved = resolveLinked(link.rel, link.sourceFile, includeDirs);
      if (resolved === null || seen.has(resolved)) continue;
      seen.add(resolved);
      try {
        const subPp = new Preprocessor({ fs: new NodeFileSystem(), includeDirs, defines });
        subPp.openFile(resolved);
        const subParser = new Parser(new Lex(subPp));
        const subProgram = subParser.parseProgram();
        for (const f of subProgram.functions) {
          allFns.push(f);
          if (f.body !== null) defined.add(f.name);
        }
        allGlobals.push(...subProgram.globals);
        for (const [n, l] of subParser.functionLinks) if (!allLinks.has(n)) allLinks.set(n, l);
        for (const n of collectCalledNames(subProgram)) queue.push(n);
      } catch (e) {
        console.error(`warning: __link for '${name}' ('${link.rel}') failed to parse: ${(e as Error).message}`);
      }
    }
    const finalProgram = { ...program, functions: allFns, globals: allGlobals };

    if (opts.printTreeBeforeOpt) {
      console.log(dumpProgram(finalProgram));
      return 0;
    }

    const org = opts.outputFormat === "rks" ? 0 : 0x0100;
    const { asm: asmSource, warnings } = compileProgram(finalProgram, { org });
    for (const w of warnings) console.error(`warning: ${w}`);

    const firstSource = opts.sources[0]!;
    const base = basename(firstSource).replace(/\.[^.]+$/, "");
    const asmPath = opts.asmFile ?? `${base}.asm`;
    const binPath = opts.binFile ?? `${base}.bin`;

    writeFileSync(asmPath, asmSource);

    // Assemble in-process via the asm8080 library (replaces shelling out to
    // `bunx asm8080`, so the published package works on plain Node).
    let sections;
    try {
      sections = asm(asmSource);
    } catch (e) {
      if (e instanceof AsmError) {
        console.error(`${asmPath}:${e.line}:${e.column}: error: ${e.message}`);
        return 1;
      }
      throw e;
    }
    if (sections.length === 0) {
      console.error("asm8080 produced no output sections");
      return 1;
    }
    const sorted = [...sections].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i]!.start <= sorted[i - 1]!.end) {
        console.error(`error: sections overlap (${hex4(sorted[i - 1]!.start)}-${hex4(sorted[i - 1]!.end)} and ${hex4(sorted[i]!.start)}-${hex4(sorted[i]!.end)})`);
        return 1;
      }
    }
    // Mirror asm8080's `.bin` layout: zero-fill from 0 up to the highest
    // section end so CP/M .bin files load correctly after being copied to
    // address 0x0100.
    const maxEnd = sorted[sorted.length - 1]!.end;
    const buf = new Uint8Array(maxEnd + 1);
    for (const s of sections) buf.set(s.data, s.start);
    const payload = opts.outputFormat === "rks" ? wrapRks(buf) : buf;
    writeFileSync(binPath, payload);
    console.log("Done");
    return 0;
  } catch (e) {
    console.error((e as Error).message);
    console.error("Compilation terminated due to error");
    return 1;
  }
}

function collectCalledNames(program: { functions: readonly { body: import("../src/frontend/ast.ts").CNode | null }[] }): Set<string> {
  const names = new Set<string>();
  const visit = (n: import("../src/frontend/ast.ts").CNode | null): void => {
    if (!n) return;
    if (n.kind === "call" && n.target.kind === "var") names.add(n.target.name);
    for (const child of childNodes(n)) visit(child);
  };
  for (const f of program.functions) visit(f.body);
  return names;
}

function childNodes(n: import("../src/frontend/ast.ts").CNode): import("../src/frontend/ast.ts").CNode[] {
  switch (n.kind) {
    case "block": return [...n.stmts];
    case "if": return n.else ? [n.cond, n.then, n.else] : [n.cond, n.then];
    case "while": return [n.cond, n.body];
    case "do": return [n.body, n.cond];
    case "for": return [n.init, n.cond, n.step, n.body].filter((x): x is import("../src/frontend/ast.ts").CNode => x !== null);
    case "return": return n.value ? [n.value] : [];
    case "assign": return [n.target, n.value];
    case "unary": return [n.arg];
    case "binary": return [n.lhs, n.rhs];
    case "call": return [n.target, ...n.args];
    case "member": return [n.object];
    case "switch": return [n.expr, n.body];
    case "case": return [n.value];
    case "load": return [n.target];
    case "pushPop": return [...n.regs, n.body];
    default: return [];
  }
}

function resolveLinked(rel: string, sourceFile: string, includeDirs: readonly string[]): string | null {
  // Try relative to the declaring source file's directory first (c8080 semantics).
  const localCandidate = pathResolve(dirname(sourceFile), rel);
  if (existsSync(localCandidate)) return localCandidate;
  for (const dir of includeDirs) {
    const candidate = pathResolve(dir, rel);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function hex4(n: number): string { return n.toString(16).padStart(4, "0").toUpperCase(); }

process.exit(await main());
