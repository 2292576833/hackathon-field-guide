import type { Actor } from "../../shared/contracts.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import { DomainError } from "../../shared/errors.ts";
import { AGENT_IDS, assertVersion, hash, safeRelative } from "./domain.ts";
import type { Skill, SkillVersion, TrackBundle } from "./domain.ts";
import { AGENT_ADAPTERS } from "./adapters.ts";
import type { SkillCandidate, SkillCandidateDependencies, SkillCandidateDocument, SkillCandidateEvidence, SkillCompatibilityEvidence, SkillPublicationInput, SkillPublicationPort, SkillPublicationTarget, SkillReviewSnapshot } from "./publication-types.ts";

/** Matches the current curated source identity set. Importing candidates never fetches or runs content. */
export const SKILL_SOURCE_REPOSITORIES = ["anthropics/skills", "github/awesome-copilot"] as const;
function reviewer(actor: Actor) { if (!actor?.userId || !actor.platformRoles.some(role => role === "admin" || role === "reviewer")) throw new DomainError("SKILL_REVIEW_FORBIDDEN", "需要技能运营审核权限。", { status: 403 }); }
function text(value: unknown, limit = 200): string { if (typeof value !== "string" || !value.trim() || value.length > limit || /[\x00-\x1f]/.test(value)) throw new DomainError("INVALID_SKILL_CANDIDATE", "候选文字缺失或过长。"); return value.trim(); }
function keys(value: unknown, allowed: readonly string[]) { if (!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).some(key=>!allowed.includes(key))) throw new DomainError("INVALID_SKILL_CANDIDATE", "候选包含未支持字段，发布元数据须由服务器记录。"); }
function revision(value: number) { if (!Number.isSafeInteger(value) || value < 0) throw new DomainError("INVALID_SKILL_CANDIDATE", "修订号无效。"); }
function conflict() : never { throw new DomainError("VERSION_CONFLICT", "候选版本或审核依据已变化，请重新核对。", { status: 409 }); }
function target(value: SkillPublicationTarget) { if (!value || !["skill", "bundle"].includes(value.kind)) throw new DomainError("INVALID_SKILL_CANDIDATE", "候选类型无效。"); text(value.id); text(value.versionId); }
function publicEvidence(value: string) { let url: URL; try { url = new URL(value); } catch { throw new DomainError("INVALID_SKILL_EVIDENCE", "证据须为公开 HTTPS 链接。"); } if (url.protocol !== "https:" || url.username || url.password || url.port || !url.hostname.includes(".") || /^(localhost|.*\.local|.*\.internal)$/.test(url.hostname) || /^\d+(\.\d+){3}$/.test(url.hostname) || url.hostname.includes(":")) throw new DomainError("INVALID_SKILL_EVIDENCE", "证据须为公开 HTTPS 链接。"); }
function fixedVersion(skill: Skill) {
  keys(skill,["id","name","title","author","summary","category","tracks","sourceUrl","recommendation","prerequisites","permissions","tutorial","versions"]);
  if (!skill || typeof skill !== "object" || !Array.isArray(skill.versions) || skill.versions.length !== 1) throw new DomainError("INVALID_SKILL_CANDIDATE", "每个候选须且仅须包含一个固定技能版本。");
  const value: SkillVersion = skill.versions[0];
  if (!Array.isArray(value?.files) || !Array.isArray(value?.compatibility)) throw new DomainError("INVALID_SKILL_CANDIDATE", "候选清单与工具声明须为列表。");
  if (typeof value.version!=="string" || !/^[a-zA-Z0-9_.@+-]{1,80}$/.test(value.version) || value.version==="latest" || !["published","withdrawn"].includes(value.status) || !Number.isFinite(Date.parse(value.reviewedAt))) throw new DomainError("INVALID_SKILL_CANDIDATE", "技能版本标签须为明确固定文字，状态和日期须有效。");
  keys(value,["id","skillId","version","commit","repository","skillPath","status","files","contentHash","license","reviewedAt","compatibility"]);
  keys(value.license,["spdx","sourceUrl","filePath","sha256","redistribution"]);
  keys(skill.recommendation,["basis","reason","taskEvaluation","popularity"]);
  keys(skill.tutorial,["suitableFor","limitations","steps","examplePrompt","checkOutput","troubleshooting"]);
  value.files.forEach(file=>keys(file,["relativePath","repositoryPath","downloadUrl","sha256","bytes"]));
  text(skill.id); if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name) || skill.id !== skill.name || value.skillId !== skill.id || value.id !== `${skill.id}@${value.commit}`) throw new DomainError("INVALID_SKILL_CANDIDATE", "技能标识须绑定完整 commit。");
  assertVersion(value); safeRelative(value.skillPath);
  if (!SKILL_SOURCE_REPOSITORIES.includes(value.repository as typeof SKILL_SOURCE_REPOSITORIES[number])) throw new DomainError("SKILL_SOURCE_NOT_ALLOWED", "候选仅允许当前固定来源白名单。");
  const expected = `https://github.com/${value.repository}/tree/${value.commit}/${value.skillPath}`;
  if (skill.sourceUrl !== expected) throw new DomainError("INVALID_SKILL_SOURCE", "原始来源须绑定同一固定技能目录。");
  for (const file of value.files) if (file.repositoryPath !== `${value.skillPath}/${file.relativePath}` && !(file.relativePath === value.license.filePath && /^(LICENSE(?:\.txt|\.md)?|NOTICE(?:\.txt|\.md)?)$/i.test(file.repositoryPath)) && !(file.relativePath === "THIRD_PARTY_NOTICES.md" && file.repositoryPath === "THIRD_PARTY_NOTICES.md")) throw new DomainError("INVALID_SKILL_SOURCE", "文件须来自固定技能目录或明确根许可/通知文件。");
  const license = value.files.find(file => file.relativePath === value.license.filePath)!;
  if (value.license.redistribution !== "allowed_with_notices" || value.license.sourceUrl !== license.downloadUrl) throw new DomainError("INVALID_SKILL_LICENSE", "许可须引用清单中的同一许可文件。");
  if (value.repository === "anthropics/skills" && !value.files.some(file=>file.relativePath==="THIRD_PARTY_NOTICES.md" && file.repositoryPath==="THIRD_PARTY_NOTICES.md")) throw new DomainError("INVALID_SKILL_LICENSE", "Anthropic 来源须保留当前要求的第三方通知文件。");
  const seen = new Set<string>();
  if (!Array.isArray(value.compatibility)) throw new DomainError("INVALID_SKILL_EVIDENCE", "工具声明无效。");
  for (const declaration of value.compatibility) {
    keys(declaration,["agentId","status","agentVersion","taskEvaluation","evidenceUrl","limitation"]);
    const agent = AGENT_ADAPTERS.find(agent => agent.id === declaration.agentId);
    if (!agent || seen.has(agent.id) || declaration.status !== "format_and_path_declared" || declaration.agentVersion !== null || declaration.taskEvaluation !== "not_tested" || declaration.evidenceUrl !== agent.evidenceUrl) throw new DomainError("INVALID_SKILL_EVIDENCE", "工具声明只能使用当前适配依据，不能冒充客户端实测。");
    text(declaration.limitation, 2000); seen.add(agent.id);
  }
  for (const field of [skill.title, skill.author, skill.summary, skill.category, skill.recommendation?.reason, skill.tutorial?.suitableFor, skill.tutorial?.limitations, skill.tutorial?.examplePrompt]) text(field, 4000);
  for (const list of [skill.prerequisites, skill.permissions, skill.tutorial.steps, skill.tutorial.checkOutput, skill.tutorial.troubleshooting]) { if (!Array.isArray(list) || list.length > 30) throw new DomainError("INVALID_SKILL_CANDIDATE", "教程列表无效。"); list.forEach(item => text(item, 4000)); }
  if (skill.recommendation.basis !== "editorial" || skill.recommendation.taskEvaluation !== "not_tested" || skill.recommendation.popularity !== null || !Array.isArray(skill.tracks) || !skill.tracks.length || skill.tracks.some(track => !["general","game","film","ai_agent"].includes(track))) throw new DomainError("INVALID_SKILL_CANDIDATE", "编辑推荐不得伪造任务评价或热度。");
  return value;
}
function bundleDocument(bundle: TrackBundle) {
  keys(bundle,["id","version","name","track","outcome","skillVersionIds","optionalSkillVersionIds","compatibility","limitations","steps","status"]);
  if (!Array.isArray(bundle.skillVersionIds) || !Array.isArray(bundle.optionalSkillVersionIds)) throw new DomainError("INVALID_SKILL_CANDIDATE", "技能包固定项须为列表。");
  text(bundle.id); text(bundle.version); text(bundle.name, 1000); text(bundle.outcome, 4000);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(bundle.id) || !/^[a-zA-Z0-9.-]{1,80}$/.test(bundle.version) || bundle.version === "latest" || !["published","withdrawn"].includes(bundle.status) || !["general","game","film","ai_agent"].includes(bundle.track) || bundle.compatibility !== "not_live_tested") throw new DomainError("INVALID_SKILL_CANDIDATE", "技能包类型、版本或兼容声明无效。");
  const ids = [...bundle.skillVersionIds, ...bundle.optionalSkillVersionIds];
  if (!bundle.skillVersionIds.length || ids.length > 12 || new Set(ids).size !== ids.length || ids.some(id => typeof id!=="string" || !/^[a-z0-9-]+@[a-f0-9]{40}$/.test(id)) || new Set(ids.map(id=>id.split("@")[0])).size !== ids.length) throw new DomainError("INVALID_SKILL_CANDIDATE", "技能包须包含不重复的固定技能版本，同一技能不能同时选择多个 commit。");
  for (const list of [bundle.limitations, bundle.steps]) { if (!Array.isArray(list) || !list.length || list.length > 30) throw new DomainError("INVALID_SKILL_CANDIDATE", "技能包说明无效。"); list.forEach(item => text(item, 4000)); }
}
function compatibility(value: SkillCompatibilityEvidence, document: SkillCandidateDocument) {
  keys(value,["agentId","level","source","clientVersion","os","checkedAt","evidenceUrl","task","limitation","requiredVersionIds"]);
  if (!value || !AGENT_IDS.includes(value.agentId) || !["unknown","installer_declared","command_verified","file_install_verified","client_load_verified","task_verified","failed"].includes(value.level) || !["official_documentation","platform_test","user_reported","model"].includes(value.source)) throw new DomainError("INVALID_SKILL_EVIDENCE", "兼容证据级别或来源无效。");
  text(value.limitation, 2000); if (value.evidenceUrl) publicEvidence(value.evidenceUrl);
  if (value.checkedAt !== null && !Number.isFinite(Date.parse(value.checkedAt))) throw new DomainError("INVALID_SKILL_EVIDENCE", "核验时间无效。");
  if (value.level.endsWith("verified")) {
    if (value.source !== "platform_test" || !value.clientVersion || !value.os || !value.checkedAt || !value.evidenceUrl) throw new DomainError("INVALID_SKILL_EVIDENCE", "实测级别需要平台实际测试、客户端版本、系统与证据，模型或用户自报不能代替。");
    text(value.clientVersion); text(value.os);
    if (value.level === "task_verified") text(value.task, 2000);
    if (document.kind === "bundle" && ["file_install_verified","client_load_verified","task_verified"].includes(value.level) && hash([...(value.requiredVersionIds ?? [])].sort()) !== hash([...document.bundle.skillVersionIds].sort())) throw new DomainError("INVALID_SKILL_EVIDENCE", "整包实测必须在同一环境覆盖全部必需固定版本。");
  }
  if (value.level === "installer_declared" && (value.source !== "official_documentation" || value.evidenceUrl !== AGENT_ADAPTERS.find(agent => agent.id === value.agentId)!.evidenceUrl)) throw new DomainError("INVALID_SKILL_EVIDENCE", "安装器声明须引用当前固定适配依据。");
}
export function validateSkillCandidateDocument(document: SkillCandidateDocument, evidence: SkillCandidateEvidence): void {
  if (!document || !["skill","bundle"].includes(document.kind) || !evidence?.license || !evidence.behavior || !Array.isArray(evidence.compatibility) || evidence.compatibility.length > 40) throw new DomainError("INVALID_SKILL_CANDIDATE", "候选正文与核验字段无效。");
  keys(document,document.kind==="skill"?["kind","skill"]:["kind","bundle"]);
  keys(evidence,["license","behavior","compatibility"]); keys(evidence.license,["status","sourceUrl","sha256","checkedBy","checkedAt","noticesIncluded"]); keys(evidence.behavior,["status","checkedBy","checkedAt","note"]);
  document.kind === "skill" ? fixedVersion(document.skill) : bundleDocument(document.bundle);
  if (!["verified","unknown"].includes(evidence.license.status) || !["reviewed","unknown"].includes(evidence.behavior.status)) throw new DomainError("INVALID_SKILL_EVIDENCE", "许可或行为核验状态无效。");
  if (evidence.license.status === "verified") {
    text(evidence.license.checkedBy); if (!evidence.license.checkedAt || !Number.isFinite(Date.parse(evidence.license.checkedAt)) || !evidence.license.sourceUrl || !evidence.license.sha256 || !/^[a-f0-9]{64}$/.test(evidence.license.sha256) || evidence.license.noticesIncluded !== true) throw new DomainError("INVALID_SKILL_LICENSE", "许可核验需要时间、来源、哈希和完整通知。");
    publicEvidence(evidence.license.sourceUrl);
    if (document.kind === "skill" && (evidence.license.sourceUrl !== document.skill.versions[0].license.sourceUrl || evidence.license.sha256 !== document.skill.versions[0].license.sha256)) throw new DomainError("INVALID_SKILL_LICENSE", "核验许可与版本清单不一致。");
  }
  if (evidence.behavior.status === "reviewed") { text(evidence.behavior.checkedBy); text(evidence.behavior.note, 4000); if (!evidence.behavior.checkedAt || !Number.isFinite(Date.parse(evidence.behavior.checkedAt))) throw new DomainError("INVALID_SKILL_EVIDENCE", "行为核验需要时间与检查说明。"); }
  evidence.compatibility.forEach(value => compatibility(value, document));
}
export function skillCandidateIdentity(document: SkillCandidateDocument): SkillPublicationTarget { return document.kind === "skill" ? { kind: "skill", id: document.skill.id, versionId: document.skill.versions[0].id } : { kind: "bundle", id: document.bundle.id, versionId: `${document.bundle.id}@${document.bundle.version}` }; }
function manifestHash(document: SkillCandidateDocument, resolvedSkillHashes?: SkillCandidate["resolvedSkillHashes"]) { return hash(document.kind === "skill" ? { id: document.skill.versions[0].id, files: document.skill.versions[0].files, license: document.skill.versions[0].license } : { id: document.bundle.id, version: document.bundle.version, required: document.bundle.skillVersionIds, optional: document.bundle.optionalSkillVersionIds, resolvedSkillHashes }); }
function contentHash(document: SkillCandidateDocument, evidence: SkillCandidateEvidence) { return hash({ document, evidence }); }
async function read(sql: SqlExecutor, value: SkillPublicationTarget, lock = false): Promise<SkillCandidate | null> { target(value); return (await sql.query<{ document: SkillCandidate }>(`SELECT document FROM skill_candidates WHERE kind=$1 AND id=$2 AND version_id=$3${lock ? " FOR UPDATE" : ""}`, [value.kind,value.id,value.versionId])).rows[0]?.document ?? null; }
async function write(sql: SqlExecutor, candidate: SkillCandidate, expectedRevision: number) {
  const params = [candidate.kind,candidate.id,candidate.versionId,candidate.revision,candidate.contentHash,JSON.stringify(candidate)];
  if (expectedRevision === 0) { const result = await sql.query("INSERT INTO skill_candidates(kind,id,version_id,revision,content_hash,document) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING", params); if (!result.rowCount) conflict(); }
  else { const result = await sql.query("UPDATE skill_candidates SET revision=$4,content_hash=$5,document=$6::jsonb WHERE kind=$1 AND id=$2 AND version_id=$3 AND revision=$7", [...params,expectedRevision]); if (!result.rowCount) conflict(); }
}
async function history(sql: SqlExecutor, candidate: SkillCandidate) { await sql.query("INSERT INTO skill_candidate_history(kind,id,version_id,revision,document) VALUES($1,$2,$3,$4,$5::jsonb)", [candidate.kind,candidate.id,candidate.versionId,candidate.revision,JSON.stringify(candidate)]); }
async function publishedSkills(sql: SqlExecutor, ids: readonly string[], allowWithdrawnSnapshot = false): Promise<SkillVersion[]> {
  const results: SkillVersion[] = []; for (const id of [...new Set(ids)].sort()) { const skillId = id.split("@")[0]; const skill = (await sql.query<{document:Skill}>("SELECT document FROM skill_catalog WHERE id=$1 FOR UPDATE", [skillId])).rows[0]?.document; const version = skill?.versions.find(value => value.id === id); if (!version || (!allowWithdrawnSnapshot && version.status !== "published")) throw new DomainError("SKILL_VERSION_UNAVAILABLE", "包内固定技能已撤回或未发布。", { status: 409 }); assertVersion(version); results.push(version); } return results;
}
async function snapshot(sql: SqlExecutor, value: SkillPublicationTarget): Promise<SkillReviewSnapshot | null> {
  const candidate = await read(sql,value,true); if (!candidate) return null;
  validateSkillCandidateDocument(candidate.document,candidate.evidence);
  if (candidate.contentHash !== contentHash(candidate.document,candidate.evidence) || candidate.manifestHash !== manifestHash(candidate.document,candidate.resolvedSkillHashes) || hash(skillCandidateIdentity(candidate.document)) !== hash({kind:candidate.kind,id:candidate.id,versionId:candidate.versionId})) throw new DomainError("SKILL_CANDIDATE_TAMPERED", "候选正文或清单哈希不一致。");
  const errors: string[] = [];
  if (candidate.evidence.license.status !== "verified") errors.push("许可尚未核验，不能发布可分发内容。");
  if (candidate.evidence.behavior.status !== "reviewed") errors.push("第三方内容的行为和权限尚未检查。");
  let observedState = candidate.state;
  if (candidate.document.kind === "bundle") {
    const rows = (await sql.query<{document:TrackBundle}>("SELECT document FROM skill_bundles WHERE id=$1 OR id=$2 ORDER BY id FOR UPDATE",[candidate.versionId,candidate.id])).rows;
    if (candidate.state === "published" && !rows.some(row=>row.document.version === (candidate.document as {kind:"bundle";bundle:TrackBundle}).bundle.version && row.document.status === "published")) observedState = "withdrawn";
    try { const versions = await publishedSkills(sql,[...candidate.document.bundle.skillVersionIds,...candidate.document.bundle.optionalSkillVersionIds]); if (hash(versionLocks(versions)) !== hash(candidate.resolvedSkillHashes)) errors.push("技能包内固定文件或许可已变化，需重新录入核验。"); } catch (error) { if (error instanceof DomainError) errors.push(error.message); else throw error; }
  } else {
    const catalog = (await sql.query<{document:Skill}>("SELECT document FROM skill_catalog WHERE id=$1 FOR UPDATE",[candidate.id])).rows[0]?.document;
    if (candidate.state === "published" && !catalog?.versions.some(version=>version.id===candidate.versionId && version.status === "published")) observedState = "withdrawn";
  }
  return {...candidate,state:observedState,validationErrors:errors};
}
function versionLocks(versions: readonly SkillVersion[]): NonNullable<SkillCandidate["resolvedSkillHashes"]> { return versions.map(version=>({versionId:version.id,contentHash:version.contentHash,licenseHash:hash(version.license)})).sort((a,b)=>a.versionId.localeCompare(b.versionId)); }
/** A bundle license review locks every required AND optional constituent license. */
export function bundleLicenseReviewHash(versions: readonly SkillVersion[]): string { return hash(versionLocks(versions).map(value=>({versionId:value.versionId,licenseHash:value.licenseHash}))); }

export function createSkillCandidateService(dependencies: SkillCandidateDependencies) {
  const { database,clock,ids } = dependencies;
  return {
    async list(actor: Actor): Promise<readonly SkillCandidate[]> { reviewer(actor); return database.transaction(async sql=>{ await dependencies.assertActorCurrent?.(sql,actor); const rows=(await sql.query<{document:SkillCandidate}>("SELECT document FROM skill_candidates ORDER BY id,version_id LIMIT 200")).rows.map(row=>row.document); await dependencies.assertActorCurrent?.(sql,actor); return rows; }); },
    async get(actor: Actor, value: SkillPublicationTarget) { reviewer(actor); return database.transaction(async sql=>{await dependencies.assertActorCurrent?.(sql,actor); const result=await snapshot(sql,value); await dependencies.assertActorCurrent?.(sql,actor); return result;}); },
    async save(actor: Actor, input: { expectedRevision: number; document: SkillCandidateDocument; evidence: SkillCandidateEvidence }): Promise<SkillCandidate> {
      reviewer(actor); revision(input.expectedRevision); validateSkillCandidateDocument(input.document,input.evidence);
      const document = structuredClone(input.document), evidence = structuredClone(input.evidence), value = skillCandidateIdentity(document);
      if ((evidence.license.status === "verified" && evidence.license.checkedBy !== actor.userId) || (evidence.behavior.status === "reviewed" && evidence.behavior.checkedBy !== actor.userId)) throw new DomainError("INVALID_SKILL_EVIDENCE", "录入核验须由当前操作者署名。");
      const now = clock.now().toISOString(); if ([evidence.license.checkedAt,evidence.behavior.checkedAt,...evidence.compatibility.map(item=>item.checkedAt)].some(at=>at && Date.parse(at)>clock.now().getTime()+60_000)) throw new DomainError("INVALID_SKILL_EVIDENCE", "核验时间不能在未来。");
      return database.transaction(async sql => {
        await dependencies.assertActorCurrent?.(sql,actor);
        const previous = await read(sql,value,true);
        if ((previous?.revision ?? 0) !== input.expectedRevision) conflict();
        if (previous && previous.state !== "draft") throw new DomainError("SKILL_VERSION_IMMUTABLE", "已发布或撤回版本不可修改，请录入新固定版本。", {status:409});
        if (!previous) {
          if (value.kind === "skill") { const existing = (await sql.query<{document:Skill}>("SELECT document FROM skill_catalog WHERE id=$1 FOR UPDATE",[value.id])).rows[0]?.document; if (existing?.versions.some(version=>version.id===value.versionId)) throw new DomainError("SKILL_VERSION_IMMUTABLE", "该固定技能版本已存在，请录入新 commit。", {status:409}); }
          else { const existing = (await sql.query<{document:TrackBundle}>("SELECT document FROM skill_bundles WHERE id=$1 OR id=$2 ORDER BY id FOR UPDATE",[value.id,value.versionId])).rows; if (existing.some(row=>row.document.version===(document as {kind:"bundle";bundle:TrackBundle}).bundle.version)) throw new DomainError("SKILL_VERSION_IMMUTABLE", "该固定包版本已存在。", {status:409}); }
        }
        const versions = document.kind === "bundle" ? await publishedSkills(sql,[...document.bundle.skillVersionIds,...document.bundle.optionalSkillVersionIds]) : null;
        if (versions && evidence.license.status === "verified" && evidence.license.sha256 !== bundleLicenseReviewHash(versions)) throw new DomainError("INVALID_SKILL_LICENSE", "技能包许可核验哈希须覆盖所有固定项许可。");
        const resolvedSkillHashes = versions ? versionLocks(versions) : undefined;
        const candidate: SkillCandidate = {...value,revision:input.expectedRevision+1,document,evidence,contentHash:contentHash(document,evidence),manifestHash:manifestHash(document,resolvedSkillHashes),state:"draft",recordedBy:actor.userId,recordedAt:now,...(resolvedSkillHashes?{resolvedSkillHashes}:{})};
        await write(sql,candidate,input.expectedRevision); await history(sql,candidate);
        await dependencies.assertActorCurrent?.(sql,actor);
        await sql.query("INSERT INTO skill_audit(id,actor_id,action,target_id,occurred_at,reason) VALUES($1,$2,$3,$4,$5::timestamptz,$6)",[ids.next(),actor.userId,"skill_candidate_saved",value.versionId,now,`候选修订 ${candidate.revision}`]); return candidate;
      });
    }
  };
}

/** Optional root startup bootstrap. It snapshots existing published catalog rows and never revives them. */
export async function importPublishedSkillCandidates(dependencies: SkillCandidateDependencies): Promise<void> {
  const {database,clock,ids}=dependencies;
  await database.transaction(async sql=>{
    const skills=(await sql.query<{document:Skill}>("SELECT document FROM skill_catalog ORDER BY id")).rows.map(row=>row.document);
    const bundles=(await sql.query<{document:TrackBundle}>("SELECT document FROM skill_bundles ORDER BY id")).rows.map(row=>row.document);
    const documents:SkillCandidateDocument[]=[];
    for(const skill of skills) for(const version of skill.versions) if(version.status==="published") documents.push({kind:"skill",skill:{...skill,versions:[version]}});
    for(const bundle of bundles) if(bundle.status==="published") documents.push({kind:"bundle",bundle});
    for(const document of documents) {
      // Rows published by this service already have their immutable candidate, so skip before validation.
      const logical=document.kind==="bundle"?{kind:"bundle" as const,id:document.bundle.bundleId??document.bundle.id,versionId:document.bundle.versionId??`${document.bundle.id}@${document.bundle.version}`}:skillCandidateIdentity(document);
      if(await read(sql,logical,true)) continue;
      if(document.kind==="bundle") { const {bundleId:_bundleId,versionId:_versionId,revision:_revision,reviewContentHash:_contentHash,reviewManifestHash:_manifestHash,compatibilityEvidence:_compatibility,...body}=document.bundle; document.bundle={...body,id:logical.id}; }
      else { const {revision:_revision,reviewContentHash:_contentHash,reviewManifestHash:_manifestHash,compatibilityEvidence:_compatibility,...body}=document.skill.versions[0]; document.skill={...document.skill,versions:[body]}; }
      const version=document.kind==="skill"?document.skill.versions[0]:null;
      const versions=document.kind==="bundle"?await publishedSkills(sql,[...document.bundle.skillVersionIds,...document.bundle.optionalSkillVersionIds],true):null;
      const evidence:SkillCandidateEvidence={license:{status:version?"verified":"unknown",sourceUrl:version?.license.sourceUrl??null,sha256:version?.license.sha256??null,checkedBy:version?"initial-curation":null,checkedAt:version?.reviewedAt??null,noticesIncluded:!!version},behavior:{status:"unknown",checkedBy:null,checkedAt:null,note:"初始目录尚无本轮独立行为核验记录。"},compatibility:AGENT_ADAPTERS.map(agent=>({agentId:agent.id,level:"installer_declared",source:"official_documentation",clientVersion:null,os:null,checkedAt:agent.checkedAt,evidenceUrl:agent.evidenceUrl,task:null,limitation:"仅固定安装器声明，客户端加载与示例任务待验。"}))};
      validateSkillCandidateDocument(document,evidence);
      const resolvedSkillHashes=versions?versionLocks(versions):undefined;
      const candidate:SkillCandidate={...logical,revision:1,document,evidence,contentHash:contentHash(document,evidence),manifestHash:manifestHash(document,resolvedSkillHashes),state:"published",recordedBy:"initial-curation",recordedAt:clock.now().toISOString(),...(resolvedSkillHashes?{resolvedSkillHashes}:{})};
      await write(sql,candidate,0); await history(sql,candidate);
      await sql.query("INSERT INTO skill_audit(id,actor_id,action,target_id,occurred_at,reason) VALUES($1,$2,$3,$4,$5::timestamptz,$6)",[ids.next(),"initial-curation","skill_candidate_imported",logical.versionId,clock.now().toISOString(),"保留既有发布版本快照；客户端兼容仍待验"]);
    }
  });
}

export function createSkillPublicationPort(): SkillPublicationPort {
  async function perform(sql: SqlExecutor,input: SkillPublicationInput,action: "publish"|"withdraw") {
    reviewer(input.actor); target(input); revision(input.expectedRevision); if (input.expectedRevision<1) conflict();
    text(input.reviewOperationId,300); text(input.reviewedBy); text(input.reason,1000); text(input.requestId,300);
    if (!Number.isFinite(Date.parse(input.reviewedAt))) throw new DomainError("INVALID_SKILL_EVIDENCE", "审核时间无效。");
    const current = await snapshot(sql,input); if (!current) throw new DomainError("NOT_FOUND", "技能候选不存在。", {status:404});
    const { requestId: _requestId, actor: _actor, ...operationInput } = input;
    const fingerprint = hash({...operationInput,actorId:input.actor.userId,action});
    await sql.query("INSERT INTO skill_publication_operations(operation_id,fingerprint,result,occurred_at) VALUES($1,$2,'null'::jsonb,$3::timestamptz) ON CONFLICT DO NOTHING",[input.reviewOperationId,fingerprint,input.reviewedAt]);
    const operation = (await sql.query<{fingerprint:string;result:(SkillPublicationTarget & {revision:number;contentHash:string})|null}>("SELECT fingerprint,result FROM skill_publication_operations WHERE operation_id=$1 FOR UPDATE",[input.reviewOperationId])).rows[0];
    if (!operation || operation.fingerprint!==fingerprint) throw new DomainError("IDEMPOTENCY_CONFLICT", "操作标识已用于不同固定版本。",{status:409});
    if (operation.result) return operation.result;
    if (current.revision!==input.expectedRevision || current.contentHash!==input.expectedContentHash || current.manifestHash!==input.expectedManifestHash) conflict();
    if (action==="publish" && (current.state!=="draft" || current.validationErrors.length)) throw new DomainError("SKILL_PUBLICATION_BLOCKED", "当前版本不可发布，请核对状态、许可、行为和包内版本。",{status:409});
    if (action==="withdraw" && current.state!=="published") throw new DomainError("SKILL_NOT_PUBLISHED", "当前固定版本未发布。",{status:409});
    const state = action==="publish" ? "published" as const : "withdrawn" as const;
    if (current.document.kind==="skill") {
      const skill = current.document.skill;
      const existing = (await sql.query<{document:Skill}>("SELECT document FROM skill_catalog WHERE id=$1 FOR UPDATE",[skill.id])).rows[0]?.document;
      if (action==="publish" && existing?.versions.some(version=>version.id===current.versionId)) throw new DomainError("SKILL_VERSION_IMMUTABLE", "不能替换或恢复已发布固定版本。",{status:409});
      const version: SkillVersion = {...skill.versions[0],status:state,reviewedAt:input.reviewedAt,revision:current.revision,reviewContentHash:current.contentHash,reviewManifestHash:current.manifestHash,compatibilityEvidence:current.evidence.compatibility};
      const versions = action==="publish" ? [...(existing?.versions??[]),version] : (existing?.versions??[]).map(value=>value.id===current.versionId?{...value,status:state}:value);
      if (action==="withdraw" && !versions.some(value=>value.id===current.versionId)) conflict();
      const published = {...(action==="withdraw" ? existing! : skill),versions};
      await sql.query("INSERT INTO skill_catalog(id,document) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET document=EXCLUDED.document",[skill.id,JSON.stringify(published)]);
    } else {
      const bundle = current.document.bundle;
      // Canonical rows retain every old package version, while legacy seed IDs continue to work.
      const existing = (await sql.query<{id:string;document:TrackBundle}>("SELECT id,document FROM skill_bundles WHERE id=$1 OR id=$2 FOR UPDATE",[current.versionId,current.id])).rows.find(row=>row.document.version===bundle.version);
      if (action==="publish" && existing) throw new DomainError("SKILL_VERSION_IMMUTABLE", "不能替换或恢复已发布包版本。",{status:409});
      const rowId = action==="withdraw" ? existing?.id : current.versionId; if (!rowId) conflict();
      const published = {...bundle,id:rowId,bundleId:current.id,versionId:current.versionId,status:state,revision:current.revision,reviewContentHash:current.contentHash,reviewManifestHash:current.manifestHash,compatibilityEvidence:current.evidence.compatibility};
      await sql.query("INSERT INTO skill_bundles(id,document) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET document=EXCLUDED.document",[rowId,JSON.stringify(published)]);
    }
    const {validationErrors:_validationErrors,...candidateBody}=current;
    await write(sql,{...candidateBody,state},current.revision);
    const result = {kind:current.kind,id:current.id,versionId:current.versionId,revision:current.revision,contentHash:current.contentHash};
    await sql.query("UPDATE skill_publication_operations SET result=$2::jsonb WHERE operation_id=$1",[input.reviewOperationId,JSON.stringify(result)]);
    await sql.query("INSERT INTO skill_audit(id,actor_id,action,target_id,occurred_at,reason) VALUES($1,$2,$3,$4,$5::timestamptz,$6)",[input.reviewOperationId,input.actor.userId,`skill_version_${state}`,current.versionId,input.reviewedAt,input.reason]); return result;
  }
  return {readForReview:snapshot,publishReviewed:(tx,input)=>perform(tx,input,"publish"),withdraw:(tx,input)=>perform(tx,input,"withdraw")};
}
