export type SrcPos = { readonly file: string; readonly line: number; readonly column: number };

export type BaseType =
  | "void"
  | "bool"
  | "char"
  | "schar"
  | "uchar"
  | "short"
  | "ushort"
  | "int"
  | "uint"
  | "long"
  | "ulong"
  | "llong"
  | "ullong"
  | "float"
  | "double";

export type StructField = {
  readonly name: string;
  readonly type: CType;
  readonly offset: number;
};

export type CType =
  | { readonly kind: "base"; readonly base: BaseType }
  | { readonly kind: "pointer"; readonly to: CType }
  | { readonly kind: "array"; readonly of: CType; readonly length: number | null }
  | { readonly kind: "struct"; readonly name: string; readonly fields: readonly StructField[] | null; readonly size: number }
  | { readonly kind: "function"; readonly ret: CType; readonly params: readonly CType[] };

export type CNode =
  | { readonly kind: "const"; readonly pos: SrcPos; readonly type: CType; readonly value: bigint | string }
  | { readonly kind: "var"; readonly pos: SrcPos; readonly name: string; readonly resolved: CVariable | null }
  | { readonly kind: "load"; readonly pos: SrcPos; readonly target: CNode }
  | { readonly kind: "assign"; readonly pos: SrcPos; readonly target: CNode; readonly value: CNode }
  | { readonly kind: "unary"; readonly pos: SrcPos; readonly op: UnaryOp; readonly arg: CNode }
  | { readonly kind: "binary"; readonly pos: SrcPos; readonly op: BinaryOp; readonly lhs: CNode; readonly rhs: CNode }
  | { readonly kind: "call"; readonly pos: SrcPos; readonly target: CNode; readonly args: readonly CNode[] }
  | { readonly kind: "member"; readonly pos: SrcPos; readonly object: CNode; readonly field: string; readonly arrow: boolean }
  | { readonly kind: "if"; readonly pos: SrcPos; readonly cond: CNode; readonly then: CNode; readonly else: CNode | null }
  | { readonly kind: "while"; readonly pos: SrcPos; readonly cond: CNode; readonly body: CNode }
  | { readonly kind: "do"; readonly pos: SrcPos; readonly body: CNode; readonly cond: CNode }
  | { readonly kind: "for"; readonly pos: SrcPos; readonly init: CNode | null; readonly cond: CNode | null; readonly step: CNode | null; readonly body: CNode }
  | { readonly kind: "block"; readonly pos: SrcPos; readonly stmts: readonly CNode[] }
  | { readonly kind: "return"; readonly pos: SrcPos; readonly value: CNode | null }
  | { readonly kind: "break"; readonly pos: SrcPos }
  | { readonly kind: "continue"; readonly pos: SrcPos }
  | { readonly kind: "goto"; readonly pos: SrcPos; readonly label: string }
  | { readonly kind: "label"; readonly pos: SrcPos; readonly name: string }
  | { readonly kind: "asm"; readonly pos: SrcPos; readonly text: string }
  | { readonly kind: "switch"; readonly pos: SrcPos; readonly expr: CNode; readonly body: CNode }
  | { readonly kind: "case"; readonly pos: SrcPos; readonly value: CNode }
  | { readonly kind: "default"; readonly pos: SrcPos }
  | { readonly kind: "pushPop"; readonly pos: SrcPos; readonly regs: readonly CNode[]; readonly body: CNode };

export type UnaryOp = "neg" | "not" | "bnot" | "addr" | "deref" | "preinc" | "predec" | "postinc" | "postdec";
export type BinaryOp =
  | "add" | "sub" | "mul" | "div" | "mod"
  | "shl" | "shr" | "and" | "or" | "xor"
  | "eq" | "ne" | "lt" | "le" | "gt" | "ge"
  | "logand" | "logor"
  | "comma";

export type InitializerValue =
  | { readonly kind: "expr"; readonly expr: CNode }
  | { readonly kind: "list"; readonly items: readonly InitializerValue[] };

export type CVariable = {
  readonly name: string;
  readonly type: CType;
  readonly storage: "auto" | "static" | "extern" | "global" | "stack";
  readonly address: number | null;
  readonly linkFile: string | null;
  readonly pos: SrcPos;
  readonly initializer: InitializerValue | null;
};

export type CFunction = {
  readonly name: string;
  readonly type: CType;
  readonly params: readonly CVariable[];
  readonly locals: readonly CVariable[];
  readonly body: CNode | null;
  readonly storage: "global" | "stack";
  readonly pos: SrcPos;
};

export type CProgram = {
  readonly globals: readonly CVariable[];
  readonly functions: readonly CFunction[];
  readonly cmm: boolean;
};
