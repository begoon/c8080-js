import type { CType, CVariable, CFunction } from "./ast.ts";

export type Scope = {
  readonly variables: Map<string, CVariable>;
  readonly typedefs: Map<string, CType>;
  readonly structTags: Map<string, CType>;
};

function emptyScope(): Scope {
  return { variables: new Map(), typedefs: new Map(), structTags: new Map() };
}

export class SymbolTable {
  private readonly stack: Scope[] = [emptyScope()];
  readonly functions = new Map<string, CFunction>();

  pushScope(): void { this.stack.push(emptyScope()); }
  popScope(): void { if (this.stack.length > 1) this.stack.pop(); }

  declareVariable(v: CVariable): void {
    this.top().variables.set(v.name, v);
  }

  lookupVariable(name: string): CVariable | null {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const v = this.stack[i]!.variables.get(name);
      if (v !== undefined) return v;
    }
    return null;
  }

  declareTypedef(name: string, type: CType): void {
    this.top().typedefs.set(name, type);
  }

  lookupTypedef(name: string): CType | null {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const t = this.stack[i]!.typedefs.get(name);
      if (t !== undefined) return t;
    }
    return null;
  }

  hasTypedef(name: string): boolean {
    return this.lookupTypedef(name) !== null;
  }

  declareFunction(f: CFunction): void {
    this.functions.set(f.name, f);
    // Also register as a variable so calls can resolve it uniformly.
    this.stack[0]!.variables.set(f.name, {
      name: f.name, type: f.type, pos: f.pos,
      storage: "global", address: null, linkFile: null,
    });
  }

  declareStruct(name: string, type: CType): void {
    this.top().structTags.set(name, type);
  }

  lookupStruct(name: string): CType | null {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const t = this.stack[i]!.structTags.get(name);
      if (t !== undefined) return t;
    }
    return null;
  }

  isAtGlobalScope(): boolean {
    return this.stack.length === 1;
  }

  private top(): Scope {
    return this.stack[this.stack.length - 1]!;
  }
}
