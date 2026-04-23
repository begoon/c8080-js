// Node-backed FileSystem. Kept in its own module so browser bundles of the
// compiler never pull `node:fs` into the import graph.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import type { FileSystem } from "./fs.ts";

export class NodeFileSystem implements FileSystem {
  readText(path: string): string | null {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  }
  exists(path: string): boolean {
    return existsSync(path);
  }
  resolve(...parts: string[]): string {
    return pathResolve(...parts);
  }
  dirname(path: string): string {
    return dirname(path);
  }
}
