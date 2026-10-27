import type { IntakeReceipt, SubmissionMaterials } from "./model.ts";

/**
 * 相似 / 重复材料的**人工复核线索**。
 *
 * 背景：竞品文档里写了"用编辑距离查重复提交"，但源码里**根本没有实现**（JUDGELAYER 全仓无该实现），
 * 而它又很容易做成一个不透明的"相似度分数"。我们只做能解释、能核对、也不下结论的一版：
 * 1. 只比较**不同队伍各自最新一版**的正式材料——同一队伍的连续版本是版本关系，不是重复。
 * 2. 只用可核对的事实：**同一文件哈希**、**同一材料地址**（忽略查询串与结尾斜杠）、**同名作品**。
 * 3. 每条线索给出强度标签（高/中/低）与**具体依据**，并明确写"这是线索不是判定"：
 *    同一套开源模板、同一场工作坊脚手架、同一份主办方示例都可能造成相同地址或同名。
 * 4. 不做任何评分、不给百分比、不产出公开分级，也不自动通知任何人；是否处理由主办方决定。
 */

export interface DuplicateSide { teamId: string; receiptId: string; version: number; title: string; submittedAt: string }
export interface DuplicatePair {
  left: DuplicateSide; right: DuplicateSide;
  /** 可核对的具体依据，按强度从高到低。 */
  reasons: { kind: "file_hash" | "material_url" | "title"; detail: string; strength: "high" | "medium" | "low" }[];
  strength: "high" | "medium" | "low";
}
export interface DuplicateReport {
  pairs: readonly DuplicatePair[];
  checkedTeams: number;
  truncated: boolean;
  notice: string;
  limitations: readonly string[];
}

export const maxDuplicatePairs = 50;

/** 地址归一：小写主机、去掉结尾斜杠、丢弃查询串与片段（报名参数常变，不该造成假重复）。 */
export function normalizedUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:") return null;
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.hostname.toLowerCase()}${path}`;
  } catch { return null; }
}
/** 名称归一：去掉空白与常见分隔符号后比较，避免"作品 A / 作品-A"被判成不同。 */
export function normalizedTitle(value: string): string {
  return value.trim().toLowerCase().replace(/[\s\-_·・.。,，:：()（）[\]【】]/g, "");
}

const latestByTeam = (receipts: readonly IntakeReceipt[]): IntakeReceipt[] => {
  const latest = new Map<string, IntakeReceipt>();
  for (const receipt of receipts) {
    const current = latest.get(receipt.teamId);
    if (!current || receipt.version > current.version) latest.set(receipt.teamId, receipt);
  }
  return [...latest.values()].sort((left, right) => (left.teamId < right.teamId ? -1 : left.teamId > right.teamId ? 1 : 0));
};
const fileHashes = (materials: SubmissionMaterials): string[] => materials.files.map(file => file.sha256.trim().toLowerCase()).filter(Boolean);
const materialUrls = (materials: SubmissionMaterials): string[] => [...materials.links.map(link => link.url), ...materials.files.map(file => file.url)].map(normalizedUrl).filter((value): value is string => !!value);
const sideOf = (receipt: IntakeReceipt): DuplicateSide => ({ teamId: receipt.teamId, receiptId: receipt.id, version: receipt.version, title: receipt.materials.title, submittedAt: receipt.submittedAt });
const strongest = (strengths: readonly ("high" | "medium" | "low")[]): "high" | "medium" | "low" => strengths.includes("high") ? "high" : strengths.includes("medium") ? "medium" : "low";

export function duplicateReport(receipts: readonly IntakeReceipt[]): DuplicateReport {
  const latest = latestByTeam(receipts), pairs: DuplicatePair[] = [];
  for (let left = 0; left < latest.length; left += 1) {
    for (let right = left + 1; right < latest.length; right += 1) {
      const one = latest[left]!, other = latest[right]!;
      if (one.teamId === other.teamId) continue;
      const reasons: DuplicatePair["reasons"][number][] = [];
      const sharedHashes = fileHashes(one.materials).filter(hash => fileHashes(other.materials).includes(hash));
      for (const hash of [...new Set(sharedHashes)]) reasons.push({ kind: "file_hash", detail: `同一文件哈希 ${hash.slice(0, 16)}…`, strength: "high" });
      const sharedUrls = materialUrls(one.materials).filter(url => materialUrls(other.materials).includes(url));
      for (const url of [...new Set(sharedUrls)]) reasons.push({ kind: "material_url", detail: `同一材料地址 ${url}`, strength: "medium" });
      const oneTitle = normalizedTitle(one.materials.title), otherTitle = normalizedTitle(other.materials.title);
      if (oneTitle && oneTitle === otherTitle) reasons.push({ kind: "title", detail: `作品名称相同：${one.materials.title}`, strength: "low" });
      if (!reasons.length) continue;
      pairs.push({ left: sideOf(one), right: sideOf(other), reasons, strength: strongest(reasons.map(reason => reason.strength)) });
    }
  }
  // 先按强度，再按队伍标识稳定排序；截断时明确告知，不悄悄丢弃。
  const order = { high: 0, medium: 1, low: 2 } as const;
  pairs.sort((a, b) => order[a.strength] - order[b.strength]
    || a.left.teamId.localeCompare(b.left.teamId) || a.right.teamId.localeCompare(b.right.teamId));
  const truncated = pairs.length > maxDuplicatePairs;
  return { pairs: pairs.slice(0, maxDuplicatePairs), checkedTeams: latest.length, truncated,
    notice: `已比较 ${latest.length} 支队伍各自最新一版的正式材料，得到 ${pairs.length} 条线索${truncated ? `（只展示前 ${maxDuplicatePairs} 条）` : ""}。这是人工复核线索，不是判定。`,
    limitations: [
      "只比较各队最新一版材料；同一队伍的连续版本属于版本关系，不在这里比较。",
      "线索只是可核对的事实：同一文件哈希、同一材料地址、同名作品。",
      "同一套开源模板、同一场工作坊脚手架或主办方示例都可能造成相同地址或同名，请先核对再处理。",
      "这里不做评分、不给百分比，也不自动通知任何队伍。",
    ] };
}
