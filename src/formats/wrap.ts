// Format-specific wrappers around a raw assembled payload.
//
// - bin                 → raw bytes, no header.
// - cpm, iskra1080      → raw bytes, no header (CLI may use a different
//                         extension but the layout is the same — code at
//                         ORG 0x0100, zero-filled from 0).
// - rks                 → custom Specialist tape envelope
//                         (little-endian start/end + payload + 16-bit
//                         checksum, no E6 trailer).
// - rk, rkr, pki, gam   → Radio-86RK tape envelopes via asm8080's
//                         wrapRk86File. pki/gam prepend an 0xE6 sync byte.

import { wrapRk86File } from "asm8080";
import { wrapRks } from "./rks.ts";
import type { OutputFormat } from "../cli.ts";

// `buf` is the byte span from `start` (inclusive) to `end` (inclusive) — the
// caller is responsible for slicing off any leading CP/M zero-fill. For the
// CP/M / Iskra / plain-bin formats it may instead contain the whole
// zero-filled image starting at address 0; those just pass through.
export function wrapForFormat(
  buf: Uint8Array,
  start: number,
  end: number,
  format: OutputFormat,
): Uint8Array {
  switch (format) {
    case "cpm":
    case "iskra1080":
    case "bin":
      return buf;
    case "rks":
      return wrapRks(buf);
    case "rk":
    case "rkr":
    case "pki":
    case "gam":
      return wrapRk86File(buf, start, end, format);
  }
}
