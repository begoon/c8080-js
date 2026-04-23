// c8080 browser playground — live C → asm pipeline with keystroke-driven
// recompile. Pure client-side: everything runs inside the page.

import { compileProgram } from "../src/codegen/i8080/compile.ts";
import { MemoryFileSystem } from "../src/frontend/fs.ts";
import { Preprocessor } from "../src/frontend/preprocessor.ts";
import { Lex } from "../src/frontend/lex.ts";
import { Parser } from "../src/frontend/parser.ts";
import { asm as assemble, AsmError, wrapRk86File } from "asm8080";
import { wrapRks } from "../src/formats/rks.ts";

type Result = {
  asm: string;
  warnings: readonly string[];
  bytes: Uint8Array | null;
  rkStart: number;
  rkEnd: number;
  error: string | null;
};

const DEFAULT_SOURCE = `// c8080 playground — edit below, recompiles on every keystroke.
// "Run" assembles an .rk tape file and boots it on the rk86.ru emulator.
// Radio-86RK monitor entry points: 0xF818 prints ASCIIZ from HL,
// 0xF86C returns to the monitor prompt.

char *msg = "Aloha!";

void print(char *s) {
    asm { CALL  0F818h }
}

int main(void) {
    print(msg);
    asm { JMP   0F86Ch }
    return 0;
}
`;

// The playground uses ORG 0 — the same origin the RK tape-wrappers expect.
// The `rkStart`/`rkEnd` range tracks the actual code span so we can feed
// it to wrapRk86File for the Run button.
const PLAYGROUND_ORG = 0;

function compile(source: string): Result {
  try {
    const fs = new MemoryFileSystem({ "/a.c": source });
    const pp = new Preprocessor({ fs });
    pp.openFile("/a.c");
    const program = new Parser(new Lex(pp)).parseProgram();
    const { asm: asmSource, warnings } = compileProgram(program, { org: PLAYGROUND_ORG });
    let bytes: Uint8Array | null = null;
    let rkStart = 0;
    let rkEnd = 0;
    try {
      const sections = assemble(asmSource);
      if (sections.length > 0) {
        const sorted = [...sections].sort((a, b) => a.start - b.start);
        rkStart = sorted[0]!.start;
        rkEnd = sorted[sorted.length - 1]!.end;
        const buf = new Uint8Array(rkEnd - rkStart + 1);
        for (const s of sections) buf.set(s.data, s.start - rkStart);
        bytes = buf;
      }
    } catch (e) {
      const msg = e instanceof AsmError
        ? `asm8080 ${e.line}:${e.column}: ${e.message}`
        : (e as Error).message;
      return { asm: asmSource, warnings, bytes: null, rkStart: 0, rkEnd: 0, error: msg };
    }
    return { asm: asmSource, warnings, bytes, rkStart, rkEnd, error: null };
  } catch (e) {
    return {
      asm: "",
      warnings: [],
      bytes: null,
      rkStart: 0,
      rkEnd: 0,
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

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

const EMULATOR_URL = "https://rk86.ru/beta/index.html";

function init(): void {
  const srcEl = document.getElementById("source") as HTMLTextAreaElement;
  const asmEl = document.getElementById("asm") as HTMLPreElement;
  const errEl = document.getElementById("error") as HTMLDivElement;
  const statusEl = document.getElementById("status") as HTMLDivElement;
  const bytesEl = document.getElementById("bytes") as HTMLPreElement;
  const runBtn = document.getElementById("run") as HTMLButtonElement;
  const downloadBtn = document.getElementById("download") as HTMLButtonElement;
  const downloadFmt = document.getElementById("download-format") as HTMLSelectElement;

  let latest: Result | null = null;

  const triggerDownload = (filename: string, blob: Blob): void => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  downloadBtn.addEventListener("click", () => {
    const fmt = downloadFmt.value;
    const name = "c8080-playground";
    if (fmt === "c") {
      triggerDownload(`${name}.c`, new Blob([srcEl.value], { type: "text/plain" }));
      return;
    }
    if (!latest) return;
    if (fmt === "asm") {
      triggerDownload(`${name}.asm`, new Blob([latest.asm], { type: "text/plain" }));
      return;
    }
    if (!latest.bytes || latest.error) return;
    const { bytes, rkStart, rkEnd } = latest;
    let out: Uint8Array;
    switch (fmt) {
      case "bin": out = bytes; break;
      case "rks": out = wrapRks(bytes); break;
      case "rk":
      case "rkr":
      case "pki":
      case "gam": out = wrapRk86File(bytes, rkStart, rkEnd, fmt); break;
      default: return;
    }
    triggerDownload(`${name}.${fmt}`, new Blob([out as BlobPart], { type: "application/octet-stream" }));
  });

  const saved = localStorage.getItem(STORAGE_KEY);
  srcEl.value = saved ?? DEFAULT_SOURCE;

  runBtn.addEventListener("click", () => {
    if (!latest || !latest.bytes || latest.error) return;
    const rk = wrapRk86File(latest.bytes, latest.rkStart, latest.rkEnd, "rk");
    const dataUrl = `data:;name=c8080-playground.rk;base64,${toBase64(rk)}`;
    const url = new URL(EMULATOR_URL);
    url.searchParams.set("run", dataUrl);
    window.open(url.toString(), "_blank", "noopener");
  });

  const run = (): void => {
    const t0 = performance.now();
    const result = compile(srcEl.value);
    const t1 = performance.now();
    latest = result;
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
    if (result.bytes) parts.push(`${result.bytes.length} bytes @ ${result.rkStart.toString(16).toUpperCase()}h–${result.rkEnd.toString(16).toUpperCase()}h`);
    if (result.warnings.length > 0) parts.push(`${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}`);
    statusEl.textContent = parts.join(" · ");
    if (result.bytes) {
      bytesEl.textContent = formatBytes(result.bytes, result.rkStart);
      bytesEl.hidden = false;
    } else {
      bytesEl.textContent = "";
      bytesEl.hidden = true;
    }
    runBtn.disabled = !result.bytes || result.error !== null;
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
