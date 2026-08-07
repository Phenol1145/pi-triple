/**
 * ptl-flow when 表达式求值器（递归下降，零依赖，无 eval）
 *
 * 文法:
 *   expr       = or
 *   or         = and ("||" and)*
 *   and        = comparison ("&&" comparison)*
 *   comparison = unary (COMP_OP unary)?   COMP_OP ∈ {==,!=,>,<,>=,<=,contains,!contains}
 *   unary      = "!" unary | operand
 *   operand    = path | literal
 *   literal    = "true" | "false" | NUMBER | SINGLE_QUOTED_STR | DOUBLE_QUOTED_STR
 *
 * 语义:
 *   == / !=: 严格相等（不跨类型转换："2" ≠ 2, false ≠ 0）
 *   > < >= <=: 仅数字比较，非数字操作数抛 ExprError
 *   contains / !contains: 字符串包含（操作数都 String() 转字符串）
 *   !: 真值取反（JS 真值语义）
 *   && / ||: 短路求值 (v1 — 未包含在 when 规范中但解析器支持以备扩展)
 *
 * 静态解析（parseExpr）：语法校验 + AST 返回，schema validate 联动。
 */

// ── Tokenizer ─────────────────────────────────────────────────

type TokenKind =
  | "path" | "number" | "string" | "true" | "false"
  | "eq" | "ne" | "lt" | "gt" | "le" | "ge"
  | "contains" | "notContains"
  | "and" | "or" | "not"
  | "eof";

interface Token { kind: TokenKind; value?: string | number; }

class Lexer {
  private pos = 0;

  constructor(private src: string) {}

  next(): Token {
    this.skipWS();
    if (this.pos >= this.src.length) return { kind: "eof" };

    const ch = this.src[this.pos];

    // 字符串字面量
    if (ch === "'" || ch === '"') return this.readString(ch);
    // 数字
    if (ch >= "0" && ch <= "9") return this.readNumber();
    // 标识符 / 关键字
    if (this.isIdentStart(ch)) return this.readIdent();

    // 双字符运算符
    if (ch === "=" && this.peek() === "=") { this.pos += 2; return { kind: "eq" }; }
    if (ch === "!" && this.peek() === "=") { this.pos += 2; return { kind: "ne" }; }
    if (ch === "<" && this.peek() === "=") { this.pos += 2; return { kind: "le" }; }
    if (ch === ">" && this.peek() === "=") { this.pos += 2; return { kind: "ge" }; }
    if (ch === "&" && this.peek() === "&") { this.pos += 2; return { kind: "and" }; }
    if (ch === "|" && this.peek() === "|") { this.pos += 2; return { kind: "or" }; }

    // ! 可能是 !contains，需要前探
    if (ch === "!" && this.lookahead(2) === "co") { this.pos += 9; return { kind: "notContains" }; }

    // 单字符
    if (ch === "<") { this.pos++; return { kind: "lt" }; }
    if (ch === ">") { this.pos++; return { kind: "gt" }; }
    if (ch === "!") { this.pos++; return { kind: "not" }; }

    throw new ExprError(`Unexpected character: '${ch}' at position ${this.pos}`);
  }

  private skipWS(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos++;
  }

  private peek(): string {
    return this.pos + 1 < this.src.length ? this.src[this.pos + 1] : "";
  }

  /** 从 pos 开始匹配 len 个字符（跨空白），返回首字符 */
  private lookahead(len: number): string {
    let p = this.pos + 1;
    let out = "";
    while (p < this.src.length && out.length < len) {
      if (!/\s/.test(this.src[p])) out += this.src[p];
      p++;
    }
    return out;
  }

  private readString(quote: string): Token {
    this.pos++; // skip opening quote
    let val = "";
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === "\\" && this.pos + 1 < this.src.length) {
        this.pos++;
        val += this.src[this.pos];
      } else if (ch === quote) {
        this.pos++;
        return { kind: "string", value: val };
      } else {
        val += ch;
      }
      this.pos++;
    }
    throw new ExprError("Unterminated string literal");
  }

  private readNumber(): Token {
    let s = "";
    while (this.pos < this.src.length && this.src[this.pos] >= "0" && this.src[this.pos] <= "9") {
      s += this.src[this.pos++];
    }
    return { kind: "number", value: Number(s) };
  }

  private isIdentStart(ch: string): boolean {
    return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
  }

  private readIdent(): Token {
    let s = "";
    while (this.pos < this.src.length && /[a-zA-Z0-9_.]/.test(this.src[this.pos])) {
      s += this.src[this.pos++];
    }
    if (s.startsWith("state") && s.includes(".")) {
      return { kind: "path", value: s };
    }
    switch (s) {
      case "true": return { kind: "true" };
      case "false": return { kind: "false" };
      case "contains": return { kind: "contains" };
      default: throw new ExprError(`Unknown identifier: '${s}'`);
    }
  }
}

// ── AST ───────────────────────────────────────────────────────

type ASTNode =
  | { kind: "binary"; op: TokenKind; left: ASTNode; right: ASTNode }
  | { kind: "not"; operand: ASTNode }
  | { kind: "path"; value: string }
  | { kind: "literal"; value: boolean | number | string };

// ── Error ─────────────────────────────────────────────────────

export class ExprError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExprError";
  }
}

// ── Parser ────────────────────────────────────────────────────

class Parser {
  private lexer: Lexer;
  private token: Token;

  constructor(src: string) {
    this.lexer = new Lexer(src);
    this.token = this.lexer.next();
  }

  parse(): ASTNode {
    const node = this.parseOr();
    if (this.token.kind !== "eof") {
      throw new ExprError(
        `Unexpected token after expression: ${this.token.kind}${this.token.value !== undefined ? " (" + this.token.value + ")" : ""}`,
      );
    }
    return node;
  }

  private advance(): void { this.token = this.lexer.next(); }

  // or = and ("||" and)*
  private parseOr(): ASTNode {
    let left = this.parseAnd();
    while (this.token.kind === "or") {
      const op = this.token.kind;
      this.advance();
      left = { kind: "binary", op, left, right: this.parseAnd() };
    }
    return left;
  }

  // and = comparison ("&&" comparison)*
  private parseAnd(): ASTNode {
    let left = this.parseComparison();
    while (this.token.kind === "and") {
      const op = this.token.kind;
      this.advance();
      left = { kind: "binary", op, left, right: this.parseComparison() };
    }
    return left;
  }

  // comparison = unary (COMP_OP unary)*
  private static COMP_OPS = new Set<TokenKind>([
    "eq", "ne", "lt", "gt", "le", "ge", "contains", "notContains",
  ]);

  private parseComparison(): ASTNode {
    let left = this.parseUnary();
    while (Parser.COMP_OPS.has(this.token.kind)) {
      const op = this.token.kind;
      this.advance();
      left = { kind: "binary", op, left, right: this.parseUnary() };
    }
    return left;
  }

  // unary = "!" unary | operand
  private parseUnary(): ASTNode {
    if (this.token.kind === "not") {
      this.advance();
      return { kind: "not", operand: this.parseUnary() };
    }
    return this.parseOperand();
  }

  private parseOperand(): ASTNode {
    const tok = this.token;
    switch (tok.kind) {
      case "path":
        this.advance();
        return { kind: "path", value: tok.value as string };
      case "number":
        this.advance();
        return { kind: "literal", value: tok.value as number };
      case "string":
        this.advance();
        return { kind: "literal", value: tok.value as string };
      case "true":
        this.advance();
        return { kind: "literal", value: true };
      case "false":
        this.advance();
        return { kind: "literal", value: false };
      default:
        throw new ExprError(`Expected operand, got ${JSON.stringify(tok.kind)}`);
    }
  }
}

// ── Evaluator ─────────────────────────────────────────────────

function resolvePath(pathStr: string, state: Record<string, unknown>): unknown {
  const parts = pathStr.split("."); // "state.verdict" → ["state","verdict"]
  let val: unknown = state;
  for (let i = 1; i < parts.length; i++) {
    if (val === null || val === undefined || typeof val !== "object") return undefined;
    val = (val as Record<string, unknown>)[parts[i]];
  }
  return val;
}

function evalNode(node: ASTNode, state: Record<string, unknown>): unknown {
  switch (node.kind) {
    case "literal":
      return node.value;
    case "path":
      return resolvePath(node.value, state);
    case "not":
      return !evalNode(node.operand, state);
    case "binary": {
      const op = node.op;

      if (op === "contains" || op === "notContains") {
        const a = String(evalNode(node.left, state) ?? "");
        const b = String(evalNode(node.right, state) ?? "");
        return op === "contains" ? a.includes(b) : !a.includes(b);
      }

      const left = evalNode(node.left, state);
      const right = evalNode(node.right, state);

      switch (op) {
        case "eq": return left === right;
        case "ne": return left !== right;
        case "lt": { const [l, r] = requireNumbers(left, right, "<"); return l < r; }
        case "gt": { const [l, r] = requireNumbers(left, right, ">"); return l > r; }
        case "le": { const [l, r] = requireNumbers(left, right, "<="); return l <= r; }
        case "ge": { const [l, r] = requireNumbers(left, right, ">="); return l >= r; }
        case "and": return !!(left && right);
        case "or": return !!(left || right);
        default:
          throw new ExprError(`Unknown binary operator: ${op}`);
      }
    }
  }
}

function requireNumbers(a: unknown, b: unknown, op: string): [number, number] {
  // 数字强转：agent 输出的 state 值常为字符串数字（"99"），按业界惯例 coercion；
  // ==/!= 保持严格类型（"2" ≠ 2），仅比较运算符强转
  const na = typeof a === "number" ? a : (typeof a === "string" && a.trim() !== "" ? Number(a) : NaN);
  const nb = typeof b === "number" ? b : (typeof b === "string" && b.trim() !== "" ? Number(b) : NaN);
  if (Number.isNaN(na) || Number.isNaN(nb)) {
    throw new ExprError(`${op} requires numbers, got ${JSON.stringify(a)} and ${JSON.stringify(b)}`);
  }
  return [na, nb];
}

// ── Public API ────────────────────────────────────────────────

/**
 * 静态解析表达式（语法校验，返回 AST）。
 * schema validate 用它验证 when 字段是否可解析。
 */
export function parseExpr(expr: string): { ok: true; ast: ASTNode } | { ok: false; error: string } {
  try {
    const parser = new Parser(expr);
    const ast = parser.parse();
    return { ok: true, ast };
  } catch (err) {
    if (err instanceof ExprError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}

/**
 * 求值 when 表达式。
 * @returns boolean
 * @throws ExprError on evaluation errors (type mismatch for comparisons, etc.)
 */
export function evalExpr(expr: string, state: Record<string, unknown>): boolean {
  const parsed = parseExpr(expr);
  if (!parsed.ok) throw new ExprError(parsed.error);
  return !!evalNode(parsed.ast, state);
}
