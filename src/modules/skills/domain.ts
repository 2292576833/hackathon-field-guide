import { createHash } from "node:crypto";
import { DomainError } from "../../shared/errors.ts";

export const AGENT_IDS = ["codex", "claude-code", "cursor", "github-copilot", "gemini-cli", "opencode", "windsurf", "cline"] as const;
export type AgentId = typeof AGENT_IDS[number];
export type Track = "general" | "game" | "film" | "ai_agent";
export interface AgentAdapter { id: AgentId; name: string; version: "1"; projectDirectory: string; evidenceUrl: string; evidenceKind: "installer_declared"; checkedAt: string; clientVersion: null; liveCompatibility: "not_tested"; loadingGuide: string }
export interface SkillFile { relativePath: string; repositoryPath: string; downloadUrl: string; sha256: string; bytes: number }
export interface SkillVersion { id: string; skillId: string; version: string; commit: string; repository: string; skillPath: string; status: "published" | "withdrawn"; files: readonly SkillFile[]; contentHash: string; license: { spdx: "MIT" | "Apache-2.0"; sourceUrl: string; filePath: string; sha256: string; redistribution: "allowed_with_notices" }; reviewedAt: string; compatibility: readonly { agentId: AgentId; status: "format_and_path_declared"; agentVersion: null; taskEvaluation: "not_tested"; evidenceUrl: string; limitation: string }[]; revision?: number; reviewContentHash?: string; reviewManifestHash?: string; compatibilityEvidence?: readonly import("./publication-types.ts").SkillCompatibilityEvidence[] }
export interface Skill { id: string; name: string; title: string; author: string; summary: string; category: string; tracks: readonly Track[]; sourceUrl: string; recommendation: { basis: "editorial"; reason: string; taskEvaluation: "not_tested"; popularity: null }; prerequisites: readonly string[]; permissions: readonly string[]; tutorial: { suitableFor: string; limitations: string; steps: readonly string[]; examplePrompt: string; checkOutput: readonly string[]; troubleshooting: readonly string[] }; versions: readonly SkillVersion[] }
export interface TrackBundle { id: string; version: string; name: string; track: Track; outcome: string; skillVersionIds: readonly string[]; optionalSkillVersionIds: readonly string[]; compatibility: "not_live_tested"; limitations: readonly string[]; steps: readonly string[]; status: "published" | "withdrawn"; bundleId?: string; versionId?: string; revision?: number; reviewContentHash?: string; reviewManifestHash?: string; compatibilityEvidence?: readonly import("./publication-types.ts").SkillCompatibilityEvidence[] }
export interface ManifestItem { skillId: string; skillVersionId: string; name: string; targetDirectory: string; repository: string; commit: string; files: readonly SkillFile[]; license: SkillVersion["license"] }
export interface InstallationManifest { schemaVersion: "1"; adapterVersion: "1"; planId: string; agentId: AgentId; scope: "project"; bundleId: string | null; bundleVersion: string | null; items: readonly ManifestItem[]; expiresAt: string }
export interface InstallationPlan extends InstallationManifest { userId: string; revision: number; status: "preview" | "confirmed" | "installed" | "failed" | "revoked"; manifestHash: string; createdAt: string; warnings: readonly string[]; tutorial: readonly string[] }
export interface InstallationReceipt { id: string; planId: string; manifestHash: string; agentId: AgentId; status: "installed" | "failed" | "revoked"; fileStatus: "written" | "rolled_back" | "removed"; loadStatus: "not_verified" | "user_reported_loaded" | "user_reported_failed"; taskStatus: "not_verified" | "user_reported_passed" | "user_reported_failed"; evidenceSource: "local_bridge_reported"; items: readonly { skillVersionId: string; files: readonly { path: string; sha256: string; bytes: number }[] }[]; createdAt: string; note: string | null }
export function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`; return JSON.stringify(value); }
export function hash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
export function manifestOf(plan: InstallationPlan): InstallationManifest { return { schemaVersion: plan.schemaVersion, adapterVersion: plan.adapterVersion, planId: plan.planId, agentId: plan.agentId, scope: plan.scope, bundleId: plan.bundleId, bundleVersion: plan.bundleVersion, items: plan.items, expiresAt: plan.expiresAt }; }
export function safeRelative(value: string): string {
  if (typeof value !== "string" || value.length > 240 || !value || value.includes("\\") || value.startsWith("/") || /[:\x00-\x1f]/.test(value) || value.split("/").some(part => !part || part === "." || part === ".." || part.endsWith(".") || part.endsWith(" ") || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) throw new DomainError("INVALID_SKILL_PATH", "技能文件路径不安全。");
  return value;
}
export function assertVersion(version: SkillVersion): void {
  if (!/^[a-f0-9]{40}$/.test(version.commit) || !/^[\w.-]+\/[\w.-]+$/.test(version.repository) || !/^[a-f0-9]{64}$/.test(version.contentHash) || !version.files.length || version.files.length > 160 || !version.files.some(file => file.relativePath === "SKILL.md") || !version.files.some(file => file.relativePath === version.license.filePath && file.sha256 === version.license.sha256) || !["MIT", "Apache-2.0"].includes(version.license.spdx)) throw new DomainError("INVALID_SKILL_VERSION", "版本缺少固定来源、完整文件或许可依据。");
  const seen = new Set<string>(); let total = 0;
  for (const file of version.files) {
    safeRelative(file.relativePath); safeRelative(file.repositoryPath);
    if (seen.has(file.relativePath.toLowerCase()) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 2 * 1024 * 1024) throw new DomainError("INVALID_SKILL_FILE", "技能文件重复或大小、哈希无效。");
    seen.add(file.relativePath.toLowerCase()); total += file.bytes;
    const expected = `https://raw.githubusercontent.com/${version.repository}/${version.commit}/${file.repositoryPath.split("/").map(encodeURIComponent).join("/")}`;
    if (file.downloadUrl !== expected) throw new DomainError("INVALID_SKILL_SOURCE", "下载必须锁定官方仓库的精确 commit 与文件路径。");
  }
  if (total > 8 * 1024 * 1024 || hash(version.files) !== version.contentHash) throw new DomainError("INVALID_SKILL_CONTENT", "技能完整清单哈希或大小不正确。");
}
