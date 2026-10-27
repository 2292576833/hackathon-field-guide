import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import { adapter, AGENT_ADAPTERS } from "./adapters.ts";
import { declaresSkillTarget, filterPublishedSkills } from "./catalog-view.ts";
import { assertVersion, hash, manifestOf, safeRelative } from "./domain.ts";
import type { AgentId, InstallationPlan, InstallationReceipt, Skill, SkillVersion } from "./domain.ts";
import type { PlanRecord, SkillsDependencies, SkillsTransaction } from "./ports.ts";
function signedIn(actor: Actor | null): Actor { if (!actor?.userId) throw new DomainError("UNAUTHENTICATED", "请先登录。", { status: 401 }); return actor; }
function text(value: unknown, max = 200): string { if (typeof value !== "string" || !value.trim() || value.length > max) throw new DomainError("INVALID_SKILL_INPUT", "输入文字缺失或过长。"); return value.trim(); }
function secretHash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function missing(): never { throw new DomainError("SKILL_NOT_FOUND", "对应技能、安装计划或版本不存在。", { status: 404 }); }
export class SkillsService {
  readonly dependencies: SkillsDependencies;
  constructor(dependencies: SkillsDependencies) { this.dependencies = dependencies; }
  agents() { return { items: AGENT_ADAPTERS }; }
  async list(query: { agentId?: string; track?: string; category?: string; search?: string } = {}) {
    if (query.agentId && !adapter(query.agentId)) throw new DomainError("UNKNOWN_AGENT", "工具不在受控适配表中。");
    if (query.track && !["general", "game", "film", "ai_agent"].includes(query.track)) throw new DomainError("UNKNOWN_TRACK", "作品方向无效。");
    return { items: filterPublishedSkills(await this.dependencies.repository.listSkills(), query), nextCursor: null };
  }
  async detail(id: string): Promise<Skill> { return this.dependencies.repository.transaction(async tx => { const skill = await tx.getSkill(text(id)); if (!skill || !skill.versions.some(version => version.status === "published")) missing(); return { ...skill, versions: skill.versions.filter(version => version.status === "published") }; }); }
  async bundles() { return { items: (await this.dependencies.repository.listBundles()).filter(value => value.status === "published"), nextCursor: null }; }
  async bundle(id: string) { return this.dependencies.repository.transaction(async tx => { const value = await tx.getBundle(text(id)); if (!value || value.status !== "published") missing(); return value; }); }
  private async activeVersions(tx: SkillsTransaction, ids: readonly string[]): Promise<readonly { skill: Skill; version: SkillVersion }[]> {
    const result = [];
    for (const versionId of [...ids].sort()) { const skillId = text(versionId).split("@")[0]; const skill = await tx.getSkill(skillId, true); const version = skill?.versions.find(value => value.id === versionId); if (!skill || !version || version.status !== "published") throw new DomainError("SKILL_VERSION_UNAVAILABLE", "所选版本已撤回或不存在，请重新预览。"); assertVersion(version); result.push({ skill, version }); }
    return result;
  }
  async createPlan(actor: Actor | null, input: { agentId: AgentId; bundleId?: string; skillVersionIds?: readonly string[]; scope: "project"; acknowledgeUnverifiedCompatibility: boolean }): Promise<InstallationPlan> {
    const user = signedIn(actor); const target = adapter(input.agentId);
    if (!target || input.scope !== "project" || input.acknowledgeUnverifiedCompatibility !== true) throw new DomainError("INSTALLATION_ACKNOWLEDGEMENT_REQUIRED", "请选择工具与项目范围，并确认这些组合尚未完成客户端任务实测。");
    if (!!input.bundleId === !!input.skillVersionIds) throw new DomainError("INVALID_SKILL_SELECTION", "选择一个资源包，或明确的技能版本列表。");
    return this.dependencies.repository.transaction(async tx => {
      const bundle = input.bundleId ? await tx.getBundle(text(input.bundleId), true) : null;
      if (input.bundleId && (!bundle || bundle.status !== "published")) missing();
      const selected = bundle?.skillVersionIds ?? input.skillVersionIds!;
      if (!Array.isArray(selected) || !selected.length || selected.length > 12 || new Set(selected).size !== selected.length) throw new DomainError("INVALID_SKILL_SELECTION", "请选择 1 到 12 个互不重复的固定技能版本。");
      const versions = await this.activeVersions(tx, selected);
      if (new Set(versions.map(value => value.skill.id)).size !== versions.length) throw new DomainError("SKILL_VERSION_CONFLICT", "同一技能不能同时安装两个版本。");
      if (versions.some(value => !declaresSkillTarget(value.version, input.agentId))) throw new DomainError("SKILL_TOOL_UNSUPPORTED", "所选固定版本缺少此工具的路径与格式依据，请换工具或选择其他技能。");
      const now = this.dependencies.clock.now(); const planId = this.dependencies.ids.next();
      const manifest = { schemaVersion: "1" as const, adapterVersion: "1" as const, planId, agentId: input.agentId, scope: "project" as const, bundleId: bundle?.id ?? null, bundleVersion: bundle?.version ?? null,
        items: versions.map(({ skill, version }) => ({ skillId: skill.id, skillVersionId: version.id, name: skill.name, targetDirectory: safeRelative(`${target.projectDirectory}/${skill.name}`), repository: version.repository, commit: version.commit, files: version.files, license: version.license })), expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString() };
      const plan: InstallationPlan = { ...manifest, userId: user.userId, revision: 1, status: "preview", manifestHash: hash(manifest), createdAt: now.toISOString(),
        warnings: ["这是编辑精选；本站尚未完成该工具环境的加载与任务效果实测。", "桥接只复制固定版本文件，不执行技能正文或脚本，不安装依赖或授权账号。", "文件写入、客户端加载、示例任务验证分别记录。", ...(bundle?.limitations ?? [])],
        tutorial: ["核对具体 commit、许可、所需运行时和写入文件清单。", "在本机明确指定项目目录，启动桥接并输入终端显示的配对令牌。", "确认这份清单后执行；打开自己的 AI 工具查看技能，再试做详情中的小任务。"] };
      await tx.insertPlan({ plan, bridgeTokenHash: null }); return plan;
    });
  }
  private async owned(tx: SkillsTransaction, actor: Actor | null, id: string, lock = false): Promise<PlanRecord> { const user = signedIn(actor); const record = await tx.getPlan(text(id), lock); if (!record || record.plan.userId !== user.userId) missing(); return record; }
  private valid(plan: InstallationPlan): void { if (Date.parse(plan.expiresAt) <= this.dependencies.clock.now().getTime()) throw new DomainError("INSTALLATION_PLAN_EXPIRED", "安装计划已过期，请重新预览与确认。", { status: 409 }); }
  private async published(tx: SkillsTransaction, plan: InstallationPlan): Promise<void> { if (plan.bundleId) { const bundle = await tx.getBundle(plan.bundleId, true); if (!bundle || bundle.status !== "published" || bundle.version !== plan.bundleVersion) throw new DomainError("BUNDLE_WITHDRAWN", "资源包已变化或撤回，请重新预览。", { status: 409 }); } const actual = await this.activeVersions(tx, plan.items.map(item => item.skillVersionId)); for (const item of plan.items) { const version = actual.find(value => value.version.id === item.skillVersionId)!.version; if (!declaresSkillTarget(version, plan.agentId)) throw new DomainError("SKILL_TOOL_UNSUPPORTED", "此固定版本的工具路径与格式依据已不可用，请重新选择并预览。", { status: 409 }); if (hash(version.files) !== hash(item.files) || hash(version.license) !== hash(item.license)) throw new DomainError("SKILL_CONTENT_CHANGED", "固定版本内容不一致，已阻止安装。", { status: 409 }); } }
  async getPlan(actor: Actor | null, id: string) { return this.dependencies.repository.transaction(async tx => (await this.owned(tx, actor, id)).plan); }
  async manifest(actor: Actor | null, id: string) { return manifestOf(await this.getPlan(actor, id)); }
  async confirm(actor: Actor | null, id: string, input: { manifestHash: string; confirm: boolean }) { return this.dependencies.repository.transaction(async tx => { const record = await this.owned(tx, actor, id, true); this.valid(record.plan); if (input.confirm !== true || input.manifestHash !== record.plan.manifestHash || !["preview", "confirmed"].includes(record.plan.status)) throw new DomainError("MANIFEST_CONFIRMATION_REQUIRED", "请确认当前精确清单，不能复用其他计划。", { status: 409 }); await this.published(tx, record.plan); const bridgeToken = this.dependencies.randomToken?.() ?? randomBytes(32).toString("hex"); const plan = { ...record.plan, status: "confirmed" as const, revision: record.plan.revision + 1 }; await tx.savePlan({ plan, bridgeTokenHash: secretHash(bridgeToken) }, record.plan.revision); return { plan, bridgeToken }; }); }
  private async bridgeRecord(tx: SkillsTransaction, input: { planId: string; manifestHash: string; bridgeToken: string }, checkExpiry = true): Promise<PlanRecord> { const record = await tx.getPlan(text(input.planId), true); const provided = secretHash(text(input.bridgeToken, 256)); if (!record?.bridgeTokenHash || !timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(record.bridgeTokenHash, "hex")) || input.manifestHash !== record.plan.manifestHash) throw new DomainError("INVALID_BRIDGE_AUTHORIZATION", "安装凭证无效。", { status: 403 }); if (checkExpiry) this.valid(record.plan); return record; }
  async authorizeBridge(input: { planId: string; manifestHash: string; bridgeToken: string }) { return this.dependencies.repository.transaction(async tx => { const record = await this.bridgeRecord(tx, input); if (record.plan.status !== "confirmed") throw new DomainError("INSTALLATION_NOT_CONFIRMED", "该安装计划未确认或已执行。", { status: 409 }); await this.published(tx, record.plan); return { manifest: manifestOf(record.plan), manifestHash: record.plan.manifestHash }; }); }
  async recordBridgeReceipt(input: { planId: string; manifestHash: string; bridgeToken: string; receipt: InstallationReceipt }): Promise<InstallationReceipt> {
    return this.dependencies.repository.transaction(async tx => {
      const record = await this.bridgeRecord(tx, input, false); const receipt = this.validateReceipt(record.plan, input.receipt);
      const existing = await tx.getReceipt(receipt.id);
      if (existing && (existing.planId !== receipt.planId || existing.manifestHash !== receipt.manifestHash || hash(existing.items) !== hash(receipt.items))) throw new DomainError("RECEIPT_CONFLICT", "回执 ID 已使用。", { status: 409 });
      if (!existing) { this.valid(record.plan); if (record.plan.status !== "confirmed") throw new DomainError("INSTALLATION_ALREADY_RECORDED", "安装状态已记录。", { status: 409 }); }
      if (existing?.status === "revoked" && receipt.status !== "revoked") throw new DomainError("RECEIPT_REVOKED", "撤销回执不能恢复成已安装。", { status: 409 });
      await tx.putReceipt(receipt, record.plan.userId);
      const plan = { ...record.plan, revision: record.plan.revision + 1, status: receipt.status === "installed" ? "installed" as const : receipt.status === "revoked" ? "revoked" as const : "failed" as const };
      await tx.savePlan({ ...record, plan }, record.plan.revision); return receipt;
    });
  }
  private validateReceipt(plan: InstallationPlan, receipt: InstallationReceipt): InstallationReceipt {
    if (!receipt || typeof receipt !== "object" || !/^[a-zA-Z0-9_-]{8,100}$/.test(receipt.id) || receipt.planId !== plan.planId || receipt.manifestHash !== plan.manifestHash || receipt.agentId !== plan.agentId || receipt.evidenceSource !== "local_bridge_reported" || !["installed", "failed", "revoked"].includes(receipt.status) || !["not_verified", "user_reported_loaded", "user_reported_failed"].includes(receipt.loadStatus) || !["not_verified", "user_reported_passed", "user_reported_failed"].includes(receipt.taskStatus) || !Number.isFinite(Date.parse(receipt.createdAt)) || Date.parse(receipt.createdAt) > this.dependencies.clock.now().getTime() + 60_000 || (receipt.note !== null && (typeof receipt.note !== "string" || receipt.note.length > 2000))) throw new DomainError("INVALID_INSTALLATION_RECEIPT", "回执身份、状态或来源不正确。");
    const expected = plan.items.map(item => ({ skillVersionId: item.skillVersionId, files: item.files.map(file => ({ path: `${item.targetDirectory}/${file.relativePath}`, sha256: file.sha256, bytes: file.bytes })) }));
    if (receipt.status === "failed" ? receipt.fileStatus !== "rolled_back" || receipt.items.length !== 0 : receipt.fileStatus !== (receipt.status === "installed" ? "written" : "removed") || hash(receipt.items) !== hash(expected)) throw new DomainError("RECEIPT_FILES_MISMATCH", "回执文件必须与精确清单完全一致。");
    return receipt;
  }
  async installations(actor: Actor | null) { const user = signedIn(actor); return { plans: await this.dependencies.repository.listPlans(user.userId), receipts: await this.dependencies.repository.listReceipts(user.userId) }; }
  /** A trusted operations caller can withdraw an exact version; pending bridge plans recheck this. */
  async withdraw(actor: Actor, skillId: string, versionId: string, reason: string): Promise<void> { if (!signedIn(actor).platformRoles.some(value => value === "admin" || value === "reviewer")) throw new DomainError("SKILL_REVIEW_FORBIDDEN", "需要运营审核权限。", { status: 403 }); text(reason, 1000); await this.dependencies.repository.transaction(async tx => { const skill = await tx.getSkill(text(skillId), true); if (!skill?.versions.some(value => value.id === versionId)) missing(); await tx.putSkill({ ...skill, versions: skill.versions.map(value => value.id === versionId ? { ...value, status: "withdrawn" } : value) }); await tx.appendAudit({ id: this.dependencies.ids.next(), actorId: actor.userId, action: "skill_version_withdrawn", targetId: versionId, reason, at: this.dependencies.clock.now().toISOString() }); }); }
}
export function createSkillsService(dependencies: SkillsDependencies): SkillsService { return new SkillsService(dependencies); }
