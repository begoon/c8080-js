// c8080 browser playground — live C → asm pipeline with keystroke-driven
// recompile. Pure client-side: everything runs inside the page.

import { compileProgram } from "../src/codegen/i8080/compile.ts";
import { MemoryFileSystem } from "../src/frontend/fs.ts";
import { Preprocessor } from "../src/frontend/preprocessor.ts";
import { Lex } from "../src/frontend/lex.ts";
import { Parser } from "../src/frontend/parser.ts";
import { asm as assemble, AsmError } from "asm8080";

type Result = {
  asm: string;
  warnings: readonly string[];
  bytes: Uint8Array | null;
  error: string | null;
};

const DEFAULT_SOURCE = `// c8080 playground.
// Edit below — the asm output refreshes on every keystroke.

int main(void) {
  int i;
  for (i = 1; i <= 5; i = i + 1) printf("i=%d, sq=%d\\n", i, i * i);
  return 0;
}
`;

function compile(source: string): Result {
  try {
    const fs = new MemoryFileSystem({ "/a.c": source });
    const pp = new Preprocessor({ fs });
    pp.openFile("/a.c");
    const program = new Parser(new Lex(pp)).parseProgram();
    const { asm: asmSource, warnings } = compileProgram(program, { org: 0x0100 });
    let bytes: Uint8Array | null = null;
    try {
      const sections = assemble(asmSource);
      if (sections.length > 0) {
        const sorted = [...sections].sort((a, b) => a.start - b.start);
        const maxEnd = sorted[sorted.length - 1]!.end;
        const buf = new Uint8Array(maxEnd + 1);
        for (const s of sections) buf.set(s.data, s.start);
        bytes = buf;
      }
    } catch (e) {
      const msg = e instanceof AsmError
        ? `asm8080 ${e.line}:${e.column}: ${e.message}`
        : (e as Error).message;
      return { asm: asmSource, warnings, bytes: null, error: msg };
    }
    return { asm: asmSource, warnings, bytes, error: null };
  } catch (e) {
    return {
      asm: "",
      warnings: [],
      bytes: null,
      error: (e as Error).message,
    };
  }
}

function hex2(n: number): string { return n.toString(16).padStart(2, "0").toUpperCase(); }
function hex4(n: number): string { return n.toString(16).padStart(4, "0").toUpperCase(); }

function formatBytes(bytes: Uint8Array, origin: number): string {
  // Find the first non-zero byte and the last non-zero byte so we can trim
  // leading/trailing zero padding (e.g. the CP/M PSP area before 0x0100)
  // without dropping rows that happen to be mostly zero but contain a NUL
  // terminator or similar meaningful byte in the middle of the data span.
  let firstNonZero = -1;
  let lastNonZero = -1;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0) {
      if (firstNonZero < 0) firstNonZero = i;
      lastNonZero = i;
    }
  }
  if (firstNonZero < 0) return "(all zero)";
  const start = firstNonZero & ~0xf;          // round down to 16-byte row
  const end = Math.min(bytes.length, (lastNonZero & ~0xf) + 16);
  const lines: string[] = [];
  for (let i = start; i < end; i += 16) {
    const row = [...bytes.slice(i, i + 16)].map(hex2).join(" ");
    const ascii = [...bytes.slice(i, i + 16)]
      .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "."))
      .join("");
    lines.push(`${hex4(origin + i)}  ${row.padEnd(47)}  ${ascii}`);
  }
  return lines.join("\n");
}

const STORAGE_KEY = "c8080-playground-source";

function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): (...args: Parameters<T>) => void {
  let handle: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (handle !== null) clearTimeout(handle);
    handle = setTimeout(() => fn(...args), ms);
  };
}

function init(): void {
  const srcEl = document.getElementById("source") as HTMLTextAreaElement;
  const asmEl = document.getElementById("asm") as HTMLPreElement;
  const errEl = document.getElementById("error") as HTMLDivElement;
  const statusEl = document.getElementById("status") as HTMLDivElement;
  const bytesEl = document.getElementById("bytes") as HTMLPreElement;

  const saved = localStorage.getItem(STORAGE_KEY);
  srcEl.value = saved ?? DEFAULT_SOURCE;

  const run = (): void => {
    const t0 = performance.now();
    const result = compile(srcEl.value);
    const t1 = performance.now();
    asmEl.textContent = result.asm || "(no output)";
    if (result.error) {
      errEl.textContent = result.error;
      errEl.hidden = false;
    } else {
      errEl.textContent = "";
      errEl.hidden = true;
    }
    const parts: string[] = [];
    parts.push(`${(t1 - t0).toFixed(1)} ms`);
    if (result.bytes) parts.push(`${result.bytes.length - 0x0100} bytes`);
    if (result.warnings.length > 0) parts.push(`${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}`);
    statusEl.textContent = parts.join(" · ");
    if (result.bytes) {
      bytesEl.textContent = formatBytes(result.bytes, 0);
      bytesEl.hidden = false;
    } else {
      bytesEl.textContent = "";
      bytesEl.hidden = true;
    }
    localStorage.setItem(STORAGE_KEY, srcEl.value);
  };

  const debouncedRun = debounce(run, 150);
  srcEl.addEventListener("input", debouncedRun);
  run();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
