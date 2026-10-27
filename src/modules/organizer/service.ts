import type { Actor, Clock, IdGenerator } from "../../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { DomainError } from "../../shared/errors.ts";
import { DEFAULT_EVENT_COMMUNITY, EVENT_MODULES, EVENT_STAFF_CAPABILITIES } from "../../shared/organizer-contracts.ts";
import type { EventStaffCapability, HostedEventAccessPort, HostedEventScope, OrganizerPrincipal } from "../../shared/organizer-contracts.ts";
import { READINESS_FIELDS } from "./model.ts";
import type { CompetitionIdentity, EventAssistantSwitch, EventAssistantSwitchesView, EventPreview, EventProfile, EventReadinessItem, HostedEvent, Organization, OrganizationApplication, OrganizerClaimCandidate, OrganizerClaimRequest, PublicCompetition, PublishedEventRevision, ReadinessField, ReadinessState, StaffGrant, StaffInvitation } from "./model.ts";
import { hashInvitationToken, invitationExpiresAt, invitationStatus, isInvitationToken, mintInvitationToken, toInvitationPreview, toInvitationView } from "./invitations.ts";
import type { ClaimStaffInvitationResult, CreateStaffInvitationResult, StaffInvitationPreview, StaffInvitationView } from "./invitations.ts";
import type { EntityId } from "../../shared/contracts.ts";
import { PostgresOrganizerRepository } from "./postgres.ts";
import { listOrganizerTemplates } from "./templates.ts";
import { assertDuplicateSource, duplicateFormInput, duplicateJudgingConfigInput, duplicateTitle, mergeConfiguration, parseDuplicateRequest, shiftedOccurrenceTimes } from "./duplicate.ts";
import { DASHBOARD_PANELS, DASHBOARD_PANEL_CAPABILITIES, DEFAULT_DASHBOARD_LIMIT, buildDashboard } from "./dashboard.ts";
import type { DashboardAccommodationRow, DashboardFactKey, DashboardFilter, DashboardJudgingProgress, DashboardJudgingWorkspace, DashboardPage, DashboardRegistrationCounts, DashboardRegistrationRow, DashboardScheduleDraft, DashboardTeamRow, DashboardView, DashboardVoucherRow } from "./dashboard.ts";
import * as v from "./validation.ts";

export interface OrganizerServiceOptions { readonly database: DatabasePort; readonly clock: Clock; readonly ids: IdGenerator; readonly repository?: PostgresOrganizerRepository; readonly discovery?: OrganizerClaimDiscoveryPort; readonly readinessEvidence?: OrganizerReadinessEvidencePort; readonly registrationForms?: OrganizerRegistrationFormPort; readonly judgingConfig?: OrganizerJudgingConfigPort; readonly dashboard?: OrganizerDashboardPort; readonly accountEmails?: OrganizerAccountEmailPort;
  /**
   * P4：本场支持的模块助手 key，由根从 `module-assistants` 注册表传入（顺序即列表顺序）。
   * **本模块不保存第二份注册表**；未传入时列表返回空开关集、写入一律 503 明确拒绝，
   * 绝不因为"没有校验依据"而静默放行任意 key。
   */
  readonly assistantKeys?: readonly string[] }
/** 自动发现只读 Port：由根提供实现，模块不直接查询该存储（规划25 第10节）。 */
export interface OrganizerClaimDiscoveryPort {
  /** 按机构名与来源域名给出候选；matchReason 只解释匹配原因，不构成归属。 */
  listCandidates(sql: SqlExecutor, options: { readonly organizationId: string; readonly organizationName: string }): Promise<OrganizerClaimCandidate[]>;
  /** 按线索 ID 取单条候选，用于比赛页上的"这是我的比赛"入口。 */
  getCandidate(sql: SqlExecutor, discoveryId: string): Promise<OrganizerClaimCandidate | null>;
  /** 该线索当前是否可被认领（仍 active 且未被认领）；不可用时返回 null。 */
  getClaimable(sql: SqlExecutor, discoveryId: string): Promise<{ readonly discoveryId: string; readonly sourceHost: string } | null>;
}
/** P03：只读读取自动发现卡片里与"待补字段"相关的证据片段。 */
export interface OrganizerReadinessEvidencePort {
  /** 缺线索返回 null；返回的片段只是抓取线索，不是主办方声明。 */
  read(sql: SqlExecutor, input: { readonly discoveryId: string }): Promise<{
    readonly sourceUrl: string | null; readonly checkedAt: string | null;
    readonly fields: Partial<Record<ReadinessField, readonly string[]>>;
  } | null>;
}
/**
 * P05 跨模块端口：把报名表读/写交给 `event-registration`，本模块不直接读写 `er_*` 存储。
 *
 * 两个方法都接收**当前事务的 SqlExecutor**，由根把 `registration.getForm(id)` 包成
 * `getForm(sql, id)`、把 `registration.saveForm(principal, id, input)` 包成
 * `saveForm(sql, principal, id, input)`；根适配器只使用被传入的 `sql`，因此三步写在同一事务里
 * （根 `DatabasePort` 的嵌套事务即保存点），任一步失败整体回滚。
 *
 * 根未注入时，`duplicateEvent` 表现为"无报名表配置可复制"而不是失败（见交付文档 NEEDS_INTERFACE）。
 */
export interface OrganizerRegistrationFormPort {
  getForm(sql: SqlExecutor, eventId: string): Promise<{ readonly title: string; readonly description: string; readonly fields: readonly unknown[] } | null>;
  saveForm(sql: SqlExecutor, principal: OrganizerPrincipal, eventId: string, input: { readonly expectedRevision: number; readonly title: string; readonly description: string; readonly fields: readonly unknown[]; readonly changeNote: string }): Promise<unknown>;
}
/**
 * P05 跨模块端口：把评审配置读/写交给 `event-judging`。
 * 语义与 `OrganizerRegistrationFormPort` 相同：只写自己的存储，只使用传入的 `sql`。
 */
export interface OrganizerJudgingConfigPort {
  /** 取本场最新一轮的已保存配置；尚未配置时返回 null（此时不复制，不编造默认值）。 */
  getConfig(sql: SqlExecutor, eventId: string): Promise<Record<string, unknown> | null>;
  saveConfig(sql: SqlExecutor, principal: OrganizerPrincipal, eventId: string, input: { readonly expectedRevision: number; readonly config: Record<string, unknown> }): Promise<unknown>;
}
/** P05 复制结果：新草稿 + 哪些配置项因来源未配置而被跳过（供界面如实说明，不假装复制成功）。 */
export interface DuplicateEventResult {
  readonly event: HostedEvent;
  /** 值为跳过原因；键为 `registrationForm` / `judgingConfig`。 */
  readonly skipped: Readonly<Record<string, string>>;
}
/**
 * P07 数据看板下钻的只读 Port。
 *
 * 看板的五块事实分别由 `event-registration`、`event-judging`、`event-communication` 拥有；
 * 本模块**不直接读它们的表**，而是由根把这些既有读取方法（原样转发、不另算一套数字）注入进来。
 * 未注入时看板如实返回"未读取"（`undefined`，界面显示"未提供"），**绝不补 0**。
 * 所有方法只读，MUST NOT 产生任何写入；实现方 MUST 直接调用对应既有读路径。
 */
export interface OrganizerDashboardPort {
  /** 既有 `event-registration.registrationCounts()` 的原样返回。 */
  readonly registrationCounts?: (principal: OrganizerPrincipal, eventId: string) => Promise<DashboardRegistrationCounts>;
  /** 既有 `event-registration.listStaff()` 的报名分页（只透传 cursor/limit，不另加筛选）。 */
  readonly registrations?: (principal: OrganizerPrincipal, eventId: string, options: { readonly cursor?: string; readonly limit?: number }) => Promise<DashboardPage<DashboardRegistrationRow>>;
  /** 既有 `event-registration.listStaffTeams()` 的正式队伍分页。 */
  readonly teams?: (principal: OrganizerPrincipal, eventId: string, options: { readonly cursor?: string; readonly limit?: number }) => Promise<DashboardPage<DashboardTeamRow>>;
  /** 既有 `event-judging.workspace()` 的轮次与收件集合。 */
  readonly judgingWorkspace?: (principal: OrganizerPrincipal, eventId: string) => Promise<DashboardJudgingWorkspace>;
  /** 既有 `event-judging.progress(roundId)` 的原样返回。 */
  readonly judgingProgress?: (principal: OrganizerPrincipal, eventId: string, roundId: string) => Promise<DashboardJudgingProgress>;
  /** 既有 `event-communication` 住宿分配读取。 */
  readonly accommodation?: (principal: OrganizerPrincipal, eventId: string) => Promise<readonly DashboardAccommodationRow[]>;
  /** 既有 `event-communication` 餐券读取。 */
  readonly vouchers?: (principal: OrganizerPrincipal, eventId: string) => Promise<readonly DashboardVoucherRow[]>;
  /** 既有 `event-communication.schedule.getScheduleDraft()` 的原样返回。 */
  readonly scheduleDraft?: (principal: OrganizerPrincipal, eventId: string) => Promise<DashboardScheduleDraft>;
}
/**
 * P3 受限邀请：领取时的"当前账号邮箱事实"。
 *
 * 领取 MUST 只由**已登录且邮箱已验证**的账号完成，绑定邮箱时还 MUST 与领取账号邮箱一致。
 * 本模块不直接查 `auth_users`（那是 auth 模块的存储），由根注入这个只读 Port，并用**当前事务的
 * SqlExecutor** 读取，使校验与既有 grant 写入落在同一事务。未注入时领取**失败关闭**（503），
 * 绝不因为"拿不到校验"而静默放行。
 */
export interface OrganizerAccountEmailPort {
  /** 账号不存在/未激活/邮箱未验证一律返回 null；MUST 只读，且只使用传入的 sql。 */
  readVerifiedEmail(sql: SqlExecutor, userId: EntityId): Promise<{ readonly email: string } | null>;
}
function denied(): never { throw new DomainError("ORGANIZER_FORBIDDEN","你目前没有这家机构或这场比赛的操作权限。", { status: 403, recoveryAction: "请选择有权限的比赛，或联系机构管理员。" }); }
function missing(): never { throw new DomainError("ORGANIZER_NOT_FOUND","未找到可访问的记录。", { status: 404 }); }
function expectRevision(actual: number, expected: unknown) { if (actual !== v.revision(expected)) throw new DomainError("ORGANIZER_REVISION_CONFLICT","内容已被其他工作人员更新，输入已保留。", { status: 409, latestRevision: actual, recoveryAction: "重新读取最新内容，核对后再保存。" }); }
function scope(event: HostedEvent): HostedEventScope {
  return { organizationId:event.organizationId,organizationName:event.organizationName,eventId:event.eventId,title:event.title,status:event.status,revision:event.revision,publishedRevision:event.publishedRevision,timezone:event.timezone,startsAt:event.startsAt,endsAt:event.endsAt,registrationOpensAt:event.registrationOpensAt,registrationClosesAt:event.registrationClosesAt,submissionClosesAt:event.submissionClosesAt,modules:event.modules,registration:event.registration,teams:event.teams,linkedEventId:event.linkedEventId,community:event.community ?? DEFAULT_EVENT_COMMUNITY };
}
function isAdminGrant(grant: StaffGrant) { return grant.status === "active" && grant.role === "organization_admin" && grant.eventId === null; }
function hasCapability(grants: readonly StaffGrant[], eventId: string, capability: EventStaffCapability) { return grants.some(grant => grant.status === "active" && (grant.eventId === null || grant.eventId === eventId) && (isAdminGrant(grant) || grant.capabilities.includes(capability))); }
function canView(grants: readonly StaffGrant[], eventId: string) { return grants.some(grant => grant.status === "active" && (grant.eventId === null || grant.eventId === eventId)); }

export class OrganizerService {
  readonly database: DatabasePort; readonly clock: Clock; readonly ids: IdGenerator; readonly repository: PostgresOrganizerRepository;
  readonly eventAccess: HostedEventAccessPort; private readonly discoveryPort?: OrganizerClaimDiscoveryPort;
  private readonly readinessPort?: OrganizerReadinessEvidencePort;
  private readonly registrationFormsPort?: OrganizerRegistrationFormPort;
  private readonly judgingConfigPort?: OrganizerJudgingConfigPort;
  private readonly dashboardPort?: OrganizerDashboardPort;
  private readonly accountEmails?: OrganizerAccountEmailPort;
  /** P4：根注入的助手 key（去重保序、裁剪空白）。空数组等价于"未注入"。 */
  private readonly assistantKeys: readonly string[];
  constructor(options: OrganizerServiceOptions) {
    this.database=options.database;this.clock=options.clock;this.ids=options.ids;this.repository=options.repository ?? new PostgresOrganizerRepository();
    this.discoveryPort=options.discovery;this.readinessPort=options.readinessEvidence;
    this.registrationFormsPort=options.registrationForms;this.judgingConfigPort=options.judgingConfig;this.dashboardPort=options.dashboard;this.accountEmails=options.accountEmails;
    this.assistantKeys=Object.freeze([...new Set((options.assistantKeys ?? []).filter(key => typeof key === "string" && key.trim().length > 0).map(key => key.trim()))]);
    this.eventAccess = { getEvent:(sql,id,options)=>this.getEventScope(sql,id,options),requireStaff:(sql,actor,id,capability)=>this.requireStaff(sql,actor,id,capability) };
  }
  private async authenticated<T>(principal: OrganizerPrincipal, work: (sql: SqlExecutor) => Promise<T>): Promise<T> {
    if (!principal || typeof principal.guard !== "function" || !principal.actor?.userId) denied();
    return this.database.transaction(async sql => { await principal.guard(sql); const result=await work(sql); await principal.guard(sql); return result; });
  }
  private now() { return this.clock.now().toISOString(); }
  private async audit(sql: SqlExecutor, principal: OrganizerPrincipal, organizationId: string, action: string, entityId: string, revision: number, eventId?: string) { await this.repository.audit(sql,{ id:this.ids.next(),organizationId,actorUserId:principal.actor.userId,action,entityId,revision,createdAt:this.now(),...(eventId ? {eventId}: {}) }); }
  private requirePlatformAdmin(principal: OrganizerPrincipal) { if (!principal.actor.platformRoles.includes("admin")) denied(); }
  private async organization(sql: SqlExecutor, id: string) { return await this.repository.getOrganization(sql,v.text(id,"机构标识",200),true) ?? missing(); }
  private async organizationAdmin(sql: SqlExecutor, actor: Actor, orgId: string, approved = true) {
    const organization=await this.organization(sql,orgId); const grants=await this.repository.listGrants(sql,orgId,actor.userId);
    if (!grants.some(isAdminGrant) || (approved && organization.status !== "approved")) denied(); return organization;
  }
  /** Trusted root setting port; uses the same current organization/grant lock and policy. */
  /**
   * 规划35（专属页）：其他模块复用**同一份**主办方审计，不新建第二套审计表。
   * 只写既有 organizer_audit_events；调用方在同一事务里调用，失败即整笔回滚。
   */
  async recordAuditEvent(sql: SqlExecutor, input: {
    readonly organizationId: string; readonly eventId?: string; readonly actorUserId: string;
    readonly action: string; readonly entityId: string; readonly revision: number;
  }): Promise<void> {
    await this.repository.audit(sql, {
      id: this.ids.next(), organizationId: input.organizationId, actorUserId: input.actorUserId,
      action: input.action, entityId: input.entityId, revision: input.revision, createdAt: this.now(),
      ...(input.eventId ? { eventId: input.eventId } : {}),
    });
  }

  async requireOrganizationManager(sql: SqlExecutor, actor: Actor, orgId: string): Promise<Organization> { return this.organizationAdmin(sql, actor, orgId); }
  /** Always lock organization before event: grant revocation, suspension and event writes share this order. */
  private async lockedEvent(sql: SqlExecutor, id: string): Promise<{ event: HostedEvent; organization: Organization }> {
    const initial=await this.repository.getEvent(sql,v.text(id,"比赛标识",200)); if (!initial) missing();
    const organization=await this.organization(sql,initial.organizationId);
    const event=await this.repository.getEvent(sql,id,true); if (!event || event.organizationId !== organization.id) missing(); return { event,organization };
  }
  private async effectiveEvent(sql: SqlExecutor, event: HostedEvent): Promise<HostedEvent> {
    if (event.publishedRevision === null) return event;
    const publication=await this.repository.getPublication(sql,event.eventId,event.publishedRevision);
    if (!publication) throw new DomainError("ORGANIZER_PUBLICATION_MISSING","已发布版本暂时无法读取，请联系管理员。",{status:503});
    return { ...publication.snapshot,status:event.status,revision:event.revision,publishedRevision:event.publishedRevision };
  }
  async getEventScope(sql: SqlExecutor, eventId: string, options?: { readonly forUpdate?: boolean }): Promise<HostedEventScope | null> {
    // Root provides current-account/session guards in consumers; this lookup carries no principal.
    const initial=await this.repository.getEvent(sql,eventId); if (!initial) return null;
    const organization=await this.repository.getOrganization(sql,initial.organizationId,Boolean(options?.forUpdate)); if (!organization || organization.status !== "approved") return null;
    const current=options?.forUpdate ? await this.repository.getEvent(sql,eventId,true) : initial; if (!current) return null;
    return scope({ ...await this.effectiveEvent(sql,current),organizationName:organization.name });
  }
  async requireStaff(sql: SqlExecutor, actor: Actor, eventId: string, capability: EventStaffCapability): Promise<HostedEventScope> {
    if (!EVENT_STAFF_CAPABILITIES.includes(capability)) denied();
    const {event,organization}=await this.lockedEvent(sql,eventId);
    if (organization.status !== "approved" || event.status === "archived") denied();
    const grants=await this.repository.listGrants(sql,organization.id,actor.userId); if (!hasCapability(grants,eventId,capability)) denied();
    return scope({ ...await this.effectiveEvent(sql,event),organizationName:organization.name });
  }
  listTemplates() { return listOrganizerTemplates(); }
  async createApplication(principal: OrganizerPrincipal, input: unknown): Promise<OrganizationApplication> {
    return this.authenticated(principal,async sql => {
      const fields=v.application(input),now=this.now(),orgId=this.ids.next();
      const organization: Organization={id:orgId,name:fields.name,kind:fields.kind,description:fields.description,ownerUserId:principal.actor.userId,status:"pending",revision:1,createdAt:now,updatedAt:now};
      const application: OrganizationApplication={...fields,evidenceUrls:fields.evidenceUrls ?? [],id:this.ids.next(),organizationId:orgId,applicantUserId:principal.actor.userId,status:"pending",revision:1,reviewNote:null,createdAt:now,updatedAt:now};
      await this.repository.insertOrganization(sql,organization);await this.repository.insertApplication(sql,application);await this.audit(sql,principal,orgId,"application_created",application.id,1);return application;
    });
  }
  async listOwnApplications(principal: OrganizerPrincipal) { return this.authenticated(principal,sql=>this.repository.listApplications(sql,principal.actor.userId)); }
  async listApplicationsForReview(principal: OrganizerPrincipal) { return this.authenticated(principal,async sql=> {this.requirePlatformAdmin(principal);return this.repository.listApplications(sql);}); }
  async updateApplication(principal: OrganizerPrincipal, id: string, input: unknown): Promise<OrganizationApplication> {
    return this.authenticated(principal,async sql=> {
      const initial=await this.repository.getApplication(sql,id);if (!initial || initial.applicantUserId !== principal.actor.userId) missing();
      const organization=await this.organization(sql,initial.organizationId),current=await this.repository.getApplication(sql,id) ?? missing();
      if (!["pending","rejected"].includes(current.status)) throw new DomainError("ORGANIZER_APPLICATION_LOCKED","当前申请已审核，身份依据变更请联系平台管理员。",{status:409});
      const fields=v.application(input,true);expectRevision(current.revision,v.object(input).expectedRevision);
      const next: OrganizationApplication={...current,...fields,evidenceUrls:fields.evidenceUrls ?? [],status:"pending",revision:current.revision+1,reviewNote:null,updatedAt:this.now()};
      await this.repository.saveOrganization(sql,{...organization,name:fields.name,kind:fields.kind,description:fields.description,status:"pending",revision:organization.revision+1,updatedAt:this.now()});
      await this.repository.saveApplication(sql,next);await this.audit(sql,principal,organization.id,"application_resubmitted",id,next.revision);return next;
    });
  }
  async reviewApplication(principal: OrganizerPrincipal, id: string, input: unknown): Promise<OrganizationApplication> {
    return this.authenticated(principal,async sql=> {
      this.requirePlatformAdmin(principal);const initial=await this.repository.getApplication(sql,id) ?? missing();
      const organization=await this.organization(sql,initial.organizationId),current=await this.repository.getApplication(sql,id) ?? missing();
      const ownGrants=await this.repository.listGrants(sql,organization.id,principal.actor.userId);
      if (current.applicantUserId === principal.actor.userId || organization.ownerUserId === principal.actor.userId || ownGrants.some(grant=>grant.status === "active")) throw new DomainError("ORGANIZER_SELF_REVIEW","机构申请人或当前工作人员不能审核自己的机构。",{status:403});
      const body=v.object(input);v.keys(body,["expectedRevision","decision","note"]);expectRevision(current.revision,body.expectedRevision);
      if (typeof body.decision !== "string" || !["approved","rejected","suspended"].includes(body.decision)) v.invalid("请选择通过、退回或停用。");
      const decision=body.decision as "approved" | "rejected" | "suspended";
      const allowed: Record<string,readonly string[]>={pending:["approved","rejected"],approved:["suspended"],rejected:[],suspended:["approved","rejected"]};
      if (!allowed[current.status].includes(decision)) throw new DomainError("ORGANIZER_REVIEW_TRANSITION","申请状态已变化，请按当前状态处理。",{status:409});
      const note=v.text(body.note,"审核说明",2000),next: OrganizationApplication={...current,status:decision,revision:current.revision+1,reviewNote:note,updatedAt:this.now()};
      await this.repository.saveOrganization(sql,{...organization,status:decision,revision:organization.revision+1,updatedAt:this.now()});await this.repository.saveApplication(sql,next);
      if (decision === "approved" && current.status === "pending" && !(await this.repository.listGrants(sql,organization.id)).some(grant=>grant.role === "organization_admin")) {
        const grant: StaffGrant={id:this.ids.next(),organizationId:organization.id,eventId:null,userId:organization.ownerUserId,role:"organization_admin",capabilities:[...EVENT_STAFF_CAPABILITIES],status:"active",revision:1,createdAt:this.now(),revokedAt:null};await this.repository.insertGrant(sql,grant);
      }
      await this.audit(sql,principal,organization.id,`application_${decision}`,id,next.revision);return next;
    });
  }
  async listOrganizations(principal: OrganizerPrincipal): Promise<Organization[]> {
    return this.authenticated(principal,async sql=> { const grants=await this.repository.listUserGrants(sql,principal.actor.userId),result: Organization[]=[];
      for (const id of [...new Set(grants.map(grant=>grant.organizationId))].sort()) {const org=await this.repository.getOrganization(sql,id,true);if (org && (await this.repository.listGrants(sql,id,principal.actor.userId)).some(grant=>grant.status === "active")) result.push(org);} return result;
    });
  }
  async updateOrganization(principal: OrganizerPrincipal, id: string, input: unknown): Promise<Organization> {
    return this.authenticated(principal,async sql=> {const org=await this.organizationAdmin(sql,principal.actor,id),body=v.object(input);v.keys(body,["expectedRevision","description"]);expectRevision(org.revision,body.expectedRevision);
      const next={...org,description:v.text(body.description,"机构简介",2000),revision:org.revision+1,updatedAt:this.now()};await this.repository.saveOrganization(sql,next);await this.audit(sql,principal,id,"organization_updated",id,next.revision);return next;});
  }
  async listStaffGrants(principal: OrganizerPrincipal, organizationId: string): Promise<StaffGrant[]> {return this.authenticated(principal,async sql=>{await this.organizationAdmin(sql,principal.actor,organizationId);return this.repository.listGrants(sql,organizationId);});}
  /**
   * 既有 StaffGrant 的**唯一写入实现**（宪法 XII 单一事实来源）。
   *
   * `grantStaff` 与受限邀请领取都只经这里写 `organizer_staff_grants`，因此不存在第二套权限事实
   * 或第二套写路径：事件范围校验、重复授权检查、组织 revision 推进与 FK 错误映射保持同一口径。
   */
  private async writeStaffGrant(sql: SqlExecutor, organization: Organization, fields: {
    readonly userId: EntityId; readonly eventId: EntityId | null;
    readonly role: StaffGrant["role"]; readonly capabilities: readonly EventStaffCapability[];
  }): Promise<StaffGrant> {
    const { userId, eventId } = fields;
    if (eventId) {const event=await this.repository.getEvent(sql,eventId,true);if (!event || event.organizationId !== organization.id) denied();if(event.status === "archived") denied();}
    const existing=(await this.repository.listGrants(sql,organization.id,userId)).find(grant=>grant.status === "active" && grant.eventId === eventId);
    if (existing) throw new DomainError("ORGANIZER_GRANT_EXISTS","该账号已有此范围的权限，请先撤销旧授权再重新设置。",{status:409});
    const grant: StaffGrant={id:this.ids.next(),organizationId:organization.id,eventId,userId,role:fields.role,capabilities:[...fields.capabilities],status:"active",revision:1,createdAt:this.now(),revokedAt:null};
    try {await this.repository.insertGrant(sql,grant);} catch (error) {if (error && typeof error === "object" && "code" in error && error.code === "23503") v.invalid("工作人员账号不存在，请核对账号标识。");throw error;}
    await this.repository.saveOrganization(sql,{...organization,revision:organization.revision+1,updatedAt:this.now()});return grant;
  }
  async grantStaff(principal: OrganizerPrincipal, organizationId: string, input: unknown): Promise<StaffGrant> {
    return this.authenticated(principal,async sql=> {
      const org=await this.organizationAdmin(sql,principal.actor,organizationId),body=v.object(input);v.keys(body,["expectedOrganizationRevision","userId","eventId","role","capabilities"]);expectRevision(org.revision,body.expectedOrganizationRevision);
      const userId=v.text(body.userId,"工作人员账号标识",200),eventId=body.eventId === null ? null : v.text(body.eventId,"比赛标识",200);
      if (typeof body.role !== "string" || !["organization_admin","staff"].includes(body.role)) v.invalid("请选择机构管理员或赛事工作人员。");
      if (body.role === "organization_admin" && eventId !== null) v.invalid("机构管理员必须使用机构范围授权。");
      const capabilities=body.role === "organization_admin" ? (v.capabilities(body.capabilities),[...EVENT_STAFF_CAPABILITIES]) : v.capabilities(body.capabilities);
      if (body.role === "staff" && !capabilities.length) v.invalid("请至少选择一项工作权限。");
      const grant=await this.writeStaffGrant(sql,org,{ userId,eventId,role:body.role as StaffGrant["role"],capabilities });
      await this.audit(sql,principal,organizationId,"staff_granted",grant.id,1,eventId ?? undefined);return grant;
    });
  }

  // ---- P3 工作人员受限邀请（宪法 XIII「工作人员受限邀请」）----
  /**
   * 生成邀请。只有**当前机构管理员**能创建（`organizationAdmin` 锁机构并校验 approved）；
   * `organization_admin` 与既有 grant 规则一致地强制机构范围并覆盖为全部能力。
   * 返回的原文 token **只在此响应出现一次**，库内只落 sha256。
   */
  async createStaffInvitation(principal: OrganizerPrincipal, organizationId: string, input: unknown): Promise<CreateStaffInvitationResult> {
    return this.authenticated(principal,async sql=> {
      const organization=await this.organizationAdmin(sql,principal.actor,organizationId),fields=v.staffInvitation(input);
      const eventId=fields.role === "organization_admin" ? null : fields.eventId;
      if (eventId) {const event=await this.repository.getEvent(sql,eventId,true);if(!event || event.organizationId !== organizationId) denied();if(event.status === "archived") denied();}
      const capabilities=fields.role === "organization_admin" ? [...EVENT_STAFF_CAPABILITIES] : [...fields.capabilities];
      const token=mintInvitationToken(),now=this.now();
      const invitation: StaffInvitation={ id:this.ids.next(),organizationId,eventId,role:fields.role,capabilities,status:"open",tokenHash:hashInvitationToken(token),boundEmail:fields.boundEmail,expiresAt:invitationExpiresAt(now,fields.expiresInDays),claimedByUserId:null,claimedAt:null,createdByUserId:principal.actor.userId,createdAt:now,revokedAt:null,revokedByUserId:null,note:fields.note,revision:1 };
      await this.repository.insertInvitation(sql,invitation);
      await this.audit(sql,principal,organizationId,"staff_invitation_created",invitation.id,1,eventId ?? undefined);
      const eventTitle=eventId ? (await this.repository.getEvent(sql,eventId))?.title ?? null : null;
      return { invitation:toInvitationView(invitation,{ now,organizationName:organization.name,eventTitle }),token };
    });
  }
  /** 机构管理员可见的邀请状态（谁、何时、领取了哪些能力）；列表**不含** token 与 tokenHash。 */
  async listStaffInvitations(principal: OrganizerPrincipal, organizationId: string): Promise<StaffInvitationView[]> {
    return this.authenticated(principal,async sql=>{
      const organization=await this.organizationAdmin(sql,principal.actor,organizationId),invitations=await this.repository.listInvitations(sql,organizationId),now=this.now();
      const titles=new Map<string,string|null>(),result: StaffInvitationView[]=[];
      for (const invitation of invitations) {
        let eventTitle: string|null=null;
        if (invitation.eventId) { if(!titles.has(invitation.eventId)) titles.set(invitation.eventId,(await this.repository.getEvent(sql,invitation.eventId))?.title ?? null); eventTitle=titles.get(invitation.eventId) ?? null; }
        result.push(toInvitationView(invitation,{ now,organizationName:organization.name,eventTitle }));
      }
      return result;
    });
  }
  /** 撤销：只允许撤销仍 open 的邀请；已领取/已撤销/已过期都给出明确错误码，不静默改状态。 */
  async revokeStaffInvitation(principal: OrganizerPrincipal, invitationId: string, input: unknown): Promise<StaffInvitationView> {
    return this.authenticated(principal,async sql=>{
      const initial=await this.repository.getInvitation(sql,v.text(invitationId,"邀请标识",200)) ?? missing();
      const organization=await this.organizationAdmin(sql,principal.actor,initial.organizationId);
      const current=await this.repository.getInvitation(sql,initial.id,true) ?? missing();
      expectRevision(current.revision,v.revokeInvitation(input));
      const status=invitationStatus(current,this.now());
      if (status === "claimed") throw new DomainError("ORGANIZER_INVITATION_CLAIMED","这份邀请已经被领取，不能撤销；如需收回权限请撤销对应的工作人员授权。",{status:409});
      if (status === "revoked") throw new DomainError("ORGANIZER_INVITATION_REVOKED","这份邀请已经撤销。",{status:409});
      if (status === "expired") throw new DomainError("ORGANIZER_INVITATION_EXPIRED","这份邀请已过期，无需撤销。",{status:409});
      const now=this.now(),next: StaffInvitation={...current,status:"revoked",revokedAt:now,revokedByUserId:principal.actor.userId,revision:current.revision+1};
      await this.repository.saveInvitation(sql,next);
      await this.audit(sql,principal,initial.organizationId,"staff_invitation_revoked",next.id,next.revision,next.eventId ?? undefined);
      const eventTitle=next.eventId ? (await this.repository.getEvent(sql,next.eventId))?.title ?? null : null;
      return toInvitationView(next,{ now,organizationName:organization.name,eventTitle });
    });
  }
  /** 领取页只读预览：任意已登录账号可读；只返回邀请自身字段，不含 token、邀请人标识与备注。 */
  async previewStaffInvitation(principal: OrganizerPrincipal, token: unknown): Promise<StaffInvitationPreview> {
    return this.authenticated(principal,async sql=>{
      if (!isInvitationToken(token)) missing();
      const invitation=await this.repository.getInvitationByTokenHash(sql,hashInvitationToken(token)) ?? missing();
      const organization=await this.repository.getOrganization(sql,invitation.organizationId);
      if (!organization) missing();
      const eventTitle=invitation.eventId ? (await this.repository.getEvent(sql,invitation.eventId))?.title ?? null : null;
      return toInvitationPreview(invitation,{ now:this.now(),organizationName:organization.name,eventTitle });
    });
  }
  /**
   * 领取（宪法 XIII 硬约束）：已登录 + 邮箱已验证（+ 绑定邮箱一致）才允许；只经既有
   * `writeStaffGrant` 写**恰好一条** StaffGrant，并把邀请置为已领取并保留领取人与时间。
   * 过期/已领/已撤销/邮箱不符都给出明确错误码；任一步失败整体回滚，邀请保持原状态。
   */
  async claimStaffInvitation(principal: OrganizerPrincipal, token: unknown): Promise<ClaimStaffInvitationResult> {
    return this.authenticated(principal,async sql=>{
      if (!isInvitationToken(token)) missing();
      const tokenHash=hashInvitationToken(token);
      const initial=await this.repository.getInvitationByTokenHash(sql,tokenHash) ?? missing();
      // 先锁机构再锁邀请，与创建/撤销保持同一加锁顺序，避免与撤权路径交叉死锁。
      const organization=await this.organization(sql,initial.organizationId);
      if (organization.status !== "approved") denied();
      const current=await this.repository.getInvitationByTokenHash(sql,tokenHash,true) ?? missing();
      const now=this.now(),status=invitationStatus(current,now);
      if (status === "claimed") throw new DomainError("ORGANIZER_INVITATION_CLAIMED","这份邀请已经被领取，不能重复使用。",{status:409,recoveryAction:"请联系邀请你的机构管理员重新生成一份邀请。"});
      if (status === "revoked") throw new DomainError("ORGANIZER_INVITATION_REVOKED","这份邀请已被撤销，请联系邀请你的机构管理员。",{status:409});
      if (status === "expired") throw new DomainError("ORGANIZER_INVITATION_EXPIRED","这份邀请已过期，请联系邀请你的机构管理员重新生成。",{status:410});
      const port=this.accountEmails;
      if (!port) throw new DomainError("ORGANIZER_INVITATION_UNAVAILABLE","邀请领取当前未接入账号邮箱校验，请联系平台管理员。",{status:503});
      const account=await port.readVerifiedEmail(sql,principal.actor.userId);
      if (!account) throw new DomainError("ORGANIZER_INVITATION_EMAIL_UNVERIFIED","请先在账号设置里完成邮箱验证，再领取这份邀请。",{status:403,recoveryAction:"完成邮箱验证后回到这个链接重试。"});
      if (current.boundEmail && account.email.trim().toLowerCase() !== current.boundEmail) throw new DomainError("ORGANIZER_INVITATION_EMAIL_MISMATCH","这份邀请绑定的是另一个邮箱，不能由当前账号领取。",{status:403,recoveryAction:"请用被邀请的邮箱登录领取，或联系机构管理员重新生成邀请。"});
      const grant=await this.writeStaffGrant(sql,organization,{ userId:principal.actor.userId,eventId:current.eventId,role:current.role,capabilities:current.capabilities });
      const next: StaffInvitation={...current,status:"claimed",claimedByUserId:principal.actor.userId,claimedAt:now,revision:current.revision+1};
      await this.repository.saveInvitation(sql,next);
      await this.audit(sql,principal,organization.id,"staff_invitation_claimed",next.id,next.revision,next.eventId ?? undefined);
      const eventTitle=next.eventId ? (await this.repository.getEvent(sql,next.eventId))?.title ?? null : null;
      return { invitation:toInvitationPreview(next,{ now,organizationName:organization.name,eventTitle }),grant };
    });
  }
  async revokeStaff(principal: OrganizerPrincipal, id: string, input: unknown): Promise<StaffGrant> {
    return this.authenticated(principal,async sql=> {const initial=await this.repository.getGrant(sql,id) ?? missing(),org=await this.organizationAdmin(sql,principal.actor,initial.organizationId),current=await this.repository.getGrant(sql,id) ?? missing();
      const body=v.object(input);v.keys(body,["expectedRevision"]);expectRevision(current.revision,body.expectedRevision);if(current.status !== "active") throw new DomainError("ORGANIZER_GRANT_REVOKED","这项授权已撤销。",{status:409});
      if (isAdminGrant(current) && (await this.repository.listGrants(sql,org.id)).filter(isAdminGrant).length <= 1) throw new DomainError("ORGANIZER_LAST_ADMIN","请先增加另一位机构管理员，不能撤销最后一位管理员。",{status:409});
      const next: StaffGrant={...current,status:"revoked",revision:current.revision+1,revokedAt:this.now()};await this.repository.saveGrant(sql,next);await this.repository.saveOrganization(sql,{...org,revision:org.revision+1,updatedAt:this.now()});await this.audit(sql,principal,org.id,"staff_revoked",id,next.revision,current.eventId ?? undefined);return next;
    });
  }
  /**
   * 创建赛事的**唯一写入实现**。`createEvent` 与 `duplicateEvent` 都只经这里写
   * `organizer_hosted_events`，因此不存在第二套创建逻辑。
   */
  private async createEventIn(sql: SqlExecutor, principal: OrganizerPrincipal, organization: Organization, input: unknown): Promise<HostedEvent> {
    const body=v.object(input);v.keys(body,[...v.CONFIGURATION_KEYS,"templateKey","expectedOrganizationRevision"]);
    const template=this.listTemplates().find(template=>template.key === body.templateKey);if(!template) return v.invalid("请选择线上、线下或练习赛模板。");const fields=v.configuration(body,template);
    if(template.format === "online" && (fields.modules.accommodation || fields.modules.mealVouchers)) v.invalid("线上赛事不提供现场住宿或餐券。");
    const event: HostedEvent={...fields,organizationId:organization.id,organizationName:organization.name,eventId:this.ids.next(),status:"draft",revision:1,publishedRevision:null,linkedEventId:null,templateKey:template.key,templateVersion:1,format:template.format,responsibleUserId:principal.actor.userId,createdAt:this.now(),updatedAt:this.now()};
    await this.repository.insertEvent(sql,event);await this.audit(sql,principal,organization.id,"event_created",event.eventId,1,event.eventId);return event;
  }
  async createEvent(principal: OrganizerPrincipal, organizationId: string, input: unknown): Promise<HostedEvent> {
    return this.authenticated(principal,async sql=> {const org=await this.organizationAdmin(sql,principal.actor,organizationId);expectRevision(org.revision,v.object(input).expectedOrganizationRevision);return this.createEventIn(sql,principal,org,input);});
  }
  async listOrganizationEvents(principal: OrganizerPrincipal, organizationId: string): Promise<HostedEvent[]> {
    return this.authenticated(principal,async sql=> {const org=await this.organization(sql,organizationId),grants=await this.repository.listGrants(sql,organizationId,principal.actor.userId);if(org.status !== "approved" || !grants.some(grant=>grant.status === "active")) denied();return (await this.repository.listEvents(sql,organizationId)).filter(event=>canView(grants,event.eventId));});
  }
  /**
   * P05：本机构可作为复制来源的赛事。
   * **复用既有 `listOrganizationEvents`，不新增查询**；具备 `event_manage` 的赛事才列出来，
   * 因为复制需要来源的运营权限。归档赛事也在列表内（界面另行提示配置可能过时）。
   */
  async listDuplicateSources(principal: OrganizerPrincipal, organizationId: string): Promise<HostedEvent[]> {
    const events=await this.listOrganizationEvents(principal,organizationId);
    return this.authenticated(principal,async sql=> {
      const grants=await this.repository.listGrants(sql,organizationId,principal.actor.userId);
      return events.filter(event=>hasCapability(grants,event.eventId,"event_manage"));
    });
  }
  /**
   * 复制上一场活动（P05）。
   *
   * 全程一个事务、一个 `SqlExecutor`：建赛事 → 存报名表 → 存评审配置；
   * 三步中任一步抛错，外层事务整体回滚，**不会留下半成品副本**（根 `DatabasePort` 的嵌套事务即保存点）。
   * 只复制**当前草稿**配置；来源的发布快照、答卷、队伍、通知、评审事实、申诉与审计都不在复制范围内。
   */
  async duplicateEvent(principal: OrganizerPrincipal, sourceEventId: string, input: unknown): Promise<DuplicateEventResult> {
    return this.authenticated(principal,async sql=> {
      const request=parseDuplicateRequest(input);
      const sourceId=v.text(sourceEventId,"来源比赛",200);
      const initial=await this.repository.getEvent(sql,sourceId) ?? missing();
      // 先锁机构再锁赛事，与既有 `lockedEvent` 的锁顺序一致。
      const organization=await this.organization(sql,initial.organizationId);
      const current=await this.repository.getEvent(sql,sourceId,true) ?? missing();
      if(current.organizationId !== organization.id) missing();
      expectRevision(organization.revision,request.expectedOrganizationRevision);
      if(organization.status !== "approved") denied();
      const grants=await this.repository.listGrants(sql,organization.id,principal.actor.userId);
      // 来源赛事与目标机构都要求 `event_manage`；跨机构来源在下面由 mergeConfiguration 再拒一次。
      if(!hasCapability(grants,current.eventId,"event_manage")) denied();
      assertDuplicateSource(current);

      const template=this.listTemplates().find(item=>item.key === current.templateKey) ?? this.listTemplates()[0];
      if(!template) return v.invalid("当前没有可用的比赛模板，请联系平台管理员。");
      const existing=(await this.repository.listEvents(sql,organization.id)).map(event=>event.title);
      const title=request.title ?? duplicateTitle(current.title,existing);
      const times=shiftedOccurrenceTimes(current,this.now());
      const configuration=mergeConfiguration(current,{...template,format:current.format}, { title, times }, organization.id);

      const event=await this.createEventIn(sql,principal,organization,{
        ...configuration, templateKey:current.templateKey, expectedOrganizationRevision:organization.revision,
      });
      // `createEventIn` 只写赛事，不推进机构 revision；这里与 `createEvent` 路径保持一致地推进一次，
      // 使同一机构下并发的两次创建会有一方在 `expectRevision` 处拿到 409，而不是双双成功。
      await this.repository.saveOrganization(sql,{...organization,revision:organization.revision+1,updatedAt:this.now()});

      const skipped: Record<string,string>={};
      if(current.modules.registration && request.includeRegistrationForm){
        if(!this.registrationFormsPort) skipped.registrationForm="未接入报名表服务，报名表未复制。";
        else {
          const form=await this.registrationFormsPort.getForm(sql,current.eventId);
          if(!form) skipped.registrationForm="来源比赛还没有保存过报名表，没有可复制的内容。";
          else await this.registrationFormsPort.saveForm(sql,principal,event.eventId,duplicateFormInput({ title:form.title, description:form.description, fields:form.fields },current.title));
        }
      }
      if(current.modules.judging && request.includeJudgingConfig){
        if(!this.judgingConfigPort) skipped.judgingConfig="未接入评审服务，评审配置未复制。";
        else {
          const config=await this.judgingConfigPort.getConfig(sql,current.eventId);
          if(!config) skipped.judgingConfig="来源比赛还没有保存过评审标准，没有可复制的内容。";
          else {
            const judged=duplicateJudgingConfigInput(config as Parameters<typeof duplicateJudgingConfigInput>[0]);
            await this.judgingConfigPort.saveConfig(sql,principal,event.eventId,{ expectedRevision:judged.expectedRevision, config:judged.config });
          }
        }
      }
      await this.audit(sql,principal,organization.id,"event_duplicated",event.eventId,1,event.eventId);
      return { event, skipped };
    });
  }
  async getManagedEvent(principal: OrganizerPrincipal, eventId: string): Promise<HostedEvent> {
    return this.authenticated(principal,async sql=> {const {event,organization}=await this.lockedEvent(sql,eventId),grants=await this.repository.listGrants(sql,organization.id,principal.actor.userId);if(organization.status !== "approved" || !canView(grants,eventId)) denied();return event;});
  }
  async updateEvent(principal: OrganizerPrincipal, eventId: string, input: unknown): Promise<HostedEvent> {
    return this.authenticated(principal,async sql=> {await this.requireStaff(sql,principal.actor,eventId,"event_manage");const event=await this.repository.getEvent(sql,eventId,true) ?? missing();if(event.status === "ended") throw new DomainError("ORGANIZER_EVENT_ENDED","赛事已结束，规则草稿不可再修改。",{status:409});
      const body=v.object(input);v.keys(body,[...v.CONFIGURATION_KEYS,"expectedRevision"]);expectRevision(event.revision,body.expectedRevision);const fields=v.configuration(body);
      if (event.format === "online" && (fields.modules.accommodation || fields.modules.mealVouchers)) v.invalid("线上赛事不提供现场住宿或餐券。");
      if(event.publishedRevision !== null) {const published=await this.effectiveEvent(sql,event);if(EVENT_MODULES.some(key=>published.modules[key] && !fields.modules[key])) throw new DomainError("ORGANIZER_MODULE_IN_USE","已发布的功能保留历史入口，不能直接关闭。",{status:409,recoveryAction:"保留功能开关，在对应页面说明停止接收新操作；如需停用请联系平台核对历史影响。"});}
      const next: HostedEvent={...event,...fields,revision:event.revision+1,updatedAt:this.now()};await this.repository.saveEvent(sql,next);await this.audit(sql,principal,event.organizationId,"event_draft_updated",eventId,next.revision,eventId);return next;
    });
  }
  /** Responsible-person transfer is organization administration, never a client-self-reported identity. */
  async changeEventResponsible(principal: OrganizerPrincipal,eventId: string,input: unknown): Promise<HostedEvent> {
    return this.authenticated(principal,async sql=> {const {event,organization}=await this.lockedEvent(sql,eventId);await this.organizationAdmin(sql,principal.actor,organization.id);
      if(event.status === "archived" || event.status === "ended") throw new DomainError("ORGANIZER_EVENT_TRANSITION","赛事已结束或归档，不能更换运营负责人。",{status:409});
      const body=v.object(input);v.keys(body,["expectedRevision","responsibleUserId"]);expectRevision(event.revision,body.expectedRevision);const userId=v.text(body.responsibleUserId,"负责人账号标识",200);
      if(!hasCapability(await this.repository.listGrants(sql,organization.id,userId),eventId,"event_manage")) throw new DomainError("ORGANIZER_RESPONSIBLE_UNAVAILABLE","请先为新负责人授予这场比赛的运营权限。",{status:409});
      const next: HostedEvent={...event,responsibleUserId:userId,revision:event.revision+1,updatedAt:this.now()};await this.repository.saveEvent(sql,next);await this.audit(sql,principal,organization.id,"event_responsible_changed",eventId,next.revision,eventId);return next;
    });
  }
  private blockers(event: HostedEvent): string[] {
    const result: string[]=[];if(!event.summary) result.push("填写比赛简介");if(!event.rules) result.push("填写正式公开规则和参赛要求");if(!event.location) result.push("填写地点或在线参与说明");
    if(event.modules.registration && (!event.registrationOpensAt || !event.registrationClosesAt)) result.push("明确报名开始和截止时间");
    if(event.modules.judging && !event.submissionClosesAt) result.push("明确作品提交截止时间");return result;
  }
  private async publicProjection(sql: SqlExecutor, event: HostedEvent, publication: PublishedEventRevision | null, organization: Organization): Promise<PublicCompetition> {
    const source=publication?.snapshot ?? event;
    return {organizationId:organization.id,organizationName:organization.name,eventId:event.eventId,title:source.title,status:event.status === "draft" ? "published" : event.status,publishedRevision:publication?.version ?? (event.publishedRevision ?? 0)+1,organizationStatus:organization.status,availability:organization.status === "approved" ? "available" : "organization_unavailable",timezone:source.timezone,startsAt:source.startsAt,endsAt:source.endsAt,registrationOpensAt:source.registrationOpensAt,registrationClosesAt:source.registrationClosesAt,submissionClosesAt:source.submissionClosesAt,modules:source.modules,summary:source.summary,rules:source.rules,location:source.location,format:source.format,changeSummary:publication?.changeSummary ?? "发布预览",publishedAt:publication?.publishedAt ?? this.now()};
  }
  private async preview(sql: SqlExecutor,event: HostedEvent,organization: Organization): Promise<EventPreview> {
    const publication=event.publishedRevision ? await this.repository.getPublication(sql,event.eventId,event.publishedRevision):null;
    const changedFields=v.CONFIGURATION_KEYS.filter(key=>!publication || JSON.stringify(event[key]) !== JSON.stringify(publication.snapshot[key]));
    return {event,publicProjection:await this.publicProjection(sql,event,null,organization),publicationBlockers:this.blockers(event),changedFields};
  }
  async previewEvent(principal: OrganizerPrincipal,eventId: string): Promise<EventPreview> {return this.authenticated(principal,async sql=>{await this.requireStaff(sql,principal.actor,eventId,"event_manage");const {event,organization}=await this.lockedEvent(sql,eventId);return this.preview(sql,event,organization);});}
  async publishEvent(principal: OrganizerPrincipal,eventId: string,input: unknown): Promise<HostedEvent> {
    return this.authenticated(principal,async sql=> {await this.requireStaff(sql,principal.actor,eventId,"event_manage");const {event,organization}=await this.lockedEvent(sql,eventId),body=v.object(input);v.keys(body,["expectedRevision","changeSummary"]);expectRevision(event.revision,body.expectedRevision);
      if(!["draft","published"].includes(event.status)) throw new DomainError("ORGANIZER_EVENT_NOT_PUBLISHABLE","当前赛事不能发布新规则。",{status:409});
      const blockers=this.blockers(event);if(blockers.length) throw new DomainError("ORGANIZER_PUBLICATION_INCOMPLETE",`发布前请完成：${blockers.join("、")}。`);
      if(!canView(await this.repository.listGrants(sql,organization.id,event.responsibleUserId),eventId) || !hasCapability(await this.repository.listGrants(sql,organization.id,event.responsibleUserId),eventId,"event_manage")) throw new DomainError("ORGANIZER_RESPONSIBLE_UNAVAILABLE","赛事负责人已无运营权限，请先由机构管理员重新授权。",{status:409});
      const preview=await this.preview(sql,event,organization);if(event.publishedRevision && !preview.changedFields.length) throw new DomainError("ORGANIZER_NOTHING_TO_PUBLISH","公开规则没有变化，当前已发布版本仍有效。",{status:409});
      const changeSummary=v.text(body.changeSummary,"本次发布说明 / 参赛影响",2000),version=(event.publishedRevision ?? 0)+1;
      const next: HostedEvent={...event,status:"published",revision:event.revision+1,publishedRevision:version,organizationName:organization.name,updatedAt:this.now()};
      const publication: PublishedEventRevision={eventId,version,sourceRevision:next.revision,snapshot:next,changeSummary,publishedAt:this.now(),publishedBy:principal.actor.userId};
      await this.repository.saveEvent(sql,next);await this.repository.insertPublication(sql,publication);await this.repository.insertChange(sql,{id:this.ids.next(),eventId,organizationId:event.organizationId,version,changeSummary,createdAt:this.now()});await this.audit(sql,principal,event.organizationId,"event_published",eventId,next.revision,eventId);return next;
    });
  }
  async archiveEvent(principal: OrganizerPrincipal,eventId: string,input: unknown): Promise<HostedEvent> {return this.transitionEvent(principal,eventId,input,"archived");}
  async endEvent(principal: OrganizerPrincipal,eventId: string,input: unknown): Promise<HostedEvent> {return this.transitionEvent(principal,eventId,input,"ended");}
  private async transitionEvent(principal: OrganizerPrincipal,eventId: string,input: unknown,status: "ended" | "archived"): Promise<HostedEvent> {
    return this.authenticated(principal,async sql=> {await this.requireStaff(sql,principal.actor,eventId,"event_manage");const event=await this.repository.getEvent(sql,eventId,true) ?? missing(),body=v.object(input);v.keys(body,["expectedRevision"]);expectRevision(event.revision,body.expectedRevision);
      if(status === "ended" && event.status !== "published") throw new DomainError("ORGANIZER_EVENT_TRANSITION","只有已发布的赛事可以结束。",{status:409});
      const next: HostedEvent={...event,status,revision:event.revision+1,updatedAt:this.now()};await this.repository.saveEvent(sql,next);await this.audit(sql,principal,event.organizationId,`event_${status}`,eventId,next.revision,eventId);return next;
    });
  }
  async listPublicCompetitions(): Promise<PublicCompetition[]> {return this.database.transaction(async sql=>{const result: PublicCompetition[]=[];for(const event of await this.repository.listEvents(sql)){if(event.publishedRevision === null) continue;const org=await this.repository.getOrganization(sql,event.organizationId),publication=await this.repository.getPublication(sql,event.eventId,event.publishedRevision);if(org && publication) result.push(await this.publicProjection(sql,event,publication,org));}return result;});}
  async getPublicCompetition(eventId: string): Promise<PublicCompetition> {return this.database.transaction(async sql=>{const {event,organization}=await this.lockedEvent(sql,eventId);if(!event.publishedRevision) missing();const publication=await this.repository.getPublication(sql,eventId,event.publishedRevision);if(!publication) missing();return this.publicProjection(sql,event,publication,organization);});}
  async listCompetitionIdentities(principal: OrganizerPrincipal): Promise<CompetitionIdentity[]> {
    return this.authenticated(principal,async sql=> {const result: CompetitionIdentity[]=[],grants=await this.repository.listUserGrants(sql,principal.actor.userId);for(const orgId of new Set(grants.map(grant=>grant.organizationId))){const org=await this.organization(sql,orgId);if(org.status !== "approved") continue;const current=await this.repository.listGrants(sql,orgId,principal.actor.userId);for(const event of await this.repository.listEvents(sql,orgId)){if(!canView(current,event.eventId)) continue;result.push({event,capabilities:EVENT_STAFF_CAPABILITIES.filter(cap=>hasCapability(current,event.eventId,cap)),organizationAdmin:current.some(isAdminGrant)});}}return result;});
  }
  async listPublicationHistory(principal: OrganizerPrincipal,eventId: string) {return this.authenticated(principal,async sql=>{const {event,organization}=await this.lockedEvent(sql,eventId);if(organization.status !== "approved" || !canView(await this.repository.listGrants(sql,event.organizationId,principal.actor.userId),eventId)) denied();return this.repository.listPublications(sql,eventId);});}
  async listPublicationChanges(principal: OrganizerPrincipal,eventId: string) {return this.authenticated(principal,async sql=>{await this.requireStaff(sql,principal.actor,eventId,"communication_manage");return this.repository.listChanges(sql,eventId);});}

  // ---- 认领已发现的赛事（规划25 / P02）----
  // 候选与可认领判断经注入 Port 读取自动发现，模块不直接查该存储。
  private discovery() {
    if (!this.discoveryPort) throw new DomainError("ORGANIZER_CLAIM_UNAVAILABLE","认领功能当前未接入自动发现数据，请联系平台管理员。",{status:503});
    return this.discoveryPort;
  }
  /** 本机构可见的认领候选。候选只作提示，不产生任何权限或归属。 */
  async listClaimCandidates(principal: OrganizerPrincipal,organizationId: string): Promise<OrganizerClaimCandidate[]> {
    return this.authenticated(principal,async sql=>{const organization=await this.organizationAdmin(sql,principal.actor,organizationId);
      return this.discovery().listCandidates(sql,{ organizationId: organization.id, organizationName: organization.name });});
  }
  /** 比赛页入口：取单条线索，并返回当前账号可用来认领的已批准机构。 */
  async getClaimCandidate(principal: OrganizerPrincipal,discoveryId: string): Promise<{ candidate: OrganizerClaimCandidate | null; organizations: readonly { id: EntityId; name: string }[]; existingClaim: OrganizerClaimRequest | null }> {
    return this.authenticated(principal,async sql=>{
      const id=v.text(discoveryId,"比赛线索",200);
      const candidate=await this.discovery().getCandidate(sql,id);
      // 只有当前账号是机构管理员、且机构已批准的才可选，避免在公开页暴露他机构标识。
      const grants=await this.repository.listUserGrants(sql,principal.actor.userId), organizations: { id: EntityId; name: string }[]=[];
      for(const grant of grants.filter(isAdminGrant)){
        const organization=await this.repository.getOrganization(sql,grant.organizationId);
        if(organization && organization.status === "approved") organizations.push({ id: organization.id, name: organization.name });
      }
      const occupied=candidate ? await this.repository.activeClaimFor(sql,candidate.discoveryId) : null;
      return { candidate, organizations, existingClaim: occupied };
    });
  }
  async listClaims(principal: OrganizerPrincipal,organizationId: string): Promise<OrganizerClaimRequest[]> {
    return this.authenticated(principal,async sql=>{await this.organizationAdmin(sql,principal.actor,organizationId);return this.repository.listClaims(sql,organizationId);});
  }
  /** 认领申请：必须先证明是本机构管理员；目标发现须仍可认领。 */
  async createClaim(principal: OrganizerPrincipal,organizationId: string,input: unknown): Promise<OrganizerClaimRequest> {
    const body=v.claim(input);
    return this.authenticated(principal,async sql=>{
      await this.organizationAdmin(sql,principal.actor,organizationId);
      const candidate=await this.discovery().getClaimable(sql,body.discoveryId);
      if(!candidate) missing();
      const occupied=await this.repository.activeClaimFor(sql,body.discoveryId);
      if(occupied) throw new DomainError("ORGANIZER_CLAIM_TAKEN","这场赛事线索已被认领或正在审核，请选择其他线索或联系我们核对归属。",{status:409});
      const current=this.now();
      const claim: OrganizerClaimRequest={ id:this.ids.next(),organizationId,discoveryId:body.discoveryId,sourceHost:candidate.sourceHost,requestedBy:principal.actor.userId,
        verification:body.verification,evidenceText:body.evidenceText,evidenceUrls:[...body.evidenceUrls],status:"pending",hostedEventId:null,
        reviewedBy:null,reviewedAt:null,reviewNote:null,revision:1,createdAt:current,updatedAt:current };
      await this.repository.insertClaim(sql,claim);
      await this.audit(sql,principal,organizationId,"claim_requested",claim.id,claim.revision);
      return claim;
    });
  }
  async withdrawClaim(principal: OrganizerPrincipal,claimId: string,input: unknown): Promise<OrganizerClaimRequest> {
    return this.authenticated(principal,async sql=>{
      const claim=await this.repository.getClaim(sql,v.text(claimId,"认领申请",200),true) ?? missing();
      await this.organizationAdmin(sql,principal.actor,claim.organizationId);
      const body=v.object(input);v.keys(body,["expectedRevision"]);expectRevision(claim.revision,body.expectedRevision);
      if(claim.status !== "pending") throw new DomainError("ORGANIZER_CLAIM_STATE","只有待审核的认领可以撤回。",{status:409});
      const next: OrganizerClaimRequest={...claim,status:"withdrawn",revision:claim.revision+1,updatedAt:this.now()};
      await this.repository.saveClaim(sql,next);await this.audit(sql,principal,claim.organizationId,"claim_withdrawn",claim.id,next.revision);return next;
    });
  }
  async listClaimsForReview(principal: OrganizerPrincipal): Promise<OrganizerClaimRequest[]> {
    return this.authenticated(principal,async sql=>{this.requirePlatformAdmin(principal);return this.repository.listClaims(sql,undefined,"pending");});
  }
  /**
   * 把已批准的认领挂接到本机构的一场赛事。
   * 认领只建立归属关系；预填值由主办方在赛事配置与补充资料里自行确认。
   */
  async linkClaimToEvent(principal: OrganizerPrincipal,claimId: string,input: unknown): Promise<OrganizerClaimRequest> {
    const body=v.object(input);v.keys(body,["eventId","expectedRevision"]);
    const eventId=v.text(body.eventId,"比赛",200), expected=v.revision(body.expectedRevision);
    return this.authenticated(principal,async sql=>{
      const claim=await this.repository.getClaim(sql,v.text(claimId,"认领申请",200),true) ?? missing();
      await this.requireStaff(sql,principal.actor,eventId,"event_manage");
      const {event}=await this.lockedEvent(sql,eventId);
      expectRevision(claim.revision,expected);
      if(claim.status !== "approved") throw new DomainError("ORGANIZER_CLAIM_STATE","只有已通过的认领可以挂接到比赛。",{status:409});
      if(event.organizationId !== claim.organizationId) denied();
      if(claim.hostedEventId && claim.hostedEventId !== event.eventId) throw new DomainError("ORGANIZER_CLAIM_ALREADY_LINKED","这条认领已经挂接到另一场比赛。",{status:409});
      const next: OrganizerClaimRequest={...claim,hostedEventId:event.eventId,revision:claim.revision+1,updatedAt:this.now()};
      await this.repository.saveClaim(sql,next);
      await this.audit(sql,principal,claim.organizationId,"claim_linked",claim.id,next.revision,event.eventId);
      return next;
    });
  }
  /** 平台管理员批准/驳回。归属核实由人依据材料判断；候选匹配本身不构成归属。 */
  async reviewClaim(principal: OrganizerPrincipal,claimId: string,input: unknown): Promise<OrganizerClaimRequest> {
    const body=v.object(input);v.keys(body,["decision","note","expectedRevision"]);
    if(typeof body.decision !== "string" || !["approved","rejected"].includes(body.decision)) return v.invalid("请选择通过或驳回。");
    const note=v.text(body.note ?? "","审核说明",2000,false), expected=v.revision(body.expectedRevision);
    return this.authenticated(principal,async sql=>{
      this.requirePlatformAdmin(principal);
      const claim=await this.repository.getClaim(sql,v.text(claimId,"认领申请",200),true) ?? missing();
      expectRevision(claim.revision,expected);
      if(claim.status !== "pending") throw new DomainError("ORGANIZER_CLAIM_STATE","这条认领申请已经处理过。",{status:409});
      if(body.decision === "approved") {
        if(!note) return v.invalid("通过认领需要写明核实了哪份材料。");
        if(!(await this.discovery().getClaimable(sql,claim.discoveryId))) throw new DomainError("ORGANIZER_CLAIM_SOURCE_UNAVAILABLE","这条赛事线索已不可用，无法批准认领。",{status:409});
      }
      const next: OrganizerClaimRequest={...claim,status:body.decision as "approved" | "rejected",reviewedBy:principal.actor.userId,reviewedAt:this.now(),reviewNote:note || null,revision:claim.revision+1,updatedAt:this.now()};
      await this.repository.saveClaim(sql,next);
      await this.audit(sql,principal,claim.organizationId,`claim_${next.status}`,claim.id,next.revision);
      return next;
    });
  }

  // ---- 待补字段引导（规划25 / P03）----
  /** 时间类字段来自 HostedEvent；其余来自赛事补充资料。清单是派生视图，不落完成状态。 */
  private static readinessPriority(field: ReadinessField): 1 | 2 | 3 {
    if (field === "registrationClosesAt") return 1;
    if (["registrationOpensAt","startsAt","endsAt","timezone","tracks"].includes(field)) return 2;
    return 3;
  }
  private readinessOrganizerValue(event: HostedEvent, profile: EventProfile | null, field: ReadinessField): string | null {
    if (["registrationOpensAt","registrationClosesAt","startsAt","endsAt","timezone"].includes(field)) {
      const value = event[field as "registrationOpensAt" | "registrationClosesAt" | "startsAt" | "endsAt" | "timezone"];
      return typeof value === "string" && value.trim() ? value : null;
    }
    const stored = profile?.values?.[field];
    return typeof stored === "string" && stored.trim() ? stored : null;
  }
  async listEventReadiness(principal: OrganizerPrincipal,eventId: string): Promise<EventReadinessItem[]> {
    return this.authenticated(principal,async sql=>{
      await this.requireStaff(sql,principal.actor,eventId,"event_manage");
      const {event}=await this.lockedEvent(sql,eventId);
      const profile=await this.repository.getEventProfile(sql,eventId);
      const claim=await this.repository.claimForEvent(sql,eventId);
      const evidence=claim && this.readinessPort ? await this.readinessPort.read(sql,{ discoveryId: claim.discoveryId }) : null;
      return READINESS_FIELDS.map(field => {
        const organizer=this.readinessOrganizerValue(event,profile,field);
        const fromSource=evidence?.fields?.[field] ?? [];
        // 冲突必须显式暴露：两侧都有值且不同，由人决定，不自动取任一侧。
        const state: ReadinessState = organizer && fromSource.length ? "conflicting" : organizer ? "known_from_organizer" : fromSource.length ? "known_from_source" : "missing";
        return { field, state, organizerValue: organizer, revision: profile?.revision ?? 0, sourceEvidence: [...fromSource].slice(0,3),
          sourceUrl: evidence?.sourceUrl ?? null, checkedAt: evidence?.checkedAt ?? null, priority: OrganizerService.readinessPriority(field) };
      }).sort((left,right) => left.priority - right.priority || READINESS_FIELDS.indexOf(left.field) - READINESS_FIELDS.indexOf(right.field));
    });
  }
  /** 补全写入赛事补充资料（时间类字段仍走 HostedEvent 配置）。清空用 value=null。 */
  async updateEventReadiness(principal: OrganizerPrincipal,eventId: string,input: unknown): Promise<EventProfile> {
    const body=v.readinessUpdate(input);
    if (["registrationOpensAt","registrationClosesAt","startsAt","endsAt","timezone"].includes(body.field))
      throw new DomainError("ORGANIZER_READINESS_CONFIGURED_FIELD","这个时间项在比赛配置里修改，以免出现两份时间。请回到比赛配置保存并重新发布。",{status:409});
    return this.authenticated(principal,async sql=>{
      await this.requireStaff(sql,principal.actor,eventId,"event_manage");
      const {event}=await this.lockedEvent(sql,eventId);
      const current=await this.repository.getEventProfile(sql,eventId,true);
      // 补充资料以 0 表示"尚无记录"，因此不用要求 ≥1 的 expectRevision 辅助函数。
      const actualRevision=current?.revision ?? 0;
      if (actualRevision !== body.expectedRevision) throw new DomainError("ORGANIZER_REVISION_CONFLICT","内容已被其他工作人员更新，输入已保留。",{status:409,latestRevision:actualRevision,recoveryAction:"重新读取最新内容，核对后再保存。"});
      const values={...(current?.values ?? {})};
      if (body.value === null) delete values[body.field]; else values[body.field]=body.value;
      const next: EventProfile={ eventId,organizationId:event.organizationId,revision:(current?.revision ?? 0)+1,
        values,updatedBy:principal.actor.userId,updatedAt:this.now() };
      if (current) await this.repository.saveEventProfile(sql,next); else await this.repository.insertEventProfile(sql,next);
      await this.audit(sql,principal,event.organizationId,body.value === null ? "event_readiness_cleared" : "event_readiness_filled",eventId,next.revision,eventId);
      return next;
    });
  }
  async getEventProfile(principal: OrganizerPrincipal,eventId: string): Promise<EventProfile | null> {
    return this.authenticated(principal,async sql=>{await this.requireStaff(sql,principal.actor,eventId,"event_manage");return this.repository.getEventProfile(sql,eventId);});
  }

  // ---- P4 赛事级模块助手开关（规划34 §2.1 / §5.1；宪法 XIII）----
  /** 只按根传入的 key 顺序装配本场开关集；表里没有行的键默认全开，不补写占位行。 */
  private async assistantSwitches(sql: SqlExecutor, eventId: string): Promise<EventAssistantSwitchesView> {
    const rows=await this.repository.listAssistantSwitches(sql,eventId),byKey=new Map(rows.map(row=>[row.assistantKey,row]));
    return { eventId, switches:this.assistantKeys.map(assistantKey=>{
      const row=byKey.get(assistantKey);
      // 没有行 = 从未关过 = 默认全开（规划34 §5.1）；revision 0 与首次设置的 expectedRevision 0 一致。
      return { assistantKey, enabled:row?.enabled ?? true, revision:row?.revision ?? 0 };
    }) };
  }
  /**
   * 本场模块助手开关（只读）。权限与既有赛事配置完全一致：`event_manage`
   * （机构管理员，或本场有该能力的当前工作人员）；跨赛事一律 403。
   * 未注入 `assistantKeys` 时返回空开关集（不是 7 个硬编码 key）。
   */
  async listEventAssistantSwitches(principal: OrganizerPrincipal, eventId: string): Promise<EventAssistantSwitchesView> {
    const id=v.text(eventId,"比赛标识",200);
    return this.authenticated(principal,async sql=>{await this.requireStaff(sql,principal.actor,id,"event_manage");return this.assistantSwitches(sql,id);});
  }
  /**
   * 写入单个模块助手开关（**内部运营项**）。
   *
   * - 只改这一张赛事级开关表：**不推进赛事 revision、不改发布快照、不进 changedFields / 历史**，
   *   因此不随正式发布版本冻结（宪法 XIII / 规划34 §5.1）。
   * - 同一事务里写一条既有 `organizer_audit_events`（action `assistant_switch_changed`；
   *   只记 key 与 enabled，**不记任何 prompt、指令或助手输出内容**）。
   * - `assistantKey` 必须在根传入的列表里（否则 422）；未接入列表时 503。
   * - 首次设置 `expectedRevision` 传 0；已存在时必须与当前 revision 一致（否则 409）。
   */
  async setEventAssistantSwitch(principal: OrganizerPrincipal, eventId: string, input: unknown): Promise<EventAssistantSwitchesView> {
    const id=v.text(eventId,"比赛标识",200);
    return this.authenticated(principal,async sql=>{
      const eventScope=await this.requireStaff(sql,principal.actor,id,"event_manage");
      if(!this.assistantKeys.length) throw new DomainError("ORGANIZER_ASSISTANT_SWITCH_UNAVAILABLE","模块助手开关当前未接入助手注册表，请联系平台管理员。",{status:503});
      const fields=v.assistantSwitch(input);
      if(!this.assistantKeys.includes(fields.assistantKey)) return v.invalid("请选择本场支持的模块助手。");
      const current=await this.repository.getAssistantSwitch(sql,id,fields.assistantKey,true);
      const actualRevision=current?.revision ?? 0;
      if(actualRevision !== fields.expectedRevision) throw new DomainError("ORGANIZER_REVISION_CONFLICT","内容已被其他工作人员更新，输入已保留。",{status:409,latestRevision:actualRevision,recoveryAction:"重新读取最新内容，核对后再保存。"});
      const next: EventAssistantSwitch={ eventId:id, organizationId:eventScope.organizationId, assistantKey:fields.assistantKey, enabled:fields.enabled, revision:actualRevision+1, updatedByUserId:principal.actor.userId, updatedAt:this.now() };
      if(current) await this.repository.saveAssistantSwitch(sql,next); else await this.repository.insertAssistantSwitch(sql,next);
      // entity_id 只表达"哪个 key、开还是关"；审计表没有 payload 列，助手内容永远进不来。
      await this.audit(sql,principal,eventScope.organizationId,"assistant_switch_changed",`${fields.assistantKey}:${fields.enabled ? "enabled" : "disabled"}`,next.revision,id);
      return this.assistantSwitches(sql,id);
    });
  }
  /**
   * P07 数据看板下钻（只读组合）。
   *
   * 只按**当前权限**把既有读取取一次，交给纯函数 `buildDashboard` 做筛选与聚合；本方法自身
   * 不写任何事实、不新增查询、不触发采集/模型/通知。未注入 Port（或该事实未接入）时对应的
   * 指标返回 `undefined`（界面显示"未提供"），**绝不补 0**；无权限的面板直接不出现。
   */
  async dashboard(principal: OrganizerPrincipal, eventId: string, filter: DashboardFilter = {}): Promise<DashboardView> {
    return this.authenticated(principal,async sql=> {
      const { event,organization }=await this.lockedEvent(sql,eventId);
      if (organization.status !== "approved" || event.status === "archived") denied();
      const grants=await this.repository.listGrants(sql,organization.id,principal.actor.userId);
      if (!canView(grants,eventId)) denied();
      const capabilities=EVENT_STAFF_CAPABILITIES.filter(capability=>hasCapability(grants,eventId,capability));
      const permitted=DASHBOARD_PANELS.filter(panel=>DASHBOARD_PANEL_CAPABILITIES[panel].some(capability=>capabilities.includes(capability)));
      if (filter.panel && !permitted.includes(filter.panel)) denied();
      const can=(capability: EventStaffCapability)=>capabilities.includes(capability);
      const port=this.dashboardPort, unread: Partial<Record<DashboardFactKey,string>>={};
      const missing="未接入该事实的只读接口（见交付文档 NEEDS_INTERFACE）。";
      let registrationCounts: DashboardRegistrationCounts | undefined;
      let registrations: DashboardPage<DashboardRegistrationRow> | undefined;
      let teams: DashboardPage<DashboardTeamRow> | undefined;
      let judgingWorkspace: DashboardJudgingWorkspace | undefined;
      let judgingProgress: DashboardJudgingProgress | undefined;
      let accommodation: readonly DashboardAccommodationRow[] | undefined;
      let vouchers: readonly DashboardVoucherRow[] | undefined;
      let scheduleDraft: DashboardScheduleDraft | undefined;
      if (can("registration_manage")) {
        if (!port?.registrationCounts) unread.registrationCounts=missing; else registrationCounts=await port.registrationCounts(principal,eventId);
        if (!port?.registrations) unread.registrations=missing;
        else registrations=await port.registrations(principal,eventId,{ ...(filter.cursor ? { cursor:filter.cursor } : {}), limit:filter.limit ?? DEFAULT_DASHBOARD_LIMIT });
      }
      if (can("teams_manage")) {
        if (!port?.teams) unread.teams=missing;
        else teams=await port.teams(principal,eventId,{ limit:filter.limit ?? DEFAULT_DASHBOARD_LIMIT });
      }
      if (can("judging_manage")) {
        if (!port?.judgingWorkspace) { unread.judgingWorkspace=missing;unread.judgingProgress=missing; }
        else {
          judgingWorkspace=await port.judgingWorkspace(principal,eventId);
          const selected=filter.roundId ? judgingWorkspace.rounds.find(round=>round.id === filter.roundId) : judgingWorkspace.rounds[judgingWorkspace.rounds.length-1];
          if (!selected) unread.judgingProgress=filter.roundId ? "所选评审轮次不存在。" : "本场还没有评审轮次。";
          else if (!port.judgingProgress) unread.judgingProgress=missing;
          else judgingProgress=await port.judgingProgress(principal,eventId,selected.id);
        }
      }
      if (can("logistics_manage")) {
        if (!port?.accommodation) unread.accommodation=missing; else accommodation=await port.accommodation(principal,eventId);
        if (!port?.vouchers) unread.vouchers=missing; else vouchers=await port.vouchers(principal,eventId);
      }
      if (can("schedule_manage")) {
        if (!port?.scheduleDraft) unread.scheduleDraft=missing; else scheduleDraft=await port.scheduleDraft(principal,eventId);
      }
      return buildDashboard({
        eventId, eventTitle:event.title, scope:"本场", readAt:this.now(), modules:event.modules,
        ...(registrationCounts === undefined ? {} : { registrationCounts }),
        ...(registrations === undefined ? {} : { registrations }),
        ...(teams === undefined ? {} : { teams }),
        ...(judgingWorkspace === undefined ? {} : { judgingWorkspace }),
        ...(judgingProgress === undefined ? {} : { judgingProgress }),
        ...(accommodation === undefined ? {} : { accommodation }),
        ...(vouchers === undefined ? {} : { vouchers }),
        ...(scheduleDraft === undefined ? {} : { scheduleDraft }),
        unread,
      },filter,permitted);
    });
  }
}
export function createOrganizerService(options: OrganizerServiceOptions): OrganizerService {return new OrganizerService(options);}
export function createHostedEventAccessPort(service: OrganizerService): HostedEventAccessPort {return service.eventAccess;}
