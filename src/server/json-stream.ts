/**
 * 规划35 P4：从**流式文本**里增量取出「完整的区块对象」。
 *
 * 模型的 JSON 是一个整体（{"version":1,"blocks":[{...},{...}]}），token 级别永远是不完整的，
 * 所以渲染边界不是 token，而是「数组里第 N 个对象闭合的那一刻」。
 *
 * 这个扫描器只做一件事：在 blocks 数组里，每闭合一个元素就 JSON.parse 一次交给调用方；
 * 字符串、转义、嵌套对象/数组都按 JSON 语法处理，**不猜、不修补半截 JSON**。
 */
export class BlocksScanner {
  private buffer = "";
  private cursor = 0;
  private phase: "seek" | "array" | "done" = "seek";
  private depth = 0;
  private elementStart = -1;
  private inString = false;
  private escaped = false;

  /** 喂一段文本，返回这次新闭合的区块（可能 0 个或多个）。 */
  push(chunk: string): readonly unknown[] {
    if (this.phase === "done") return [];
    this.buffer += chunk;
    const out: unknown[] = [];
    this.advance(out);
    return out;
  }

  /** 流结束时是否还有未闭合的内容（数组没走到 `]`）。 */
  get incomplete(): boolean { return this.phase !== "done"; }

  private advance(out: unknown[]): void {
    for (; this.cursor < this.buffer.length; this.cursor += 1) {
      const char = this.buffer[this.cursor]!;
      if (this.phase === "seek") {
        if (char !== "[") continue;
        const head = this.buffer.slice(Math.max(0, this.cursor - 32), this.cursor);
        if (!/"?blocks"?\s*:\s*$/.test(head)) continue;
        this.phase = "array";
        this.depth = 0;
        continue;
      }
      if (this.phase !== "array") return;
      if (this.inString) {
        if (this.escaped) { this.escaped = false; continue; }
        if (char === "\\") { this.escaped = true; continue; }
        if (char === "\"") this.inString = false;
        continue;
      }
      if (char === "\"") { this.inString = true; continue; }
      if (char === "{" || char === "[") {
        if (this.depth === 0) this.elementStart = this.cursor;
        this.depth += 1;
        continue;
      }
      if (char === "}" || char === "]") {
        if (this.depth === 0) { this.phase = "done"; return; }
        this.depth -= 1;
        if (this.depth === 0 && this.elementStart >= 0) {
          const slice = this.buffer.slice(this.elementStart, this.cursor + 1);
          this.elementStart = -1;
          try { out.push(JSON.parse(slice)); } catch { /* 半截或非法：不渲染，最终整页仍要过 parseSpec */ }
        }
        continue;
      }
    }
  }
}
