import { dirname, join } from "node:path";

export interface FileSystem {
  readText(path: string): string | null;
  exists(path: string): boolean;
  resolve(...parts: string[]): string;
  dirname(path: string): string;
}

export class MemoryFileSystem implements FileSystem {
  private readonly files: Map<string, string>;

  constructor(files: Record<string, string> = {}) {
    this.files = new Map(Object.entries(files));
  }

  set(path: string, text: string): void {
    this.files.set(this.normalize(path), text);
  }

  readText(path: string): string | null {
    return this.files.get(this.normalize(path)) ?? null;
  }
  exists(path: string): boolean {
    return this.files.has(this.normalize(path));
  }
  resolve(...parts: string[]): string {
    if (parts.length === 0) return "";
    const joined = parts.reduce((acc, p) => (p.startsWith("/") ? p : acc ? join(acc, p) : p), "");
    return this.normalize(joined);
  }
  dirname(path: string): string {
    return dirname(this.normalize(path));
  }

  private normalize(p: string): string {
    return p.replace(/\/+/g, "/");
  }
}

export function findIncludeFile(
  fs: FileSystem,
  name: string,
  localDir: string | null,
  globalDirs: readonly string[],
): string | null {
  if (localDir !== null) {
    const candidate = fs.resolve(localDir, name);
    if (fs.exists(candidate)) return candidate;
  }
  for (const dir of globalDirs) {
    const candidate = fs.resolve(dir, name);
    if (fs.exists(candidate)) return candidate;
  }
  return null;
}
