import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import { hashInput } from "./manifest.ts";
import { requireProjectAccess } from "./permissions.ts";
import type {
  ConfirmedDeliveryRequirements, DeliveryMaterialChecklist, DeliveryMaterialsServiceDependencies,
  DeliveryMaterialsSummary, DeliveryMaterialsView, MaterialVerification, SaveDeliveryMaterialsInput,
} from "./delivery-materials-types.ts";

function invalid(message: string): never { throw new DomainError("INVALID_DELIVERY_MATERIALS", message); }
function text(value: unknown, field: string, maximum = 2000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f]/.test(value)) invalid(`${field}格式不正确。`);
  return value.trim();
}
function keys(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("请提供材料记录对象。");
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid("材料记录包含不可写入的字段。");
  return value as Record<string, unknown>;
}
function sha(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(value)) invalid("请填写完整代码版本 SHA 或明确留空。");
  return value.toLowerCase();
}
function verification(value: unknown, now: Date): MaterialVerification | null {
  if (value === null) return null;
  const v = keys(value, ["outcome", "verifiedAt", "evidenceRefs", "note", "verificationSource"]);
  if (!["passed", "failed", "inconclusive"].includes(v.outcome as string) || v.verificationSource !== "user_reported") invalid("只能记录成员自报的材料核对结果。");
  const at = text(v.verifiedAt, "核对时间", 40);
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(at) || !Number.isFinite(Date.parse(at)) || Date.parse(at) > now.getTime()) invalid("核对时间必须有效、带时区且不晚于现在。");
  const calendar = new Date(`${at.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== at.slice(0, 10)) invalid("核对日期无效。");
  if (!Array.isArray(v.evidenceRefs) || v.evidenceRefs.length > 30) invalid("核对依据必须为不超过30项的列表。");
  const evidenceRefs = [...new Set(v.evidenceRefs.map(item => text(item, "核对依据")))];
  if (v.outcome === "passed" && !evidenceRefs.length) invalid("核对通过必须填写真实依据。");
  if (typeof v.note !== "string" || v.note.length > 2000 || /[\u0000-\u001f]/.test(v.note)) invalid("核对说明格式不正确。");
  return { outcome: v.outcome as MaterialVerification["outcome"], verifiedAt: new Date(at).toISOString(), evidenceRefs, note: v.note.trim(), verificationSource: "user_reported" };
}
function normalize(input: SaveDeliveryMaterialsInput, now: Date): SaveDeliveryMaterialsInput {
  const v = keys(input, ["expectedVersion", "eventId", "requirementsVersion", "repositoryCommitSha", "entries", "branchVerification", "idempotencyKey"]);
  if (v.expectedVersion !== null && (!Number.isSafeInteger(v.expectedVersion) || Number(v.expectedVersion) < 1)) invalid("请提供当前材料清单版本。");
  const repositoryCommitSha = sha(v.repositoryCommitSha);
  if (!Array.isArray(v.entries) || v.entries.length > 200) invalid("材料清单最多200项。");
  const entries = v.entries.map(raw => {
    const entry = keys(raw, ["requirementId", "location", "revision", "repositoryCommitSha", "verification"]);
    const location = entry.location === null ? null : text(entry.location, "材料位置", 2048);
    // A location may be a repository/local path or an HTTPS URL; never execute or fetch it.
    if (location && /^[a-z][a-z0-9+.-]*:/i.test(location) && !/^[a-z]:[\\/]/i.test(location)) {
      let url: URL; try { url = new URL(location); } catch { invalid("材料链接格式不正确。"); }
      if (url.protocol !== "https:" || !url.hostname || url.username || url.password) invalid("材料链接应为不含账号凭据的HTTPS地址。");
    }
    const revision = entry.revision === null ? null : text(entry.revision, "材料修订", 200);
    const commit = sha(entry.repositoryCommitSha);
    const check = verification(entry.verification, now);
    if (check?.outcome === "passed" && (!location || !revision || !commit || !repositoryCommitSha || commit !== repositoryCommitSha)) invalid("材料核对通过需真实位置、修订和与本次清单一致的代码版本。");
    return { requirementId: text(entry.requirementId, "材料要求ID", 200), location, revision, repositoryCommitSha: commit, verification: check };
  });
  if (new Set(entries.map(entry => entry.requirementId)).size !== entries.length) invalid("同一材料要求不能重复填写。");
  entries.sort((a, b) => a.requirementId.localeCompare(b.requirementId));
  let branchVerification: SaveDeliveryMaterialsInput["branchVerification"] = null;
  if (v.branchVerification !== null) {
    const branch = keys(v.branchVerification, ["branch", "repositoryCommitSha", "outcome", "verifiedAt", "evidenceRefs", "note", "verificationSource"]);
    const { branch: name, repositoryCommitSha: branchSha, ...check } = branch;
    const normalized = verification(check, now)!;
    const commit = sha(branchSha); if (!commit) invalid("分支核对必须指定完整代码版本。");
    const branchName = text(name, "核对分支", 255);
    if (/\s|\.\.|~|\^|:|\?|\*|\[|\\|@\{|\/\//.test(branchName) || branchName.startsWith("/") || branchName.endsWith("/") || branchName.endsWith(".") || branchName.split("/").some(part => part.startsWith(".") || part.endsWith(".lock"))) invalid("核对分支名称无效。");
    if (normalized.outcome === "passed" && commit !== repositoryCommitSha) invalid("分支核对通过必须关联本次清单的同一代码版本。");
    branchVerification = { ...normalized, branch: branchName, repositoryCommitSha: commit };
  }
  const idempotencyKey = text(v.idempotencyKey, "幂等键", 128);
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) invalid("幂等键格式无效。");
  return { expectedVersion: v.expectedVersion as number | null, eventId: text(v.eventId, "赛事ID", 200), requirementsVersion: text(v.requirementsVersion, "确认规则版本", 200), repositoryCommitSha, entries, branchVerification, idempotencyKey };
}

/** Prepared only means member-reported material verification for the current rules and saved commit. */
export function summarizeDeliveryMaterials(view: Pick<DeliveryMaterialsView, "requirements" | "current">, currentCommitSha: string | null): DeliveryMaterialsSummary {
  const { requirements, current } = view;
  const gaps: string[] = [];
  const sameRules = Boolean(requirements && current && current.eventId === requirements.eventId && current.requirementsVersion === requirements.requirementsVersion);
  const sameCommit = Boolean(currentCommitSha && current?.repositoryCommitSha?.toLowerCase() === currentCommitSha.toLowerCase());
  if (!requirements) gaps.push("尚未读取当前已确认的正式比赛要求，请到比赛要求页核对。");
  else {
    gaps.push(...requirements.unknowns);
    if (requirements.materialsStatus === "unknown") gaps.push("必交材料范围尚不能确定，请人工核对正式规则原文。");
    if (!sameRules && current) gaps.push("材料清单引用的确认规则版本已变化，需重新核对。");
    if (current && !sameCommit) gaps.push("材料清单与当前已保存代码版本不一致，需重新核对。");
  }
  const materials: DeliveryMaterialsSummary["materials"] = (requirements?.materials ?? []).map(requirement => {
    const entry = current?.entries.find(item => item.requirementId === requirement.id) ?? null;
    let status: DeliveryMaterialsSummary["materials"][number]["status"] = "unknown";
    if (!entry || !entry.location || !entry.revision) status = "missing";
    else if (!sameRules || !sameCommit || entry.repositoryCommitSha?.toLowerCase() !== currentCommitSha?.toLowerCase()) status = "outdated";
    else if (entry.verification?.outcome === "failed") status = "failed";
    else if (entry.verification?.outcome === "passed" && entry.verification.evidenceRefs.length && requirement.necessity !== "unknown") status = "prepared";
    if (requirement.necessity === "required" && status !== "prepared") gaps.push(`必交材料“${requirement.label}”${status === "missing" ? "尚未填写完整位置与修订" : "尚未完成当前版本核对"}。`);
    if (requirement.necessity === "unknown") gaps.push(`“${requirement.label}”是否必交尚待确认。`);
    return { ...requirement, status, entry };
  });
  const record = current?.branchVerification ?? null;
  let branch: DeliveryMaterialsSummary["branch"] = { status: "not_verified", verificationSource: record?.verificationSource ?? null, record };
  if (!requirements || requirements.requiredBranch.status === "unknown") {
    branch.status = "unknown";
    if (requirements?.requiredBranch.status === "unknown") gaps.push(requirements.requiredBranch.reason);
  } else if (requirements.requiredBranch.status === "not_required") branch.status = "not_required";
  else if (record && sameRules && sameCommit && record.repositoryCommitSha.toLowerCase() === currentCommitSha?.toLowerCase()) {
    branch.status = record.branch !== requirements.requiredBranch.name || record.outcome === "failed" ? "mismatch" : record.outcome === "passed" && record.evidenceRefs.length ? "matched" : "not_verified";
  }
  if (requirements?.requiredBranch.status === "specified" && branch.status !== "matched") gaps.push(`比赛要求分支“${requirements.requiredBranch.name}”尚未核对当前代码版本。`);
  const deduplicated = [...new Set(gaps)];
  let status: DeliveryMaterialsSummary["status"];
  if (!requirements) status = "not_loaded";
  else if (requirements.materialsStatus === "unknown" || branch.status === "unknown" || materials.some(item => item.necessity === "unknown")) status = "unknown";
  else if (materials.some(item => item.necessity === "required" && item.status === "missing")) status = "missing";
  else if (!sameRules || !sameCommit || deduplicated.length || !["matched", "not_required"].includes(branch.status)) status = "needs_review";
  else status = "ready";
  return { status, requirements, checklist: current, currentCommitSha, branch, materials, gaps: deduplicated, recoveryAction: "review_confirmed_event_requirements" };
}

export class DeliveryMaterialsService {
  private readonly d: DeliveryMaterialsServiceDependencies;
  constructor(dependencies: DeliveryMaterialsServiceDependencies) { this.d = dependencies; }
  async read(actor: Actor, projectId: string): Promise<DeliveryMaterialsView> {
    await requireProjectAccess(this.d.access, actor, projectId);
    const [requirements, current, history] = await Promise.all([this.d.requirements.readConfirmed(actor, projectId), this.d.store.getCurrent(projectId), this.d.store.listHistory(projectId)]);
    if (requirements && requirements.projectId !== projectId) throw new DomainError("DELIVERY_REQUIREMENTS_INVALID", "比赛要求范围不一致。", { status: 503 });
    await requireProjectAccess(this.d.access, actor, projectId);
    return structuredClone({ requirements, current, history });
  }
  async history(actor: Actor, projectId: string): Promise<DeliveryMaterialChecklist[]> {
    await requireProjectAccess(this.d.access, actor, projectId);
    const history = await this.d.store.listHistory(projectId);
    await requireProjectAccess(this.d.access, actor, projectId);
    return structuredClone(history);
  }
  async save(actor: Actor, projectId: string, input: SaveDeliveryMaterialsInput): Promise<DeliveryMaterialChecklist> {
    await requireProjectAccess(this.d.access, actor, projectId, true);
    const now = this.d.clock.now();
    if (!Number.isFinite(now.getTime())) throw new DomainError("INVALID_SERVER_CLOCK", "暂时无法确定记录时间。", { status: 500 });
    const normalized = normalize(input, now);
    const inputHash = hashInput(normalized);
    return this.d.database.transaction(async executor => {
      await this.d.writeAccess.assertWritable(actor, projectId, executor);
      const rules: ConfirmedDeliveryRequirements | null = await this.d.requirements.readConfirmed(actor, projectId, executor);
      if (!rules || rules.projectId !== projectId || rules.eventId !== normalized.eventId || rules.requirementsVersion !== normalized.requirementsVersion) throw new DomainError("REQUIREMENTS_VERSION_CONFLICT", "确认规则已变化或尚未读取，请先重新核对比赛要求。", { status: 409, recoveryAction: "review_confirmed_event_requirements" });
      if (normalized.entries.some(entry => !rules.materials.some(requirement => requirement.id === entry.requirementId))) invalid("材料ID必须来自当前已确认正式规则。");
      const existing = await this.d.store.findByKey(projectId, actor.userId, normalized.idempotencyKey, executor);
      if (existing) {
        if (existing.inputHash !== inputHash) throw new DomainError("IDEMPOTENCY_KEY_REUSED", "相同幂等键已用于不同材料内容。", { status: 409 });
        return structuredClone(existing);
      }
      const current = await this.d.store.getCurrent(projectId, executor);
      if ((current?.version ?? null) !== normalized.expectedVersion) throw new DomainError("VERSION_CONFLICT", "材料清单已更新，请读取最新版本后核对。", { status: 409, latestRevision: current?.version ?? undefined });
      const unchangedRules = current?.eventId === normalized.eventId && current.requirementsVersion === normalized.requirementsVersion && current.repositoryCommitSha === normalized.repositoryCommitSha;
      const entries = normalized.entries.map(entry => {
        const previous = unchangedRules ? current?.entries.find(item => item.requirementId === entry.requirementId) : null;
        const { verifiedBy: previousVerifier, ...previousVerification } = previous?.verification ?? {};
        const sameEntry = previous && previous.location === entry.location && previous.revision === entry.revision && previous.repositoryCommitSha === entry.repositoryCommitSha && hashInput(previous.verification ? previousVerification : null) === hashInput(entry.verification);
        return { ...entry, verification: entry.verification ? { ...entry.verification, verifiedBy: sameEntry && previousVerifier ? previousVerifier : actor.userId } : null };
      });
      const { verifiedBy: previousBranchVerifier, ...previousBranch } = current?.branchVerification ?? {};
      const sameBranch = unchangedRules && current?.branchVerification && hashInput(previousBranch) === hashInput(normalized.branchVerification);
      const record: DeliveryMaterialChecklist = {
        id: current?.id ?? this.d.ids.next(), projectId, version: (current?.version ?? 0) + 1,
        eventId: normalized.eventId, requirementsVersion: normalized.requirementsVersion, repositoryCommitSha: normalized.repositoryCommitSha,
        entries,
        branchVerification: normalized.branchVerification ? { ...normalized.branchVerification, verifiedBy: sameBranch && previousBranchVerifier ? previousBranchVerifier : actor.userId } : null,
        recordedBy: actor.userId, recordedAt: now.toISOString(), idempotencyKey: normalized.idempotencyKey, inputHash,
      };
      await this.d.store.save(record, normalized.expectedVersion, executor);
      return structuredClone(record);
    });
  }
}
