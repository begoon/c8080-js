import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { wrapRks } from "../../src/formats/rks.ts";

const EXAMPLES = [
  "/Users/alexander/github/c8080/examples/game2048.specialist.rks",
  "/Users/alexander/github/c8080/examples/game2048.86rk.rk",
  "/Users/alexander/github/c8080/examples/lines.specialist.rks",
];

describe("wrapRks", () => {
  for (const path of EXAMPLES) {
    test(`reproduces envelope of ${path}`, () => {
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
