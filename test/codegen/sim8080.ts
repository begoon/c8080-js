// Minimal 8080 simulator for running compiled programs inside tests.
// Covers the instruction set the current codegen emits.

export type SimResult = {
  readonly hl: number;
  readonly a: number;
  readonly steps: number;
  readonly memory: Uint8Array;
  readonly output: string;
};

class Cpu {
  mem = new Uint8Array(65536);
  pc = 0; sp = 0xff00;
  a = 0; b = 0; c = 0; d = 0; e = 0; h = 0; l = 0;
  zf = false; cf = false; sf = false;

  hl(): number { return (this.h << 8) | this.l; }
  de(): number { return (this.d << 8) | this.e; }
  bc(): number { return (this.b << 8) | this.c; }
  setHL(v: number): void { v &= 0xffff; this.h = v >> 8; this.l = v & 0xff; }
  setDE(v: number): void { v &= 0xffff; this.d = v >> 8; this.e = v & 0xff; }
  setBC(v: number): void { v &= 0xffff; this.b = v >> 8; this.c = v & 0xff; }

  readByte(a: number): number { return this.mem[a & 0xffff]!; }
  readWord(a: number): number { return this.mem[a]! | (this.mem[a + 1]! << 8); }
  writeByte(a: number, v: number): void { this.mem[a & 0xffff] = v & 0xff; }
  writeWord(a: number, v: number): void { this.mem[a] = v & 0xff; this.mem[a + 1] = (v >> 8) & 0xff; }

  fetch(): number { return this.mem[this.pc++]!; }
  fetchWord(): number { const v = this.readWord(this.pc); this.pc += 2; return v; }

  pushWord(v: number): void { this.sp = (this.sp - 2) & 0xffff; this.writeWord(this.sp, v); }
  popWord(): number { const v = this.readWord(this.sp); this.sp = (this.sp + 2) & 0xffff; return v; }

  setFlagsByte(v: number): void {
    this.zf = (v & 0xff) === 0;
    this.sf = (v & 0x80) !== 0;
  }
  setFlagsByteCarry(v: number): void {
    this.cf = v > 0xff || v < 0;
    this.setFlagsByte(v);
  }

  step(): boolean {
    const opcode = this.fetch();
    switch (opcode) {
      case 0x00: return true;
      case 0xC3: this.pc = this.fetchWord(); return true;
      case 0xCA: { const a = this.fetchWord(); if (this.zf) this.pc = a; return true; }
      case 0xC2: { const a = this.fetchWord(); if (!this.zf) this.pc = a; return true; }
      case 0xDA: { const a = this.fetchWord(); if (this.cf) this.pc = a; return true; }
      case 0xD2: { const a = this.fetchWord(); if (!this.cf) this.pc = a; return true; }
      case 0xFA: { const a = this.fetchWord(); if (this.sf) this.pc = a; return true; }
      case 0xF2: { const a = this.fetchWord(); if (!this.sf) this.pc = a; return true; }
      case 0xCD: { const a = this.fetchWord(); this.pushWord(this.pc); this.pc = a; return true; }
      case 0xC9: this.pc = this.popWord(); return true;
      case 0x21: this.l = this.fetch(); this.h = this.fetch(); return true;
      case 0x11: this.e = this.fetch(); this.d = this.fetch(); return true;
      case 0x01: this.c = this.fetch(); this.b = this.fetch(); return true;
      case 0x31: this.sp = this.fetchWord(); return true;
      case 0x3A: this.a = this.readByte(this.fetchWord()); return true;
      case 0x32: this.writeByte(this.fetchWord(), this.a); return true;
      case 0x2A: { const addr = this.fetchWord(); this.l = this.readByte(addr); this.h = this.readByte(addr + 1); return true; }
      case 0x22: { const addr = this.fetchWord(); this.writeByte(addr, this.l); this.writeByte(addr + 1, this.h); return true; }
      case 0x3E: this.a = this.fetch(); return true;
      case 0x06: this.b = this.fetch(); return true;
      case 0x0E: this.c = this.fetch(); return true;
      case 0x16: this.d = this.fetch(); return true;
      case 0x1E: this.e = this.fetch(); return true;
      case 0x26: this.h = this.fetch(); return true;
      case 0x2E: this.l = this.fetch(); return true;
      case 0x36: this.writeByte(this.hl(), this.fetch()); return true;
      case 0x09: { const v = this.hl() + this.bc(); this.cf = v > 0xffff; this.setHL(v); return true; }
      case 0x19: { const v = this.hl() + this.de(); this.cf = v > 0xffff; this.setHL(v); return true; }
      case 0x29: { const v = this.hl() + this.hl(); this.cf = v > 0xffff; this.setHL(v); return true; }
      case 0xE5: this.pushWord(this.hl()); return true;
      case 0xD5: this.pushWord(this.de()); return true;
      case 0xC5: this.pushWord(this.bc()); return true;
      case 0xE1: this.setHL(this.popWord()); return true;
      case 0xD1: this.setDE(this.popWord()); return true;
      case 0xC1: this.setBC(this.popWord()); return true;
      case 0xF5: { // PUSH PSW (A + flags)
        let flags = 0x02; // reserved bit
        if (this.sf) flags |= 0x80;
        if (this.zf) flags |= 0x40;
        if (this.cf) flags |= 0x01;
        this.pushWord((this.a << 8) | flags);
        return true;
      }
      case 0xF1: { // POP PSW
        const w = this.popWord();
        const flags = w & 0xff;
        this.a = (w >> 8) & 0xff;
        this.sf = (flags & 0x80) !== 0;
        this.zf = (flags & 0x40) !== 0;
        this.cf = (flags & 0x01) !== 0;
        return true;
      }
      case 0x2F: this.a = (~this.a) & 0xff; return true;
      case 0xEB: { const h = this.h, l = this.l; this.h = this.d; this.l = this.e; this.d = h; this.e = l; return true; }
      case 0x23: this.setHL(this.hl() + 1); return true;
      case 0x13: this.setDE(this.de() + 1); return true;
      case 0x03: this.setBC(this.bc() + 1); return true;
      case 0x2B: this.setHL(this.hl() - 1); return true;
      case 0x1B: this.setDE(this.de() - 1); return true;
      case 0x0B: this.setBC(this.bc() - 1); return true; // DCX B
      case 0x17: { // RAL: A = (A << 1) | CF; new CF = old bit 7
        const oldCF = this.cf ? 1 : 0;
        this.cf = (this.a & 0x80) !== 0;
        this.a = ((this.a << 1) | oldCF) & 0xff;
        return true;
      }
      case 0x1F: { // RAR: A = (A >> 1) | (CF << 7); new CF = old bit 0
        const oldCF = this.cf ? 0x80 : 0;
        this.cf = (this.a & 0x01) !== 0;
        this.a = (this.a >> 1) | oldCF;
        return true;
      }
      case 0x07: { // RLC
        this.cf = (this.a & 0x80) !== 0;
        this.a = ((this.a << 1) | (this.cf ? 1 : 0)) & 0xff;
        return true;
      }
      case 0x0F: { // RRC
        this.cf = (this.a & 0x01) !== 0;
        this.a = (this.a >> 1) | (this.cf ? 0x80 : 0);
        return true;
      }
      case 0xE6: { this.a = this.a & this.fetch(); this.cf = false; this.setFlagsByte(this.a); return true; } // ANI
      case 0xF6: { this.a = this.a | this.fetch(); this.cf = false; this.setFlagsByte(this.a); return true; } // ORI
      case 0xEE: { this.a = this.a ^ this.fetch(); this.cf = false; this.setFlagsByte(this.a); return true; } // XRI
      case 0xC6: { const r = this.a + this.fetch(); this.setFlagsByteCarry(r); this.a = r & 0xff; return true; } // ADI
      case 0xD6: { const r = this.a - this.fetch(); this.setFlagsByteCarry(r); this.a = r & 0xff; return true; } // SUI
      case 0xCE: { const r = this.a + this.fetch() + (this.cf ? 1 : 0); this.setFlagsByteCarry(r); this.a = r & 0xff; return true; } // ACI
      case 0xDE: { const r = this.a - this.fetch() - (this.cf ? 1 : 0); this.setFlagsByteCarry(r); this.a = r & 0xff; return true; } // SBI
      case 0xFE: { const r = this.a - this.fetch(); this.setFlagsByteCarry(r); return true; } // CPI
      case 0x04: this.b = (this.b + 1) & 0xff; this.setFlagsByte(this.b); return true; // INR B
      case 0x0C: this.c = (this.c + 1) & 0xff; this.setFlagsByte(this.c); return true;
      case 0x14: this.d = (this.d + 1) & 0xff; this.setFlagsByte(this.d); return true;
      case 0x1C: this.e = (this.e + 1) & 0xff; this.setFlagsByte(this.e); return true;
      case 0x24: this.h = (this.h + 1) & 0xff; this.setFlagsByte(this.h); return true;
      case 0x2C: this.l = (this.l + 1) & 0xff; this.setFlagsByte(this.l); return true;
      case 0x3C: this.a = (this.a + 1) & 0xff; this.setFlagsByte(this.a); return true; // INR A
      case 0x05: this.b = (this.b - 1) & 0xff; this.setFlagsByte(this.b); return true; // DCR B
      case 0x0D: this.c = (this.c - 1) & 0xff; this.setFlagsByte(this.c); return true;
      case 0x15: this.d = (this.d - 1) & 0xff; this.setFlagsByte(this.d); return true;
      case 0x1D: this.e = (this.e - 1) & 0xff; this.setFlagsByte(this.e); return true;
      case 0x25: this.h = (this.h - 1) & 0xff; this.setFlagsByte(this.h); return true;
      case 0x2D: this.l = (this.l - 1) & 0xff; this.setFlagsByte(this.l); return true;
      case 0x3D: this.a = (this.a - 1) & 0xff; this.setFlagsByte(this.a); return true; // DCR A
      case 0xC0: if (!this.zf) { this.pc = this.popWord(); } return true; // RNZ
      case 0xC8: if (this.zf) { this.pc = this.popWord(); } return true; // RZ
      case 0xD0: if (!this.cf) { this.pc = this.popWord(); } return true; // RNC
      case 0xD8: if (this.cf) { this.pc = this.popWord(); } return true; // RC
      case 0xF0: if (!this.sf) { this.pc = this.popWord(); } return true; // RP
      case 0xF8: if (this.sf) { this.pc = this.popWord(); } return true; // RM
    }
    if (opcode >= 0x40 && opcode <= 0x7f && opcode !== 0x76) {
      const dst = (opcode >> 3) & 7;
      const src = opcode & 7;
      const getReg = (r: number): number => r === 0 ? this.b : r === 1 ? this.c : r === 2 ? this.d :
        r === 3 ? this.e : r === 4 ? this.h : r === 5 ? this.l : r === 6 ? this.readByte(this.hl()) : this.a;
      const setReg = (r: number, v: number): void => {
        v &= 0xff;
        if (r === 0) this.b = v; else if (r === 1) this.c = v; else if (r === 2) this.d = v;
        else if (r === 3) this.e = v; else if (r === 4) this.h = v; else if (r === 5) this.l = v;
        else if (r === 6) this.writeByte(this.hl(), v); else this.a = v;
      };
      setReg(dst, getReg(src));
      return true;
    }
    if (opcode >= 0x80 && opcode <= 0xbf) {
      const src = opcode & 7;
      const op = (opcode >> 3) & 7;
      const getReg = (r: number): number => r === 0 ? this.b : r === 1 ? this.c : r === 2 ? this.d :
        r === 3 ? this.e : r === 4 ? this.h : r === 5 ? this.l : r === 6 ? this.readByte(this.hl()) : this.a;
      const v = getReg(src);
      switch (op) {
        case 0: { const r = this.a + v; this.setFlagsByteCarry(r); this.a = r & 0xff; return true; }
        case 1: { const r = this.a + v + (this.cf ? 1 : 0); this.setFlagsByteCarry(r); this.a = r & 0xff; return true; }
        case 2: { const r = this.a - v; this.setFlagsByteCarry(r); this.a = r & 0xff; return true; }
        case 3: { const r = this.a - v - (this.cf ? 1 : 0); this.setFlagsByteCarry(r); this.a = r & 0xff; return true; }
        case 4: { this.a = this.a & v; this.cf = false; this.setFlagsByte(this.a); return true; }
        case 5: { this.a = this.a ^ v; this.cf = false; this.setFlagsByte(this.a); return true; }
        case 6: { this.a = this.a | v; this.cf = false; this.setFlagsByte(this.a); return true; }
        case 7: { const r = this.a - v; this.setFlagsByteCarry(r); return true; }
      }
    }
    return false;
  }
}

export function simulate(binary: Uint8Array, entry = 0x0100, maxSteps = 200_000): SimResult {
  const cpu = new Cpu();
  for (let i = 0; i < binary.length; i++) cpu.mem[i] = binary[i]!;
  cpu.pc = entry;
  cpu.sp = 0xff00;
  const sentinel = 0xdead;
  cpu.pushWord(sentinel);

  const outputBytes: number[] = [];
  let steps = 0;
  while (cpu.pc !== sentinel) {
    // CP/M BDOS trap at 0x0005.
    if (cpu.pc === 0x0005) {
      bdosCall(cpu, outputBytes);
      cpu.pc = cpu.popWord();
      steps++;
      continue;
    }
    if (!cpu.step()) {
      const op = cpu.mem[cpu.pc - 1]!;
      throw new Error(`unhandled opcode 0x${op.toString(16)} at PC=0x${(cpu.pc - 1).toString(16)}`);
    }
    if (++steps > maxSteps) throw new Error(`runaway after ${maxSteps} steps`);
  }
  return {
    hl: cpu.hl(), a: cpu.a, steps, memory: cpu.mem,
    output: String.fromCharCode(...outputBytes),
  };
}

function bdosCall(cpu: Cpu, output: number[]): void {
  switch (cpu.c) {
    case 2: // console output: print char in E
      output.push(cpu.e);
      return;
    case 9: { // print $-terminated string at DE
      let addr = cpu.de();
      for (let i = 0; i < 65536; i++) {
        const ch = cpu.mem[addr]!;
        if (ch === 0x24 /* $ */) return;
        output.push(ch);
        addr = (addr + 1) & 0xffff;
      }
      return;
    }
    default:
      throw new Error(`unsupported BDOS call C=${cpu.c}`);
  }
}
