// EBNF v1 子集解析器与校验器（手写，零依赖）。
//
// 语法（v1 子集，行级简化——生产式按行拆，`=` 前为名字，`;` 终止）：
//   production := name, "=", expr, ";" ;
//   expr       := term, {"|", term} ;            -- choice
//   term       := factor, {(",",) factor} ;      -- seq（`,` 或并列 = 顺序匹配）
//   factor     := atom, {atom} ;
//   atom       := name | "\"" text "\"" | "(" expr ")"
//               | name, ("*" | "+" | "?") | name, "(*", note, "*)" ;
//   note       := text;                          -- 值约束注解：(* min=0 max=1 *) 等
//   `--` 到行尾为注释（字符串字面量内不识别）。
//
// token 流（校验输入）：按行拆分（每行一个 token），行内按 "|" 拆分字段。
//
// AST 编码（EbnfExpr）：
//   - 叶子原子（名字 / 字符串字面量）→ { kind: "seq", value }（无 children）
//   - `?` 后缀 → { kind: "optional", value }
//   - `*` / `+` 后缀 → { kind: "repeat", value, min, max }（min=0/1，max 不定义）
//   - 注解 `(* min=.. max=.. *)` → { kind: "repeat", value, min, max }
//     （min/max 既是重复次数上下界，也是数值范围；仅 max 已定义时做数值范围校验，
//       以此区分 `*`/`+` 后缀与注解来源）
//   - `|` 顶层 → { kind: "choice", children }；`,` 或并列 → { kind: "seq", children }
//   - 特殊字面量：`"|"` = 字段分隔符（校验时跳过）；`"?"`/`"*"`/`"+"` = 前置因子的后缀

export interface EbnfValue { kind: "terminal" | "nonterminal" | "string" | "number" | "any" | "ref"; value: string; }
export interface EbnfExpr {
  kind: "choice" | "seq" | "repeat" | "optional";
  children?: EbnfExpr[];
  value?: EbnfValue;
  min?: number; max?: number;       // repeat: (* + ?) 与 (* min=0 max=1 *) 注解
}
export interface EbnfProduction { name: string; expr: EbnfExpr; line: number; }
export interface EbnfGrammar { productions: EbnfProduction[]; }
export interface EbnfParseError { message: string; line: number; column: number; }

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

// 行内 `--` 注释剥离（字符串字面量内不识别）
function stripComment(line: string): string {
  let inStr = false;
  for (let i = 0; i < line.length - 1; i++) {
    const c = line[i];
    if (c === '"') inStr = !inStr;
    if (!inStr && c === "-" && line[i + 1] === "-") return line.slice(0, i);
  }
  return line;
}

// 行级语法解析器（一个生产式 = 一行）
class LineParser {
  private s: string;
  private name: string;
  private lineNo: number;
  private errors: EbnfParseError[];
  private pos = 0;

  constructor(s: string, name: string, lineNo: number, errors: EbnfParseError[]) {
    this.s = s;
    this.name = name;
    this.lineNo = lineNo;
    this.errors = errors;
  }

  private err(message: string, column: number): null {
    this.errors.push({ message: `${this.name}: ${message}`, line: this.lineNo, column });
    return null;
  }

  private skipWs(): void {
    while (this.pos < this.s.length && " \t\r\n".includes(this.s[this.pos])) this.pos++;
  }

  private peek(): string | undefined {
    return this.s[this.pos];
  }

  private atEnd(): boolean {
    return this.pos >= this.s.length;
  }

  parseProductionBody(): EbnfExpr | null {
    const expr = this.parseExpr();
    if (!expr) return null;
    this.skipWs();
    if (this.atEnd()) return this.err("缺少 ';' 终止符", this.s.length + 1);
    if (this.s[this.pos] !== ";") return this.err(`期望 ';'，实际为 '${this.s[this.pos]}'`, this.pos + 1);
    this.pos++; // 消费 ';'
    this.skipWs();
    if (!this.atEnd()) return this.err(`';' 后有多余内容 "${this.s.slice(this.pos)}"`, this.pos + 1);
    return expr;
  }

  // expr := term, {"|", term}
  private parseExpr(): EbnfExpr | null {
    const first = this.parseTerm();
    if (!first) return null;
    const terms: EbnfExpr[] = [first];
    while (true) {
      this.skipWs();
      if (this.peek() !== "|") break;
      this.pos++;
      const t = this.parseTerm();
      if (!t) return null;
      terms.push(t);
    }
    return terms.length === 1 ? terms[0] : { kind: "choice", children: terms };
  }

  // term := factor, {(",",) factor}   （`?`/`*`/`+` 为前一因子的后缀）
  private parseTerm(): EbnfExpr | null {
    const factors: EbnfExpr[] = [];
    let expectFactor = false;
    while (true) {
      this.skipWs();
      const ch = this.peek();
      if (ch === undefined || ch === "|" || ch === ";" || ch === ")") {
        if (expectFactor) return this.err("逗号后缺少因子", this.pos + 1);
        break;
      }
      if (ch === ",") {
        if (factors.length === 0) return this.err("表达式不能以 ',' 开头", this.pos + 1);
        this.pos++;
        expectFactor = true;
        continue;
      }
      if ((ch === "?" || ch === "*" || ch === "+") && factors.length > 0) {
        const wrapped = this.postfix(factors[factors.length - 1], ch, this.pos + 1);
        if (!wrapped) return null;
        factors[factors.length - 1] = wrapped;
        this.pos++;
        expectFactor = false;
        continue;
      }
      const f = this.parseFactor();
      if (!f) return null;
      // 引号后缀：`"?"`/`"*"`/`"+"` 作为独立因子时，作用于前一因子
      if (isPostfixLiteral(f)) {
        if (factors.length === 0) return this.err(`后缀 "${f.value!.value}" 缺少前置因子`, this.pos);
        const wrapped = this.postfix(factors[factors.length - 1], f.value!.value, this.pos);
        if (!wrapped) return null;
        factors[factors.length - 1] = wrapped;
        expectFactor = false;
        continue;
      }
      factors.push(f);
      expectFactor = false;
    }
    if (factors.length === 0) return this.err("期望表达式", this.pos + 1);
    return factors.length === 1 ? factors[0] : { kind: "seq", children: factors };
  }

  private postfix(target: EbnfExpr, op: string, column: number): EbnfExpr | null {
    if (!target.value) return this.err(`后缀 "${op}" 只能作用于名字原子`, column);
    if (op === "?") return { kind: "optional", value: target.value };
    return { kind: "repeat", value: target.value, min: op === "+" ? 1 : 0 };
  }

  // factor := atom
  private parseFactor(): EbnfExpr | null {
    this.skipWs();
    const ch = this.peek();
    if (ch === undefined) return this.err("期望因子，实际为行尾", this.pos + 1);
    let atom: EbnfExpr;
    if (ch === '"') {
      atom = { kind: "seq", value: { kind: "terminal", value: this.parseString() } };
    } else if (ch === "(") {
      this.pos++;
      const inner = this.parseExpr();
      this.skipWs();
      if (this.peek() === ")") this.pos++;
      else this.err("缺少 ')'", this.pos + 1);
      if (!inner) return null;
      atom = inner;
    } else if (ch !== undefined && /[A-Za-z_]/.test(ch)) {
      atom = this.parseAtomName();
    } else {
      return this.err(`期望因子，实际为 '${ch}'`, this.pos + 1);
    }
    // 注解：name "(*" note "*)"（只允许跟在名字原子后）
    this.skipWs();
    if (this.peek() === "(" && this.s[this.pos + 1] === "*") {
      if (!atom.value || atom.value.kind === "terminal") {
        this.err("注解 (* ... *) 只能跟在名字原子后", this.pos + 1);
        this.skipAnnotation();
        return atom;
      }
      const mm = this.parseAnnotation();
      if (mm) atom = { kind: "repeat", value: atom.value, min: mm.min, max: mm.max };
      return atom;
    }
    return atom;
  }

  private parseAtomName(): EbnfExpr {
    const m = NAME_RE.exec(this.s.slice(this.pos))!;
    this.pos += m[0].length;
    const name = m[0];
    let kind: EbnfValue["kind"] = "nonterminal";
    if (name === "number") kind = "number";
    else if (name === "string") kind = "string";
    else if (name === "any") kind = "any";
    // "word" 等未定义名字 → nonterminal；校验时未找到生产式则按内置语义（word = 非空 token）
    return { kind: "seq", value: { kind, value: name } };
  }

  private parseString(): string {
    const start = this.pos;
    this.pos++; // 跳过开引号
    let out = "";
    while (this.pos < this.s.length && this.s[this.pos] !== '"') {
      out += this.s[this.pos];
      this.pos++;
    }
    if (this.pos >= this.s.length) this.err("未闭合的字符串字面量", start + 1);
    else this.pos++; // 闭引号
    return out;
  }

  // (* min=0 max=1 *) —— 提取 min/max（数值范围 / 重复次数上下界）
  private parseAnnotation(): { min?: number; max?: number } | null {
    this.pos += 2; // "(*"
    const start = this.pos;
    while (this.pos < this.s.length) {
      if (this.s[this.pos] === "*" && this.s[this.pos + 1] === ")") break;
      this.pos++;
    }
    if (this.pos >= this.s.length) {
      this.err("注解缺少 '*)'", start + 1);
      return null;
    }
    const note = this.s.slice(start, this.pos);
    this.pos += 2; // "*)"
    const minM = /min\s*=\s*(-?\d+(?:\.\d+)?)/.exec(note);
    const maxM = /max\s*=\s*(-?\d+(?:\.\d+)?)/.exec(note);
    return {
      ...(minM ? { min: Number(minM[1]) } : {}),
      ...(maxM ? { max: Number(maxM[1]) } : {}),
    };
  }

  private skipAnnotation(): void {
    // 注解非法时：跳到 "*)"
    while (this.pos < this.s.length) {
      if (this.s[this.pos] === "*" && this.s[this.pos + 1] === ")") {
        this.pos += 2;
        return;
      }
      this.pos++;
    }
  }
}

function isPostfixLiteral(expr: EbnfExpr): boolean {
  return expr.value?.kind === "terminal" && (expr.value.value === "?" || expr.value.value === "*" || expr.value.value === "+");
}

export function parseEbnf(text: string): { ok: true; grammar: EbnfGrammar } | { ok: false; errors: EbnfParseError[] } {
  const errors: EbnfParseError[] = [];
  const productions: EbnfProduction[] = [];
  const names = new Set<string>();
  const lines = text.split("\n");
  for (let idx = 0; idx < lines.length; idx++) {
    const lineNo = idx + 1;
    const line = stripComment(lines[idx]);
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) {
      if (line.trim() !== "") {
        errors.push({ message: "无法识别生产式（期望 name = expr ;）", line: lineNo, column: 1 });
      }
      continue;
    }
    const name = m[1];
    if (names.has(name)) {
      errors.push({ message: `重复的生产式 "${name}"`, line: lineNo, column: line.indexOf(name) + 1 });
      continue;
    }
    names.add(name);
    const p = new LineParser(m[2], name, lineNo, errors);
    const expr = p.parseProductionBody();
    if (expr) productions.push({ name, expr, line: lineNo });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, grammar: { productions } };
}

// ---------------- 校验 ----------------

const NUM_RE = /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/;

interface Ctx { prods: Map<string, EbnfProduction>; errors: string[]; entry: string; label: string; }
interface MRes { ok: boolean; next: number; reason: string; value: string; }

function failRes(reason: string): MRes { return { ok: false, next: 0, reason, value: "" }; }
function okRes(next: number, value = ""): MRes { return { ok: true, next, reason: "", value }; }

function labelOf(expr: EbnfExpr): string {
  return expr.value ? expr.value.value : "表达式";
}

function isSeparator(expr: EbnfExpr): boolean {
  return expr.value?.kind === "terminal" && expr.value.value === "|";
}

// 校验语义：以 entryName 生产式为主规则，按 token 流匹配（token = 行，`|` 分隔字段）。
// 每行匹配失败即记录该行第一个错误（错误格式 `<entry>: 第 <i> 项 <field> <原因>`），
// 多行输入逐行校验收集全部行级错误。
export function validateAgainstGrammar(grammar: EbnfGrammar, entryName: string, input: string): string[] {
  const errors: string[] = [];
  const prods = new Map(grammar.productions.map((p) => [p.name, p]));
  const main = prods.get(entryName);
  if (!main) {
    errors.push(`${entryName}: 未找到主规则 "${entryName}"`);
    return errors;
  }
  const ctx: Ctx = { prods, errors, entry: entryName, label: entryName };
  for (const rawLine of input.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const fields = line.split("|").map((f) => f.trim());
    const r = matchExpr(main.expr, fields, 0, ctx, false);
    if (r.ok && r.next < fields.length) {
      errors.push(`${entryName}: 第 ${r.next + 1} 项 ${fields[r.next]} 多余`);
    }
  }
  return errors;
}

function matchExpr(expr: EbnfExpr, fields: string[], i: number, ctx: Ctx, silent: boolean): MRes {
  switch (expr.kind) {
    // 叶子原子编码为 kind="seq" 且带 value；kind="seq" 且有 children 才是序列
    case "seq": return expr.value ? matchAtom(expr, fields, i, ctx, silent) : matchSeq(expr, fields, i, ctx, silent);
    case "choice": return matchChoice(expr, fields, i, ctx, silent);
    case "repeat": return matchRepeat(expr, fields, i, ctx, silent);
    case "optional": return matchOptional(expr, fields, i, ctx, silent);
  }
}

// 原子：terminal（`"|"` 为分隔符，不消费字段）/ number / string（任意）/ any / nonterminal（递归展开或内置 word）
function matchAtom(expr: EbnfExpr, fields: string[], i: number, ctx: Ctx, silent: boolean): MRes {
  const v = expr.value!;
  if (v.kind === "terminal" && v.value === "|") return okRes(i);
  if (i >= fields.length) return failRes("缺失");
  const field = fields[i];
  switch (v.kind) {
    case "terminal": return field === v.value ? okRes(i + 1, field) : failRes(`期望 "${v.value}"`);
    case "number": return NUM_RE.test(field) ? okRes(i + 1, field) : failRes("非数值");
    case "string": return okRes(i + 1, field);   // 任意字符串
    case "any": return okRes(i + 1, field);      // 任意值
    case "nonterminal": {
      const prod = ctx.prods.get(v.value);
      if (prod) return matchExpr(prod.expr, fields, i, { ...ctx, label: v.value }, silent);
      if (v.value === "word") return field !== "" ? okRes(i + 1, field) : failRes("不能为空");
      return failRes("未定义");
    }
    case "ref": return failRes("未定义");
  }
}

function matchSeq(expr: EbnfExpr, fields: string[], i: number, ctx: Ctx, silent: boolean): MRes {
  for (const child of expr.children ?? []) {
    if (isSeparator(child)) continue; // 字段分隔符 `"|"` 不消费字段、不失败
    const r = matchExpr(child, fields, i, ctx, true);
    if (!r.ok) {
      if (!silent) ctx.errors.push(`${ctx.entry}: 第 ${i + 1} 项 ${labelOf(child)} ${r.reason}`);
      return r;
    }
    i = r.next;
  }
  return okRes(i);
}

function matchChoice(expr: EbnfExpr, fields: string[], i: number, ctx: Ctx, silent: boolean): MRes {
  for (const child of expr.children ?? []) {
    const r = matchExpr(child, fields, i, ctx, true);
    if (r.ok) return r;
  }
  if (!silent) ctx.errors.push(`${ctx.entry}: 第 ${i + 1} 项 ${ctx.label} 不匹配`);
  return failRes("不匹配");
}

// optional：字段缺失 = 可缺省；字段存在则必须匹配（否则报错）
function matchOptional(expr: EbnfExpr, fields: string[], i: number, ctx: Ctx, silent: boolean): MRes {
  if (i >= fields.length) return okRes(i);
  const r = matchAtom(expr, fields, i, ctx, true);
  if (r.ok) return r;
  if (!silent) ctx.errors.push(`${ctx.entry}: 第 ${i + 1} 项 ${expr.value!.value} ${r.reason}`);
  return r;
}

// repeat：`*`/`+` 后缀 = 重复次数上下界；注解（max 已定义）额外做数值范围校验
function matchRepeat(expr: EbnfExpr, fields: string[], i: number, ctx: Ctx, silent: boolean): MRes {
  const min = expr.min ?? 0;
  const max = expr.max;
  let count = 0;
  let j = i;
  const values: { pos: number; value: string }[] = [];
  while (max === undefined || count < max) {
    if (j >= fields.length) break;
    const r = matchAtom(expr, fields, j, ctx, true);
    if (!r.ok) break;
    values.push({ pos: j + 1, value: r.value });
    count++;
    j = r.next;
  }
  if (count < min) {
    const reason = count === 0 && j >= fields.length ? "缺失" : "数量不足";
    if (!silent) ctx.errors.push(`${ctx.entry}: 第 ${j + 1} 项 ${ctx.label} ${reason}`);
    return failRes(reason);
  }
  if (max !== undefined) {
    for (const v of values) {
      if (!NUM_RE.test(v.value)) continue;
      const n = Number(v.value);
      if ((min !== undefined && n < min) || n > max) {
        if (!silent) ctx.errors.push(`${ctx.entry}: 第 ${v.pos} 项 ${ctx.label} 超出范围`);
        return failRes("超出范围");
      }
    }
  }
  return okRes(j);
}
