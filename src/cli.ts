export type OutputFormat = "cpm" | "iskra1080" | "rks";

export type Options = {
  outputFormat: OutputFormat;
  binFile: string | null;
  asmFile: string | null;
  printTreeBeforeOpt: boolean;
  printTreeAfterOpt: boolean;
  cmm: boolean;
  includeDirs: string[];
  defines: string[];
  sources: string[];
};

export function parseArgs(argv: readonly string[]): Options {
  const o: Options = {
    outputFormat: "cpm",
    binFile: null,
    asmFile: null,
    printTreeBeforeOpt: false,
    printTreeAfterOpt: false,
    cmm: false,
    includeDirs: [],
    defines: [],
    sources: [],
  };

  let disableOptions = false;
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i]!;
    if (!disableOptions && s.startsWith("-")) {
      if (s.length === 2) {
        switch (s[1]) {
          case "V": o.printTreeBeforeOpt = true; continue;
          case "W": o.printTreeAfterOpt = true; continue;
          case "-": disableOptions = true; continue;
          case "m": o.cmm = true; continue;
        }
      }
      let value = s.slice(2);
      if (value === "") {
        if (i + 1 >= argv.length) throw new Error(`missing value after '${s}'`);
        i++;
        value = argv[i]!;
      }
      switch (s[1]) {
        case "I": o.includeDirs.push(value); continue;
        case "O": {
          const fmt = parseOutputFormat(value);
          if (fmt === null) throw new Error(`unrecognized output format '${value}'`);
          o.outputFormat = fmt;
          continue;
        }
        case "D": o.defines.push(value); continue;
        case "o": o.binFile = value; continue;
        case "a": o.asmFile = value; continue;
      }
      throw new Error(`unrecognized command-line option '${s}'`);
    }
    o.sources.push(s);
  }
  return o;
}

function parseOutputFormat(s: string): OutputFormat | null {
  const k = s.toLowerCase();
  if (k === "cpm") return "cpm";
  if (k === "i1080" || k === "iskra1080") return "iskra1080";
  if (k === "rks") return "rks";
  return null;
}
