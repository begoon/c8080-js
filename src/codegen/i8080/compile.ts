import type { CFunction, CNode, CProgram, CType, CVariable, InitializerValue, StructField } from "../../frontend/ast.ts";

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
    case "switch":
      compileSwitch(out, n, warnings);
      return;
    case "case":
    case "default":
    case "label":
    case "goto":
      // Handled in compileSwitch / not-yet for top-level goto-label flow.
      warnings.push(`${n.kind} outside of a switch is not supported yet`);
      return;
    default:
      if (isExpressionKind(n.kind)) { compileExpression(out, n, warnings); return; }
      warnings.push(`unhandled statement kind '${n.kind}'`);
      return;
  }
}

function isExpressionKind(k: CNode["kind"]): boolean {
  return (
    k === "const" || k === "var" || k === "binary" || k === "unary" ||
    k === "call" || k === "load" || k === "assign" || k === "member" ||
    k === "ternary"
  );
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
      // Arrays decay to pointers: load the address, not the contents.
      if (n.resolved && n.resolved.type.kind === "array") {
        out.instruction("LXI", `H,${addr}`);
        return;
      }
      // Byte-sized variables: LDA + zero-extend.
      if (n.resolved && isByteType(n.resolved.type)) {
        out.instruction("LDA", addr);
        out.instruction("MOV", "L,A");
        out.instruction("MVI", "H,0");
        return;
      }
      out.instruction("LHLD", addr);
      return;
    }
    case "binary":
      if (n.op === "logand" || n.op === "logor") {
        compileShortCircuit(out, n.op, n.lhs, n.rhs, warnings);
        return;
      }
      compileBinary(out, n.op, n.lhs, n.rhs, warnings);
      return;
    case "unary":
      compileUnary(out, n.op, n.arg, warnings);
      return;
    case "call":
      compileCall(out, n, warnings);
      return;
    case "member":
      compileMemberRead(out, n, warnings);
      return;
    case "ternary": {
      const elseLabel = out.freshLabel("telse");
      const endLabel = out.freshLabel("tend");
      compileExpression(out, n.cond, warnings);
      out.instruction("MOV", "A,H"); out.instruction("ORA", "L");
      out.instruction("JZ", elseLabel);
      compileExpression(out, n.then, warnings);
      out.instruction("JMP", endLabel);
      out.label(elseLabel);
      compileExpression(out, n.else, warnings);
      out.label(endLabel);
      return;
    }
    case "assign": {
      if (n.target.kind === "var") {
        compileExpression(out, n.value, warnings);
        const addr = variableAddress(out, n.target.name, n.target.resolved);
        if (addr === null) { warnings.push(`unresolved assignment target '${n.target.name}'`); return; }
        if (n.target.resolved && isByteType(n.target.resolved.type)) {
          out.instruction("MOV", "A,L");
          out.instruction("STA", addr);
        } else {
          out.instruction("SHLD", addr);
        }
        return;
      }
      if (n.target.kind === "member") {
        compileMemberAssign(out, n.target, n.value, warnings);
        return;
      }
      if (n.target.kind === "unary" && n.target.op === "deref") {
        // *addr = value
        compileExpression(out, n.target.arg, warnings); // HL = address
        out.instruction("PUSH", "H");
        compileExpression(out, n.value, warnings);     // HL = value
        out.instruction("POP", "D");                    // DE = address
        out.instruction("XCHG");                        // HL = address, DE = value
        if (derefIsByte(n.target.arg)) {
          out.instruction("MOV", "M,E");
        } else {
          out.instruction("MOV", "M,E");
          out.instruction("INX", "H");
          out.instruction("MOV", "M,D");
        }
        return;
      }
      warnings.push(`unsupported assignment target: ${n.target.kind}`);
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
  // Scale RHS if this is pointer arithmetic.
  if (op === "add" || op === "sub") {
    const ptrSize = pointeeByteSize(lhs);
    if (ptrSize > 1) scaleHL(out, ptrSize, warnings);
  }
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
    case "mul":
      out.instruction("CALL", "__o_mul_u16");
      out.noteCallTo("__o_mul_u16");
      return;
    case "div": {
      // Need dividend in HL, divisor in DE; currently DE=LHS, HL=RHS → XCHG to swap.
      out.instruction("XCHG");
      out.instruction("CALL", "__o_div_u16");
      out.noteCallTo("__o_div_u16");
      return;
    }
    case "mod": {
      out.instruction("XCHG");
      out.instruction("CALL", "__o_div_u16");
      out.noteCallTo("__o_div_u16");
      out.instruction("XCHG"); // remainder is in DE, move to HL
      return;
    }
    case "shl": {
      // HL = DE << HL (only low byte of HL matters for shift amount).
      out.instruction("CALL", "__o_shl_u16");
      out.noteCallTo("__o_shl_u16");
      return;
    }
    case "shr": {
      out.instruction("CALL", "__o_shr_u16");
      out.noteCallTo("__o_shr_u16");
      return;
    }
    case "eq": case "ne": case "lt": case "le": case "gt": case "ge":
      compileCompare(out, op);
      return;
    case "and": case "or": case "xor":
      compileBitwise16(out, op);
      return;
    // logand/logor are handled before compileBinary via compileShortCircuit.
    default:
      warnings.push(`unhandled binary op '${op}'`);
      out.instruction("LXI", "H,0");
      return;
  }
}

function compileShortCircuit(out: Emitter, op: "logand" | "logor", lhs: CNode, rhs: CNode, warnings: string[]): void {
  const falseLabel = out.freshLabel(op === "logand" ? "land0" : "lor0");
  const trueLabel = out.freshLabel(op === "logand" ? "land1" : "lor1");
  const endLabel = out.freshLabel("lend");
  // Evaluate LHS.
  compileExpression(out, lhs, warnings);
  out.instruction("MOV", "A,H"); out.instruction("ORA", "L");
  if (op === "logand") {
    out.instruction("JZ", falseLabel); // if LHS == 0, result = 0
  } else {
    out.instruction("JNZ", trueLabel); // if LHS != 0, result = 1
  }
  // Evaluate RHS.
  compileExpression(out, rhs, warnings);
  out.instruction("MOV", "A,H"); out.instruction("ORA", "L");
  if (op === "logand") {
    out.instruction("JZ", falseLabel); // if RHS == 0, result = 0
    out.instruction("LXI", "H,1");
    out.instruction("JMP", endLabel);
    out.label(falseLabel);
    out.instruction("LXI", "H,0");
  } else {
    out.instruction("JNZ", trueLabel); // if RHS != 0, result = 1
    out.instruction("LXI", "H,0");
    out.instruction("JMP", endLabel);
    out.label(trueLabel);
    out.instruction("LXI", "H,1");
  }
  out.label(endLabel);
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
  if (op === "deref") { compileDeref(out, arg, warnings); return; }
  if (op === "addr") {
    if (arg.kind === "var") {
      const addr = variableAddress(out, arg.name, arg.resolved);
      if (addr) { out.instruction("LXI", `H,${addr}`); return; }
    }
    if (arg.kind === "unary" && arg.op === "deref") {
      compileExpression(out, arg.arg, warnings); // the address itself
      return;
    }
    warnings.push(`&expr not supported for this operand`);
    out.instruction("LXI", "H,0");
    return;
  }
  if (op === "preinc" || op === "predec" || op === "postinc" || op === "postdec") {
    compileIncDec(out, op, arg, warnings);
    return;
  }
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

function computeMemberAddress(out: Emitter, n: Extract<CNode, { kind: "member" }>, warnings: string[]): StructField | null {
  // Leaves the member's address in HL. Returns the field definition (for size info) or null on error.
  const field = resolveField(n);
  if (!field) { warnings.push(`cannot resolve field '${n.field}'`); out.instruction("LXI", "H,0"); return null; }

  if (n.arrow) {
    // object is a pointer to struct; load the pointer value (HL).
    compileExpression(out, n.object, warnings);
  } else {
    // object is a struct value; get its address via &object.
    compileAddrOf(out, n.object, warnings);
  }
  if (field.offset > 0) {
    out.instruction("LXI", `D,${field.offset}`);
    out.instruction("DAD", "D");
  }
  return field;
}

function compileMemberRead(out: Emitter, n: Extract<CNode, { kind: "member" }>, warnings: string[]): void {
  const field = computeMemberAddress(out, n, warnings);
  if (!field) return;
  if (isByteType(field.type)) {
    out.instruction("MOV", "A,M"); out.instruction("MOV", "L,A"); out.instruction("MVI", "H,0");
  } else {
    out.instruction("MOV", "E,M"); out.instruction("INX", "H"); out.instruction("MOV", "D,M"); out.instruction("XCHG");
  }
}

function compileMemberAssign(out: Emitter, target: Extract<CNode, { kind: "member" }>, value: CNode, warnings: string[]): void {
  const field = resolveField(target);
  if (!field) { warnings.push(`cannot resolve field '${target.field}'`); return; }
  // Compute address, push, compute value, pop address, store.
  if (target.arrow) compileExpression(out, target.object, warnings);
  else compileAddrOf(out, target.object, warnings);
  if (field.offset > 0) {
    out.instruction("LXI", `D,${field.offset}`);
    out.instruction("DAD", "D");
  }
  out.instruction("PUSH", "H");
  compileExpression(out, value, warnings);
  out.instruction("POP", "D");
  out.instruction("XCHG"); // HL = addr, DE = value
  if (isByteType(field.type)) {
    out.instruction("MOV", "M,E");
  } else {
    out.instruction("MOV", "M,E"); out.instruction("INX", "H"); out.instruction("MOV", "M,D");
  }
}

function resolveField(n: Extract<CNode, { kind: "member" }>): StructField | null {
  const st = structTypeOf(n.object, n.arrow);
  if (!st || !st.fields) return null;
  return st.fields.find((f) => f.name === n.field) ?? null;
}

function structTypeOf(n: CNode, isArrowContext: boolean): Extract<CType, { kind: "struct" }> | null {
  // For a.x: n should have struct type directly.
  // For a->x: n should have pointer-to-struct type.
  if (n.kind === "var" && n.resolved) {
    const t = n.resolved.type;
    if (isArrowContext) {
      if (t.kind === "pointer" && t.to.kind === "struct") return t.to;
    } else {
      if (t.kind === "struct") return t;
    }
  }
  if (n.kind === "unary" && n.op === "deref") {
    // *p where p is pointer-to-struct
    const inner = n.arg;
    if (inner.kind === "var" && inner.resolved && inner.resolved.type.kind === "pointer" && inner.resolved.type.to.kind === "struct") {
      return inner.resolved.type.to;
    }
  }
  return null;
}

function compileAddrOf(out: Emitter, n: CNode, warnings: string[]): void {
  if (n.kind === "var") {
    const addr = variableAddress(out, n.name, n.resolved);
    if (addr) { out.instruction("LXI", `H,${addr}`); return; }
  }
  if (n.kind === "unary" && n.op === "deref") {
    compileExpression(out, n.arg, warnings); // the deref's arg already IS the address
    return;
  }
  warnings.push(`cannot take address of ${n.kind}`);
  out.instruction("LXI", "H,0");
}

function compileIncDec(out: Emitter, op: string, arg: CNode, warnings: string[]): void {
  const isPre = op === "preinc" || op === "predec";
  const delta = op === "preinc" || op === "postinc" ? 1 : -1;
  // For a var: load, mutate, store; result in HL.
  if (arg.kind === "var") {
    const addr = variableAddress(out, arg.name, arg.resolved);
    if (!addr) { warnings.push(`unresolved ${op} target`); out.instruction("LXI", "H,0"); return; }
    const ptrSize = arg.resolved?.type.kind === "pointer" ? typeSize(arg.resolved.type.to) : 1;
    if (arg.resolved && isByteType(arg.resolved.type)) {
      out.instruction("LDA", addr);
      if (!isPre) {
        out.instruction("MOV", "L,A");
        out.instruction("MVI", "H,0");
      }
      out.instruction(delta > 0 ? "INR" : "DCR", "A");
      out.instruction("STA", addr);
      if (isPre) { out.instruction("MOV", "L,A"); out.instruction("MVI", "H,0"); }
      return;
    }
    out.instruction("LHLD", addr);
    if (!isPre) { out.instruction("PUSH", "H"); }
    // ++/-- on pointer scales by pointee size.
    const step = Math.max(ptrSize, 1);
    for (let i = 0; i < step; i++) out.instruction(delta > 0 ? "INX" : "DCX", "H");
    out.instruction("SHLD", addr);
    if (!isPre) out.instruction("POP", "H");
    return;
  }
  if (arg.kind === "unary" && arg.op === "deref") {
    // *p ++ / --: load through pointer, bump, store back.
    compileExpression(out, arg.arg, warnings); // HL = address
    out.instruction("PUSH", "H");
    const byte = derefIsByte(arg.arg);
    if (byte) {
      out.instruction("MOV", "A,M");
      if (!isPre) { out.instruction("MOV", "L,A"); out.instruction("MVI", "H,0"); out.instruction("PUSH", "H"); }
      out.instruction(delta > 0 ? "INR" : "DCR", "A");
      out.instruction("POP", "D"); // restore address (or old value for post)
      // Need HL = address again: we pushed twice; pop both correctly:
      // Actually let's just use a different approach below.
    }
    warnings.push(`${op} on dereferenced pointer not fully supported`);
    out.instruction("POP", "H");
    out.instruction("LXI", "H,0");
    return;
  }
  if (arg.kind === "member") {
    warnings.push(`${op} on struct member not yet supported`);
    out.instruction("LXI", "H,0");
    return;
  }
  warnings.push(`${op} on this operand not supported`);
  out.instruction("LXI", "H,0");
}

function compileDeref(out: Emitter, arg: CNode, warnings: string[]): void {
  compileExpression(out, arg, warnings); // HL = address
  if (derefIsByte(arg)) {
    out.instruction("MOV", "A,M");
    out.instruction("MOV", "L,A");
    out.instruction("MVI", "H,0");
  } else {
    out.instruction("MOV", "E,M");
    out.instruction("INX", "H");
    out.instruction("MOV", "D,M");
    out.instruction("XCHG");
  }
}

function derefIsByte(addressExpr: CNode): boolean {
  // Inspect the expression structure to decide whether *p is a byte load.
  if (addressExpr.kind === "var" && addressExpr.resolved) {
    const t = addressExpr.resolved.type;
    if (t.kind === "pointer") return isByteType(t.to);
    if (t.kind === "array") return isByteType(t.of);
  }
  if (addressExpr.kind === "binary" && addressExpr.op === "add") {
    return derefIsByte(addressExpr.lhs) || derefIsByte(addressExpr.rhs);
  }
  if (addressExpr.kind === "unary") {
    if (addressExpr.op === "preinc" || addressExpr.op === "predec" ||
        addressExpr.op === "postinc" || addressExpr.op === "postdec") {
      return derefIsByte(addressExpr.arg);
    }
    if (addressExpr.op === "addr") return derefIsByte(addressExpr.arg);
  }
  return false;
}

function isByteType(t: CType): boolean {
  if (t.kind !== "base") return false;
  return t.base === "char" || t.base === "schar" || t.base === "uchar" || t.base === "bool";
}

function pointeeByteSize(n: CNode): number {
  if (n.kind === "var" && n.resolved) {
    const t = n.resolved.type;
    if (t.kind === "pointer") return typeSize(t.to);
    if (t.kind === "array") return typeSize(t.of);
  }
  if (n.kind === "binary" && n.op === "add") {
    return pointeeByteSize(n.lhs) || pointeeByteSize(n.rhs);
  }
  return 0;
}

function scaleHL(out: Emitter, size: number, warnings: string[]): void {
  if (size === 1 || size === 0) return;
  // Power-of-two: shift left.
  let log = 0;
  let s = size;
  while (s > 1 && (s & 1) === 0) { log++; s >>= 1; }
  if (s === 1) {
    for (let i = 0; i < log; i++) out.instruction("DAD", "H");
    return;
  }
  // Non-power-of-two: multiply by size.
  out.instruction("LXI", `D,${size}`);
  out.instruction("CALL", "__o_mul_u16");
  out.noteCallTo("__o_mul_u16");
  void warnings;
}

function compileSwitch(out: Emitter, n: Extract<CNode, { kind: "switch" }>, warnings: string[]): void {
  // Gather case values and default marker. Bodies can have any statements
  // interleaved with case/default markers.
  const stmts = n.body.kind === "block" ? n.body.stmts : [n.body];
  const cases: Array<{ value: bigint; label: string; idx: number }> = [];
  let defaultIdx = -1;
  let defaultLabel: string | null = null;
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i]!;
    if (s.kind === "case") {
      const v = foldConstExpr(s.value);
      if (v === null) { warnings.push(`non-constant case value`); continue; }
      cases.push({ value: v, label: out.freshLabel(`case`), idx: i });
    } else if (s.kind === "default") {
      defaultIdx = i;
      defaultLabel = out.freshLabel("default");
    }
  }
  const endLabel = out.freshLabel("endsw");

  // Dispatcher.
  compileExpression(out, n.expr, warnings);
  for (const c of cases) {
    // 16-bit compare: HL vs c.value.
    const lo = Number(c.value & 0xffn);
    const hi = Number((c.value >> 8n) & 0xffn);
    out.instruction("MOV", "A,L"); out.instruction("CPI", `${lo}`);
    const skip = out.freshLabel("swskip");
    out.instruction("JNZ", skip);
    out.instruction("MOV", "A,H"); out.instruction("CPI", `${hi}`);
    out.instruction("JZ", c.label);
    out.label(skip);
  }
  out.instruction("JMP", defaultLabel ?? endLabel);

  // Body emission with labels at case/default positions.
  out.beginLoop(endLabel, endLabel); // break exits the switch
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i]!;
    if (s.kind === "case") {
      const c = cases.find((cc) => cc.idx === i);
      if (c) out.label(c.label);
      continue;
    }
    if (s.kind === "default") {
      if (defaultLabel) out.label(defaultLabel);
      continue;
    }
    compileNode(out, s, warnings);
  }
  out.endLoop();
  out.label(endLabel);
  void defaultIdx;
}

function foldConstExpr(n: CNode): bigint | null {
  if (n.kind === "const") return typeof n.value === "bigint" ? n.value : null;
  if (n.kind === "unary") {
    const v = foldConstExpr(n.arg);
    if (v === null) return null;
    if (n.op === "neg") return -v;
    if (n.op === "bnot") return ~v;
    return null;
  }
  if (n.kind === "binary") {
    const l = foldConstExpr(n.lhs);
    const r = foldConstExpr(n.rhs);
    if (l === null || r === null) return null;
    switch (n.op) {
      case "add": return l + r;
      case "sub": return l - r;
      case "mul": return l * r;
      case "shl": return l << r;
      case "shr": return l >> r;
      case "or": return l | r;
      case "and": return l & r;
      case "xor": return l ^ r;
    }
  }
  return null;
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
  directiveRaw(text: string): void { this.lines.push(`    ${text}`); this.lastInstruction = ""; }
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
      // Params are always 2 bytes (int/pointer) per c8080's calling convention.
      // Locals use their real size.
      let frameBytes = frame.func.params.length * 2;
      const localOffsets: number[] = [];
      for (const l of frame.func.locals) {
        localOffsets.push(frameBytes);
        frameBytes += Math.max(typeSize(l.type), 1);
      }
      if (frameBytes > 0) {
        this.directive(`DS   ${frameBytes}  ; ${frame.func.name}`);
      }
      this.lines.push(`${frameAddr(frame.func.name)}: EQU __static_stack+${offset}`);
      for (let i = 0; i < frame.func.params.length; i++) {
        this.lines.push(`${paramAddr(frame.func.name, i + 1)}: EQU ${frameAddr(frame.func.name)}+${i * 2}`);
      }
      for (let i = 0; i < frame.func.locals.length; i++) {
        this.lines.push(`${localAddr(frame.func.name, i)}: EQU ${frameAddr(frame.func.name)}+${localOffsets[i]}`);
      }
      offset += frameBytes;
    }
  }

  emitGlobalsStorage(): void {
    const unique = new Map<string, CVariable>();
    for (const [name, v] of this.globalVars) unique.set(name, v);
    if (unique.size === 0 && this.strings.size === 0) return;
    this.blank();
    for (const [name, v] of unique) {
      this.label(name);
      if (v.initializer !== null) {
        emitInitializerData(this, v.type, v.initializer);
      } else {
        const size = Math.max(typeSize(v.type), 1);
        this.directive(`DS   ${size}`);
      }
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
  __o_mul_u16: `
__o_mul_u16:
    MOV   B,H
    MOV   C,L
    LXI   H,0
    MVI   A,16
.Lmulloop:
    DAD   H
    XCHG
    DAD   H
    XCHG
    JNC   .Lmulskip
    DAD   B
.Lmulskip:
    DCR   A
    JNZ   .Lmulloop
    RET
`,
  __o_div_u16: `
__o_div_u16:
    MOV   B,D
    MOV   C,E
    LXI   D,0
    MVI   A,16
    STA   __o_div_cnt
.Ldivloop:
    DAD   H
    MOV   A,E
    RAL
    MOV   E,A
    MOV   A,D
    RAL
    MOV   D,A
    MOV   A,E
    SUB   C
    MOV   E,A
    MOV   A,D
    SBB   B
    MOV   D,A
    JC    .Ldivrestore
    INR   L
    JMP   .Ldivnext
.Ldivrestore:
    MOV   A,E
    ADD   C
    MOV   E,A
    MOV   A,D
    ADC   B
    MOV   D,A
.Ldivnext:
    LDA   __o_div_cnt
    DCR   A
    STA   __o_div_cnt
    JNZ   .Ldivloop
    RET

__o_div_cnt:
    DS    1
`,
  __o_shl_u16: `
__o_shl_u16:
    MOV   A,L
    ANI   0Fh
    RZ
    XCHG
    MOV   B,A
.Lshlloop:
    DAD   H
    DCR   B
    JNZ   .Lshlloop
    RET
`,
  __o_shr_u16: `
__o_shr_u16:
    MOV   A,L
    ANI   0Fh
    RZ
    XCHG
    MOV   B,A
.Lshrloop:
    MOV   A,H
    ORA   A
    RAR
    MOV   H,A
    MOV   A,L
    RAR
    MOV   L,A
    DCR   B
    JNZ   .Lshrloop
    RET
`,
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

function emitInitializerData(out: Emitter, type: CType, init: InitializerValue): void {
  if (init.kind === "expr") {
    const e = init.expr;
    // String literal initializing a char array: emit DB "text", 0.
    if (e.kind === "const" && typeof e.value === "string") {
      out.directiveRaw(`DB   ${encodeDbString(e.value)}, 0`);
      const declared = typeSize(type);
      const actual = e.value.length + 1;
      if (declared > actual) out.directiveRaw(`DS   ${declared - actual}`);
      return;
    }
    const v = foldConst(e);
    if (v === null) {
      out.directiveRaw(`DS   ${Math.max(typeSize(type), 1)}   ; non-constant initializer dropped`);
      return;
    }
    emitScalarBytes(out, type, v);
    return;
  }
  // List initializer.
  if (type.kind === "array") {
    let emitted = 0;
    for (const item of init.items) {
      emitInitializerData(out, type.of, item);
      emitted += Math.max(typeSize(type.of), 1);
    }
    const total = Math.max(typeSize(type), 1);
    if (total > emitted) out.directiveRaw(`DS   ${total - emitted}`);
    return;
  }
  // Non-array list initializer: emit each element as a bigint if constant.
  for (const item of init.items) {
    if (item.kind === "expr") {
      const v = foldConst(item.expr);
      if (v !== null) emitScalarBytes(out, { kind: "base", base: "int" }, v);
      else out.directiveRaw(`DW   0   ; non-const item`);
    }
  }
}

function emitScalarBytes(out: Emitter, type: CType, value: bigint): void {
  const size = Math.max(typeSize(type), 1);
  if (size === 1) out.directiveRaw(`DB   ${(Number(value) & 0xff)}`);
  else if (size === 2) out.directiveRaw(`DW   ${Number(value) & 0xffff}`);
  else {
    // Multi-byte: split into bytes, little-endian.
    const parts: string[] = [];
    let v = value;
    for (let i = 0; i < size; i++) { parts.push(String(Number(v & 0xffn))); v = v >> 8n; }
    out.directiveRaw(`DB   ${parts.join(", ")}`);
  }
}

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
