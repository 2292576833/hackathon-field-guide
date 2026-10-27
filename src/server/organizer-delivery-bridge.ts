import type { Clock } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import { DomainError } from "../shared/errors.ts";
import type { EventParticipationPort, EventRosterTeamSnapshot, HostedEventAccessPort, HostedEventScope, OrganizerPrincipal, VerifiedEventSubmissionPort } from "../shared/organizer-contracts.ts";
import type { SubmissionLinkContextPort } from "../modules/event-judging/index.ts";
import { PostgresEventsRepository } from "../modules/events/index.ts";
import type { EventsUnitOfWork } from "../modules/events/index.ts";
import type { PostgresProjectsRepository } from "../modules/projects/index.ts";
import { PostgresDeliveryStore } from "../modules/github/index.ts";
import type { DeliveryStorePort, SubmissionRecord } from "../modules/github/index.ts";
import { confirmedRequirementVersionId } from "./facts.ts";

export interface OrganizerDeliveryBridgeDependencies {
  readonly projectsRepository: Pick<PostgresProjectsRepository, "getPlanningContextForUpdate">;
  /** Public, current HostedEvent and roster ports. Lazy closures avoid a composition cycle. */
  readonly hostedEvents: Pick<HostedEventAccessPort, "getEvent">;
  readonly participation: Pick<EventParticipationPort, "getTeam">;
  readonly clock: Clock;
  /** Server configuration, never request Host, forwarded headers or a request body. */
  readonly origin: string;
  /** Called after project/confirmation locks; checks the current explicit mapping before M06 writes. */
  readonly validateOfficialMapping?: (sql: SqlExecutor, event: HostedEventScope) => Promise<string | null>;
  /** Optional test/root factories must bind the supplied transaction database, not another pool. */
  readonly createEventsRepository?: (database: DatabasePort) => Pick<EventsUnitOfWork, "getConfirmation" | "getEvent" | "getRules">;
  readonly createDeliveryStore?: (database: DatabasePort) => Pick<DeliveryStorePort, "getSubmission" | "insertSubmission">;
}

type TrustedContext = {
  readonly event: HostedEventScope; readonly team: EventRosterTeamSnapshot;
  readonly stageId: string; readonly requirementsVersion: string;
  readonly platformUrl: string; readonly repositoryCommitSha: null;
};
type Receipt = Parameters<VerifiedEventSubmissionPort["recordReceipt"]>[2];

function fail(code: string, message: string, status = 409): never {
  throw new DomainError(code, message, { status, recoveryAction: "review_event_rules" });
}
function identifier(value: string): string {
  if (typeof value !== "string" || !value || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) fail("INVALID_HOSTED_RECEIPT", "正式收件标识无效。", 422);
  return value;
}
function trustedOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { return fail("INVALID_HOSTED_ORIGIN", "正式收件服务尚未配置可信 HTTPS 地址。", 503); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) fail("INVALID_HOSTED_ORIGIN", "正式收件服务尚未配置可信 HTTPS 地址。", 503);
  return url.origin;
}
/** The outer O04 transaction owns commit/rollback. Every adapter query stays on this executor. */
function transactionDatabase(sql: SqlExecutor): DatabasePort {
  return { query: (statement, parameters) => sql.query(statement, parameters), transaction: work => work(sql) };
}
function submissionAddress(origin: string, eventId: string): string {
  return new URL(`/competitions/${encodeURIComponent(identifier(eventId))}/submit`, origin).href;
}
function validatedReceiptAddress(origin: string, receipt: Receipt): string {
  if (typeof receipt.receiptUrl !== "string" || receipt.receiptUrl.length > 2048) fail("HOSTED_RECEIPT_URL_MISMATCH", "回执地址与当前赛事正式收件入口不匹配。", 422);
  let url: URL;
  try { url = new URL(receipt.receiptUrl, origin); } catch { return fail("HOSTED_RECEIPT_URL_MISMATCH", "回执地址与当前赛事正式收件入口不匹配。", 422); }
  const expected = new URL(submissionAddress(origin, receipt.eventId));
  expected.searchParams.set("receipt", identifier(receipt.id));
  if (url.username || url.password || url.hash || url.href !== expected.href) fail("HOSTED_RECEIPT_URL_MISMATCH", "回执必须指向本站这场比赛、这份正式材料的查询入口。", 422);
  return expected.href;
}

/**
 * Server-only bridge. An explicitly mapped HostedEvent and a team's expressly linked M02
 * project may append an M06 platform receipt. No public handler accepts these trusted fields.
 * It does not download materials, run a project, call GitHub or claim a repository was tested.
 */
export function createOrganizerDeliveryBridge(deps: OrganizerDeliveryBridgeDependencies): {
  readonly submissionLinkContext: SubmissionLinkContextPort;
  readonly verifiedSubmissions: VerifiedEventSubmissionPort;
} {
  const origin = trustedOrigin(deps.origin);
  const eventsFor = deps.createEventsRepository ?? (database => new PostgresEventsRepository(database));
  const deliveryFor = deps.createDeliveryStore ?? (database => new PostgresDeliveryStore(database));

  async function currentContext(sql: SqlExecutor, principal: OrganizerPrincipal, eventId: string, teamId: string): Promise<TrustedContext | null> {
    await principal.guard(sql);
    const event = await deps.hostedEvents.getEvent(sql, identifier(eventId), { forUpdate: true });
    if (!event || event.eventId !== eventId) fail("EVENT_NOT_FOUND", "找不到这场比赛。", 404);
    const team = await deps.participation.getTeam(sql, eventId, identifier(teamId));
    if (!team || team.id !== teamId || team.eventId !== eventId || team.organizationId !== event.organizationId || !team.memberUserIds.includes(principal.actor.userId)) fail("TEAM_ACCESS_DENIED", "当前账号无法确认这支队伍的正式材料。", 403);
    // Formal organizer intake remains valid without a historical M03/private M02 association.
    if (!event.linkedEventId || !team.projectId) { await principal.guard(sql); return null; }
    if (event.status !== "published" || event.publishedRevision === null || !event.modules.judging) fail("HOSTED_SUBMISSION_UNAVAILABLE", "当前赛事未开放正式收件。");
    if (team.status !== "locked" || !team.eligible || team.captainUserId !== principal.actor.userId) fail("TEAM_NOT_ELIGIBLE", "请由已锁定且报名通过队伍的当前队长确认正式材料。", 403);

    // M02 mutations also lock the project first. The lock protects absent M03 confirmation rows.
    const project = await deps.projectsRepository.getPlanningContextForUpdate(sql, team.projectId, principal.actor.userId);
    if (project.project.id !== team.projectId || !project.members.some(member => member.projectId === team.projectId && member.userId === principal.actor.userId && member.status === "active")) fail("PROJECT_ACCESS_DENIED", "你已没有关联团队空间的权限。", 403);
    if (project.project.stage === "archived") fail("PROJECT_ARCHIVED", "归档团队空间只读，不能增加平台收件记录。");
    const database = transactionDatabase(sql), repository = eventsFor(database);
    await sql.query("SELECT id FROM m03_project_rules WHERE id=$1 FOR UPDATE", [team.projectId]);
    const confirmation = await repository.getConfirmation(team.projectId);
    if (!confirmation || confirmation.projectId !== team.projectId || confirmation.eventId !== event.linkedEventId) fail("REQUIREMENTS_NOT_CONFIRMED", "关联空间须先确认这场比赛的真实规则。");
    if (deps.validateOfficialMapping && await deps.validateOfficialMapping(sql,event) !== event.linkedEventId) fail("OFFICIAL_MAPPING_CHANGED", "正式规则关联已变化，请重新核对后提交。");
    await sql.query("SELECT id FROM m03_events WHERE id=$1 FOR SHARE", [event.linkedEventId]);
    const published = await repository.getEvent(event.linkedEventId);
    if (!published || published.id !== event.linkedEventId || published.publicationStatus === "archived" || !published.publishedVersion) fail("CONFIRMED_RULES_UNAVAILABLE", "关联赛事的公开规则暂时不可用。", 503);
    if (published.publishedVersion !== confirmation.rulesVersion) fail("REQUIREMENTS_VERSION_CONFLICT", "赛事已更新规则，请对照并重新确认后正式提交。");
    const rules = await repository.getRules(confirmation.eventId, confirmation.rulesVersion);
    if (!rules || rules.eventId !== confirmation.eventId || rules.version !== confirmation.rulesVersion) fail("CONFIRMED_RULES_UNAVAILABLE", "已确认规则暂时不可读取。", 503);
    const target = submissionAddress(origin, eventId);
    const stages = rules.stages.filter(stage => {
      if (!["submission", "pitch"].includes(stage.stageType) || !stage.submissionUrl) return false;
      try { const url = new URL(stage.submissionUrl); return !url.username && !url.password && url.href === target; } catch { return false; }
    });
    if (stages.length !== 1) fail("SUBMISSION_STAGE_UNCONFIRMED", "已确认规则须明确且唯一指向本站这场比赛的正式提交阶段。", 422);
    // A latest saved Git commit need not be the commit represented by submitted links. Keep it unknown.
    const output: TrustedContext = { event, team, stageId: stages[0]!.id, requirementsVersion: confirmedRequirementVersionId(confirmation), platformUrl: new URL(stages[0]!.submissionUrl!).href, repositoryCommitSha: null };
    await principal.guard(sql);
    return output;
  }

  const submissionLinkContext: SubmissionLinkContextPort = {
    async resolve(sql, principal, suppliedEvent, suppliedTeam) {
      if (suppliedTeam.eventId !== suppliedEvent.eventId || suppliedTeam.organizationId !== suppliedEvent.organizationId) fail("EVENT_SCOPE_MISMATCH", "队伍与赛事不匹配。", 403);
      const context = await currentContext(sql, principal, suppliedEvent.eventId, suppliedTeam.id);
      if (!context) return null;
      if (context.event.organizationId !== suppliedEvent.organizationId || context.event.revision !== suppliedEvent.revision || context.event.linkedEventId !== suppliedEvent.linkedEventId || context.team.revision !== suppliedTeam.revision || context.team.projectId !== suppliedTeam.projectId) fail("HOSTED_LINK_CONTEXT_CHANGED", "赛事或关联空间已更新，请重新预览正式材料。");
      return { stageId: context.stageId, requirementsVersion: context.requirementsVersion, repositoryCommitSha: context.repositoryCommitSha };
    },
  };
  const verifiedSubmissions: VerifiedEventSubmissionPort = {
    async recordReceipt(sql, principal, receipt) {
      const context = await currentContext(sql, principal, receipt.eventId, receipt.teamId);
      if (!context) fail("HOSTED_RECEIPT_UNLINKED", "这份正式收件尚未关联可核验的团队规则记录。");
      if (receipt.linkedEventId !== context.event.linkedEventId || receipt.projectId !== context.team.projectId || receipt.stageId !== context.stageId || receipt.requirementsVersion !== context.requirementsVersion || receipt.repositoryCommitSha !== context.repositoryCommitSha) fail("HOSTED_RECEIPT_FACT_MISMATCH", "收件事实与当前关联赛事、空间及规则版本不匹配。");
      if (typeof receipt.materialHash !== "string" || !/^[a-f0-9]{64}$/.test(receipt.materialHash)) fail("INVALID_HOSTED_RECEIPT", "正式材料快照哈希无效。", 422);
      const now = deps.clock.now(), submitted = new Date(receipt.submittedAt);
      if (!Number.isFinite(now.getTime()) || !Number.isFinite(submitted.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(receipt.submittedAt) || submitted.toISOString() !== receipt.submittedAt || submitted.getTime() > now.getTime()) fail("INVALID_HOSTED_RECEIPT", "正式收件时间无效。", 422);
      const receiptUrl = validatedReceiptAddress(origin, receipt), store = deliveryFor(transactionDatabase(sql));
      const submissionRecordId = `hosted-intake:${identifier(receipt.id)}`;
      const evidenceRefs = [receiptUrl, `hosted-material-sha256:${receipt.materialHash}`];
      const existing = await store.getSubmission(receipt.projectId, submissionRecordId);
      if (existing) {
        if (existing.projectId !== receipt.projectId || existing.eventId !== receipt.linkedEventId || existing.stageId !== receipt.stageId || existing.requirementsVersion !== receipt.requirementsVersion || existing.platformUrl !== context.platformUrl || existing.submittedAt !== receipt.submittedAt || existing.recordedBy !== principal.actor.userId || existing.repositoryCommitSha !== null || existing.verificationSource !== "platform_verified" || existing.status !== "verified" || existing.version !== 1 || existing.evidenceRefs.length !== evidenceRefs.length || !existing.evidenceRefs.every((value, index) => value === evidenceRefs[index])) fail("HOSTED_RECEIPT_REPLAY_CONFLICT", "这份回执已有不同的平台事实，不能覆盖历史记录。");
        await principal.guard(sql);
        return { submissionRecordId };
      }
      const record: SubmissionRecord = { id: submissionRecordId, projectId: receipt.projectId, eventId: receipt.linkedEventId, stageId: context.stageId, requirementsVersion: context.requirementsVersion,
        platformUrl: context.platformUrl, submittedAt: receipt.submittedAt, verificationSource: "platform_verified", repositoryCommitSha: null, status: "verified", evidenceRefs,
        recordedBy: principal.actor.userId, recordedAt: now.toISOString(), version: 1 };
      await store.insertSubmission(record);
      await principal.guard(sql);
      return { submissionRecordId };
    },
  };
  return { submissionLinkContext, verifiedSubmissions };
}
