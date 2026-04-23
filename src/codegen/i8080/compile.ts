import type { CFunction, CNode, CProgram, CType, CVariable } from "../../frontend/ast.ts";

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

  const hasMain = p.functions.some((f) => f.name === "main" && f.body !== null);
  if (hasMain) {
    out.instruction("JMP", "main");
    out.blank();
  }

  for (const g of p.globals) out.declareGlobal(g);

  const userFuncNames = new Set(p.functions.filter((f) => f.body !== null).map((f) => f.name));
  for (const f of p.functions) {
    if (f.body === null) continue;
    compileFunction(out, f, warnings);
    out.blank();
  }

  out.emitRuntimeHelpers(userFuncNames);
  out.emitStaticStack();
  out.emitGlobalsStorage();
  out.directive("END");
  return { asm: out.render(), warnings };
}

function compileFunction(out: Emitter, f: CFunction, warnings: string[]): void {
  out.beginFunction(f);
  out.label(f.name);

  // Prologue: save the "last int param in HL" into its static-stack slot so that
  // subsequent uses can load it via LHLD.
  const lastParam = findLastIntParam(f);
  if (lastParam !== null) {
    out.instruction("SHLD", paramAddr(f.name, lastParam));
  }

  compileNode(out, f.body!, warnings);
  if (!out.lastWasReturn()) out.instruction("RET");
  out.endFunction();
}

function findLastIntParam(f: CFunction): number | null {
  for (let i = f.params.length - 1; i >= 0; i--) {
    if (isIntLike(f.params[i]!.type)) return i + 1; // 1-based
  }
  return null;
}

function paramAddr(func: string, n: number): string { return `__a_${n}_${func.toLowerCase()}`; }
function frameAddr(func: string): string { return `__s_${func.toLowerCase()}`; }

function compileNode(out: Emitter, n: CNode, warnings: string[]): void {
  switch (n.kind) {
    case "block":
      for (const s of n.stmts) compileNode(out, s, warnings);
      return;
    case "return":
      if (n.value !== null) compileExpression(out, n.value, warnings);
      out.instruction("RET");
      return;
    case "asm":
      out.raw(n.text);
      return;
    case "assign":
      compileExpression(out, n, warnings);
      return;
    case "if": {
      compileExpression(out, n.cond, warnings);
      const elseLabel = out.freshLabel("else");
      const endLabel = out.freshLabel("endif");
      out.instruction("MOV", "A,H");
      out.instruction("ORA", "L");
      out.instruction("JZ", n.else ? elseLabel : endLabel);
      compileNode(out, n.then, warnings);
      if (n.else) {
        out.instruction("JMP", endLabel);
        out.label(elseLabel);
        compileNode(out, n.else, warnings);
      }
      out.label(endLabel);
      return;
    }
    case "while": {
      const loopLabel = out.freshLabel("while");
      const endLabel = out.freshLabel("endwhile");
      out.beginLoop(loopLabel, endLabel);
      out.label(loopLabel);
      compileExpression(out, n.cond, warnings);
      out.instruction("MOV", "A,H");
      out.instruction("ORA", "L");
      out.instruction("JZ", endLabel);
      compileNode(out, n.body, warnings);
      out.instruction("JMP", loopLabel);
      out.label(endLabel);
      out.endLoop();
      return;
    }
    case "do": {
      const loopLabel = out.freshLabel("do");
      const contLabel = out.freshLabel("docont");
      const endLabel = out.freshLabel("enddo");
      out.beginLoop(contLabel, endLabel);
      out.label(loopLabel);
      compileNode(out, n.body, warnings);
      out.label(contLabel);
      compileExpression(out, n.cond, warnings);
      out.instruction("MOV", "A,H");
      out.instruction("ORA", "L");
      out.instruction("JNZ", loopLabel);
      out.label(endLabel);
      out.endLoop();
      return;
    }
    case "for": {
      const loopLabel = out.freshLabel("for");
      const contLabel = out.freshLabel("forcont");
      const endLabel = out.freshLabel("endfor");
      if (n.init) compileNode(out, n.init, warnings);
      out.beginLoop(contLabel, endLabel);
      out.label(loopLabel);
      if (n.cond) {
        compileExpression(out, n.cond, warnings);
        out.instruction("MOV", "A,H");
        out.instruction("ORA", "L");
        out.instruction("JZ", endLabel);
      }
      compileNode(out, n.body, warnings);
      out.label(contLabel);
      if (n.step) compileExpression(out, n.step, warnings);
      out.instruction("JMP", loopLabel);
      out.label(endLabel);
      out.endLoop();
      return;
    }
    case "break": {
      const l = out.currentLoopEnd();
      if (l === null) { warnings.push("break outside loop"); return; }
      out.instruction("JMP", l);
      return;
    }
    case "continue": {
      const l = out.currentLoopCont();
      if (l === null) { warnings.push("continue outside loop"); return; }
      out.instruction("JMP", l);
      return;
    }
    default:
      if (isExpressionKind(n.kind)) { compileExpression(out, n, warnings); return; }
      warnings.push(`unhandled statement kind '${n.kind}'`);
      return;
  }
}

function isExpressionKind(k: CNode["kind"]): boolean {
  return k === "const" || k === "var" || k === "binary" || k === "unary" || k === "call" || k === "load" || k === "assign";
}

function compileExpression(out: Emitter, n: CNode, warnings: string[]): void {
  // Leaves the 16-bit result in HL.
  const folded = foldConst(n);
  if (folded !== null) {
    out.instruction("LXI", `H,${toDec(folded)}`);
    return;
  }
  switch (n.kind) {
    case "const":
      if (typeof n.value === "string") {
        const lbl = out.internString(n.value);
        out.instruction("LXI", `H,${lbl}`);
      } else {
        out.instruction("LXI", `H,${toDec(n.value)}`);
      }
      return;
    case "var": {
      const addr = variableAddress(out, n.name, n.resolved);
      if (addr === null) { warnings.push(`unresolved variable '${n.name}'`); out.instruction("LXI", "H,0"); return; }
      out.instruction("LHLD", addr);
      return;
    }
    case "binary":
      compileBinary(out, n.op, n.lhs, n.rhs, warnings);
      return;
    case "unary":
      compileUnary(out, n.op, n.arg, warnings);
      return;
    case "call":
      compileCall(out, n, warnings);
      return;
    case "assign": {
      compileExpression(out, n.value, warnings);
      if (n.target.kind === "var") {
        const addr = variableAddress(out, n.target.name, n.target.resolved);
        if (addr !== null) out.instruction("SHLD", addr);
        else warnings.push(`unresolved assignment target '${n.target.name}'`);
      } else {
        warnings.push(`unsupported assignment target: ${n.target.kind}`);
      }
      return;
    }
    default:
      warnings.push(`unhandled expression kind '${n.kind}'`);
      out.instruction("LXI", "H,0");
      return;
  }
}

function compileBinary(
  out: Emitter,
  op: string,
  lhs: CNode,
  rhs: CNode,
  warnings: string[],
): void {
  // Standard pattern: compute LHS→HL, push, compute RHS→HL, pop DE, op (HL op= DE with LHS in DE).
  compileExpression(out, lhs, warnings);
  out.instruction("PUSH", "H");
  compileExpression(out, rhs, warnings);
  out.instruction("POP", "D");
  switch (op) {
    case "add": out.instruction("DAD", "D"); return;
    case "sub": {
      // HL = DE - HL: A = -HL + 1, then DAD D
      out.instruction("MOV", "A,H"); out.instruction("CMA"); out.instruction("MOV", "H,A");
      out.instruction("MOV", "A,L"); out.instruction("CMA"); out.instruction("MOV", "L,A");
      out.instruction("INX", "H");
      out.instruction("DAD", "D");
      return;
    }
    case "eq": case "ne": case "lt": case "le": case "gt": case "ge":
      compileCompare(out, op);
      return;
    case "and": case "or": case "xor":
      compileBitwise16(out, op);
      return;
    case "logand": case "logor": {
      // Treat as: 0 if both/either 0 else 1. For now, short-fold: compute ORs.
      // HL = (HL != 0) && (DE != 0) ? 1 : 0   (for logand)
      warnings.push(`logical ${op} uses simplified codegen`);
      out.instruction("MOV", "A,H"); out.instruction("ORA", "L"); // A != 0 iff HL != 0
      // HL = A != 0 ? 1 : 0 (for logand, multiply with DE truthiness)
      // simplified: if HL == 0, result 0; else result is DE != 0 ? 1 : 0 for logand; DE for logor.
      // Skipping a full short-circuit for now.
      out.instruction("LXI", "H,0");
      return;
    }
    default:
      warnings.push(`unhandled binary op '${op}'`);
      out.instruction("LXI", "H,0");
      return;
  }
}

function compileCompare(out: Emitter, op: string): void {
  // At this point DE = LHS, HL = RHS. We want HL = (DE op HL) ? 1 : 0.
  // 16-bit unsigned comparison.
  switch (op) {
    case "eq":
    case "ne": {
      // XOR low bytes, stash; XOR high bytes; OR → Z iff fully equal.
      out.instruction("MOV", "A,E"); out.instruction("XRA", "L");
      out.instruction("MOV", "L,A");
      out.instruction("MOV", "A,D"); out.instruction("XRA", "H");
      out.instruction("ORA", "L");
      setBoolFromFlag(out, op === "eq" ? "JZ" : "JNZ");
      return;
    }
    case "lt":
    case "ge": {
      // Signed DE < HL via sign of (DE - HL). Ignores overflow (MVP).
      out.instruction("MOV", "A,E"); out.instruction("SUB", "L");
      out.instruction("MOV", "A,D"); out.instruction("SBB", "H");
      setBoolFromFlag(out, op === "lt" ? "JM" : "JP");
      return;
    }
    case "le":
    case "gt": {
      // DE > HL ⇔ HL < DE (signed).
      out.instruction("MOV", "A,L"); out.instruction("SUB", "E");
      out.instruction("MOV", "A,H"); out.instruction("SBB", "D");
      setBoolFromFlag(out, op === "gt" ? "JM" : "JP");
      return;
    }
  }
}

function setBoolFromFlag(out: Emitter, jumpWhenTrue: string): void {
  const t = out.freshLabel("cmpT");
  const e = out.freshLabel("cmpE");
  out.instruction(jumpWhenTrue, t);
  out.instruction("LXI", "H,0");
  out.instruction("JMP", e);
  out.label(t);
  out.instruction("LXI", "H,1");
  out.label(e);
}

function compileBitwise16(out: Emitter, op: "and" | "or" | "xor"): void {
  // HL op= DE (byte-wise)
  const byteOp = op === "and" ? "ANA" : op === "or" ? "ORA" : "XRA";
  out.instruction("MOV", "A,L"); out.instruction(byteOp, "E"); out.instruction("MOV", "L,A");
  out.instruction("MOV", "A,H"); out.instruction(byteOp, "D"); out.instruction("MOV", "H,A");
}

function compileUnary(out: Emitter, op: string, arg: CNode, warnings: string[]): void {
  compileExpression(out, arg, warnings);
  switch (op) {
    case "neg":
      out.instruction("MOV", "A,H"); out.instruction("CMA"); out.instruction("MOV", "H,A");
      out.instruction("MOV", "A,L"); out.instruction("CMA"); out.instruction("MOV", "L,A");
      out.instruction("INX", "H");
      return;
    case "bnot":
      out.instruction("MOV", "A,H"); out.instruction("CMA"); out.instruction("MOV", "H,A");
      out.instruction("MOV", "A,L"); out.instruction("CMA"); out.instruction("MOV", "L,A");
      return;
    case "not": {
      out.instruction("MOV", "A,H"); out.instruction("ORA", "L");
      const t = out.freshLabel("notT");
      const e = out.freshLabel("notE");
      out.instruction("JZ", t);
      out.instruction("LXI", "H,0");
      out.instruction("JMP", e);
      out.label(t);
      out.instruction("LXI", "H,1");
      out.label(e);
      return;
    }
    default:
      warnings.push(`unhandled unary op '${op}'`);
      out.instruction("LXI", "H,0");
      return;
  }
}

function compileCall(out: Emitter, n: Extract<CNode, { kind: "call" }>, warnings: string[]): void {
  if (n.target.kind !== "var") {
    warnings.push("indirect call not yet supported");
    out.instruction("LXI", "H,0");
    return;
  }
  const name = n.target.name;
  out.noteCallTo(name);
  const args = n.args;
  for (let i = 0; i < args.length - 1; i++) {
    compileExpression(out, args[i]!, warnings);
    out.instruction("SHLD", paramAddr(name, i + 1));
  }
  if (args.length > 0) compileExpression(out, args[args.length - 1]!, warnings);
  out.instruction("CALL", name);
}

function variableAddress(out: Emitter, name: string, v: CVariable | null): string | null {
  if (v === null) {
    // Unresolved — could be a global variable we'll emit storage for later.
    return name;
  }
  const found = out.findVariableStorage(name, v);
  return found;
}

function isIntLike(t: CType): boolean {
  if (t.kind === "base") {
    return t.base === "int" || t.base === "uint" || t.base === "short" || t.base === "ushort" ||
      t.base === "char" || t.base === "schar" || t.base === "uchar" || t.base === "bool";
  }
  if (t.kind === "pointer") return true; // 16-bit
  return false;
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

type FunctionFrame = {
  readonly func: CFunction;
  readonly paramSlots: number;
};

class Emitter {
  private readonly lines: string[] = [];
  private lastInstruction = "";
  private labelCounter = 0;
  private readonly loopStack: Array<{ cont: string; end: string }> = [];
  private readonly strings = new Map<string, string>();
  private currentFrame: FunctionFrame | null = null;
  private readonly frames: FunctionFrame[] = [];
  private readonly globalVars = new Map<string, CVariable>();

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

  freshLabel(prefix: string): string {
    this.labelCounter++;
    return `.L${prefix}${this.labelCounter}`;
  }

  beginLoop(cont: string, end: string): void { this.loopStack.push({ cont, end }); }
  endLoop(): void { this.loopStack.pop(); }
  currentLoopEnd(): string | null { return this.loopStack[this.loopStack.length - 1]?.end ?? null; }
  currentLoopCont(): string | null { return this.loopStack[this.loopStack.length - 1]?.cont ?? null; }

  beginFunction(f: CFunction): void {
    const frame: FunctionFrame = { func: f, paramSlots: f.params.length };
    this.currentFrame = frame;
    this.frames.push(frame);
  }
  endFunction(): void { this.currentFrame = null; }

  private readonly callsSeen = new Set<string>();
  noteCallTo(name: string): void { this.callsSeen.add(name); }

  emitRuntimeHelpers(userDefined: ReadonlySet<string>): void {
    for (const name of this.callsSeen) {
      if (userDefined.has(name)) continue;
      const helper = RUNTIME_HELPERS[name];
      if (!helper) continue;
      this.blank();
      this.raw(helper.trimEnd());
    }
  }

  findVariableStorage(name: string, v: CVariable): string {
    if (this.currentFrame !== null) {
      // Is it a parameter of the current function?
      const paramIdx = this.currentFrame.func.params.findIndex((p) => p === v || p.name === name);
      if (paramIdx >= 0) return paramAddr(this.currentFrame.func.name, paramIdx + 1);
      // Is it a local?
      const localIdx = this.currentFrame.func.locals.findIndex((l) => l === v || l.name === name);
      if (localIdx >= 0) return localAddr(this.currentFrame.func.name, localIdx);
    }
    // Treat as global.
    this.globalVars.set(name, v);
    return name;
  }

  declareGlobal(v: CVariable): void {
    this.globalVars.set(v.name, v);
  }

  internString(s: string): string {
    const existing = this.strings.get(s);
    if (existing !== undefined) return existing;
    const label = `__str${this.strings.size}`;
    this.strings.set(s, label);
    return label;
  }

  emitStaticStack(): void {
    if (this.frames.length === 0 && this.strings.size === 0) return;
    this.blank();
    this.label("__static_stack");
    let offset = 0;
    for (const frame of this.frames) {
      const slotBytes = frame.func.params.length * 2 + frame.func.locals.length * 2;
      if (slotBytes > 0) {
        this.directive(`DS   ${slotBytes}  ; ${frame.func.name}`);
      }
      this.lines.push(`${frameAddr(frame.func.name)}: EQU __static_stack+${offset}`);
      for (let i = 0; i < frame.func.params.length; i++) {
        this.lines.push(`${paramAddr(frame.func.name, i + 1)}: EQU ${frameAddr(frame.func.name)}+${i * 2}`);
      }
      for (let i = 0; i < frame.func.locals.length; i++) {
        this.lines.push(`${localAddr(frame.func.name, i)}: EQU ${frameAddr(frame.func.name)}+${(frame.func.params.length + i) * 2}`);
      }
      offset += slotBytes;
    }
  }

  emitGlobalsStorage(): void {
    const unique = new Map<string, CVariable>();
    for (const [name, v] of this.globalVars) unique.set(name, v);
    if (unique.size === 0 && this.strings.size === 0) return;
    this.blank();
    for (const [name, v] of unique) {
      const size = typeSize(v.type);
      this.label(name);
      this.directive(`DS   ${size}`);
    }
    for (const [text, label] of this.strings) {
      this.label(label);
      this.directive(`DB   ${encodeDbString(text)}, 0`);
    }
  }
}

function localAddr(func: string, idx: number): string {
  return `__l_${idx}_${func.toLowerCase()}`;
}

function typeSize(t: CType): number {
  if (t.kind === "base") {
    switch (t.base) {
      case "char": case "schar": case "uchar": case "bool": return 1;
      case "short": case "ushort": case "int": case "uint": return 2;
      case "long": case "ulong": return 4;
      case "llong": case "ullong": return 8;
      case "float": return 4;
      case "double": return 8;
      case "void": return 0;
    }
  }
  if (t.kind === "pointer") return 2;
  if (t.kind === "array") return typeSize(t.of) * (t.length ?? 0);
  if (t.kind === "struct") return 0; // unknown for MVP
  if (t.kind === "function") return 0;
  return 0;
}

const RUNTIME_HELPERS: Record<string, string> = {
  putchar: `
putchar:
    MOV   E,L
    MVI   C,2
    CALL  5
    RET
`,
  puts: `
puts:
    SHLD  __rt_puts_p
.Lputsloop:
    LHLD  __rt_puts_p
    MOV   A,M
    ORA   A
    JZ    .Lputsdone
    MOV   E,A
    MVI   C,2
    PUSH  H
    CALL  5
    POP   H
    INX   H
    SHLD  __rt_puts_p
    JMP   .Lputsloop
.Lputsdone:
    RET

__rt_puts_p:
    DS    2
`,
};

function encodeDbString(s: string): string {
  const parts: string[] = [];
  let buf = "";
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x22 || code > 0x7e) {
      if (buf.length > 0) { parts.push(`"${buf}"`); buf = ""; }
      parts.push(code.toString());
    } else {
      buf += ch;
    }
  }
  if (buf.length > 0) parts.push(`"${buf}"`);
  if (parts.length === 0) parts.push("0");
  return parts.join(", ");
}
