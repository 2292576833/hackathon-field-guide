import { DomainError } from "../../shared/errors.ts";
import { recruitingPurposes, recruitingRoles } from "./model.ts";
import type { AvatarContent, CardDraft, RecruitingListFilter, RecruitingPostData, RecruitingProfileData, WorkLink } from "./model.ts";

export function invalid(message = "内容无效，请检查填写后重试。"): never { throw new DomainError("INVALID_RECRUITING_INPUT", message, { status: 400 }); }
export function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid();
  return value as Record<string, unknown>;
}
export function revision(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 2_147_483_646) invalid("资料版本无效，请重新读取。"); return value; }
export function text(value: unknown, maximum: number, required = false): string {
  if (typeof value !== "string" || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) invalid();
  const result = value.trim(); if (required && !result) invalid("请填写必要内容。"); return result;
}
export function id(value: unknown): string { const result = text(value, 160, true); if (!/^[\w-]+$/.test(result)) invalid(); return result; }
function choices<T extends string>(value: unknown, allowed: readonly T[], max = allowed.length): T[] {
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== "string" || !allowed.includes(item as T)) || new Set(value).size !== value.length) invalid();
  return value as T[];
}
function labels(value: unknown): string[] { if (!Array.isArray(value) || value.length > 30) invalid(); return [...new Set(value.map(item => text(item, 80, true)))]; }
function hours(value: unknown): number | null { if (value === null) return null; if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 24) invalid(); return value; }
function bool(value: unknown): boolean { if (typeof value !== "boolean") invalid(); return value; }
function links(value: unknown): WorkLink[] {
  if (!Array.isArray(value) || value.length > 8) invalid("作品链接最多8个。");
  return value.map(item => { const row = object(item, ["title", "url"]), title = text(row.title, 100, true), raw = text(row.url, 2048, true); let url: URL;
    try { url = new URL(raw); } catch { invalid("作品地址须为完整的 HTTP 或 HTTPS 链接。"); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) invalid("作品地址须为完整的 HTTP 或 HTTPS 链接。");
    return { title, url: url.href };
  });
}
export function emptyProfile(): RecruitingProfileData { return { primaryRoles: [], supportingRoles: [], purposes: [], purposeNote: "", resume: "", workLinks: [], mbti: "", age: null }; }
export function validateProfileData(value: unknown): RecruitingProfileData {
  const v = object(value, ["primaryRoles", "supportingRoles", "purposes", "purposeNote", "resume", "workLinks", "mbti", "age"]);
  const mbti = text(v.mbti, 4).toUpperCase(); if (mbti && !/^[IE][NS][FT][JP]$/.test(mbti)) invalid("MBTI选填，填写时请使用四字母类型。");
  if (v.age !== null && (typeof v.age !== "number" || !Number.isInteger(v.age) || v.age < 1 || v.age > 120)) invalid("年龄选填，填写时请用1至120的整数。");
  return { primaryRoles: choices(v.primaryRoles, recruitingRoles), supportingRoles: choices(v.supportingRoles, recruitingRoles), purposes: choices(v.purposes, recruitingPurposes), purposeNote: text(v.purposeNote, 240), resume: text(v.resume, 4000), workLinks: links(v.workLinks), mbti, age: v.age as number | null };
}
export const cardDraftFields = ["headline", "introduction", "primaryRoles", "supportingRoles", "purposes", "purposeNote", "skills", "city", "availableHoursPerDay", "workLinks", "showMbti", "showAge", "showAvatar"] as const;
export function validateCardDraft(value: unknown): CardDraft {
  const v = object(value, cardDraftFields);
  if (JSON.stringify(v).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)) invalid("公开名片不展示邮箱，请移除邮箱后预览发布。");
  return { headline: text(v.headline, 100, true), introduction: text(v.introduction, 1600, true), primaryRoles: choices(v.primaryRoles, recruitingRoles), supportingRoles: choices(v.supportingRoles, recruitingRoles), purposes: choices(v.purposes, recruitingPurposes), purposeNote: text(v.purposeNote, 240), skills: labels(v.skills), city: text(v.city, 80), availableHoursPerDay: hours(v.availableHoursPerDay), workLinks: links(v.workLinks), showMbti: bool(v.showMbti), showAge: bool(v.showAge), showAvatar: bool(v.showAvatar) };
}
export function validatePostData(value: unknown): RecruitingPostData {
  const v = object(value, ["spaceName", "title", "description", "neededRoles", "purposes", "seats", "status"]);
  if (JSON.stringify(v).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)) invalid("公开招募不展示邮箱，请通过站内申请联系。");
  if (typeof v.seats !== "number" || !Number.isInteger(v.seats) || v.seats < 1 || v.seats > 50) invalid("招募人数请填写1至50的整数。");
  if (v.status !== "open" && v.status !== "closed" && v.status !== "withdrawn") invalid();
  return { spaceName: text(v.spaceName, 120, true), title: text(v.title, 120, true), description: text(v.description, 4000, true), neededRoles: choices(v.neededRoles, recruitingRoles), purposes: choices(v.purposes, recruitingPurposes), seats: v.seats, status: v.status };
}
export function validateFilter(value: RecruitingListFilter = {}): Required<Pick<RecruitingListFilter, "keyword" | "limit">> & RecruitingListFilter {
  const v = object(value, ["role", "purpose", "keyword", "cursor", "limit"]);
  if (v.role !== undefined && !recruitingRoles.includes(v.role as never)) invalid();
  if (v.purpose !== undefined && !recruitingPurposes.includes(v.purpose as never)) invalid();
  const limit = v.limit === undefined ? 24 : v.limit; if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 60) invalid();
  return { ...value, keyword: v.keyword === undefined ? "" : text(v.keyword, 120), ...(v.cursor === undefined ? {} : { cursor: id(v.cursor) }), limit };
}

export const AVATAR_MAX_BYTES = 512 * 1024;
/** Bounded raster structures; served by root with nosniff and no-store. Never fetch remote avatars. */
export function validateAvatar(value: unknown): AvatarContent {
  const v = object(value, ["mimeType", "base64"]);
  if (!["image/png", "image/jpeg", "image/webp"].includes(v.mimeType as string) || typeof v.base64 !== "string" || v.base64.length > Math.ceil(AVATAR_MAX_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v.base64)) invalid("头像只接受512KB以内的PNG、JPEG或WebP图片。");
  const bytes = Buffer.from(v.base64, "base64"); if (!bytes.length || bytes.length > AVATAR_MAX_BYTES) invalid("头像太大或为空。");
  let width = 0, height = 0;
  if (v.mimeType === "image/png") {
    if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) invalid("图片格式与文件内容不符。");
    let offset = 8, chunks = 0, hasData = false, ended = false;
    while (offset + 12 <= bytes.length && ++chunks <= 4096) { const size = bytes.readUInt32BE(offset), type = bytes.toString("ascii", offset + 4, offset + 8); if (size > bytes.length - offset - 12) invalid("PNG图片已损坏。");
      if (chunks === 1) { if (type !== "IHDR" || size !== 13) invalid(); width = bytes.readUInt32BE(offset + 8); height = bytes.readUInt32BE(offset + 12); }
      if (type === "IDAT") hasData = true;
      offset += size + 12;
      if (type === "IEND") { if (size !== 0 || offset !== bytes.length) invalid(); ended = true; break; }
    }
    if (!hasData || !ended) invalid("PNG图片已损坏。");
  } else if (v.mimeType === "image/jpeg") {
    if (bytes.length < 12 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) invalid("JPEG图片已损坏。");
    let offset = 2, foundScan = false;
    while (offset + 4 <= bytes.length) { if (bytes[offset++] !== 255) invalid(); while (bytes[offset] === 255) offset++; const marker = bytes[offset++]; if (marker === 217) break;
      const size = bytes.readUInt16BE(offset); if (size < 2 || offset + size > bytes.length) invalid();
      if ([192,193,194].includes(marker)) { if (size < 8) invalid(); height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); }
      if (marker === 218) { foundScan = true; break; } offset += size;
    }
    if (!foundScan) invalid("JPEG图片缺少图像数据。");
  } else {
    if (bytes.length < 30 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP" || bytes.readUInt32LE(4) + 8 !== bytes.length) invalid("WebP图片已损坏。");
    const chunk = bytes.toString("ascii", 12, 16), size = bytes.readUInt32LE(16); if (size > bytes.length - 20) invalid();
    let offset = 12, hasFrame = false;
    while (offset + 8 <= bytes.length) { const kind = bytes.toString("ascii", offset, offset + 4), length = bytes.readUInt32LE(offset + 4), payload = offset + 8; if (length > bytes.length - payload) invalid();
      if (kind === "ANIM" || kind === "ANMF") invalid("头像请使用静态WebP图片。");
      if (kind === "VP8 ") { if (length < 10 || bytes[payload + 3] !== 157 || bytes[payload + 4] !== 1 || bytes[payload + 5] !== 42) invalid(); hasFrame = true; }
      if (kind === "VP8L") { if (length < 5 || bytes[payload] !== 47) invalid(); hasFrame = true; }
      offset = payload + length + (length % 2);
    }
    if (offset !== bytes.length || !hasFrame) invalid("WebP缺少完整图像数据。");
    if (chunk === "VP8 " && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) { width = bytes.readUInt16LE(26) & 16383; height = bytes.readUInt16LE(28) & 16383; }
    else if (chunk === "VP8L" && bytes[20] === 47) { const bits = bytes.readUInt32LE(21); width = (bits & 16383) + 1; height = ((bits >>> 14) & 16383) + 1; }
    else if (chunk === "VP8X" && size === 10 && !(bytes[20] & 2)) { width = bytes.readUIntLE(24, 3) + 1; height = bytes.readUIntLE(27, 3) + 1; if (bytes.length <= 30) invalid(); }
    else invalid("头像请使用静态WebP图片。");
  }
  if (width < 1 || height < 1 || width > 2048 || height > 2048) invalid("头像尺寸须在2048×2048以内。");
  return { mimeType: v.mimeType as AvatarContent["mimeType"], bytes };
}
