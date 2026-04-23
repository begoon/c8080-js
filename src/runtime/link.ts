// Demand-links compiler-embedded runtime sources (e.g. the mini printf) into a
// program. Called after __link walking so user-provided definitions always win.

import type { CNode, CProgram } from "../frontend/ast.ts";
import { Lex } from "../frontend/lex.ts";
import { MemoryFileSystem } from "../frontend/fs.ts";
import { Preprocessor } from "../frontend/preprocessor.ts";
import { Parser } from "../frontend/parser.ts";
import { PRINTF_SOURCE } from "./printf.ts";

type EmbeddedSource = { readonly provides: readonly string[]; readonly source: string };

const EMBEDDED_SOURCES: readonly EmbeddedSource[] = [
  { provides: ["printf", "__printf_putint"], source: PRINTF_SOURCE },
];

export function linkBuiltins(program: CProgram): CProgram {
  const defined = new Set(program.functions.filter((f) => f.body !== null).map((f) => f.name));
  const called = collectCalledNames(program);
  const extraFns = [...program.functions];
  const extraGlobals = [...program.globals];
  for (const { provides, source } of EMBEDDED_SOURCES) {
    const needs = provides.some((n) => called.has(n) && !defined.has(n));
    if (!needs) continue;
    const sub = parseEmbedded(source);
    for (const f of sub.functions) {
      if (defined.has(f.name)) continue; // user override wins
      extraFns.push(f);
      if (f.body !== null) defined.add(f.name);
      // Calls inside the runtime may pull in more helpers (none right now, but
      // keep the frontier expanding).
      for (const n of collectCalledNamesFromFn(f)) called.add(n);
    }
    for (const g of sub.globals) extraGlobals.push(g);
  }
  return { ...program, functions: extraFns, globals: extraGlobals };
}

function parseEmbedded(source: string): CProgram {
  const fs = new MemoryFileSystem({ "/__builtin.c": source });
  const pp = new Preprocessor({ fs });
  pp.openFile("/__builtin.c");
  return new Parser(new Lex(pp)).parseProgram();
}

function collectCalledNames(program: CProgram): Set<string> {
  const names = new Set<string>();
  for (const f of program.functions) for (const n of collectCalledNamesFromFn(f)) names.add(n);
  return names;
}

function collectCalledNamesFromFn(f: CProgram["functions"][number]): Set<string> {
  const names = new Set<string>();
  const visit = (n: CNode | null): void => {
    if (!n) return;
    if (n.kind === "call" && n.target.kind === "var") names.add(n.target.name);
    for (const c of children(n)) visit(c);
  };
  visit(f.body);
  return names;
}

function children(n: CNode): CNode[] {
  switch (n.kind) {
    case "block": return [...n.stmts];
    case "if": return n.else ? [n.cond, n.then, n.else] : [n.cond, n.then];
    case "while": return [n.cond, n.body];
    case "do": return [n.body, n.cond];
    case "for": return [n.init, n.cond, n.step, n.body].filter((x): x is CNode => x !== null);
    case "return": return n.value ? [n.value] : [];
    case "assign": return [n.target, n.value];
    case "unary": return [n.arg];
    case "binary": return [n.lhs, n.rhs];
    case "call": return [n.target, ...n.args];
    case "member": return [n.object];
    case "switch": return [n.expr, n.body];
    case "case": return [n.value];
    case "load": return [n.target];
    case "pushPop": return [...n.regs, n.body];
    default: return [];
  }
}
