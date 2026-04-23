import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { wrapRks } from "../../src/formats/rks.ts";

// Byte-exact reproductions against real tape files from the upstream
// c8080 repo — useful when you've got the reference checkout at
// ../c8080, and silently skipped on CI (or any machine without it) so
// the suite stays green.
const EXAMPLES = [
  "/Users/alexander/github/c8080/examples/game2048.specialist.rks",
  "/Users/alexander/github/c8080/examples/game2048.86rk.rk",
  "/Users/alexander/github/c8080/examples/lines.specialist.rks",
];

describe("wrapRks", () => {
  for (const path of EXAMPLES) {
    const name = `reproduces envelope of ${basename(path)}`;
    if (!existsSync(path)) {
      test.skip(name, () => {});
      continue;
    }
    test(name, () => {
      const file = new Uint8Array(readFileSync(path));
      const payload = file.subarray(4, file.length - 2);
      const rebuilt = wrapRks(payload);
      expect(rebuilt).toEqual(file);
    });
  }

  test("empty payload yields empty output", () => {
    expect(wrapRks(new Uint8Array(0))).toEqual(new Uint8Array(0));
  });
});
