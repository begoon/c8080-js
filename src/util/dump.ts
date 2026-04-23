import type { CFunction, CNode, CProgram, CType, CVariable } from "../frontend/ast.ts";

export function dumpProgram(p: CProgram): string {
  const lines: string[] = [];
  if (p.cmm) lines.push("(cmm)");
  for (const g of p.globals) {
    lines.push(`global ${g.name}: ${formatType(g.type)} [${g.storage}]`);
  }
  for (const f of p.functions) lines.push(...dumpFunction(f));
  return lines.join("\n");
}

function dumpFunction(f: CFunction): string[] {
  const sig = `func ${f.name}(${f.params.map(formatParam).join(", ")}): ${formatType(returnType(f.type))} [${f.storage}]`;
  const lines: string[] = [sig];
  if (f.body === null) {
    lines.push("  (prototype)");
    return lines;
  }
  lines.push(...dumpNode(f.body, "  "));
  return lines;
}

function returnType(t: CType): CType {
  return t.kind === "function" ? t.ret : t;
}

function formatParam(p: CVariable): string {
  return `${p.name || "_"}: ${formatType(p.type)}`;
}

export function formatType(t: CType): string {
  switch (t.kind) {
    case "base": return t.base;
    case "pointer": return `${formatType(t.to)}*`;
    case "array": return `${formatType(t.of)}[${t.length ?? ""}]`;
    case "struct": return `struct ${t.name}`;
    case "function": return `fn(${t.params.map(formatType).join(",")}) → ${formatType(t.ret)}`;
  }
}

export function dumpNode(n: CNode, indent: string): string[] {
  const lines: string[] = [];
  const emit = (s: string): number => lines.push(`${indent}${s}`);
  const child = (c: CNode): void => { lines.push(...dumpNode(c, indent + "  ")); };

  switch (n.kind) {
    case "const":
      emit(`const ${formatType(n.type)} = ${typeof n.value === "bigint" ? n.value.toString() : JSON.stringify(n.value)}`);
      break;
    case "var":
      emit(`var ${n.name}${n.resolved ? ` [${n.resolved.storage}:${formatType(n.resolved.type)}]` : " [unresolved]"}`);
      break;
    case "load":
      emit("load");
      child(n.target);
      break;
    case "assign":
      emit("assign");
      child(n.target);
      child(n.value);
      break;
    case "unary":
      emit(`unary ${n.op}`);
      child(n.arg);
      break;
    case "binary":
      emit(`binary ${n.op}`);
      child(n.lhs);
      child(n.rhs);
      break;
    case "call":
      emit(`call`);
      lines.push(`${indent}  target:`);
      lines.push(...dumpNode(n.target, indent + "    "));
      if (n.args.length > 0) {
        lines.push(`${indent}  args:`);
        for (const a of n.args) lines.push(...dumpNode(a, indent + "    "));
      }
      break;
    case "if":
      emit("if");
      lines.push(`${indent}  cond:`);
      lines.push(...dumpNode(n.cond, indent + "    "));
      lines.push(`${indent}  then:`);
      lines.push(...dumpNode(n.then, indent + "    "));
      if (n.else) {
        lines.push(`${indent}  else:`);
        lines.push(...dumpNode(n.else, indent + "    "));
      }
      break;
    case "while":
      emit("while");
      lines.push(`${indent}  cond:`);
      lines.push(...dumpNode(n.cond, indent + "    "));
      lines.push(`${indent}  body:`);
      lines.push(...dumpNode(n.body, indent + "    "));
      break;
    case "do":
      emit("do-while");
      lines.push(`${indent}  body:`);
      lines.push(...dumpNode(n.body, indent + "    "));
      lines.push(`${indent}  cond:`);
      lines.push(...dumpNode(n.cond, indent + "    "));
      break;
    case "for":
      emit("for");
      if (n.init) { lines.push(`${indent}  init:`); lines.push(...dumpNode(n.init, indent + "    ")); }
      if (n.cond) { lines.push(`${indent}  cond:`); lines.push(...dumpNode(n.cond, indent + "    ")); }
      if (n.step) { lines.push(`${indent}  step:`); lines.push(...dumpNode(n.step, indent + "    ")); }
      lines.push(`${indent}  body:`);
      lines.push(...dumpNode(n.body, indent + "    "));
      break;
    case "block":
      if (n.stmts.length === 0) { emit("block {}"); break; }
      emit("block");
      for (const s of n.stmts) child(s);
      break;
    case "return":
      emit("return");
      if (n.value) child(n.value);
      break;
    case "break": emit("break"); break;
    case "continue": emit("continue"); break;
    case "goto": emit(`goto ${n.label}`); break;
    case "label": emit(`label ${n.name}:`); break;
    case "asm": emit(`asm { ${ellipsis(n.text, 60)} }`); break;
    case "switch":
      emit("switch");
      lines.push(`${indent}  expr:`);
      lines.push(...dumpNode(n.expr, indent + "    "));
      lines.push(`${indent}  body:`);
      lines.push(...dumpNode(n.body, indent + "    "));
      break;
    case "case":
      emit("case");
      child(n.value);
      break;
    case "default":
      emit("default");
      break;
    case "member":
      emit(`${n.arrow ? "->" : "."}${n.field}`);
      child(n.object);
      break;
    case "pushPop":
      emit("push_pop");
      if (n.regs.length > 0) { lines.push(`${indent}  regs:`); for (const r of n.regs) lines.push(...dumpNode(r, indent + "    ")); }
      lines.push(`${indent}  body:`);
      lines.push(...dumpNode(n.body, indent + "    "));
      break;
  }
  return lines;
}

function ellipsis(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}
