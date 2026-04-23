#!/usr/bin/env bun
import { parseArgs } from "../src/cli.ts";
import { NodeFileSystem } from "../src/frontend/fs.ts";
import { Preprocessor } from "../src/frontend/preprocessor.ts";
import { Lex } from "../src/frontend/lex.ts";
import { Parser } from "../src/frontend/parser.ts";
import { dumpProgram } from "../src/util/dump.ts";
import { dirname, resolve as pathResolve } from "node:path";
import { existsSync } from "node:fs";

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

    const selfDir = dirname(pathResolve(process.argv[1] ?? ""));
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
    const program = new Parser(new Lex(pp)).parseProgram();

    if (opts.printTreeBeforeOpt) {
      console.log(dumpProgram(program));
    } else {
      console.error("c8080-js: parsing complete — codegen not yet implemented");
      console.error(`  ${program.functions.length} functions, ${program.globals.length} globals`);
      return 1;
    }
    return 0;
  } catch (e) {
    console.error((e as Error).message);
    console.error("Compilation terminated due to error");
    return 1;
  }
}

process.exit(await main());
