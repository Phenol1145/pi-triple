// 源适配器接口（spec §4）：v1 仅仓库 docs 一个实现；接口源无关，
// 未来会话源/外部源（agent-reach）加适配器即可。

export interface SourceDoc {
  relPath: string;      // 相对源根的路径（/ 分隔）
  title: string;        // 首个 `# ` 标题；缺省回退文件名去扩展名；`|` 已替换为 `／`
  firstPara: string;    // 标题后首个非空段落（≤500 字符）；`|` 已替换为 `／`
  contentHash: string;  // sha256(全文)
}

export interface IngestSource {
  list(): SourceDoc[];
}
