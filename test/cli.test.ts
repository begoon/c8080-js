import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/cli.ts";

describe("parseArgs", () => {
  test("defaults", () => {
    const o = parseArgs(["hello.c"]);
    expect(o.outputFormat).toBe("cpm");
    expect(o.sources).toEqual(["hello.c"]);
    expect(o.cmm).toBe(false);
  });

  test("combined short option values (-Orks, -Ifoo)", () => {
    const o = parseArgs(["-Orks", "-Iinc", "-DARCH_SPECIALIST", "-oout.bin", "a.c"]);
    expect(o.outputFormat).toBe("rks");
    expect(o.includeDirs).toEqual(["inc"]);
    expect(o.defines).toEqual(["ARCH_SPECIALIST"]);
    expect(o.binFile).toBe("out.bin");
    expect(o.sources).toEqual(["a.c"]);
  });

  test("separated option values (-I inc)", () => {
    const o = parseArgs(["-I", "inc", "a.c"]);
    expect(o.includeDirs).toEqual(["inc"]);
  });

  test("cmm flag", () => {
    const o = parseArgs(["-m", "a.c"]);
    expect(o.cmm).toBe(true);
  });

  test("-- ends option parsing", () => {
    const o = parseArgs(["--", "-Orks"]);
    expect(o.outputFormat).toBe("cpm");
    expect(o.sources).toEqual(["-Orks"]);
  });

  test("unknown option throws", () => {
    expect(() => parseArgs(["-Zfoo"])).toThrow("unrecognized command-line option '-Zfoo'");
  });
});
