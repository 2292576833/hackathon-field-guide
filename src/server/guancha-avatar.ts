/**
 * 从观猹拉取用户头像。
 *
 * 安全边界（这是从第三方地址取字节，必须当成不可信输入）：
 *  - 只允许 https，且 host 必须是观猹自有域（`watcha.cn` / `*.watcha.cn` / `*.volces.com`）；
 *  - 不跟随跨站跳转（最多 3 跳，且每跳都要重新过白名单）；
 *  - 限流读取：超过上限立即中止，不把整个响应读进内存；
 *  - 类型按**魔数**判定，不信 `content-type` 头；
 *  - 只有 PNG / JPEG / WebP 三种，与本站既有的头像校验一致。
 *
 * 本模块只负责"拿到并初步识别"；最终合法性由既有 `validateAvatar`（尺寸、完整性）判定。
 */

export interface GuanchaAvatarDownload {
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
  readonly base64: string;
  readonly byteLength: number;
}

export const GUANCHA_AVATAR_MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 8_000;

export function isAllowedGuanchaAvatarHost(hostname: string): boolean {
  return hostname === "watcha.cn" || hostname.endsWith(".watcha.cn") || hostname.endsWith(".volces.com");
}

/** 校验候选地址；不合法返回 null（调用方按"没有头像"处理，不报错）。 */
export function guanchaAvatarUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (!isAllowedGuanchaAvatarHost(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}

/** 按魔数识别图片类型；识别不出来返回 null（绝不采信响应头）。 */
export function detectImageMime(bytes: Uint8Array): GuanchaAvatarDownload["mimeType"] | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

/**
 * 下载头像。任何一步不满足（非白名单、超限、类型不认识、超时）都返回 `null`，
 * 由调用方按"这次没有拿到头像"处理——**头像失败绝不能让登录失败**。
 */
export async function fetchGuanchaAvatar(rawUrl: unknown, fetchImplementation: typeof fetch = fetch): Promise<GuanchaAvatarDownload | null> {
  let current = guanchaAvatarUrl(rawUrl);
  if (!current) return null;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetchImplementation(current, {
          method: "GET", redirect: "manual", signal: controller.signal,
          headers: { accept: "image/png,image/jpeg,image/webp" },
        });
      } finally { clearTimeout(timer); }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return null;
        let next: string;
        try { next = new URL(location, current).href; } catch { return null; }
        current = guanchaAvatarUrl(next);
        if (!current) return null;
        continue;
      }
      if (response.status !== 200) return null;

      // 有 content-length 时先挡一次，避免白读大文件。
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > GUANCHA_AVATAR_MAX_BYTES) return null;

      const bytes = await readBounded(response, GUANCHA_AVATAR_MAX_BYTES);
      if (bytes === null) return null;
      const mimeType = detectImageMime(bytes);
      if (!mimeType) return null;
      return { mimeType, base64: Buffer.from(bytes).toString("base64"), byteLength: bytes.length };
    }
    return null;
  } catch { return null; }
}

/** 边读边计数：一旦超过上限立刻停止，不信任任何头信息。 */
async function readBounded(response: Response, limit: number): Promise<Uint8Array | null> {
  const body = response.body;
  if (!body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    return buffer.length > 0 && buffer.length <= limit ? buffer : null;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > limit) { await reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
  } catch { return null; }
  if (total === 0) return null;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
  return merged;
}
