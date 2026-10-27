import type { Clock, IdGenerator } from "../shared/contracts.ts";
import { DomainError } from "../shared/errors.ts";
import type { SqlExecutor } from "../shared/persistence.ts";
import { readImageSize, type ImageSize } from "./image-size.ts";

/** 规划35 方案 C：图片只存档。上限 2 MiB，只收三种位图。 */
export const PAGE_ASSET_MAX_BYTES = 2 * 1024 * 1024;
export const PAGE_ASSET_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type PageAssetMimeType = (typeof PAGE_ASSET_MIME_TYPES)[number];

const MAGIC: Record<PageAssetMimeType, readonly number[]> = {
  "image/png": [0x89, 0x50, 0x4e, 0x47],
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/webp": [0x52, 0x49, 0x46, 0x46],
};

function fail(code: string, message: string, status = 422): never {
  throw new DomainError(code, message, { status });
}

/**
 * 校验上传体（JSON：mimeType + base64）。
 *
 * 只做两件事：**大小**与**魔数**。不做 OCR、不做人脸、不猜内容（方案 C 明确不判断图片里有什么）。
 * SVG 一律拒绝——它能带脚本，不能当作图片资源。
 */
export function decodePageAssetUpload(value: unknown): { mimeType: PageAssetMimeType; bytes: Buffer } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("PAGE_ASSET_INVALID", "上传内容格式不正确。");
  const record = value as Record<string, unknown>;
  const mimeType = record.mimeType;
  if (typeof mimeType !== "string" || !(PAGE_ASSET_MIME_TYPES as readonly string[]).includes(mimeType)) {
    fail("PAGE_ASSET_TYPE_UNSUPPORTED", "只支持 PNG、JPEG、WebP 三种图片；SVG 与其它格式不接受。");
  }
  const base64 = record.base64;
  if (typeof base64 !== "string" || base64.length === 0) fail("PAGE_ASSET_INVALID", "没有收到图片内容。");
  const raw = base64.startsWith("data:") ? base64.slice(base64.indexOf(",") + 1) : base64;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(raw)) fail("PAGE_ASSET_INVALID", "图片内容不是合法的 base64。");
  const bytes = Buffer.from(raw, "base64");
  if (bytes.byteLength === 0) fail("PAGE_ASSET_INVALID", "图片内容为空。");
  if (bytes.byteLength > PAGE_ASSET_MAX_BYTES) fail("PAGE_ASSET_TOO_LARGE", "图片最大 2 MB，请压缩后再上传。", 413);
  const magic = MAGIC[mimeType as PageAssetMimeType];
  if (magic.some((byte, index) => bytes[index] !== byte)) fail("PAGE_ASSET_TYPE_MISMATCH", "文件内容与声明的图片类型不一致。");
  return { mimeType: mimeType as PageAssetMimeType, bytes };
}

export interface SavePageAssetInput {
  readonly organizationId: string;
  readonly eventId: string;
  readonly createdBy: string;
  readonly mimeType: PageAssetMimeType;
  readonly bytes: Buffer;
}

/** 同赛事按内容去重：重复上传返回同一个 assetId。 */
export async function savePageAsset(
  sql: SqlExecutor, ids: IdGenerator, clock: Clock, input: SavePageAssetInput,
): Promise<{ readonly assetId: string; readonly sha256: string; readonly deduplicated: boolean }> {
  const { createHash } = await import("node:crypto");
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const existing = await sql.query<{ id: string }>(
    "SELECT id FROM organizer_page_assets WHERE event_id=$1 AND sha256=$2", [input.eventId, sha256]);
  if (existing.rows[0]) return { assetId: existing.rows[0].id, sha256, deduplicated: true };
  const assetId = ids.next();
  await sql.query(
    "INSERT INTO organizer_page_assets(id,organization_id,event_id,mime_type,bytes,sha256,created_by,created_at) VALUES($1,$2,$3,$4,$5::bytea,$6,$7,$8::timestamptz)",
    [assetId, input.organizationId, input.eventId, input.mimeType, input.bytes, sha256, input.createdBy, clock.now().toISOString()],
  );
  return { assetId, sha256, deduplicated: false };
}

export async function readPageAsset(
  sql: SqlExecutor, assetId: string,
): Promise<{ readonly eventId: string; readonly mimeType: string; readonly bytes: Buffer } | null> {
  const result = await sql.query<{ event_id: string; mime_type: string; bytes: Buffer }>(
    "SELECT event_id,mime_type,bytes FROM organizer_page_assets WHERE id=$1", [assetId]);
  const row = result.rows[0];
  if (!row) return null;
  return { eventId: row.event_id, mimeType: row.mime_type, bytes: Buffer.from(row.bytes) };
}

/** 公开读取的判据：这张图**确实被某一版已发布快照引用**，否则不对外长缓存。 */
export async function isAssetPublished(sql: SqlExecutor, eventId: string, assetId: string): Promise<boolean> {
  // 读已发布快照（≤160KB）在 JS 里查引用：不依赖 jsonb_path 的变量绑定，也不做模糊匹配。
  const result = await sql.query<{ published: unknown }>(
    "SELECT published FROM organizer_page_specs WHERE event_id=$1 AND status='published'", [eventId]);
  const needle = '"assetId":"' + assetId + '"';
  return result.rows.some(row => row.published !== null && JSON.stringify(row.published).includes(needle));
}

export async function pageAssetResponse(sql: SqlExecutor, assetId: string): Promise<Response | null> {
  const asset = await readPageAsset(sql, assetId);
  if (asset === null) return null;
  const published = await isAssetPublished(sql, asset.eventId, assetId);
  return new Response(new Uint8Array(asset.bytes), {
    status: 200,
    headers: {
      "Content-Type": asset.mimeType,
      "Content-Length": String(asset.bytes.byteLength),
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
      "Cache-Control": published ? "public, max-age=31536000, immutable" : "private, no-store",
    },
  });
}

export type PageAssetAspect = "16:9" | "4:3" | "1:1" | "3:4";

export interface PageAssetSuggestion {
  readonly aspect: PageAssetAspect;
  readonly blocks: readonly string[];
  readonly note: string;
}

/**
 * 规划35 方案 C 的「放置建议」：**只看宽高比**，不看图片内容。
 *
 * 这不是视觉理解——没有 OCR、没有人脸、没有内容描述；规则是确定性的，可复核。
 * 读不到尺寸就返回 null，界面据此不给建议。
 */
export function suggestPlacement(size: ImageSize | null): PageAssetSuggestion | null {
  if (size === null) return null;
  const ratio = size.width / size.height;
  const note = "按宽高比给的确定性建议；不读取图片内容，也不判断图片里有什么。";
  if (ratio >= 1.5) return { aspect: "16:9", blocks: ["bannerImage"], note };
  if (ratio >= 1.2) return { aspect: "4:3", blocks: ["bannerImage", "sponsorWall"], note };
  if (ratio >= 0.95) return { aspect: "1:1", blocks: ["sponsorWall"], note };
  return { aspect: "3:4", blocks: ["peopleWall"], note };
}
