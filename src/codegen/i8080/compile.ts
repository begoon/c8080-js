import type { CFunction, CNode, CProgram } from "../../frontend/ast.ts";

export type CompileResult = {
  readonly asm: string;
  readonly warnings: readonly string[];
};

export function compileProgram(p: CProgram, options: { org?: number } = {}): CompileResult {
  const out = new Emitter();
  const warnings: string[] = [];
  const org = options.org ?? 0x0100;

  out.directive(`ORG ${toHex(org)}`);
  out.blank();

  // Entry point: if there's a function named 'main', jump to it first so the
  // binary starts executing there when loaded at ORG.
  const hasMain = p.functions.some((f) => f.name === "main" && f.body !== null);
  if (hasMain) {
    out.instruction("JMP", "main");
    out.blank();
  }

  for (const f of p.functions) {
    if (f.body === null) continue;
    compileFunction(out, f, warnings);
    out.blank();
  }

  out.directive("END");
  return { asm: out.render(), warnings };
}

function compileFunction(out: Emitter, f: CFunction, warnings: string[]): void {
  out.label(f.name);
  compileNode(out, f.body!, warnings, { functionName: f.name });
  // Ensure every function ends with RET.
  if (!out.lastWasReturn()) out.instruction("RET");
}

type CompileCtx = { readonly functionName: string };

function compileNode(out: Emitter, n: CNode, warnings: string[], ctx: CompileCtx): void {
  switch (n.kind) {
    case "block":
      for (const s of n.stmts) compileNode(out, s, warnings, ctx);
      return;
    case "return":
      if (n.value !== null) compileExpression(out, n.value, warnings);
      out.instruction("RET");
      return;
    case "asm":
      out.raw(n.text);
      return;
    default:
      warnings.push(`unhandled statement kind '${n.kind}' in ${ctx.functionName}`);
      return;
  }
}

function compileExpression(out: Emitter, n: CNode, warnings: string[]): void {
  // Loads the expression value into HL (16-bit) or A (8-bit, for chars/bools).
  // For now, 16-bit int is the only supported result type.
  switch (n.kind) {
    case "const": {
      if (typeof n.value !== "bigint") {
        warnings.push(`non-integer const not yet supported`);
        out.instruction("LXI", "H,0");
        return;
      }
      out.instruction("LXI", `H,${toDec(n.value)}`);
      return;
    }
    case "binary": {
      const folded = foldConst(n);
      if (folded !== null) {
        out.instruction("LXI", `H,${toDec(folded)}`);
        return;
      }
      // Fallback: compute LHS into HL, push, compute RHS into HL, pop DE, op.
      compileExpression(out, n.lhs, warnings);
      out.instruction("PUSH", "H");
      compileExpression(out, n.rhs, warnings);
      out.instruction("POP", "D");
      switch (n.op) {
        case "add": out.instruction("DAD", "D"); return;
        case "sub": {
          // HL = DE - HL  →  negate HL, then DAD D.
          // (not the fastest, but tiny)
          out.instruction("MOV", "A,H");
          out.instruction("CMA");
          out.instruction("MOV", "H,A");
          out.instruction("MOV", "A,L");
          out.instruction("CMA");
          out.instruction("MOV", "L,A");
          out.instruction("INX", "H");
          out.instruction("DAD", "D");
          return;
        }
        default:
          warnings.push(`unhandled binary op '${n.op}'`);
          out.instruction("LXI", "H,0");
          return;
      }
    }
    default:
      warnings.push(`unhandled expression kind '${n.kind}'`);
      out.instruction("LXI", "H,0");
      return;
  }
}

function foldConst(n: CNode): bigint | null {
  if (n.kind === "const") return typeof n.value === "bigint" ? n.value : null;
  if (n.kind === "unary") {
    const v = foldConst(n.arg);
    if (v === null) return null;
    switch (n.op) {
      case "neg": return -v;
      case "not": return v === 0n ? 1n : 0n;
      case "bnot": return ~v;
      default: return null;
    }
  }
  if (n.kind === "binary") {
    const l = foldConst(n.lhs);
    const r = foldConst(n.rhs);
    if (l === null || r === null) return null;
    switch (n.op) {
      case "add": return l + r;
      case "sub": return l - r;
      case "mul": return l * r;
      case "div": return r === 0n ? null : l / r;
      case "mod": return r === 0n ? null : l % r;
      case "shl": return l << r;
      case "shr": return l >> r;
      case "and": return l & r;
      case "or":  return l | r;
      case "xor": return l ^ r;
      default: return null;
    }
  }
  return null;
}

function toHex(n: number): string { return `${n.toString(16).toUpperCase()}h`; }
function toDec(n: bigint): string { return n.toString(); }

class Emitter {
  private readonly lines: string[] = [];
  private lastInstruction = "";

  directive(text: string): void { this.lines.push(`    ${text}`); this.lastInstruction = ""; }
  blank(): void { this.lines.push(""); }
  label(name: string): void { this.lines.push(`${name}:`); this.lastInstruction = ""; }
  instruction(op: string, operands?: string): void {
    this.lines.push(operands ? `    ${op.padEnd(6)}${operands}` : `    ${op}`);
    this.lastInstruction = op.toUpperCase();
  }
  raw(text: string): void { this.lines.push(text); this.lastInstruction = ""; }
  lastWasReturn(): boolean { return this.lastInstruction === "RET"; }
  render(): string { return this.lines.join("\n") + "\n"; }
}
