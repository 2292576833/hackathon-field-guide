import { createHash } from "node:crypto";
import type { Clock, IdGenerator } from "../shared/contracts.ts";
import { DomainError } from "../shared/errors.ts";
import type { EventStaffCapability, OrganizerPrincipal } from "../shared/organizer-contracts.ts";
import type { DatabasePort } from "../shared/persistence.ts";
import { withAiExecutionContext, type JsonModelPort } from "./ai.ts";
import { createModuleAssistantService } from "../modules/module-assistants/index.ts";
import type {
  ModuleAssistantFacts, ModuleAssistantFactsPort, ModuleAssistantFactsRequest, ModuleAssistantKey,
  ModuleAssistantLedgerEntry, ModuleAssistantLedgerPort, ModuleAssistantLedgerRecord, ModuleAssistantModelPort,
  ModuleAssistantModelRequest, ModuleAssistantModelResult, ModuleAssistantScopePort, ModuleAssistantService,
} from "../modules/module-assistants/index.ts";

/**
 * 规划34 P4：7 个流程模块助手全部接线（B1 评审/报名 + B2 概览/队伍/通知答疑/行程/现场服务）。
 * 每个助手只读**本模块注册表声明的**事实键；读不到的键写进 `missing`，绝不编造。
 */
export const WIRED_MODULE_ASSISTANTS: readonly ModuleAssistantKey[] = ["overview", "registration", "teams", "communication", "schedule", "services", "judging", "enroll", "teamup", "submit", "results", "retro", "plan", "resources"];

type Read = (principal: OrganizerPrincipal, eventId: string) => Promise<unknown>;
interface RegistrationFactsSource {
  registrationCounts(principal: OrganizerPrincipal, eventId: string): Promise<{ counts: Record<string, number>; pending: number; reserved: number }>;
  listStaff(principal: OrganizerPrincipal, eventId: string, options: { status?: string; cursor?: string; limit?: number }): Promise<{ registrations: { items: readonly { id: string; userId: string; submittedAt: string | null }[] } }>;
  getStaffForm(principal: OrganizerPrincipal, eventId: string): Promise<{ form: { revision: number; title: string } | null }>;
  /** 选手侧：本人报名与队伍状态（只读，SQL 级，需在同一事务里调用）。 */
  getOwnFacts(sql: unknown, eventId: string, userId: string): Promise<{
    readonly registration: { readonly status: string; readonly reviewNote: string } | null;
    readonly team: { readonly id: string; readonly name: string; readonly track: string; readonly status: string; readonly captainUserId: string; readonly memberCount: number } | null;
  } | null>;
  /** 选手侧：本场报名表（只读，不需要工作人员权限）。 */
  getRegistrationForm(eventId: string): Promise<{ form: { revision: number; title: string; fields: readonly { label: string }[] } | null }>;
  listStaffTeams(principal: OrganizerPrincipal, eventId: string, options?: { limit?: number }): Promise<unknown>;
}
interface JudgingFactsSource {
  workspace(principal: OrganizerPrincipal, eventId: string): Promise<{ rounds: readonly { id: string; status: string }[]; submissions: readonly unknown[]; assignments: readonly unknown[] }>;
  progress(principal: OrganizerPrincipal, eventId: string, roundId: string): Promise<unknown>;
}
interface OverviewFactsSource { getManagedEvent: Read; listEventReadiness: Read }
interface CommunicationFactsSource { listManagedAnnouncements: Read; listManagedTickets: Read; listPublicFaqs: Read }
interface ScheduleFactsSource { getScheduleDraft: Read; getSchedule: Read; listManagedIcebreakers: Read }
interface LogisticsFactsSource { listAccommodation: Read; listVouchers: Read }
interface JudgingClosureSource {
  closureIntakeReceipts(sql: unknown, scope: unknown): Promise<readonly { readonly teamId: string; readonly materials: { readonly title: string; readonly description: string; readonly links: readonly unknown[]; readonly files: readonly unknown[] } }[]>;
  closurePublishedResults(sql: unknown, scope: unknown): Promise<readonly { readonly id: string; readonly roundTitle: string; readonly version: number; readonly publishedAt: string; readonly rows: readonly { readonly teamId: string; readonly title: string; readonly total: number; readonly rank: number }[] }[]>;
  closureJudgingRounds(sql: unknown, scope: unknown): Promise<readonly { readonly id: string; readonly title: string; readonly criteriaCount: number; readonly state: string; readonly appealWindowDays: number }[]>;
}

export interface ModuleAssistantRuntimeDeps {
  readonly database: DatabasePort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly aiModel: JsonModelPort | null;
  readonly organizer: OverviewFactsSource;
  readonly registration: RegistrationFactsSource;
  readonly communication: CommunicationFactsSource;
  readonly schedule: ScheduleFactsSource;
  readonly logistics: LogisticsFactsSource;
  readonly judging: JudgingFactsSource;
  /** 赛事范围（只读），给「我的材料 / 我的结果」定位队伍用。 */
  readonly events: { getEvent(sql: unknown, eventId: string): Promise<{ readonly organizationId: string } | null> };
  /** 选手自己的名片（角色/技能），未接入时返回 null；只读、仅本人。 */
  readonly readParticipantProfile?: (actor: unknown) => Promise<{
    readonly primaryRoles: readonly string[]; readonly supportingRoles: readonly string[]; readonly skills: readonly string[];
  } | null>;
}
/** 每次请求解析出的本场授权范围（由根用服务端既有授权解析，禁止取自请求 JSON）。 */
export interface ModuleAssistantBoundScope {
  readonly organizationId: string;
  readonly eventId: string;
  readonly capabilities: readonly EventStaffCapability[];
  /** 根判定：本场报名已通过时为 true。选手端助手只认这一个标记。 */
  readonly participantApproved?: boolean;
  readonly enabledAssistants?: readonly ModuleAssistantKey[];
}
export interface ModuleAssistantRuntime {
  readonly wired: readonly ModuleAssistantKey[];
  service(principal: OrganizerPrincipal, scope: ModuleAssistantBoundScope): ModuleAssistantService;
}

/** 只读列表归一：接受数组或带唯一列表字段的对象；拿不到就返回空数组，绝不编造条目。 */
function rows(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["sessions", "items", "teams", "registrations", "announcements", "tickets", "faqs", "vouchers", "assignments", "groups", "questions"]) {
      const inner = record[key];
      if (Array.isArray(inner)) return inner;
      if (inner && typeof inner === "object" && Array.isArray((inner as Record<string, unknown>).items)) return (inner as { items: unknown[] }).items;
    }
  }
  return [];
}
function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}
function text(value: unknown, key: string): string | null {
  const found = field(value, key);
  return typeof found === "string" && found ? found : null;
}

/**
 * 模块助手的**根运行时**：把四个注入 Port 适配到既有服务与既有 AI 账本。
 * 没有任何发布/发信/扣分/改结果/改权限路径；模型只出草稿。
 */
export function createModuleAssistantRuntime(deps: ModuleAssistantRuntimeDeps): ModuleAssistantRuntime {
  function facts(principal: OrganizerPrincipal, scope: ModuleAssistantBoundScope): ModuleAssistantFactsPort {
    const finished = (moduleKey: ModuleAssistantKey, request: ModuleAssistantFactsRequest, values: Record<string, unknown>, missing: string[]): ModuleAssistantFacts => ({
      moduleKey, organizationId: request.organizationId, eventId: request.eventId, namespace: request.namespace,
      capturedAt: deps.clock.now().toISOString(),
      fingerprint: createHash("sha256").update(JSON.stringify({ values, missing })).digest("hex"),
      values, sources: [], missing,
    });
    const later = (key: string) => `${key} 暂未接入`;
    async function safely(missing: string[], label: string, work: () => Promise<void>): Promise<void> {
      try { await work(); } catch { missing.push(`${label}未读取`); }
    }
    async function overview(request: ModuleAssistantFactsRequest): Promise<ModuleAssistantFacts> {
      const values: Record<string, unknown> = {}, missing: string[] = [];
      let managed: unknown = null;
      await safely(missing, "本场赛事", async () => { managed = await deps.organizer.getManagedEvent(principal, request.eventId); });
      values.status = text(managed, "status") ?? "unknown";
      values.startsAt = text(managed, "startsAt");
      values.endsAt = text(managed, "endsAt");
      await safely(missing, "发布就绪", async () => {
        const readiness = rows(await deps.organizer.listEventReadiness(principal, request.eventId));
        values.readiness = readiness.map(item => ({ field: text(item, "field") ?? text(item, "key") ?? "unknown", state: text(item, "state") ?? text(item, "status") ?? "unknown" })).slice(0, 40);
        values.publishBlockers = readiness.filter(item => ["missing", "conflicting"].includes(text(item, "state") ?? text(item, "status") ?? "")).length;
      });
      missing.push(later("rulesVersion"), later("versionChanges"));
      return finished("overview", request, values, missing);
    }
    async function registration(request: ModuleAssistantFactsRequest): Promise<ModuleAssistantFacts> {
      const values: Record<string, unknown> = {}, missing: string[] = [];
      await safely(missing, "报名计数", async () => {
        const counts = await deps.registration.registrationCounts(principal, request.eventId);
        values.pendingReviewCount = counts.pending; values.approvedCount = counts.counts.approved;
        values.rejectedCount = counts.counts.rejected; values.withdrawnCount = counts.counts.withdrawn; values.draftCount = counts.counts.draft;
      });
      await safely(missing, "待审报名分页", async () => {
        const page = await deps.registration.listStaff(principal, request.eventId, { status: "pending", limit: 20 });
        values.pendingRows = page.registrations.items.map(row => ({ id: row.id, userId: row.userId, submittedAt: row.submittedAt }));
      });
      await safely(missing, "报名表版本", async () => {
        const view = await deps.registration.getStaffForm(principal, request.eventId);
        if (view.form) values.formVersion = view.form.revision; else missing.push("本场还没有已发布报名表");
      });
      missing.push(later("capacity"), later("registrationWindow"));
      return finished("registration", request, values, missing);
    }
    async function teams(request: ModuleAssistantFactsRequest): Promise<ModuleAssistantFacts> {
      const values: Record<string, unknown> = {}, missing: string[] = [];
      await safely(missing, "本场队伍", async () => {
        const view = await deps.registration.listStaffTeams(principal, request.eventId, { limit: 100 });
        const items = rows(view);
        values.confirmedTeamCount = items.length;
        values.proposedGrouping = items.slice(0, 40).map(item => ({ id: text(item, "id") ?? "unknown", name: text(item, "name") ?? "未命名", track: text(item, "track") ?? "" }));
      });
      missing.push(later("formingTeamCount"), later("withdrawnTeamCount"), later("teamSizeRules"), later("eligibilityIssues"));
      return finished("teams", request, values, missing);
    }
    async function communication(request: ModuleAssistantFactsRequest): Promise<ModuleAssistantFacts> {
      const values: Record<string, unknown> = {}, missing: string[] = [];
      await safely(missing, "本场公告", async () => {
        const announcements = rows(await deps.communication.listManagedAnnouncements(principal, request.eventId));
        values.announcementCount = announcements.length;
        values.draftAnnouncements = announcements.slice(0, 20).map(item => ({ id: text(item, "id") ?? "unknown", title: text(item, "title") ?? "未命名", status: text(item, "status") ?? "unknown" }));
      });
      await safely(missing, "本场工单", async () => {
        const tickets = rows(await deps.communication.listManagedTickets(principal, request.eventId));
        values.openTicketCount = tickets.filter(item => ["open", "pending", "waiting"].includes(text(item, "status") ?? "open")).length;
        values.recentQuestions = tickets.slice(0, 20).map(item => ({ id: text(item, "id") ?? "unknown", subject: text(item, "subject") ?? text(item, "title") ?? "未命名", status: text(item, "status") ?? "unknown" }));
      });
      await safely(missing, "公开 FAQ", async () => { values.publishedFaqCount = rows(await deps.communication.listPublicFaqs(principal, request.eventId)).length; });
      missing.push(later("templateCount"));
      return finished("communication", request, values, missing);
    }
    async function schedule(request: ModuleAssistantFactsRequest): Promise<ModuleAssistantFacts> {
      const values: Record<string, unknown> = {}, missing: string[] = [];
      await safely(missing, "行程草稿", async () => {
        const draft = rows(await deps.schedule.getScheduleDraft(principal, request.eventId));
        values.draftSessionCount = draft.length;
        values.sessions = draft.slice(0, 40).map(item => ({ id: text(item, "id") ?? "unknown", title: text(item, "title") ?? "未命名", startsAt: text(item, "startsAt") }));
      });
      await safely(missing, "已发布行程", async () => { values.publishedSessionCount = rows(await deps.schedule.getSchedule(principal, request.eventId)).length; });
      missing.push(later("timeConflicts"), later("timezone"));
      return finished("schedule", request, values, missing);
    }
    async function services(request: ModuleAssistantFactsRequest): Promise<ModuleAssistantFacts> {
      const values: Record<string, unknown> = {}, missing: string[] = [];
      await safely(missing, "住宿分配", async () => {
        const assignments = rows(await deps.logistics.listAccommodation(principal, request.eventId));
        values.accommodationAssignedCount = assignments.length;
        values.unassignedPeople = assignments.slice(0, 20).map(item => ({ userId: text(item, "userId") ?? "unknown", room: text(item, "room") ?? "未安排" }));
      });
      await safely(missing, "餐券", async () => { values.mealVoucherIssuedCount = rows(await deps.logistics.listVouchers(principal, request.eventId)).length; });
      await safely(missing, "破冰分组", async () => { values.icebreakingGroupCount = rows(await deps.schedule.listManagedIcebreakers(principal, request.eventId)).length; });
      missing.push(later("accommodationUnassignedCount"));
      return finished("services", request, values, missing);
    }
    async function judging(request: ModuleAssistantFactsRequest): Promise<ModuleAssistantFacts> {
      const values: Record<string, unknown> = {}, missing: string[] = [];
      await safely(missing, "评审工作区", async () => {
        const workspace = await deps.judging.workspace(principal, request.eventId);
        values.receiptCount = workspace.submissions.length;
        values.assignmentCount = workspace.assignments.length;
        const latest = workspace.rounds.length ? workspace.rounds[workspace.rounds.length - 1]! : null;
        values.roundStatus = latest ? latest.status : "none";
        if (latest) await safely(missing, "评审进度", async () => { values.progress = await deps.judging.progress(principal, request.eventId, latest.id); });
        else missing.push("本场还没有评审轮次");
      });
      missing.push(later("calibration"), later("integrity"), later("fairness"), later("disclosureGate"));
      return finished("judging", request, values, missing);
    }
    async function withEventScope<T>(eventId: string, work: (sql: unknown, scope: unknown) => Promise<T>): Promise<T> {
      return deps.database.transaction(async sql => {
        const scope = await deps.events.getEvent(sql, eventId);
        if (!scope) throw new DomainError("EVENT_SITE_FORBIDDEN", "赛事不存在。", { status: 404 });
        return work(sql, scope);
      });
    }
    const closure = () => deps.judging as unknown as JudgingClosureSource;
    async function enroll(request: ModuleAssistantFactsRequest): Promise<ModuleAssistantFacts> {
      const values: Record<string, unknown> = {}, missing: string[] = [];
      await safely(missing, "我的报名", async () => {
        const own = await deps.database.transaction(sql => deps.registration.getOwnFacts(sql, request.eventId, request.actor.userId));
        values.registrationStatus = own?.registration?.status ?? "none";
        values.teamStatus = own?.team?.status ?? null;
        values.teamName = own?.team?.name ?? null;
      });
      await safely(missing, "本场报名表", async () => {
        const form = await deps.registration.getRegistrationForm(request.eventId);
        if (form.form) { values.formVersion = form.form.revision; values.formFieldLabels = form.form.fields.slice(0, 40).map(fieldItem => fieldItem.label); }
        else missing.push("本场还没有已发布报名表");
      });
      missing.push(later("报名时间窗"), later("截止时间"));
      return finished("enroll", request, values, missing);
    }
    async function teamup(request: ModuleAssistantFactsRequest): Promise<ModuleAssistantFacts> {
      const values: Record<string, unknown> = {}, missing: string[] = [];
      await safely(missing, "我的队伍", async () => {
        const own = await deps.database.transaction(sql => deps.registration.getOwnFacts(sql, request.eventId, request.actor.userId));
        values.myTeamStatus = own?.team?.status ?? null;
        values.myTeamName = own?.team?.name ?? null;
      });
      await safely(missing, "组队大厅", async () => {
        const open = await deps.database.query<{ count: number }>("SELECT count(*)::int AS count FROM tmt_team_match_opt_in WHERE event_id=$1 AND open=true", [request.eventId]);
        values.hallCandidateCount = open.rows[0]?.count ?? 0;
      });
      await safely(missing, "我的角色与技能", async () => {
        const profile = await deps.readParticipantProfile?.(request.actor) ?? null;
        if (profile === null) { missing.push("还没有名片，先补名片"); return; }
        values.myRoles = [...profile.primaryRoles, ...profile.supportingRoles];
        values.mySkills = [...profile.skills];
      });
      missing.push(later("缺口"));
      return finished("teamup", request, values, missing);
    }
    async function submit(request: ModuleAssistantFactsRequest): Promise<ModuleAssistantFacts> {
      const values: Record<string, unknown> = {}, missing: string[] = [];
      await safely(missing, "我的材料", async () => {
        const own = await deps.database.transaction(sql => deps.registration.getOwnFacts(sql, request.eventId, request.actor.userId));
        const teamId = own?.team?.id ?? null;
        values.teamName = own?.team?.name ?? null;
        if (teamId === null) { missing.push("还没有队伍，暂无提交材料"); return; }
        const receipts = await withEventScope(request.eventId, (sql, scope) => closure().closureIntakeReceipts(sql, scope));
        const mine = receipts.find(receipt => receipt.teamId === teamId) ?? null;
        values.myMaterialStatus = mine === null ? "not_submitted" : "submitted";
        if (mine === null) { missing.push("还没有提交记录"); return; }
        values.materialTitle = mine.materials.title;
        values.materialLinkCount = mine.materials.links.length;
        values.materialFileCount = mine.materials.files.length;
        values.missingItems = mine.materials.description.trim() === "" ? ["简介还没写"] : [];
      });
      missing.push(later("提交时间窗"));
      return finished("submit", request, values, missing);
    }
    async function results(request: ModuleAssistantFactsRequest): Promise<ModuleAssistantFacts> {
      const values: Record<string, unknown> = {}, missing: string[] = [];
      await safely(missing, "已公布结果", async () => {
        const own = await deps.database.transaction(sql => deps.registration.getOwnFacts(sql, request.eventId, request.actor.userId));
        const teamId = own?.team?.id ?? null;
        values.teamName = own?.team?.name ?? null;
        const rounds = await withEventScope(request.eventId, (sql, scope) => closure().closureJudgingRounds(sql, scope));
        const publishedRounds = rounds.filter(round => round.state === "published");
        values.scoringDimensions = publishedRounds.map(round => round.criteriaCount);
        const windowDays = publishedRounds.at(-1)?.appealWindowDays ?? null;
        values.appealWindowDays = windowDays;
        const published = await withEventScope(request.eventId, (sql, scope) => closure().closurePublishedResults(sql, scope));
        const latest = published.at(-1) ?? null;
        values.publishedRevision = latest === null ? null : latest.version;
        if (latest !== null && windowDays !== null) {
          const publishedAt = Date.parse(latest.publishedAt);
          if (Number.isFinite(publishedAt)) values.appealDeadlineAt = new Date(publishedAt + windowDays * 86_400_000).toISOString();
        }
        if (teamId === null) { missing.push("还没有队伍，暂无本人结果"); return; }
        const mine = published.flatMap(projection => projection.rows
          .filter(row => row.teamId === teamId)
          .map(row => ({ round: projection.roundTitle, total: row.total, rank: row.rank, publishedAt: projection.publishedAt })));
        values.myResult = mine.at(-1) ?? null;
      });
      missing.push(later("我的申诉状态"));
      return finished("results", request, values, missing);
    }
    async function retro(request: ModuleAssistantFactsRequest): Promise<ModuleAssistantFacts> {
      const values: Record<string, unknown> = {}, missing: string[] = [];
      await safely(missing, "我的参赛事实", async () => {
        const own = await deps.database.transaction(sql => deps.registration.getOwnFacts(sql, request.eventId, request.actor.userId));
        values.registrationStatus = own?.registration?.status ?? "none";
        values.myTeamName = own?.team?.name ?? null;
      });
      missing.push(later("提交版本"), later("已公布结果"));
      return finished("retro", request, values, missing);
    }
    return { overview, registration, teams, communication, schedule, services, judging, enroll, teamup, submit, results, retro };
  }
  return {
    wired: WIRED_MODULE_ASSISTANTS,
    service(principal, scope) {
      let lastCall: { executionId: string; usage: { inputTokens: number; outputTokens: number } | null } | null = null;
      const scopePort: ModuleAssistantScopePort = {
        resolve: async ({ actor }) => {
          if (actor.userId !== principal.actor.userId) throw new DomainError("MODULE_ASSISTANT_SCOPE_INVALID", "授权范围与当前账号不一致。", { status: 503 });
          return { organizationId: scope.organizationId, eventId: scope.eventId, capabilities: scope.capabilities, ...(scope.participantApproved === undefined ? {} : { participantApproved: scope.participantApproved }), ...(scope.enabledAssistants ? { enabledAssistants: scope.enabledAssistants } : {}) };
        },
      };
      const model: ModuleAssistantModelPort = {
        available: Boolean(deps.aiModel),
        modelVersion: deps.aiModel ? deps.aiModel.modelVersion : "unconfigured",
        async complete(request: ModuleAssistantModelRequest): Promise<ModuleAssistantModelResult> {
          const transport = deps.aiModel;
          if (!transport) throw new DomainError("AI_UNCONFIGURED", "本站尚未配置模型，模块助手暂不可用；本模块的人工流程照常可用。", { status: 503 });
          const executionId = deps.ids.next(), leaseToken = deps.ids.next();
          const projectId = `organizer-assistant:${request.eventId}:${request.assistantKey}`;
          const actorId = principal.actor.userId;
          const now = deps.clock.now(), until = new Date(now.getTime() + 300_000).toISOString(), at = now.toISOString();
          await deps.database.query("INSERT INTO ai_execution_jobs(id,kind,module_job_id,source_revision,project_id,actor_id,status,attempts,lease_owner,lease_token,lease_until,external_state,created_at,updated_at) VALUES($1,$2,$1,1,$3,$4,'running',0,'module-assistant',$5,$6::timestamptz,'not_sent',$7::timestamptz,$7::timestamptz)",
            [executionId, "module_assistant", projectId, actorId, leaseToken, until, at]);
          try {
            const result = await withAiExecutionContext({ executionId, leaseToken, projectId, actorId }, () => transport.completeJSON({ systemPrompt: request.systemPrompt, input: request.input, promptVersion: request.promptVersion, outputExample: request.outputExample, maxOutputTokens: request.maxOutputTokens }, AbortSignal.timeout(120_000)));
            lastCall = { executionId, usage: result.usage };
            await deps.database.query("UPDATE ai_execution_jobs SET status='succeeded',attempts=attempts+1,lease_owner=NULL,lease_token=NULL,lease_until=NULL,external_state='response_received',updated_at=$2::timestamptz WHERE id=$1", [executionId, deps.clock.now().toISOString()]);
            return { content: result.content, usage: result.usage, modelVersion: result.modelVersion, requestId: result.requestId };
          } catch (error) {
            await deps.database.query("UPDATE ai_execution_jobs SET status='failed',attempts=attempts+1,lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=$2::timestamptz WHERE id=$1", [executionId, deps.clock.now().toISOString()]).catch(() => {});
            throw error;
          }
        },
      };
      const ledger: ModuleAssistantLedgerPort = {
        async record(_entry: ModuleAssistantLedgerEntry): Promise<ModuleAssistantLedgerRecord> {
          if (!lastCall) return { ledgerId: "", cost: null };
          return { ledgerId: lastCall.executionId, cost: { microUsdEstimated: null, note: "费用由既有 AI 账本按次结算；未配置定价时不显示金额。" } };
        },
      };
      return createModuleAssistantService({ scope: scopePort, facts: facts(principal, scope), model, ledger, clock: deps.clock });
    },
  };
}
