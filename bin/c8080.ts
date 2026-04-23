#!/usr/bin/env bun
import { parseArgs } from "../src/cli.ts";

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
    console.error("c8080-js: compilation not yet implemented");
    console.error(`parsed options: ${JSON.stringify(opts)}`);
    return 1;
  } catch (e) {
    console.error((e as Error).message);
    console.error("Compilation terminated due to error");
    return 1;
  }
}

process.exit(await main());
