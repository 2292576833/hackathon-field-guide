/** Apply after schema allowlisting. Originals remain unchanged in persistence.
 * This catches recognizable secrets and contacts; it cannot classify all prose. */
export function redactExportText(value: string): string {
  return value
    .replace(/-----BEGIN ([A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?(?:-----END \1-----|$)/gi, "[私钥已省略]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "[凭据已省略]")
    .replace(/["']?\b(?:[A-Z_]*(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|PASSWORD|SECRET)|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|password|secret|authorization|token)["']?\s*[=:]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;，；]+)/gi, "[凭据已省略]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g, "[凭据已省略]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[联系方式已省略]")
    .replace(/(?<!\d)(?:\+86[- ]?)?1[3-9]\d{9}(?!\d)/g, "[联系方式已省略]")
    .replace(/\b[A-Z]:[\\/][^\s<>"'，。；]+/gi, "[本机路径已省略]")
    .replace(/(?:\/Users\/|\/home\/|\/mnt\/)[^\s<>"'，。；]+/g, "[本机路径已省略]");
}
export function redactExportValue<T>(value: T): T {
  if (typeof value === "string") return redactExportText(value) as T;
  if (Array.isArray(value)) return value.map(redactExportValue) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactExportValue(item)])) as T;
  return value;
}
