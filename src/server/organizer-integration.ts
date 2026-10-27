import type { Clock, IdGenerator } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import { DomainError, isDomainError, toErrorEnvelope } from "../shared/errors.ts";
import type { EventJudgeConflictPort, EventNotificationPort, EventProjectLinkPort, OrganizerPrincipal, VerifiedEventSubmissionPort } from "../shared/organizer-contracts.ts";
import { OrganizerService, createHostedEventAccessPort, createOrganizerHttpHandlers, organizerHttpRoute } from "../modules/organizer/index.ts";
import type { HostedEvent, OrganizationApplication, StaffGrant, EventPreview } from "../modules/organizer/index.ts";
import { createEventRegistrationService, createEventRegistrationHandlers } from "../modules/event-registration/index.ts";
import type { EventRegistrationHandlers, EventRegistrationRouteParams, EventProjectLinkPreviewPort, EventTeamTrackPort } from "../modules/event-registration/index.ts";
import { createEventCommunicationService, createEventScheduleService, createEventLogisticsService, createEventCommunicationHttpHandlers, eventCommunicationHttpRoute } from "../modules/event-communication/index.ts";
import type { EventOwnFactsPort } from "../modules/event-communication/index.ts";
import { createEventJudgingService, createEventJudgingHandlers } from "../modules/event-judging/index.ts";
import type { EventJudgingRouteParams, SubmissionLinkContextPort } from "../modules/event-judging/index.ts";
import { createEventClosureService, createEventClosureHandlers } from "../modules/event-closure/index.ts";
import { createEventCommunityService, createEventCommunityHandlers } from "../modules/event-community/index.ts";
import type { EventCommunityRouteParams } from "../modules/event-community/index.ts";
import { createEventPeerReviewService, createEventPeerReviewHandlers } from "../modules/event-peer-review/index.ts";
import type { EventPeerReviewRouteParams } from "../modules/event-peer-review/index.ts";
import { createEventSiteService, createEventSiteHandlers } from "../modules/event-site/index.ts";
import type { EventSiteRouteParams } from "../modules/event-site/index.ts";
import { EVENT_SITE_GENERATION_MAX_OUTPUT_TOKENS, EVENT_SITE_SUGGESTION_MAX_OUTPUT_TOKENS, applyAnnotations, defaultPageSpec, generatePage, refineContainer, suggestForSpec } from "../modules/event-site/index.ts";
import { createBudgetedJsonCall } from "./ai-call.ts";
import { withAiExecutionContext } from "./ai.ts";
import { BlocksScanner } from "./json-stream.ts";
import { EVENT_SITE_GENERATION_PROMPT_VERSION, EVENT_SITE_GENERATION_SYSTEM_PROMPT, buildGenerationUserPrompt, parseGenerationIntent, parseSpec, reviewSpec } from "../modules/event-site/index.ts";
import type { StreamingJsonModelPort } from "./ai-stream.ts";
import { decodePageAssetUpload, pageAssetResponse, savePageAsset, suggestPlacement } from "./page-assets.ts";
import { readImageSize } from "./image-size.ts";
import type { EventClosureRouteParams, ClosureReuseSource, EventClosureSourcePort } from "../modules/event-closure/index.ts";
import { MODULE_ASSISTANT_KEYS, moduleAssistantCatalog } from "../modules/module-assistants/index.ts";
import { createModuleAssistantRuntime, WIRED_MODULE_ASSISTANTS } from "./module-assistant-runtime.ts";
import type { JsonModelPort } from "./ai.ts";
import type { ProjectAggregate, ProjectsRepository } from "../modules/projects/index.ts";
import { createOrganizerClaimDiscoveryPort, createOrganizerReadinessEvidencePort } from "./organizer-claims.ts";

export interface OrganizerIntegrationDependencies {
  readonly database: DatabasePort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly requestIds?: IdGenerator;
  /** Current actor plus an account/session guard. No JSON-derived principals. */
  resolvePrincipal(request: Request): Promise<OrganizerPrincipal | null>;
  assertMutationAllowed(request: Request): Promise<void>;
  /** Account owner supplies this check; FK existence does not prove account eligibility. */
  requireActiveTarget(sql: SqlExecutor, userId: string): Promise<void>;
  /** M02 public repository, sharing the ambient transaction and exact executor. */
  readonly projectRepository?: Pick<ProjectsRepository, "withProject">;
  /** Persisted, event-scoped human relationship checks; absence is needs_review. */
  readonly relationshipReviews?: EventJudgeConflictPort;
  readonly tracks?: EventTeamTrackPort;
  /** Root may decorate the raw current scope with an explicitly verified M03 association. */
  readonly decorateEventAccess?: (base: import("../shared/organizer-contracts.ts").HostedEventAccessPort) => import("../shared/organizer-contracts.ts").HostedEventAccessPort;
  readonly notification?: EventNotificationPort;
  readonly announcementAudience?: { listRecipientUserIds(sql: SqlExecutor, eventId: string): Promise<readonly string[]> };
  /** Supply these together only after a real M02/M03/M06 trusted bridge exists. */
  readonly verifiedSubmissions?: VerifiedEventSubmissionPort;
  readonly submissionLinkContext?: SubmissionLinkContextPort;
  /**
   * 规划34 D1：惰性取 recruiting（组装顺序上它晚于本集成，与既有 L114 的惰性闭包同法）。
   * 只用于把"本场参赛名录"按账号批量取已发布名片；不写入、不改变任何权限。
   */
  /** 规划34 P4：既有带预算的模型端口（未配置 AI 时为 undefined，助手按 degraded 返回）。 */
  readonly aiModel?: JsonModelPort;
  /** 规划35 P4：存在即表示提供方支持流式（当前只有 OpenAI 兼容路径）。 */
  readonly aiStreamModel?: StreamingJsonModelPort | null;
  readonly recruiting?: () => {
    publishedCardsForUsers(sql: SqlExecutor, userIds: readonly string[]): Promise<readonly { readonly userId: string; readonly card: { readonly displayName: string; readonly headline: string; readonly introduction: string; readonly skills: readonly string[]; readonly city: string } }[]>;
    /** 规划36：本人名片（角色/技能），只读、仅本人，供组队顾问使用。 */
    readPrivateProfile(actor: unknown): Promise<unknown>;
  };
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
interface RegistrationRoute {
  readonly pattern: RegExp;
  readonly methods: Partial<Record<Method, keyof EventRegistrationHandlers>>;
  readonly parameters?: readonly (keyof EventRegistrationRouteParams)[];
}
const REGISTRATION_ROUTES: readonly RegistrationRoute[] = [
  { pattern: /^me\/competitions$/, methods: { GET: "listMine" } },
  { pattern: /^competitions\/([^/]+)\/registration-form$/, methods: { GET: "getRegistrationForm" }, parameters: ["eventId"] },
  { pattern: /^organizer\/events\/([^/]+)\/registration-form$/, methods: { GET: "getStaffForm", PUT: "saveForm" }, parameters: ["eventId"] },
  { pattern: /^competitions\/([^/]+)\/my-registration$/, methods: { GET: "getMine", PATCH: "saveDraft" }, parameters: ["eventId"] },
  { pattern: /^competitions\/([^/]+)\/my-registration\/submit$/, methods: { POST: "submit" }, parameters: ["eventId"] },
  { pattern: /^competitions\/([^/]+)\/my-registration\/withdraw$/, methods: { POST: "withdraw" }, parameters: ["eventId"] },
  { pattern: /^organizer\/events\/([^/]+)\/registrations$/, methods: { GET: "listStaff" }, parameters: ["eventId"] },
  { pattern: /^organizer\/events\/([^/]+)\/registration-counts$/, methods: { GET: "registrationCounts" }, parameters: ["eventId"] },
  { pattern: /^organizer\/events\/([^/]+)\/registrations\/export$/, methods: { GET: "exportRegistrations" }, parameters: ["eventId"] },
  { pattern: /^organizer\/events\/([^/]+)\/registrations\/([^/]+)\/review$/, methods: { POST: "review" }, parameters: ["eventId", "registrationId"] },
  { pattern: /^competitions\/([^/]+)\/teams$/, methods: { GET: "listTeams", POST: "createTeam" }, parameters: ["eventId"] },
  { pattern: /^competitions\/([^/]+)\/teams\/public$/, methods: { GET: "listPublicTeams" }, parameters: ["eventId"] },
  { pattern: /^organizer\/events\/([^/]+)\/teams$/, methods: { GET: "listStaffTeams" }, parameters: ["eventId"] },
  { pattern: /^organizer\/events\/([^/]+)\/team-candidates$/, methods: { GET: "getStaffCandidates" }, parameters: ["eventId"] },
  { pattern: /^organizer\/events\/([^/]+)\/team-suggestions$/, methods: { GET: "listTeamSuggestions", POST: "proposeTeam" }, parameters: ["eventId"] },
  { pattern: /^competitions\/([^/]+)\/teams\/([^/]+)\/join-requests$/, methods: { POST: "requestJoin" }, parameters: ["eventId", "teamId"] },
  { pattern: /^competitions\/([^/]+)\/teams\/([^/]+)\/requests\/([^/]+)\/respond$/, methods: { POST: "respondJoin" }, parameters: ["eventId", "teamId", "requestId"] },
  { pattern: /^competitions\/([^/]+)\/teams\/([^/]+)\/requests\/([^/]+)\/cancel$/, methods: { POST: "cancelJoin" }, parameters: ["eventId", "teamId", "requestId"] },
  { pattern: /^competitions\/([^/]+)\/teams\/([^/]+)\/leave$/, methods: { POST: "leaveTeam" }, parameters: ["eventId", "teamId"] },
  { pattern: /^competitions\/([^/]+)\/teams\/([^/]+)\/lock$/, methods: { POST: "lockRoster" }, parameters: ["eventId", "teamId"] },
  { pattern: /^organizer\/events\/([^/]+)\/teams\/([^/]+)\/reopen$/, methods: { POST: "reopenRoster" }, parameters: ["eventId", "teamId"] },
  { pattern: /^competitions\/([^/]+)\/teams\/([^/]+)\/project-link$/, methods: { GET: "getProjectLink", POST: "requestProjectLink" }, parameters: ["eventId", "teamId"] },
  { pattern: /^competitions\/([^/]+)\/teams\/([^/]+)\/project-link\/([^/]+)\/confirm$/, methods: { POST: "confirmProjectLink" }, parameters: ["eventId", "teamId", "requestId"] },
];
type JudgingHandlers = ReturnType<typeof createEventJudgingHandlers>;
interface JudgingRoute {
  readonly pattern: RegExp;
  readonly methods: Partial<Record<Method, keyof JudgingHandlers>>;
  readonly parameters?: readonly (keyof EventJudgingRouteParams)[];
}
const JUDGING_ROUTES: readonly JudgingRoute[] = [
  { pattern: /^competitions\/([^/]+)\/submissions\/preview$/, methods: { POST: "previewSubmission" }, parameters: ["eventId"] },
  { pattern: /^competitions\/([^/]+)\/submissions\/submit$/, methods: { POST: "submit" }, parameters: ["eventId"] },
  { pattern: /^competitions\/([^/]+)\/my-submissions$/, methods: { GET: "mySubmissions" }, parameters: ["eventId"] },
  { pattern: /^organizer\/events\/([^/]+)\/judging\/config$/, methods: { GET: "workspace", PUT: "saveConfig" }, parameters: ["eventId"] },
  { pattern: /^organizer\/events\/([^/]+)\/judging\/rounds\/([^/]+)\/start$/, methods: { POST: "startRound" }, parameters: ["eventId", "roundId"] },
  { pattern: /^organizer\/events\/([^/]+)\/judging\/rounds\/([^/]+)\/lock$/, methods: { POST: "lockRound" }, parameters: ["eventId", "roundId"] },
  { pattern: /^organizer\/events\/([^/]+)\/judging\/rounds\/([^/]+)\/reopen$/, methods: { POST: "reopenRound" }, parameters: ["eventId", "roundId"] },
  { pattern: /^organizer\/events\/([^/]+)\/judge-assignments$/, methods: { POST: "assignJudge" }, parameters: ["eventId"] },
  { pattern: /^organizer\/events\/([^/]+)\/judging\/assignments\/([^/]+)\/review$/, methods: { POST: "reviewAssignment" }, parameters: ["eventId", "assignmentId"] },
  { pattern: /^organizer\/events\/([^/]+)\/judging\/assignments\/([^/]+)\/revoke$/, methods: { POST: "revokeAssignment" }, parameters: ["eventId", "assignmentId"] },
  { pattern: /^judging\/([^/]+)\/assignments$/, methods: { GET: "judgeAssignments" }, parameters: ["eventId"] },
  { pattern: /^judging\/([^/]+)\/assignments\/([^/]+)\/materials$/, methods: { GET: "judgeMaterials" }, parameters: ["eventId", "assignmentId"] },
  { pattern: /^judging\/([^/]+)\/assignments\/([^/]+)\/conflicts$/, methods: { POST: "declareConflict" }, parameters: ["eventId", "assignmentId"] },
  { pattern: /^judging\/([^/]+)\/assignments\/([^/]+)\/scores\/draft$/, methods: { POST: "saveScore" }, parameters: ["eventId", "assignmentId"] },
  { pattern: /^judging\/([^/]+)\/assignments\/([^/]+)\/scores\/submit$/, methods: { POST: "submitScore" }, parameters: ["eventId", "assignmentId"] },
  { pattern: /^organizer\/events\/([^/]+)\/judging\/results\/preview$/, methods: { POST: "previewResults" }, parameters: ["eventId"] },
  { pattern: /^organizer\/events\/([^/]+)\/judging\/rounds\/([^/]+)\/calibration$/, methods: { GET: "calibration" }, parameters: ["eventId", "roundId"] },
  { pattern: /^organizer\/events\/([^/]+)\/judging\/rounds\/([^/]+)\/integrity$/, methods: { GET: "integrity" }, parameters: ["eventId", "roundId"] },
  { pattern: /^organizer\/events\/([^/]+)\/judging\/rounds\/([^/]+)\/fairness$/, methods: { GET: "fairness" }, parameters: ["eventId", "roundId"] },
  // 规划33 P06：评审进度（纯派生只读）与已公布结果导出（可对外留档，不含评委账号）。
  { pattern: /^organizer\/events\/([^/]+)\/judging\/rounds\/([^/]+)\/progress$/, methods: { GET: "progress" }, parameters: ["eventId", "roundId"] },
  { pattern: /^organizer\/events\/([^/]+)\/judging\/rounds\/([^/]+)\/results-export$/, methods: { GET: "exportResults" }, parameters: ["eventId", "roundId"] },
  { pattern: /^competitions\/([^/]+)\/my-checklists$/, methods: { GET: "myChecklists" }, parameters: ["eventId"] },
  { pattern: /^competitions\/([^/]+)\/appeals$/, methods: { GET: "ownAppeals", POST: "fileAppeal" }, parameters: ["eventId"] },
  { pattern: /^competitions\/([^/]+)\/appeals\/([^/]+)\/withdraw$/, methods: { POST: "withdrawAppeal" }, parameters: ["eventId", "appealId"] },
  { pattern: /^organizer\/events\/([^/]+)\/judging\/appeals$/, methods: { GET: "eventAppeals" }, parameters: ["eventId"] },
  { pattern: /^organizer\/events\/([^/]+)\/judging\/duplicates$/, methods: { GET: "duplicates" }, parameters: ["eventId"] },
  { pattern: /^organizer\/events\/([^/]+)\/judging\/appeals\/([^/]+)\/resolve$/, methods: { POST: "resolveAppeal" }, parameters: ["eventId", "appealId"] },
  { pattern: /^organizer\/events\/([^/]+)\/judging\/results\/publish$/, methods: { POST: "publishResults" }, parameters: ["eventId"] },
  { pattern: /^organizer\/events\/([^/]+)\/judging\/results\/withdraw$/, methods: { POST: "withdrawResults" }, parameters: ["eventId"] },
  { pattern: /^competitions\/([^/]+)\/results$/, methods: { GET: "publicResults" }, parameters: ["eventId"] },
  { pattern: /^competitions\/([^/]+)\/results\/mine$/, methods: { GET: "myResults" }, parameters: ["eventId"] },
  { pattern: /^organizer\/events\/([^/]+)\/judging\/export$/, methods: { GET: "exportScores" }, parameters: ["eventId"] },
  { pattern: /^organizer\/events\/([^/]+)\/judging\/audit$/, methods: { GET: "auditHistory" }, parameters: ["eventId"] },
  // 规划34 C①：作品展示（队伍本人可选公开）。赛事级开关 community.workShowcase 由 organizer 模块持有并随发布冻结。
  { pattern: /^competitions\/([^/]+)\/works$/, methods: { GET: "works" }, parameters: ["eventId"] },
  { pattern: /^competitions\/([^/]+)\/works\/public$/, methods: { GET: "publicWorks" }, parameters: ["eventId"] },
  { pattern: /^competitions\/([^/]+)\/works\/([^/]+)\/disclosure$/, methods: { GET: "myWorkDisclosure", POST: "submitWorkDisclosure" }, parameters: ["eventId", "teamId"] },
  { pattern: /^competitions\/([^/]+)\/works\/([^/]+)\/disclosure\/withdraw$/, methods: { POST: "withdrawWorkDisclosure" }, parameters: ["eventId", "teamId"] },
  { pattern: /^organizer\/events\/([^/]+)\/judging\/works$/, methods: { GET: "eventWorkShowcase" }, parameters: ["eventId"] },
  // 规划34 C②：作品文字留言（与数值互评分列；三层门禁在服务里）。
  { pattern: /^competitions\/([^/]+)\/works\/([^/]+)\/comments$/, methods: { GET: "workComments", POST: "createWorkComment" }, parameters: ["eventId", "snapshotId"] },
  { pattern: /^competitions\/([^/]+)\/works\/([^/]+)\/comments\/([^/]+)\/hide$/, methods: { POST: "hideWorkComment" }, parameters: ["eventId", "snapshotId", "commentId"] },
  { pattern: /^competitions\/([^/]+)\/works\/([^/]+)\/comments\/([^/]+)\/report$/, methods: { POST: "reportWorkComment" }, parameters: ["eventId", "snapshotId", "commentId"] },
];

type ClosureHandlers = ReturnType<typeof createEventClosureHandlers>;
interface ClosureRoute {
  readonly pattern: RegExp;
  readonly methods: Partial<Record<Method, keyof ClosureHandlers>>;
  readonly parameters?: readonly (keyof EventClosureRouteParams)[];
}
/** 规划33 P09：唯一新事实（联系意愿）与只读赛后清单；无新增一级导航。 */
const CLOSURE_ROUTES: readonly ClosureRoute[] = [
  { pattern: /^organizer\/events\/([^/]+)\/closure$/, methods: { GET: "postEventSummary" }, parameters: ["eventId"] },
  { pattern: /^organizer\/events\/([^/]+)\/closure\/contact-willingness$/, methods: { GET: "eventContactWillingness" }, parameters: ["eventId"] },
  { pattern: /^competitions\/([^/]+)\/contact-willingness$/, methods: { GET: "myContactWillingness", POST: "submitContactWillingness" }, parameters: ["eventId"] },
  { pattern: /^competitions\/([^/]+)\/contact-willingness\/eligibility$/, methods: { GET: "myWillingnessEligibility" }, parameters: ["eventId"] },
  { pattern: /^competitions\/([^/]+)\/contact-willingness\/([^/]+)\/withdraw$/, methods: { POST: "withdrawContactWillingness" }, parameters: ["eventId", "willingnessId"] },
];

type CommunityHandlers = ReturnType<typeof createEventCommunityHandlers>;
interface CommunityRoute {
  readonly pattern: RegExp;
  readonly methods: Partial<Record<Method, keyof CommunityHandlers>>;
  readonly parameters?: readonly (keyof EventCommunityRouteParams)[];
}
/** 规划34 P6：选手社区（连接/私信/屏蔽/举报）。全部入口都在赛事级开关之后。 */
const COMMUNITY_ROUTES: readonly CommunityRoute[] = [
  { pattern: /^competitions\/([^/]+)\/community$/, methods: { GET: "overview" }, parameters: ["eventId"] },
  { pattern: /^competitions\/([^/]+)\/community\/connections$/, methods: { POST: "requestConnection" }, parameters: ["eventId"] },
  { pattern: /^competitions\/([^/]+)\/community\/connections\/([^/]+)\/respond$/, methods: { POST: "respondConnection" }, parameters: ["eventId", "connectionId"] },
  { pattern: /^competitions\/([^/]+)\/community\/connections\/([^/]+)\/cancel$/, methods: { POST: "cancelConnection" }, parameters: ["eventId", "connectionId"] },
  { pattern: /^competitions\/([^/]+)\/community\/conversations\/([^/]+)$/, methods: { GET: "conversation" }, parameters: ["eventId", "peerUserId"] },
  { pattern: /^competitions\/([^/]+)\/community\/messages$/, methods: { POST: "sendDirectMessage" }, parameters: ["eventId"] },
  { pattern: /^competitions\/([^/]+)\/community\/messages\/([^/]+)\/withdraw$/, methods: { POST: "withdrawDirectMessage" }, parameters: ["eventId", "messageId"] },
  { pattern: /^competitions\/([^/]+)\/community\/blocks$/, methods: { POST: "blockUser" }, parameters: ["eventId"] },
  { pattern: /^competitions\/([^/]+)\/community\/blocks\/delete$/, methods: { POST: "unblockUser" }, parameters: ["eventId"] },
  { pattern: /^competitions\/([^/]+)\/community\/reports$/, methods: { POST: "reportUser" }, parameters: ["eventId"] },
  { pattern: /^organizer\/events\/([^/]+)\/community\/reports$/, methods: { GET: "organizerReports" }, parameters: ["eventId"] },
];

type PeerReviewHandlers = ReturnType<typeof createEventPeerReviewHandlers>;
interface PeerReviewRoute {
  readonly pattern: RegExp;
  readonly methods: Partial<Record<Method, keyof PeerReviewHandlers>>;
  readonly parameters?: readonly (keyof EventPeerReviewRouteParams)[];
}
/** 规划34 P7：数值互评。与文字留言、评审分**分列**；无评委侧入口，无通往名次/导出的写路径。 */
const PEER_REVIEW_ROUTES: readonly PeerReviewRoute[] = [
  { pattern: /^competitions\/([^/]+)\/works\/([^/]+)\/peer-review$/, methods: { GET: "workPeerReview", POST: "submitPeerReview" }, parameters: ["eventId", "snapshotId"] },
  { pattern: /^competitions\/([^/]+)\/works\/([^/]+)\/peer-review\/withdraw$/, methods: { POST: "withdrawPeerReview" }, parameters: ["eventId", "snapshotId"] },
  { pattern: /^competitions\/([^/]+)\/works\/([^/]+)\/peer-review\/([^/]+)\/report$/, methods: { POST: "reportPeerReview" }, parameters: ["eventId", "snapshotId", "reviewId"] },
];

type EventSiteHandlers = ReturnType<typeof createEventSiteHandlers>;
interface EventSiteRoute {
  readonly pattern: RegExp;
  readonly methods: Partial<Record<Method, keyof EventSiteHandlers>>;
  readonly parameters: readonly (keyof EventSiteRouteParams)[];
}
/** 规划35 P1：专属页的写读接口。`/s/<短码>` 是页面路由，不在这里。 */
const EVENT_SITE_ROUTES: readonly EventSiteRoute[] = [
  { pattern: /^organizer\/events\/([^/]+)\/page$/, methods: { GET: "getPage", PUT: "savePage" }, parameters: ["eventId"] },
  { pattern: /^organizer\/events\/([^/]+)\/page\/publish$/, methods: { POST: "publishPage" }, parameters: ["eventId"] },
  { pattern: /^organizer\/events\/([^/]+)\/page\/short-code\/reset$/, methods: { POST: "rotateShortCode" }, parameters: ["eventId"] },
  { pattern: /^organizer\/events\/([^/]+)\/page\/suspend$/, methods: { POST: "suspendPage" }, parameters: ["eventId"] },
  { pattern: /^organizer\/events\/([^/]+)\/page\/resume$/, methods: { POST: "resumePage" }, parameters: ["eventId"] },
  { pattern: /^organizer\/events\/([^/]+)\/page\/apply-template$/, methods: { POST: "applyTemplate" }, parameters: ["eventId"] },
  { pattern: /^organizer\/events\/([^/]+)\/page\/revisions$/, methods: { GET: "listRevisions" }, parameters: ["eventId"] },
  { pattern: /^organizer\/events\/([^/]+)\/page\/revisions\/([^/]+)\/restore$/, methods: { POST: "restoreRevision" }, parameters: ["eventId", "revision"] },
  { pattern: /^organizer\/page-templates$/, methods: { GET: "listTemplates", POST: "saveTemplate" }, parameters: [] },
  { pattern: /^organizer\/page-templates\/([^/]+)$/, methods: { DELETE: "deleteTemplate" }, parameters: ["templateId"] },
  { pattern: /^organizer\/pages$/, methods: { GET: "listOrganizationPages" }, parameters: [] },
  { pattern: /^admin\/hosted-sites$/, methods: { GET: "listHostedSites" }, parameters: [] },
  { pattern: /^admin\/hosted-sites\/([^/]+)\/suspend$/, methods: { POST: "adminSuspendPage" }, parameters: ["eventId"] },
  { pattern: /^admin\/hosted-sites\/([^/]+)\/resume$/, methods: { POST: "adminResumePage" }, parameters: ["eventId"] },
];

/** All modules share one DatabasePort; no separate PGlite instance or shadow permissions. */
export function createOrganizerIntegration(deps: OrganizerIntegrationDependencies) {
  if (Boolean(deps.verifiedSubmissions) !== Boolean(deps.submissionLinkContext)) throw new Error("Trusted submission ports must be supplied together.");
  const { database, clock, ids } = deps, requestIds = deps.requestIds ?? ids;
  const authorized = new WeakSet<Request>();
  async function authorizeMutation(request: Request) {
    if (!authorized.has(request)) { await deps.assertMutationAllowed(request); authorized.add(request); }
  }
  /** Checks occur after scoped authorization, before the outer transaction commits. */
  class CurrentAccountOrganizerService extends OrganizerService {
    override async previewEvent(principal: OrganizerPrincipal, eventId: string): Promise<EventPreview> {
      return database.transaction(async sql => {
        await principal.guard(sql);
        const preview = await super.previewEvent(principal, eventId);
        const missingForm = preview.event.modules.registration && !await registration.getConfiguredForm(sql, eventId);
        await principal.guard(sql);
        return missingForm ? { ...preview, publicationBlockers: [...preview.publicationBlockers, "先进入报名管理，发布本场报名表"] } : preview;
      });
    }
    override async publishEvent(principal: OrganizerPrincipal, eventId: string, input: unknown): Promise<HostedEvent> {
      return database.transaction(async sql => {
        const preview = await this.previewEvent(principal, eventId);
        if (preview.publicationBlockers.length) throw new DomainError("ORGANIZER_PUBLICATION_INCOMPLETE", `发布前请完成：${preview.publicationBlockers.join("、")}。`, { status: 409 });
        const published = await super.publishEvent(principal, eventId, input);
        const actual = await super.getPublicCompetition(eventId);
        await communication.publishRuleChange(sql, principal, { eventId, organizationId: published.organizationId, publishedRevision: published.publishedRevision!, title: actual.title, changeSummary: actual.changeSummary, rulesUrl: `/competitions/${encodeURIComponent(eventId)}` });
        return published;
      });
    }
    private async eligibleTarget<T>(principal: OrganizerPrincipal, work: () => Promise<T>, target: (value: T) => string | null): Promise<T> {
      return database.transaction(async sql => {
        await principal.guard(sql); const value = await work(), userId = target(value);
        if (userId) await deps.requireActiveTarget(sql, userId);
        await principal.guard(sql); return value;
      });
    }
    override grantStaff(principal: OrganizerPrincipal, organizationId: string, input: unknown): Promise<StaffGrant> {
      return this.eligibleTarget(principal, () => super.grantStaff(principal, organizationId, input), grant => grant.userId);
    }
    override changeEventResponsible(principal: OrganizerPrincipal, eventId: string, input: unknown): Promise<HostedEvent> {
      return this.eligibleTarget(principal, () => super.changeEventResponsible(principal, eventId, input), event => event.responsibleUserId);
    }
    override reviewApplication(principal: OrganizerPrincipal, applicationId: string, input: unknown): Promise<OrganizationApplication> {
      return this.eligibleTarget(principal, () => super.reviewApplication(principal, applicationId, input), application => application.status === "approved" ? application.applicantUserId : null);
    }
  }
  const organizer = new CurrentAccountOrganizerService({ database, clock, ids, discovery: createOrganizerClaimDiscoveryPort(), readinessEvidence: createOrganizerReadinessEvidencePort(),
    // 规划34 P4：本场模块助手开关允许的键来自助手注册表（避免第二份硬编码列表）。
    assistantKeys: MODULE_ASSISTANT_KEYS,
    // 规划34 P3：受限邀请的领取必须核对「绑定邮箱一致」，因此需要一个返回邮箱的同事务只读 Port。
    // 只读 auth_users（active + 已验证）；读不到就返回 null，模块按 403/503 明确拒绝，绝不静默放宽。
    accountEmails: { readVerifiedEmail: async (sql: SqlExecutor, userId: string) => {
      const result = await sql.query<{ email: string }>("SELECT email FROM auth_users WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL", [userId]);
      return result.rows[0] ? { email: result.rows[0].email } : null;
    } },
    // 规划33 P07：只读看板 Port —— 每个方法都只是既有读路径的原样转发，不另写查询、不另算口径。
    // 注入方法在调用时才对 registration/judging/logistics/schedule 求值（与 getConfiguredForm 同模式的闭包转发）。
    dashboard: {
      registrationCounts: (principal, eventId) => registration.registrationCounts(principal, eventId),
      registrations: async (principal, eventId, options) => (await registration.listStaff(principal, eventId, options)).registrations,
      teams: async (principal, eventId, options) => (await registration.listStaffTeams(principal, eventId, options)).teams,
      judgingWorkspace: (principal, eventId) => judging.workspace(principal, eventId),
      judgingProgress: (principal, eventId, roundId) => judging.progress(principal, eventId, roundId),
      accommodation: (principal, eventId) => logistics.listAccommodation(principal, eventId),
      vouchers: (principal, eventId) => logistics.listVouchers(principal, eventId),
      scheduleDraft: (principal, eventId) => schedule.getScheduleDraft(principal, eventId),
    } });
  const rawEvents = createHostedEventAccessPort(organizer);
  const events = deps.decorateEventAccess?.(rawEvents) ?? rawEvents;
  const readProject = async <T>(sql: SqlExecutor, projectId: string, work: (aggregate: ProjectAggregate, executor: SqlExecutor) => T | Promise<T>): Promise<T> => {
    if (!deps.projectRepository) throw new DomainError("PROJECT_LINK_UNCONFIGURED", "团队空间关联暂未配置；你仍可完成这场比赛的报名、组队和提交。", { status: 503 });
    return deps.projectRepository.withProject(projectId, async (aggregate, executor) => {
      if (executor !== sql) throw new DomainError("PROJECT_TRANSACTION_MISMATCH", "空间关联暂时无法在同一事务核对，请稍后重试。", { status: 503 });
      return await work(aggregate, executor);
    });
  };
  let registration: ReturnType<typeof createEventRegistrationService>;
  const projectLinks: EventProjectLinkPort = {
    async confirmLink(sql, principal, input) {
      await principal.guard(sql);
      const event = await events.getEvent(sql, input.eventId, { forUpdate: true });
      const roster = await registration.getTeam(sql, input.eventId, input.teamId);
      if (!event || !roster || roster.eventId !== event.eventId || roster.organizationId !== event.organizationId || roster.status === "withdrawn"
        || (roster.projectId !== null && roster.projectId !== input.projectId)) throw new DomainError("PROJECT_LINK_SCOPE_MISMATCH", "请选择这场比赛的当前正式队伍，再核对空间关联。", { status: 409 });
      await readProject<void>(sql, input.projectId, async aggregate => {
        const manager = aggregate.members.find(member => member.userId === principal.actor.userId && member.status === "active" && member.role === "manager");
        if (!manager) throw new DomainError("PROJECT_MANAGER_REQUIRED", "请由当前团队空间管理员确认关联。", { status: 403 });
        if (aggregate.project.stage === "archived") throw new DomainError("PROJECT_READ_ONLY", "已归档空间不能建立新的赛事关联。", { status: 409 });
        if (aggregate.project.revision !== input.expectedProjectRevision) throw new DomainError("PROJECT_REVISION_CONFLICT", "空间资料已更新，请核对当前版本后重新确认。", { status: 409, latestRevision: aggregate.project.revision });
        if (!aggregate.members.some(member => member.userId === roster.captainUserId && member.status === "active")) throw new DomainError("PROJECT_LINK_CAPTAIN_REQUIRED", "请先由队长加入这个团队空间，再确认关联。", { status: 409 });
        if (event.linkedEventId && aggregate.project.eventId && event.linkedEventId !== aggregate.project.eventId) throw new DomainError("PROJECT_EVENT_MISMATCH", "这个空间选择了另一场比赛，请先核对参赛赛事。", { status: 409 });
      });
      await principal.guard(sql);
    },
  };
  const projectLinkPreview: EventProjectLinkPreviewPort = {
    async requireManagerPreview(sql, principal, input) {
      await principal.guard(sql);
      const event = await events.getEvent(sql, input.eventId);
      const roster = await registration.getTeam(sql, input.eventId, input.teamId);
      if (!event || !roster || roster.eventId !== event.eventId || roster.organizationId !== event.organizationId) throw new DomainError("PROJECT_LINK_NOT_FOUND", "没有可确认的空间关联。", { status: 404 });
      await readProject<void>(sql, input.projectId, async aggregate => {
        if (!aggregate.members.some(member => member.userId === principal.actor.userId && member.status === "active" && member.role === "manager")) throw new DomainError("PROJECT_MANAGER_REQUIRED", "请由当前团队空间管理员查看关联请求。", { status: 403 });
      });
      await principal.guard(sql);
    },
  };
  registration = createEventRegistrationService({ database, clock, ids, events, projectLinks, projectLinkPreview, ...(deps.tracks ? { tracks: deps.tracks } : {}) });
  const conflicts: EventJudgeConflictPort = {
    async inspect(sql, input) {
      const event = await events.getEvent(sql, input.eventId, { forUpdate: true });
      const roster = await registration.getTeam(sql, input.eventId, input.teamId);
      if (!event || !roster || roster.eventId !== event.eventId || roster.organizationId !== event.organizationId) return { status: "needs_review", reasons: ["当前正式队伍与赛事关联无法确认。"] };
      if (roster.memberUserIds.includes(input.judgeUserId)) return { status: "conflict", reasons: ["评委是该作品的当前正式队伍成员。"] };
      if (roster.projectId) {
        try {
          const involved = await readProject<boolean>(sql, roster.projectId, async aggregate => aggregate.members.some(member => member.userId === input.judgeUserId));
          if (involved) return { status: "conflict", reasons: ["评委曾参与这支队伍实际关联的团队空间。"] };
        } catch (error) {
          if (!isDomainError(error) || !["PROJECT_NOT_FOUND", "PROJECT_LINK_UNCONFIGURED", "PROJECT_TRANSACTION_MISMATCH"].includes(error.code)) throw error;
          return { status: "needs_review", reasons: ["关联团队空间的参与关系暂时无法确认。"] };
        }
      }
      if (!deps.relationshipReviews) return { status: "needs_review", reasons: ["站内没有已知关联，线下辅导等关系仍需人工核查。"] };
      const reviewed = await deps.relationshipReviews.inspect(sql, input);
      if (!["clear", "conflict", "needs_review"].includes(reviewed.status) || !Array.isArray(reviewed.reasons) || reviewed.reasons.some(reason => typeof reason !== "string" || reason.length > 500)) throw new DomainError("RELATIONSHIP_REVIEW_INVALID", "人工关系核查暂时不可用，请重新核查。", { status: 503 });
      return { status: reviewed.status, reasons: reviewed.reasons.slice(0, 12) };
    },
  };
  /**
   * 规划 33 P08：选手侧汇总所需的**本人报名与队伍**只读投影。
   *
   * 全部复用既有读路径，**不新增 SQL 之外的任何事实**：
   * - 报名走本模块既有 `registration.getRegistration(sql, eventId, userId)`（它已是
   *   `EventParticipationPort.getRegistration` 的实现），额外带出审核说明；
   * - 队伍先取该赛事下本人的**活跃队伍 id**（复用 event-registration 自己的 store 读），
   *   再走既有 `registration.getTeam(sql, eventId, teamId)`。
   * 两者都接收当前事务的 `sql`，因此与调用方**同一个 `SqlExecutor`**，不另开事务或连接。
   * 读不到时返回 `null`（由 event-communication 按 `unread` 处理），**不编造**。
   */
  const ownFacts: EventOwnFactsPort = {
    async registration(sql, eventId, userId) {
      const facts = await registration.getOwnFacts(sql, eventId, userId);
      if (!facts) return null;
      return facts.registration;
    },
    async team(sql, eventId, userId) {
      const facts = await registration.getOwnFacts(sql, eventId, userId);
      if (!facts) return null;
      return facts.team;
    },
  };
  const communication = createEventCommunicationService({ database, clock, ids, eventAccess: events, participation: registration, ownFacts,
    // 规划34 D1：本场参赛名录的只读组合。全部为 **sql 级转发**（同一 executor），不新写查询、不新口径。
    ...(deps.recruiting ? { directory: {
      approvedParticipantIds: (sql: SqlExecutor, eventId: string) => registration.approvedParticipantIds(sql, eventId),
      publicTeams: (sql: SqlExecutor, eventId: string) => registration.publicTeamsIn(sql, eventId),
      publishedCards: async (sql: SqlExecutor, userIds: readonly string[]) => {
        const cards = await deps.recruiting!().publishedCardsForUsers(sql, userIds);
        return cards.map(item => ({ userId: item.userId, displayName: item.card.displayName, headline: item.card.headline, introduction: item.card.introduction, skills: item.card.skills, city: item.card.city }));
      },
    } } : {}),
    ...(deps.notification ? { notification: deps.notification } : {}), ...(deps.announcementAudience ? { announcementAudience: deps.announcementAudience } : {}) });
  const schedule = createEventScheduleService({ database, clock, ids, eventAccess: events, participation: registration });
  const logistics = createEventLogisticsService({ database, clock, ids, eventAccess: events, participation: registration });
  const baseJudging = createEventJudgingService({ database, clock, ids, events, participation: registration, conflicts,
    ...(deps.verifiedSubmissions && deps.submissionLinkContext ? { verifiedSubmissions: deps.verifiedSubmissions, submissionLinkContext: deps.submissionLinkContext } : {}) });
  const judging = { ...baseJudging, async assignJudge(...args: Parameters<typeof baseJudging.assignJudge>) {
    return database.transaction(async sql => {
      await args[0].guard(sql); const assignment = await baseJudging.assignJudge(...args);
      await deps.requireActiveTarget(sql, assignment.judgeUserId); await args[0].guard(sql); return assignment;
    });
  } };
  const organizerHandlers = createOrganizerHttpHandlers({ service: organizer, authenticate: async request => {
    const principal = await deps.resolvePrincipal(request);
    if (!principal) throw new DomainError("UNAUTHENTICATED", "请先登录，继续当前比赛的操作。", { status: 401 });
    return principal;
  }, authorizeMutation, requestId: () => requestIds.next() });
  const registrationHandlers = createEventRegistrationHandlers({ service: registration, resolvePrincipal: deps.resolvePrincipal, authorizeMutation, requestIds });
  const communicationHandlers = createEventCommunicationHttpHandlers({ communication, schedule, logistics, resolvePrincipal: deps.resolvePrincipal, authorizeMutation, requestId: () => requestIds.next() });
  const judgingHandlers = createEventJudgingHandlers({ service: judging, resolvePrincipal: deps.resolvePrincipal, authorizeMutation, requestIds });
  // 规划33 P09：赛后闭环。唯一新增事实是「队伍是否愿意被联系」（默认不公开、只对本场主办方可见）；
  // 其余全部由既有记录派生，来源端口只转发既有读取，不另写查询、不另算分数与名次。
  const closureSources: EventClosureSourcePort = {
    intakeReceipts: async (sql, eventId) => { const scope = await events.getEvent(sql, eventId); return scope ? judging.closureIntakeReceipts(sql, scope) : []; },
    publishedResults: async (sql, eventId) => { const scope = await events.getEvent(sql, eventId); return scope ? judging.closurePublishedResults(sql, scope) : []; },
    reuseSources: async (sql, eventId) => {
      const scope = await events.getEvent(sql, eventId);
      if (!scope) return [];
      const sources: ClosureReuseSource[] = [];
      if (scope.publishedRevision !== null) sources.push({ id: `published-revision:${scope.eventId}`, kind: "published_revision", label: `正式规则 v${scope.publishedRevision}`, detail: "已发布的公开规则版本与期限；下一届请重新确认后再复用。", href: `/organizers/workspace/${encodeURIComponent(scope.eventId)}/settings`, state: "published" });
      const form = await registration.getConfiguredForm(sql, scope.eventId);
      if (form) sources.push({ id: `registration-form:${scope.eventId}`, kind: "registration_form", label: "报名表字段", detail: `当前已发布报名表「${form.title}」（第 ${form.revision} 版）。`, href: `/organizers/workspace/${encodeURIComponent(scope.eventId)}/registration`, state: "published" });
      const published = (await judging.closureJudgingRounds(sql, scope)).filter(round => round.state === "published").at(-1);
      if (published) sources.push({ id: `judging-baseline:${published.id}`, kind: "judging_baseline", label: "评审基准", detail: `最近已公布的评审轮「${published.title}」：${published.criteriaCount} 个维度，最少 ${published.minJudges} 位评委。`, href: `/organizers/workspace/${encodeURIComponent(scope.eventId)}/judging`, state: "published" });
      return sources;
    },
  };
  // 规划34 P4：模块助手根运行时（只读事实 + 既有 AI 账本）。7 个流程模块助手全部接线；
  // 助手开关是内部运营项（默认全开），由 enabledModuleAssistants() 在每次调用时读取。
  const moduleAssistantRuntime = createModuleAssistantRuntime({
    database, clock, ids, aiModel: deps.aiModel ?? null, organizer, registration, communication, schedule, logistics, judging, events,
    ...(deps.recruiting ? {
      readParticipantProfile: async (actor: unknown) => {
        const view = await deps.recruiting!().readPrivateProfile(actor as never).catch(() => null) as { profile?: { primaryRoles?: readonly string[]; supportingRoles?: readonly string[]; skills?: readonly string[] } } | null;
        const profile = view?.profile;
        return profile && Array.isArray(profile.primaryRoles) ? { primaryRoles: profile.primaryRoles, supportingRoles: profile.supportingRoles ?? [], skills: profile.skills ?? [] } : null;
      },
    } : {}),
  });
  // 规划34 P6：选手社区。通知**复用既有 outbox**（共享 EventNotificationPort 增加可选 kind:"community"），不建第二套通知；
  // 未配置发信账号时模块如实显示「未发送」，不伪装成功。
  // 规划34 P7：数值互评。跨模块读取走**只读**来源端口，与根共用同一个 SqlExecutor（同一事务）。
  // 本模块不导入评审模块、没有评委侧路由，也不并入任何汇总/导出。
  const peerReview = createEventPeerReviewService({ database, clock, ids, events, source: {
    intakeWorks: async (sql, eventId) => { const scope = await events.getEvent(sql, eventId); if (!scope) return []; return (await judging.closureIntakeReceipts(sql, scope)).map(receipt => ({ id: receipt.id, teamId: receipt.teamId, version: receipt.version, submittedAt: receipt.submittedAt, memberUserIds: receipt.memberUserIds })); },
    workDisclosures: async (sql, eventId) => { const scope = await events.getEvent(sql, eventId); return scope ? await judging.closureWorkDisclosures(sql, scope) : []; },
    approvedParticipantIds: (sql, eventId) => registration.approvedParticipantIds(sql, eventId),
  } });
  const peerReviewHandlers = createEventPeerReviewHandlers({ service: peerReview, resolvePrincipal: deps.resolvePrincipal, authorizeMutation, requestIds });
  // 规划35：主办方专属页。规格与规则在 event-site 模块；权限、事实、审计都由根注入。
  // 事实只读既有平台事实：赛事级时间来自赛事范围；FAQ 复用公开 FAQ 读；
  // 逐场日程节点走 schedule 的同事务公开投影（只含 audience=all 的已发布条目）。
  /** 事实端口：编辑器预览与公开页用**同一份**只读事实，避免两套口径。 */
  const eventSiteFacts = {
    schedule: async (sql: Parameters<typeof events.getEvent>[0], eventId: string) => {
      const scope = await events.getEvent(sql, eventId);
      return scope
        ? { registrationCloses: scope.registrationClosesAt, submissionCloses: scope.submissionClosesAt, startsAt: scope.startsAt, endsAt: scope.endsAt, timezone: scope.timezone }
        : { registrationCloses: null, submissionCloses: null, startsAt: null, endsAt: null, timezone: null };
    },
    // 同事务读取：公开只含 audience=all 的已发布条目；未发布/未开日程返回空，不编造时间。
    scheduleNodes: (sql: Parameters<typeof schedule.publicScheduleNodes>[0], eventId: string) => schedule.publicScheduleNodes(sql, eventId),
    faqEntries: async (_sql: unknown, eventId: string) => {
      const entries = await communication.listPublicFaqs(null, eventId).catch(() => []);
      return entries.map(entry => ({ id: entry.id, question: entry.question, answer: entry.answer }));
    },
  };
  const eventSite = createEventSiteService({
    database, clock, ids,
    access: {
      requireEventManager: (sql, principal, eventId) => events.requireStaff(sql, principal.actor, eventId, "event_manage"),
      requireOrganizationAdmin: async (sql, principal, organizationId) => { await organizer.requireOrganizationManager(sql, principal.actor, organizationId); },
      requirePlatformAdmin: async (_sql, principal) => {
        if (!principal.actor.platformRoles.includes("admin")) throw new DomainError("EVENT_SITE_FORBIDDEN", "只有平台管理员可以执行这个操作。", { status: 403 });
      },
      publicEvent: async (sql, eventId) => {
        const scope = await events.getEvent(sql, eventId);
        return scope ? { eventId: scope.eventId, organizationId: scope.organizationId, title: scope.title, status: scope.status } : null;
      },
    },
    audit: {
      record: async (sql, event) => {
        await organizer.recordAuditEvent(sql, {
          organizationId: event.organizationId, actorUserId: event.actorUserId, action: event.action,
          entityId: event.entityId, revision: event.revision,
          ...(event.eventId ? { eventId: event.eventId } : {}),
        });
      },
    },
    facts: eventSiteFacts,
  });
  const eventSiteHandlers = createEventSiteHandlers({ service: eventSite, resolvePrincipal: deps.resolvePrincipal, authorizeMutation, requestIds });
  /** 规划35 P2：页面生成的模型端口（复用既有 AI 账本与预算；未配置模型时 available:false）。 */
  function eventSiteModel(principal: OrganizerPrincipal, eventId: string) {
    const call = createBudgetedJsonCall({ database, clock, ids, model: deps.aiModel ?? null, kind: "page_builder", actorId: () => principal.actor.userId });
    return {
      available: call.available,
      modelVersion: call.modelVersion,
      complete: async (request: { readonly systemPrompt: string; readonly input: string; readonly maxOutputTokens: number }) => {
        const result = await call.complete({
          scopeKey: `organizer-page:${eventId}`,
          systemPrompt: request.systemPrompt, input: request.input, maxOutputTokens: request.maxOutputTokens,
        });
        return { content: result.content };
      },
    };
  }
  /**
   * 规划35 P2：一键生成 / 建议。两者都**不落库**：采纳仍走既有 PUT page（同一套校验、CAS 与审计）。
   * 权限按本场 event_manage 判定；未登录 401、非本场 403、非 POST 405。
   */
  async function eventSiteGenerate(request: Request, eventId: string, mode: "generate" | "suggest"): Promise<Response> {
    if (request.method !== "POST") return methodRejected(requestIds, ["POST"]);
    const principal = await deps.resolvePrincipal(request);
    if (!principal) throw new DomainError("UNAUTHENTICATED", "请先登录，继续当前比赛的操作。", { status: 401 });
    const identities = await organizer.listCompetitionIdentities(principal);
    const identity = identities.find(item => item.event.eventId === eventId);
    if (!identity || !identity.capabilities.includes("event_manage")) {
      throw new DomainError("EVENT_SITE_FORBIDDEN", "只有本场具备「比赛规则与发布」权限的工作人员可以生成页面。", { status: 403 });
    }
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const model = eventSiteModel(principal, eventId);
    const data = mode === "generate"
      ? await generatePage({ model, intent: body.intent })
      : await suggestForSpec({ model, spec: body.spec });
    return Response.json({ data, requestId: requestIds.next() }, { headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  }
  /**
   * 规划35 P3：批注打标 与 AI 组件编辑。**都不落库**，采纳仍走既有 PUT page（唯一草稿写路径）。
   * 请求体可以不带 spec：省略时根读当前草稿（没有就用默认模块集），避免客户端传整页。
   */
  async function eventSiteAnnotate(request: Request, eventId: string, containerId: string | null): Promise<Response> {
    if (request.method !== "POST") return methodRejected(requestIds, ["POST"]);
    const principal = await deps.resolvePrincipal(request);
    if (!principal) throw new DomainError("UNAUTHENTICATED", "请先登录，继续当前比赛的操作。", { status: 401 });
    const identities = await organizer.listCompetitionIdentities(principal);
    const identity = identities.find(item => item.event.eventId === eventId);
    if (!identity || !identity.capabilities.includes("event_manage")) {
      throw new DomainError("EVENT_SITE_FORBIDDEN", "只有本场具备「比赛规则与发布」权限的工作人员可以改动页面。", { status: 403 });
    }
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    let spec = body.spec;
    if (spec === undefined || spec === null) {
      const current = await eventSite.pageForOrganizer(principal, eventId);
      spec = current.spec ?? current.suggestedSpec ?? defaultPageSpec();
    }
    const model = eventSiteModel(principal, eventId);
    const data = containerId === null
      ? await applyAnnotations({ model, spec, annotations: body.annotations })
      : await refineContainer({ model, spec, containerId, instruction: typeof body.instruction === "string" ? body.instruction : "" });
    return Response.json({ data, requestId: requestIds.next() }, { headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  }
  const community = createEventCommunityService({ database, clock, ids, events, participation: registration, ...(deps.notification ? { notification: deps.notification } : {}) });
  const communityHandlers = createEventCommunityHandlers({ service: community, resolvePrincipal: deps.resolvePrincipal, authorizeMutation, requestIds });
  const closure = createEventClosureService({ database, clock, ids, events, participation: registration, source: closureSources });
  const closureHandlers = createEventClosureHandlers({ service: closure, resolvePrincipal: deps.resolvePrincipal, authorizeMutation, requestIds });
  /**
   * 规划34 P4：本场可用模块助手目录（只读）。
   * 只列出**当前身份确实拥有对应能力**的助手；不新增导航、不返回任何事实数据、不调用模型。
   * 未登录 401、非本场工作人员 403；非 GET 一律 405。
   */
  /**
   * 规划34 P4：运行一个模块助手（只出草稿）。未登录 401、非本场工作人员 403、B1 之外的助手 403、非 POST 405。
   * 没有任何发布/发信/扣分/改结果/改权限路径；模型不可用时如实返回 degraded 且人工流程照常。
   */
  /**
   * 本场**已启用**的模块助手键。开关是内部运营项（默认全开、即时生效、写既有审计）。
   * 读取开关需要 `event_manage`：其他工作人员读不到时按规划默认（全开）处理，不因此让助手不可用。
   */
  async function enabledModuleAssistants(principal: Parameters<typeof organizer.listEventAssistantSwitches>[0], eventId: string): Promise<readonly string[]> {
    try {
      const view = await organizer.listEventAssistantSwitches(principal, eventId);
      return view.switches.filter(item => item.enabled).map(item => item.assistantKey);
    } catch { return MODULE_ASSISTANT_KEYS; }
  }
  async function moduleAssistantRun(request: Request, eventId: string, assistantKey: string): Promise<Response> {
    if (request.method !== "POST") return methodRejected(requestIds, ["POST"]);
    const principal = await deps.resolvePrincipal(request);
    if (!principal) throw new DomainError("UNAUTHENTICATED", "请先登录，继续当前比赛的操作。", { status: 401 });
    const identity = (await organizer.listCompetitionIdentities(principal)).find(item => item.event.eventId === eventId) ?? null;
    const entry = moduleAssistantCatalog().find(item => item.key === assistantKey);
    if (!entry || !WIRED_MODULE_ASSISTANTS.includes(entry.key)) throw new DomainError("MODULE_ASSISTANT_DISABLED", "这个助手还没有接入只读事实来源。", { status: 403 });
    // 选手端助手只认「本场报名已通过」；主办方助手仍只认对应权限。
    const own = await database.transaction(sql => registration.getOwnFacts(sql, eventId, principal.actor.userId)).catch(() => null);
    const participantApproved = own?.registration?.status === "approved";
    if (entry.audience === "staff" && identity === null) throw new DomainError("MODULE_ASSISTANT_FORBIDDEN", "本场模块助手只对拥有对应权限的本场工作人员开放。", { status: 403 });
    if (entry.audience === "participant" && !participantApproved) throw new DomainError("MODULE_ASSISTANT_FORBIDDEN", "这个助手只对本场报名已通过的参赛者开放。", { status: 403 });
    const organizationId = identity?.event.organizationId ?? (await database.transaction(sql => events.getEvent(sql, eventId)))?.organizationId;
    if (typeof organizationId !== "string") throw new DomainError("MODULE_ASSISTANT_SCOPE_INVALID", "暂时无法确认本场归属，请刷新后重试。", { status: 503 });
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const instruction = typeof body.instruction === "string" ? body.instruction : "";
    const expectedFingerprint = typeof body.expectedFingerprint === "string" ? body.expectedFingerprint : undefined;
    const enabledForScope = identity === null ? null : await enabledModuleAssistants(principal, eventId);
    const service = moduleAssistantRuntime.service(principal, {
      organizationId, eventId, capabilities: identity?.capabilities ?? [], participantApproved,
      ...(enabledForScope === null ? {} : { enabledAssistants: enabledForScope as never }),
    });
    const data = await service.run(principal.actor, { assistantKey: assistantKey as never, eventId, instruction, ...(expectedFingerprint ? { expectedFingerprint } : {}) });
    return Response.json({ data, requestId: requestIds.next() }, { headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  }
  async function moduleAssistantDirectory(request: Request, eventId: string): Promise<Response> {
    if (request.method !== "GET") return methodRejected(requestIds, ["GET"]);
    const principal = await deps.resolvePrincipal(request);
    if (!principal) throw new DomainError("UNAUTHENTICATED", "请先登录，继续当前比赛的操作。", { status: 401 });
    const identities = await organizer.listCompetitionIdentities(principal);
    const identity = identities.find(item => item.event.eventId === eventId) ?? null;
    const own = await database.transaction(sql => registration.getOwnFacts(sql, eventId, principal.actor.userId)).catch(() => null);
    const participantApproved = own?.registration?.status === "approved";
    if (identity === null && !participantApproved) throw new DomainError("MODULE_ASSISTANT_FORBIDDEN", "本场助手只对工作人员或本场报名已通过的参赛者开放。", { status: 403 });
    const enabled = identity === null ? MODULE_ASSISTANT_KEYS : await enabledModuleAssistants(principal, eventId);
    const entries = moduleAssistantCatalog().filter(entry => WIRED_MODULE_ASSISTANTS.includes(entry.key) && (
      (entry.audience === "staff" && identity !== null && entry.requiredCapability !== undefined && identity.capabilities.includes(entry.requiredCapability))
      || (entry.audience === "participant" && participantApproved)));
    return Response.json({ data: { eventId, entries, enabledAssistants: enabled }, requestId: requestIds.next() }, { headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  }
  function match(segments: readonly string[]): ((request: Request) => Promise<Response>) | null {
    if (segments.some(segment => !segment || segment.length > 250 || /[\/\\\u0000-\u001f\u007f]/.test(segment))) throw new DomainError("INVALID_ROUTE", "路由标识无效。", { status: 400 });
    const path = segments.join("/");
    for (const route of REGISTRATION_ROUTES) {
      const found = path.match(route.pattern); if (!found) continue;
      const parameters = Object.fromEntries((route.parameters ?? []).map((key, index) => [key, found[index + 1]])) as EventRegistrationRouteParams;
      return request => {
        const name = route.methods[request.method as Method];
        return name ? registrationHandlers[name](request, parameters) : methodRejected(requestIds, Object.keys(route.methods));
      };
    }
    for (const route of JUDGING_ROUTES) {
      const found = path.match(route.pattern); if (!found) continue;
      const parameters = Object.fromEntries((route.parameters ?? []).map((key, index) => [key, found[index + 1]])) as unknown as EventJudgingRouteParams;
      return request => {
        const name = route.methods[request.method as Method];
        return name ? judgingHandlers[name](request, parameters) : methodRejected(requestIds, Object.keys(route.methods));
      };
    }
    for (const route of CLOSURE_ROUTES) {
      const found = path.match(route.pattern); if (!found) continue;
      const parameters = Object.fromEntries((route.parameters ?? []).map((key, index) => [key, found[index + 1]])) as unknown as EventClosureRouteParams;
      return request => {
        const name = route.methods[request.method as Method];
        return name ? closureHandlers[name](request, parameters) : methodRejected(requestIds, Object.keys(route.methods));
      };
    }
    for (const route of PEER_REVIEW_ROUTES) {
      const found = path.match(route.pattern); if (!found) continue;
      const parameters = Object.fromEntries((route.parameters ?? []).map((key, index) => [key, found[index + 1]])) as unknown as EventPeerReviewRouteParams;
      return request => {
        const name = route.methods[request.method as Method];
        return name ? peerReviewHandlers[name](request, parameters) : methodRejected(requestIds, Object.keys(route.methods));
      };
    }
    const assistantRunRoute = /^organizer\/events\/([^/]+)\/module-assistants\/([^/]+)$/.exec(path);
    if (assistantRunRoute) { const runEventId = assistantRunRoute[1]!, runKey = assistantRunRoute[2]!; return request => moduleAssistantRun(request, runEventId, runKey); }
    const assistantRoute = /^organizer\/events\/([^/]+)\/module-assistants$/.exec(path);
    if (assistantRoute) { const assistantEventId = assistantRoute[1]!; return request => moduleAssistantDirectory(request, assistantEventId); }
    for (const route of COMMUNITY_ROUTES) {
      const found = path.match(route.pattern); if (!found) continue;
      const parameters = Object.fromEntries((route.parameters ?? []).map((key, index) => [key, found[index + 1]])) as unknown as EventCommunityRouteParams;
      return request => {
        const name = route.methods[request.method as Method];
        return name ? communityHandlers[name](request, parameters) : methodRejected(requestIds, Object.keys(route.methods));
      };
    }
    // 规划35 方案 C：图片资产。上传要 event_manage；读取只给「被已发布快照引用过」的图（或本场工作人员）。
    // 规划35 P6：复制赛事**带上页面规格**。复用 organizer 的 duplicate 响应，再用既有 saveDraft 复制草稿。
    if (path.match(/^organizer\/events\/([^/]+)\/duplicate$/)) {
      const sourceEventId = path.split("/")[2]!;
      return async request => {
        if (request.method !== "POST") return methodRejected(requestIds, ["POST"]);
        const organizerRoute = organizerHttpRoute(segments);
        if (!organizerRoute) return null as never;
        const principal = await deps.resolvePrincipal(request);
        const response = await organizerHandlers.handle(request, organizerRoute);
        if (!response.ok || principal === null) return response;
        try {
          const envelope = await response.clone().json() as { data?: { event?: { eventId?: string } } };
          const targetEventId = envelope.data?.event?.eventId;
          if (targetEventId && targetEventId !== sourceEventId) {
            const source = await eventSite.pageForOrganizer(principal, sourceEventId);
            const spec = source.spec ?? source.published ?? source.suggestedSpec;
            if (spec !== null) await eventSite.saveDraft(principal, targetEventId, { spec, expectedRevision: 0 });
          }
        } catch { /* 页面没复制成功不影响复制赛事本身；赛事详情页会显示还没有专属页 */ }
        return response;
      };
    }
    const pageAssetUploadRoute = /^organizer\/events\/([^/]+)\/page\/assets$/.exec(path);
    if (pageAssetUploadRoute) {
      const id = pageAssetUploadRoute[1]!;
      return async request => {
        if (request.method !== "POST") return methodRejected(requestIds, ["POST"]);
        const principal = await deps.resolvePrincipal(request);
        if (!principal) throw new DomainError("UNAUTHENTICATED", "请先登录，继续当前比赛的操作。", { status: 401 });
        const identities = await organizer.listCompetitionIdentities(principal);
        const identity = identities.find(item => item.event.eventId === id);
        if (!identity || !identity.capabilities.includes("event_manage")) {
          throw new DomainError("EVENT_SITE_FORBIDDEN", "只有本场具备「比赛规则与发布」权限的工作人员可以上传图片。", { status: 403 });
        }
        const body = await request.json().catch(() => ({}));
        const upload = decodePageAssetUpload(body);
        const saved = await database.transaction(sql => savePageAsset(sql, ids, clock, {
          organizationId: identity.event.organizationId, eventId: id, createdBy: principal.actor.userId,
          mimeType: upload.mimeType, bytes: upload.bytes,
        }));
        // 方案 C：只读文件头拿宽高，按比例给确定性建议；读不到就不给建议。
        const size = readImageSize(upload.bytes, upload.mimeType);
        const suggestion = suggestPlacement(size);
        return Response.json({ data: { ...saved, size, suggestion }, requestId: requestIds.next() }, { status: 201, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
      };
    }
    const pageAssetReadRoute = /^page-assets\/([^/]+)$/.exec(path);
    if (pageAssetReadRoute) {
      const assetId = pageAssetReadRoute[1]!;
      return async request => {
        if (request.method !== "GET") return methodRejected(requestIds, ["GET"]);
        const response = await database.transaction(sql => pageAssetResponse(sql, assetId));
        if (response !== null) return response;
        return Response.json(toErrorEnvelope(new DomainError("PAGE_ASSET_NOT_FOUND", "这张图片不存在。", { status: 404 }), requestIds.next()), { status: 404 });
      };
    }
    // 规划35：编辑器预览用**同一份**只读事实（时间线与 FAQ 不再是空的）。
    const eventSiteFactsRoute = /^organizer\/events\/([^/]+)\/page\/facts$/.exec(path);
    if (eventSiteFactsRoute) {
      const id = eventSiteFactsRoute[1]!;
      return async request => {
        if (request.method !== "GET") return methodRejected(requestIds, ["GET"]);
        const principal = await deps.resolvePrincipal(request);
        if (!principal) throw new DomainError("UNAUTHENTICATED", "请先登录，继续当前比赛的操作。", { status: 401 });
        await database.transaction(sql => events.requireStaff(sql, principal.actor, id, "event_manage"));
        const data = await database.transaction(async sql => {
          const scheduleFacts = await eventSiteFacts.schedule(sql, id);
          const nodes = await eventSiteFacts.scheduleNodes(sql, id);
          const faqs = await eventSiteFacts.faqEntries(sql, id);
          return { ...scheduleFacts, scheduleNodes: nodes, faqEntries: faqs };
        });
        return Response.json({ data, requestId: requestIds.next() }, { headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
      };
    }
    // 规划35 §19.4：编辑器只要一个输入框，赛事名由根给，不让主办方重填。
    const eventSiteContextRoute = /^organizer\/events\/([^/]+)\/page\/context$/.exec(path);
    if (eventSiteContextRoute) {
      const id = eventSiteContextRoute[1]!;
      return async request => {
        if (request.method !== "GET") return methodRejected(requestIds, ["GET"]);
        const principal = await deps.resolvePrincipal(request);
        if (!principal) throw new DomainError("UNAUTHENTICATED", "请先登录，继续当前比赛的操作。", { status: 401 });
        const scope = await database.transaction(sql => events.requireStaff(sql, principal.actor, id, "event_manage"));
        return Response.json({ data: { eventTitle: scope.title, organizerName: scope.organizationName }, requestId: requestIds.next() },
          { headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
      };
    }
    const eventSiteCapabilityRoute = /^organizer\/events\/([^/]+)\/page\/ai-capability$/.exec(path);
    if (eventSiteCapabilityRoute) {
      const id = eventSiteCapabilityRoute[1]!;
      return async request => {
        if (request.method !== "GET") return methodRejected(requestIds, ["GET"]);
        const principal = await deps.resolvePrincipal(request);
        if (!principal) throw new DomainError("UNAUTHENTICATED", "请先登录，继续当前比赛的操作。", { status: 401 });
        const identities = await organizer.listCompetitionIdentities(principal);
        const identity = identities.find(item => item.event.eventId === id);
        if (!identity || !identity.capabilities.includes("event_manage")) {
          throw new DomainError("EVENT_SITE_FORBIDDEN", "只有本场具备「比赛规则与发布」权限的工作人员可以查看生成能力。", { status: 403 });
        }
        return Response.json({ data: {
          model: Boolean(deps.aiModel), stream: Boolean(deps.aiStreamModel),
          reason: deps.aiStreamModel ? null : "当前提供方不支持流式输出（DSH 为一次完整返回），实时生成会降级为一次性生成。",
        }, requestId: requestIds.next() }, { headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
      };
    }
    // 规划35 §6.5：流式生成。能力不支持时**明确 409**，客户端回落一次性生成。
    const eventSiteStreamRoute = /^organizer\/events\/([^/]+)\/page\/generate\/stream$/.exec(path);
    if (eventSiteStreamRoute) {
      const id = eventSiteStreamRoute[1]!;
      return async request => {
        if (request.method !== "POST") return methodRejected(requestIds, ["POST"]);
        const principal = await deps.resolvePrincipal(request);
        if (!principal) throw new DomainError("UNAUTHENTICATED", "请先登录，继续当前比赛的操作。", { status: 401 });
        const identities = await organizer.listCompetitionIdentities(principal);
        const identity = identities.find(item => item.event.eventId === id);
        if (!identity || !identity.capabilities.includes("event_manage")) {
          throw new DomainError("EVENT_SITE_FORBIDDEN", "只有本场具备「比赛规则与发布」权限的工作人员可以生成页面。", { status: 403 });
        }
        const model = deps.aiStreamModel;
        if (!model) {
          return Response.json(toErrorEnvelope(new DomainError("EVENT_SITE_STREAM_UNAVAILABLE", "当前提供方不支持流式输出；请用一次性生成。", { status: 409 }), requestIds.next()), { status: 409, headers: { "Cache-Control": "private, no-store" } });
        }
        const body = await request.json().catch(() => ({})) as Record<string, unknown>;
        const intent = parseGenerationIntent(body.intent);
        const encoder = new TextEncoder();
        // 流式也进既有账本：先落一条执行行，再在同一上下文里 reserve/settle。
        const jobId = ids.next(), leaseToken = ids.next();
        const startedAt = clock.now();
        await database.query(
          "INSERT INTO ai_execution_jobs(id,kind,module_job_id,source_revision,project_id,actor_id,status,attempts,lease_owner,lease_token,lease_until,external_state,created_at,updated_at)"
          + " VALUES($1,'page_builder_stream',$1,1,$2,$3,'running',0,'page-stream',$4,$5::timestamptz,'not_sent',$6::timestamptz,$6::timestamptz)",
          [jobId, `organizer-page:${id}`, principal.actor.userId, leaseToken, new Date(startedAt.getTime() + 300_000).toISOString(), startedAt.toISOString()]);
        const finishJob = async (ok: boolean) => {
          await database.query(
            "UPDATE ai_execution_jobs SET status=$2,attempts=attempts+1,lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=$3::timestamptz WHERE id=$1",
            [jobId, ok ? "succeeded" : "failed", clock.now().toISOString()],
          ).catch(() => undefined);
        };
        const stream = await withAiExecutionContext(
          { executionId: jobId, leaseToken, projectId: `organizer-page:${id}`, actorId: principal.actor.userId },
          async () => new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
            const scanner = new BlocksScanner();
            let text = "";
            let finalSpec: unknown = null;
            try {
              for await (const chunk of model.streamText({
                systemPrompt: EVENT_SITE_GENERATION_SYSTEM_PROMPT,
                input: buildGenerationUserPrompt(intent),
                promptVersion: EVENT_SITE_GENERATION_PROMPT_VERSION,
              }, request.signal)) {
                text += chunk;
                for (const block of scanner.push(chunk)) send("block", block);
              }
              // parseSpec 要的是已解析的对象（与 generatePage 拿到的 content 一致）。
              const spec = parseSpec(JSON.parse(text));
              finalSpec = spec;
              send("done", { spec, findings: reviewSpec(spec), modelVersion: model.modelVersion });
            } catch (error) {
              send("error", {
                code: isDomainError(error) ? error.code : "EVENT_SITE_MODEL_UNAVAILABLE",
                message: isDomainError(error) ? error.message : "流式生成中断，没有自动重试。可以改用一次性生成或手动编辑。",
              });
            } finally { await finishJob(finalSpec !== null); controller.close(); }
          },
        }),
        );
        return new Response(stream, { status: 200, headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "private, no-store",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        } });
      };
    }
    const eventSiteAnnotationsRoute = /^organizer\/events\/([^/]+)\/page\/annotations$/.exec(path);
    if (eventSiteAnnotationsRoute) { const id = eventSiteAnnotationsRoute[1]!; return request => eventSiteAnnotate(request, id, null); }
    const eventSiteRefineRoute = /^organizer\/events\/([^/]+)\/page\/ai-blocks\/([^/]+)\/refine$/.exec(path);
    if (eventSiteRefineRoute) { const id = eventSiteRefineRoute[1]!, containerId = eventSiteRefineRoute[2]!; return request => eventSiteAnnotate(request, id, containerId); }
    const eventSiteGenerateRoute = /^organizer\/events\/([^/]+)\/page\/generate$/.exec(path);
    if (eventSiteGenerateRoute) { const id = eventSiteGenerateRoute[1]!; return request => eventSiteGenerate(request, id, "generate"); }
    const eventSiteSuggestRoute = /^organizer\/events\/([^/]+)\/page\/suggestions$/.exec(path);
    if (eventSiteSuggestRoute) { const id = eventSiteSuggestRoute[1]!; return request => eventSiteGenerate(request, id, "suggest"); }
    for (const route of EVENT_SITE_ROUTES) {
      const found = path.match(route.pattern); if (!found) continue;
      const parameters = Object.fromEntries(route.parameters.map((key, index) => [key, found[index + 1]])) as EventSiteRouteParams;
      return request => {
        const name = route.methods[request.method as Method];
        return name ? eventSiteHandlers[name](request, parameters) : methodRejected(requestIds, Object.keys(route.methods));
      };
    }
    // 规划36 §2.2：AI 工作台的专员目录（只读标签与职责，用于 @ 专员与快捷指令）。
    if (path === "ai/specialists") {
      return async request => {
        if (request.method !== "GET") return methodRejected(requestIds, ["GET"]);
        const principal = await deps.resolvePrincipal(request);
        if (!principal) throw new DomainError("UNAUTHENTICATED", "请先登录。", { status: 401 });
        // 按当前身份标注可用性：主办方看权限，选手看报名是否通过；不可用的仍列出来但标 false，
        // 界面据此隐藏或置灰，避免点了才 403。
        const identity = (await organizer.listCompetitionIdentities(principal)).reduce<{ eventId: string; capabilities: readonly string[] }[]>((acc, item) => {
          acc.push({ eventId: item.event.eventId, capabilities: item.capabilities as readonly string[] }); return acc;
        }, []);
        const mine = await database.transaction(async sql => {
          // 真实表名是 event_registration_registrations（不是 organizer_registrations）。
          // 查询失败时**不要把所有人当成没报名**：抛出去由上层按"未知"处理。
          const rows = await sql.query<{ event_id: string; status: string }>("SELECT event_id,status FROM event_registration_registrations WHERE user_id=$1", [principal.actor.userId]);
          return rows.rows;
        });
        const approvedEvents = new Set(mine.filter(row => String(row.status) === "approved").map(row => String(row.event_id)));
        const staffCapabilities = new Set(identity.flatMap(item => item.capabilities));
        const specialists = moduleAssistantCatalog().map(entry => ({
          key: entry.key, label: entry.label, audience: entry.audience, reads: entry.readsDescription,
          available: entry.audience === "participant" ? approvedEvents.size > 0 : entry.requiredCapability !== undefined && staffCapabilities.has(entry.requiredCapability),
        }));
        // 计划34：选手端助手只在"本场已通过报名"时可用；这里同时返回可用于哪几场。
        const events = [...approvedEvents];
        return Response.json({ data: { specialists, approvedEvents: events }, requestId: requestIds.next() }, { headers: { "Cache-Control": "private, no-store" } });
      };
    }
    // 规划36 §2.1：AI 工作台的会话归档（左侧会话列表）。只归档、不复制第二份正在进行的对话。
    const aiThreadsRoute = /^ai\/threads$/.exec(path);
    if (aiThreadsRoute) {
      return async request => {
        const principal = await deps.resolvePrincipal(request);
        if (!principal) throw new DomainError("UNAUTHENTICATED", "请先登录。", { status: 401 });
        const actorId = principal.actor.userId;
        if (request.method === "GET") {
          const rows = await database.query<{ id: string; title: string; created_at: Date | string; size: number }>(
            "SELECT id,title,created_at,jsonb_array_length(messages) AS size FROM ai_console_threads WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50", [actorId]);
          return Response.json({ data: { threads: rows.rows.map(row => ({ id: row.id, title: row.title, createdAt: new Date(row.created_at).toISOString(), size: row.size })) }, requestId: requestIds.next() },
            { headers: { "Cache-Control": "private, no-store" } });
        }
        if (request.method !== "POST") return methodRejected(requestIds, ["GET", "POST"]);
        const body = await request.json().catch(() => ({})) as { title?: unknown };
        // 归档当前对话：读一次既有会话，写一条归档，再清空当前线程（同一次请求内完成，避免半截状态）。
        const conversation = await database.transaction(async sql => {
          const rows = await sql.query<{ role: string; content: string }>("SELECT role,content FROM personal_dsh_messages WHERE user_id=$1 AND project_id IS NULL ORDER BY created_at", [actorId]);
          return rows.rows;
        });
        if (conversation.length === 0) return Response.json({ data: { archived: false, reason: "empty" }, requestId: requestIds.next() }, { headers: { "Cache-Control": "private, no-store" } });
        const title = typeof body.title === "string" && body.title.trim() !== "" ? body.title.trim().slice(0, 80) : conversation.find(item => item.role === "user")?.content.slice(0, 40) || "未命名会话";
        const id = ids.next();
        await database.query("INSERT INTO ai_console_threads(id,user_id,title,messages,created_at) VALUES($1,$2,$3,$4::jsonb,$5::timestamptz)", [id, actorId, title, JSON.stringify(conversation), clock.now().toISOString()]);
        await database.query("DELETE FROM personal_dsh_messages WHERE user_id=$1 AND project_id IS NULL", [actorId]);
        return Response.json({ data: { archived: true, id, title }, requestId: requestIds.next() }, { headers: { "Cache-Control": "private, no-store" } });
      };
    }
    const aiThreadRoute = /^ai\/threads\/([^/]+)$/.exec(path);
    if (aiThreadRoute) {
      const threadId = aiThreadRoute[1]!;
      return async request => {
        const principal = await deps.resolvePrincipal(request);
        if (!principal) throw new DomainError("UNAUTHENTICATED", "请先登录。", { status: 401 });
        if (request.method === "DELETE") {
          await database.query("DELETE FROM ai_console_threads WHERE id=$1 AND user_id=$2", [threadId, principal.actor.userId]);
          return Response.json({ data: { deleted: true }, requestId: requestIds.next() }, { headers: { "Cache-Control": "private, no-store" } });
        }
        if (request.method !== "GET") return methodRejected(requestIds, ["GET", "DELETE"]);
        const row = await database.query<{ id: string; title: string; messages: readonly { role: string; content: string }[]; created_at: Date | string }>(
          "SELECT id,title,messages,created_at FROM ai_console_threads WHERE id=$1 AND user_id=$2", [threadId, principal.actor.userId]);
        const thread = row.rows[0];
        if (!thread) throw new DomainError("AI_THREAD_NOT_FOUND", "这条会话不存在。", { status: 404 });
        return Response.json({ data: { id: thread.id, title: thread.title, messages: thread.messages, createdAt: new Date(thread.created_at).toISOString() }, requestId: requestIds.next() },
          { headers: { "Cache-Control": "private, no-store" } });
      };
    }
    // 规划36 §2.3：智能组队大厅。可见性复用社区名录开关（已开名录 + 本人报名已通过）。
    const teamMatchOptInRoute = /^competitions\/([^/]+)\/team-match\/opt-in$/.exec(path);
    if (teamMatchOptInRoute) {
      const eventId = teamMatchOptInRoute[1]!;
      return async request => {
        const principal = await deps.resolvePrincipal(request);
        if (!principal) throw new DomainError("UNAUTHENTICATED", "请先登录，继续当前比赛的操作。", { status: 401 });
        // 与大厅读取同一条闸门：名录开着且本人报名已通过，才允许开关。
        try { await communication.directory(principal, eventId); }
        catch { throw new DomainError("TEAM_MATCH_FORBIDDEN", "只有本场报名已通过、且主办方开了参赛名录时才能使用组队大厅。", { status: 403 }); }
        if (request.method === "GET") {
          const row = await database.query<{ open: boolean }>("SELECT open FROM tmt_team_match_opt_in WHERE event_id=$1 AND user_id=$2", [eventId, principal.actor.userId]);
          return Response.json({ data: { open: row.rows[0]?.open ?? false }, requestId: requestIds.next() }, { headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
        }
        if (request.method !== "POST") return methodRejected(requestIds, ["GET", "POST"]);
        const body = await request.json().catch(() => ({})) as { open?: unknown };
        if (typeof body.open !== "boolean") throw new DomainError("TEAM_MATCH_INVALID", "open 必须是布尔值。", { status: 422 });
        await database.query(
          "INSERT INTO tmt_team_match_opt_in(organization_id,event_id,user_id,open,updated_at) SELECT organization_id,$1,$2,$3,$4::timestamptz FROM organizer_hosted_events WHERE id=$1 ON CONFLICT (event_id,user_id) DO UPDATE SET open=EXCLUDED.open,updated_at=EXCLUDED.updated_at",
          [eventId, principal.actor.userId, body.open, clock.now().toISOString()],
        );
        return Response.json({ data: { open: body.open }, requestId: requestIds.next() }, { headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
      };
    }
    const teamMatchRoute = /^competitions\/([^/]+)\/team-match$/.exec(path);
    if (teamMatchRoute) {
      const eventId = teamMatchRoute[1]!;
      return async request => {
        if (request.method !== "GET") return methodRejected(requestIds, ["GET"]);
        const principal = await deps.resolvePrincipal(request);
        if (!principal) throw new DomainError("UNAUTHENTICATED", "请先登录，继续当前比赛的操作。", { status: 401 });
        // 名录本身负责「已开名录 + 报名已通过」两件事；没开就 403，不返回空名单假装没人。
        const directory = await communication.directory(principal, eventId);
        const people = directory.entries.filter(entry => entry.userId !== principal.actor.userId);
        const optIns = people.length === 0 ? [] : (await database.query<{ user_id: string }>(
          "SELECT user_id FROM tmt_team_match_opt_in WHERE event_id=$1 AND open=true AND user_id = ANY($2::text[])",
          [eventId, people.map(entry => entry.userId)],
        )).rows.map(row => row.user_id);
        const open = new Set(optIns);
        const candidates = people.filter(entry => open.has(entry.userId)).map(entry => ({
          userId: entry.userId, displayName: entry.displayName, headline: entry.headline,
          skills: [...entry.skills], city: entry.city,
        }));
        return Response.json({ data: { candidates, notice: "只显示本人愿意被组队、且已发布名片的参赛者；平台不评分、不排名、不撮合。", limitations: ["未开启或未发布名片的人不会出现。", "联系方式由本人决定，这里不显示。"] }, requestId: requestIds.next() },
          { headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
      };
    }
    const communicationRoute = eventCommunicationHttpRoute(segments);
    if (communicationRoute) return request => communicationHandlers.handle(request, communicationRoute);
    const organizerRoute = organizerHttpRoute(segments);
    return organizerRoute ? request => organizerHandlers.handle(request, organizerRoute) : null;
  }
  return {
    organizer, rawEvents, events, registration, projectLinks, projectLinkPreview, conflicts, communication, schedule, logistics, judging, closure, community, peerReview, eventSite,
    handlers: { organizer: organizerHandlers, registration: registrationHandlers, communication: communicationHandlers, judging: judgingHandlers, closure: closureHandlers, community: communityHandlers, peerReview: peerReviewHandlers },
    capabilities: {
      verifiedProjectSubmission: Boolean(deps.verifiedSubmissions && deps.submissionLinkContext), judgingAi: false,
      announcementEmail: Boolean(deps.notification && deps.announcementAudience), manualRelationshipReview: Boolean(deps.relationshipReviews), officialTrackConfiguration: Boolean(deps.tracks),
    },
    match,
    /** Root passes decoded /api/v1 segments and its globally bounded Request. Unknown routes return null. */
    async handle(request: Request, segments: readonly string[]): Promise<Response | null> {
      try {
        const handler = match(segments); if (!handler) return null;
        if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) await authorizeMutation(request);
        return await handler(request);
      } catch (error) {
        return Response.json(toErrorEnvelope(error, requestIds.next()), { status: isDomainError(error) ? error.status : 500, headers: { "Cache-Control": "private, no-store", "Vary": "Cookie", "X-Content-Type-Options": "nosniff" } });
      }
    },
  };
}
function methodRejected(ids: IdGenerator, allowed: readonly string[]): Promise<Response> {
  return Promise.resolve(Response.json(toErrorEnvelope(new DomainError("METHOD_NOT_ALLOWED", "当前入口不支持此操作。", { status: 405 }), ids.next()), { status: 405, headers: { Allow: allowed.join(", "), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } }));
}
export type OrganizerIntegration = ReturnType<typeof createOrganizerIntegration>;
