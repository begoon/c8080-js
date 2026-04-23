import { describe, expect, test } from "bun:test";
import { MemoryFileSystem } from "../../src/frontend/fs.ts";
import { Preprocessor } from "../../src/frontend/preprocessor.ts";
import { Lex } from "../../src/frontend/lex.ts";
import { Parser } from "../../src/frontend/parser.ts";
import { dumpProgram } from "../../src/util/dump.ts";

function dump(src: string): string {
  const pp = new Preprocessor({ fs: new MemoryFileSystem({ "/a.c": src }) });
  pp.openFile("/a.c");
  const p = new Parser(new Lex(pp)).parseProgram();
  return dumpProgram(p);
}

describe("dump", () => {
  test("empty main", () => {
    expect(dump(`int main() {}`)).toBe(
      "func main(): int [global]\n" +
      "  block {}"
    );
  });

  test("return with binary expression", () => {
    expect(dump(`int f() { return 1 + 2; }`)).toBe(
      "func f(): int [global]\n" +
      "  block\n" +
      "    return\n" +
      "      binary add\n" +
      "        const int = 1\n" +
      "        const int = 2"
    );
  });

  test("if / else", () => {
    const out = dump(`int f() { if (1) return 1; else return 0; }`);
    expect(out).toContain("if");
    expect(out).toContain("then:");
    expect(out).toContain("else:");
  });

  test("global variable", () => {
    const out = dump(`int x;`);
    expect(out).toBe("global x: int [global]");
  });

  test("pointer global", () => {
    const out = dump(`char *s;`);
    expect(out).toBe("global s: char* [global]");
  });
});
