import { createHash } from "node:crypto";
import type { Clock, IdGenerator } from "../../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { DomainError } from "../../shared/errors.ts";
import type { OrganizerPrincipal, HostedEventAccessPort, HostedEventScope, EventStaffCapability, EventParticipationPort, EventProjectLinkPort } from "../../shared/organizer-contracts.ts";
import { PostgresRegistrationRepository } from "./postgres.ts";
import type { RegistrationStore } from "./repository.ts";
import type { EventProjectLinkPreviewPort, EventTeamTrackPort } from "./ports.ts";
import type { Registration, RegistrationForm, MyRegistrationView, RegistrationFormView, SaveFormInput, SaveDraftInput, MutationInput, ReviewRegistrationInput, StaffRegistrationsView, RosterTeam, PublicRosterTeam, CreateTeamInput, JoinTeamInput, RespondJoinInput, LeaveTeamInput, TeamsView, JoinRequest, ProjectLinkRequest, RequestProjectLinkInput, ConfirmProjectLinkInput, MyCompetition, Page, ExportResult, TeamSuggestion, ProposeTeamInput, ReopenRosterInput, TeamCandidate } from "./model.ts";
import { identifier, revision, plainText, invalid, validateFields, validateAnswers, pageOptions, assertRevision, canonical, csvCell } from "./validation.ts";

export interface EventRegistrationDependencies {
  database: DatabasePort; events: HostedEventAccessPort; projectLinks: EventProjectLinkPort;
  clock: Clock; ids: IdGenerator;
  projectLinkPreview?: EventProjectLinkPreviewPort;
  tracks?: EventTeamTrackPort;
}
function notFound(): never { throw new DomainError("NOT_FOUND", "比赛或记录不存在，或当前无法查看。", { status: 404 }); }
function denied(message = "当前账号无法进行这项操作。"): never { throw new DomainError("EVENT_ACCESS_DENIED", message, { status: 403 }); }
function blocked(code: string, message: string): never { throw new DomainError(code, message, { status: 409 }); }

/** No ProjectMembership or private project content is created/read in this module. */
export class EventRegistrationService implements EventParticipationPort {
  private readonly deps: EventRegistrationDependencies;
  private readonly repository: PostgresRegistrationRepository;
  constructor(dependencies: EventRegistrationDependencies) {
    this.deps = dependencies; this.repository = new PostgresRegistrationRepository(dependencies.database);
  }
  private now() { return this.deps.clock.now().toISOString(); }
  private async scope(sql: SqlExecutor, eventId: string, writable: boolean, principal: OrganizerPrincipal | null, capability?: EventStaffCapability) {
    const event = await this.deps.events.getEvent(sql, eventId, { forUpdate: writable });
    if (!event || event.eventId !== eventId) notFound();
    if (capability) {
      const authorized = await this.deps.events.requireStaff(sql, principal!.actor, eventId, capability);
      if (authorized.eventId !== eventId || authorized.organizationId !== event.organizationId || authorized.revision !== event.revision) denied();
    } else if (event.status === "draft") notFound();
    if (writable && event.status === "archived") blocked("EVENT_READ_ONLY", "比赛已归档，保留历史资料，不能继续修改。");
    return event;
  }
  private async withEvent<T>(principal: OrganizerPrincipal | null, eventId: string, writable: boolean, capability: EventStaffCapability | undefined,
    work: (store: RegistrationStore, event: HostedEventScope) => Promise<T>): Promise<T> {
    identifier(eventId, "比赛标识");
    return this.deps.database.transaction(async sql => {
      if (principal) await principal.guard(sql);
      const event = await this.scope(sql, eventId, writable, principal, capability);
      const store = this.repository.store(sql);
      // Consistent order: current session -> O01 event -> O02 event -> rows.
      if (writable) await store.lockEvent(eventId, event.organizationId);
      const result = await work(store, event);
      if (principal) await principal.guard(sql);
      const after = await this.scope(sql, eventId, writable, principal, capability);
      if (event.organizationId !== after.organizationId || event.revision !== after.revision) blocked("EVENT_CHANGED", "比赛配置已更新，请核对当前比赛后重试。");
      return result;
    });
  }
  private async replay<T>(store: RegistrationStore, principal: OrganizerPrincipal, event: HostedEventScope, operation: string, input: { idempotencyKey: string }, work: () => Promise<T>, authorizeReplay?: () => Promise<void>): Promise<T> {
    identifier(input.idempotencyKey, "操作标识");
    const fingerprint = createHash("sha256").update(canonical(input)).digest("hex");
    const receipt = await store.getReceipt<T>(event.eventId, principal.actor.userId, operation, input.idempotencyKey, fingerprint);
    if (receipt !== null) { if (authorizeReplay) await authorizeReplay(); return receipt; }
    const result = await work();
    await store.putReceipt(event.eventId, principal.actor.userId, operation, input.idempotencyKey, fingerprint, result);
    return result;
  }
  private registrationEnabled(event: HostedEventScope, submit = false) {
    if (!event.modules.registration) blocked("REGISTRATION_DISABLED", "这场比赛暂未开放报名。已有报名记录仍可查看或撤回。");
    if (event.status !== "published") blocked("REGISTRATION_CLOSED", "这场比赛暂不接受新的报名，请查看已保存的报名记录。");
    const now = this.deps.clock.now().getTime();
    if (submit && event.registrationOpensAt && now < Date.parse(event.registrationOpensAt)) blocked("REGISTRATION_NOT_OPEN", "报名尚未开始，请在页面显示的开放时间再提交。");
    if (event.registrationClosesAt && now >= Date.parse(event.registrationClosesAt)) blocked("REGISTRATION_CLOSED", "报名时间已结束。草稿不代表已报名。");
  }
  private teamsEnabled(event: HostedEventScope, newMember = true) {
    if (!event.modules.teams || event.status !== "published") blocked("TEAMS_CLOSED", "这场比赛当前不接受建队或加入队伍，已有名单仍可查看。");
    if (newMember && event.teams.locksAt && this.deps.clock.now().getTime() >= Date.parse(event.teams.locksAt)) blocked("ROSTER_DEADLINE", "组队期限已到，不能再增加成员。请联系比赛工作人员。");
  }
  private async approved(store: RegistrationStore, eventId: string, userId: string): Promise<Registration> {
    const value = await store.getRegistration(eventId, userId);
    if (!value || value.status !== "approved") blocked("REGISTRATION_REQUIRED", "请先完成报名并通过审核，再加入正式队伍。");
    return value;
  }
  private async capacity(store: RegistrationStore, event: HostedEventScope) {
    if (event.registration.capacity !== null && await store.countReservations(event.eventId) >= event.registration.capacity) blocked("REGISTRATION_FULL", "报名名额已满。输入仍保留，可关注后续名额或联系主办方。");
  }
  private async trackConfiguration(sql: SqlExecutor, eventId: string) {
    const config = this.deps.tracks ? await this.deps.tracks.getConfiguration(sql, eventId) : { configured: false, required: false, revision: 0, options: [] };
    if (!Array.isArray(config.options) || config.options.length > 100 || !Number.isSafeInteger(config.revision) || config.revision < 0 || typeof config.required !== "boolean" || typeof config.configured !== "boolean") throw new Error("Invalid event track configuration port.");
    for (const option of config.options) { identifier(option.id); plainText(option.title, "官方赛道", 100, true); }
    if (new Set(config.options.map(option => option.id)).size !== config.options.length) throw new Error("Duplicate event track identities.");
    return config;
  }
  private async validateTrack(sql: SqlExecutor, eventId: string, track: string) {
    const config = await this.trackConfiguration(sql, eventId);
    if (!config.configured && track) blocked("TRACKS_NOT_CONFIGURED", "官方赛道尚未接入，请先不选赛道并查看比赛规则。");
    if (config.required && !track) invalid("请从这场比赛的官方赛道中选择一项。");
    if (track && !config.options.some(option => option.id === track)) invalid("所选赛道不属于这场比赛，请重新选择。");
  }
  private async formView(store: RegistrationStore, event: HostedEventScope): Promise<RegistrationFormView> {
    return { event, form: await store.getForm(event.eventId), reservedCount: await store.countReservations(event.eventId) };
  }
  async getRegistrationForm(eventId: string): Promise<RegistrationFormView> {
    return this.withEvent(null, eventId, false, undefined, (store, event) => this.formView(store, event));
  }
  async getStaffForm(principal: OrganizerPrincipal, eventId: string): Promise<RegistrationFormView> {
    return this.withEvent(principal, eventId, false, "registration_manage", (store, event) => this.formView(store, event));
  }
  /** Trusted root publication check after current event authorization; no HTTP route or state initialization. */
  async getConfiguredForm(sql: SqlExecutor, eventId: string): Promise<RegistrationForm | null> {
    identifier(eventId, "比赛标识");
    return this.repository.store(sql).getForm(eventId);
  }
  /**
   * 规划 33 P05：**在调用方的事务里**写入报名表，供根把它注入 `organizer` 的
   * `registrationForms.saveForm`，使"复制上一场"的
   * 建事件 → 存报名表 → 存评审配置 三步**同处一个事务**（任一步失败整体回滚）。
   *
   * 与 `saveForm` 的分工：`saveForm` 自己开事务并校验 `registration_manage`；
   * 本方法**只用传入的 `sql`**，不另开事务。权限由调用方（organizer 的
   * `duplicateEvent`，已校验来源与目标机构的 `event_manage`）在同一事务内先行核查。
   * 业务规则与 `saveForm` **完全同口径**：复用同一个校验与 `appendForm` 写路径，
   * 不新增第二套写逻辑。
   */
  async saveFormIn(sql: SqlExecutor, eventId: string, input: SaveFormInput, _principal?: OrganizerPrincipal): Promise<RegistrationForm> {
    // `_principal` 仅用于与 `OrganizerRegistrationFormPort.saveForm` 的形参对齐：
    // 权限由调用方（organizer 的 `duplicateEvent`，已在同一事务内校验来源与目标机构的
    // `event_manage`）先行核查，因此这里**不重复鉴权**，也不使用该参数。
    identifier(eventId, "比赛标识");
    const store = this.repository.store(sql);
    return this.writeForm(store, eventId, input);
  }
  private async writeForm(store: RegistrationStore, eventId: string, input: SaveFormInput): Promise<RegistrationForm> {
    revision(input.expectedRevision, true);
    const fields = validateFields(input.fields), title = plainText(input.title, "报名表标题", 100, true), description = plainText(input.description, "报名说明", 2000), changeNote = plainText(input.changeNote, "变更说明", 1000);
    const current = await store.getForm(eventId); assertRevision(current?.revision ?? 0, input.expectedRevision);
    if (current && !changeNote) invalid("修改已发布报名表时，请说明变化及对选手的影响。");
    const form: RegistrationForm = { eventId, revision: (current?.revision ?? 0) + 1, title, description, fields, changeNote, publishedAt: this.now() };
    await store.appendForm(form); return form;
  }
  async saveForm(principal: OrganizerPrincipal, eventId: string, input: SaveFormInput): Promise<RegistrationForm> {
    return this.withEvent(principal, eventId, true, "registration_manage", (store, event) => this.writeForm(store, event.eventId, input));
  }
  async getMine(principal: OrganizerPrincipal, eventId: string): Promise<MyRegistrationView> {
    return this.withEvent(principal, eventId, false, undefined, async (store, event) => ({ ...await this.formView(store, event), registration: await store.getRegistration(eventId, principal.actor.userId) }));
  }
  async saveDraft(principal: OrganizerPrincipal, eventId: string, input: SaveDraftInput): Promise<Registration> {
    revision(input.expectedRevision, true); revision(input.formRevision);
    return this.withEvent(principal, eventId, true, undefined, async (store, event) => {
      this.registrationEnabled(event);
      const form = await store.getForm(eventId); if (!form) blocked("FORM_NOT_READY", "主办方尚未发布报名表，请稍后再来。");
      assertRevision(form.revision, input.formRevision);
      const current = await store.getRegistration(eventId, principal.actor.userId); assertRevision(current?.revision ?? 0, input.expectedRevision);
      if (current && ["pending", "approved"].includes(current.status)) blocked("REGISTRATION_ALREADY_SUBMITTED", "报名已提交，不能直接改写原答卷。如需更正，请先撤回再重新填写。");
      const now = this.now();
      const next: Registration = { id: current?.id ?? this.deps.ids.next(), eventId, organizationId: event.organizationId, userId: principal.actor.userId,
        status: "draft", revision: (current?.revision ?? 0) + 1, formRevision: form.revision, schema: form, answers: validateAnswers(form, input.answers, false),
        reviewNote: "", submittedAt: null, reviewedAt: null, createdAt: current?.createdAt ?? now, updatedAt: now };
      await store.saveRegistration(next, current?.revision ?? 0, principal.actor.userId); return next;
    });
  }
  async submit(principal: OrganizerPrincipal, eventId: string, input: MutationInput): Promise<Registration> {
    revision(input.expectedRevision);
    return this.withEvent(principal, eventId, true, undefined, (store, event) => this.replay(store, principal, event, "registration.submit", input, async () => {
      this.registrationEnabled(event, true);
      const current = await store.getRegistration(eventId, principal.actor.userId); if (!current) blocked("DRAFT_REQUIRED", "请先保存报名表，再确认提交。");
      assertRevision(current.revision, input.expectedRevision);
      if (current.status !== "draft") blocked("REGISTRATION_ALREADY_SUBMITTED", "这份报名已经处理，请查看当前状态。");
      const form = await store.getForm(eventId); if (!form || form.revision !== current.formRevision) blocked("FORM_CHANGED", "主办方已更新报名表，请核对最新字段并重新保存草稿。");
      const answers = validateAnswers(current.schema, current.answers, true); await this.capacity(store, event);
      const now = this.now();
      const next: Registration = { ...current, answers, status: event.registration.reviewRequired ? "pending" : "approved", revision: current.revision + 1, submittedAt: now, updatedAt: now, reviewedAt: event.registration.reviewRequired ? null : now };
      await store.saveRegistration(next, current.revision, principal.actor.userId); return next;
    }));
  }
  private async invalidateRoster(store: RegistrationStore, event: HostedEventScope, userId: string, actorUserId: string) {
    const teamId = await store.activeTeamId(event.eventId, userId); if (!teamId) return;
    const team = await this.team(store, event, teamId);
    await store.saveTeam({ ...team, revision: team.revision + 1, eligible: false, updatedAt: this.now() }, team.revision, actorUserId);
    // A pending project-link preview must be recreated after roster facts change.
  }
  async withdraw(principal: OrganizerPrincipal, eventId: string, input: MutationInput): Promise<Registration> {
    revision(input.expectedRevision);
    return this.withEvent(principal, eventId, true, undefined, (store, event) => this.replay(store, principal, event, "registration.withdraw", input, async () => {
      const current = await store.getRegistration(eventId, principal.actor.userId); if (!current) notFound(); assertRevision(current.revision, input.expectedRevision);
      if (current.status === "withdrawn") return current;
      const next: Registration = { ...current, status: "withdrawn", revision: current.revision + 1, updatedAt: this.now() };
      await store.saveRegistration(next, current.revision, principal.actor.userId);
      await this.invalidateRoster(store, event, current.userId, principal.actor.userId); return next;
    }));
  }
  async review(principal: OrganizerPrincipal, eventId: string, registrationId: string, input: ReviewRegistrationInput): Promise<Registration> {
    identifier(registrationId); revision(input.expectedRevision);
    if (!["approved", "rejected"].includes(input.decision)) invalid("请选择通过或拒绝。");
    const note = plainText(input.note, "审核说明", 2000, input.decision === "rejected");
    return this.withEvent(principal, eventId, true, "registration_manage", (store, event) => this.replay(store, principal, event, `registration.review:${registrationId}`, input, async () => {
      const current = await store.getRegistrationById(eventId, registrationId); if (!current) notFound(); assertRevision(current.revision, input.expectedRevision);
      if (!(["pending", "approved"] as string[]).includes(current.status)) blocked("REGISTRATION_NOT_REVIEWABLE", "只有已提交的报名可审核，请查看当前状态。");
      // Pending already reserves its slot; approval cannot consume another slot.
      const next: Registration = { ...current, status: input.decision, reviewNote: note, reviewedAt: this.now(), revision: current.revision + 1, updatedAt: this.now() };
      await store.saveRegistration(next, current.revision, principal.actor.userId);
      if (input.decision === "rejected") await this.invalidateRoster(store, event, current.userId, principal.actor.userId);
      return next;
    }, async () => {
      const current = await store.getRegistrationById(eventId, registrationId);
      if (!current || current.status === "draft" || current.submittedAt === null) blocked("REGISTRATION_NOT_REVIEWABLE", "报名已变为私人草稿或当前不可查看，请读取当前已提交名单。");
    }));
  }
  async listStaff(principal: OrganizerPrincipal, eventId: string, options: { status?: string; cursor?: string; limit?: number } = {}): Promise<StaffRegistrationsView> {
    const paging = pageOptions(options);
    if (options.status && !["pending", "approved", "rejected", "withdrawn"].includes(options.status)) invalid("只能查看已提交的报名；私人草稿仅本人可见。");
    return this.withEvent(principal, eventId, false, "registration_manage", async (store, event) => ({ event, registrations: await store.listRegistrations(eventId, paging), reservedCount: await store.countReservations(eventId) }));
  }
  /** 报名状态精确计数：只读派生，用于工作台徽标；不含只有本人可见的草稿。 */
  async registrationCounts(principal: OrganizerPrincipal, eventId: string): Promise<{ counts: Record<Registration["status"], number>; pending: number; reserved: number }> {
    return this.withEvent(principal, eventId, false, "registration_manage", async (store, event) => {
      const counts = await store.countRegistrations(event.eventId);
      return { counts, pending: counts.pending, reserved: await store.countReservations(event.eventId) };
    });
  }
  async exportRegistrations(principal: OrganizerPrincipal, eventId: string): Promise<ExportResult> {
    return this.withEvent(principal, eventId, false, "registration_manage", async store => {
      const rows: Registration[] = []; let cursor: string | undefined;
      do {
        const page = await store.listRegistrations(eventId, { limit: 100, ...(cursor ? { cursor } : {}) }); rows.push(...page.items); cursor = page.nextCursor ?? undefined;
        if (rows.length > 5000 || (rows.length === 5000 && cursor)) blocked("EXPORT_LIMIT", "当前报名超过一次导出上限，请由主会话接入分批导出后再试。");
      } while (cursor);
      const csv = "\uFEFF" + [["报名编号", "账号编号", "状态", "答卷版本", "提交时间", "审核说明", "答卷（字段原版本）"].map(csvCell).join(","), ...rows.map(row => [row.id, row.userId, row.status, row.formRevision, row.submittedAt ?? "", row.reviewNote, row.answers].map(csvCell).join(","))].join("\r\n");
      return { filename: `registrations-${eventId.replace(/[^a-zA-Z0-9_-]/g, "_")}.csv`, contentType: "text/csv; charset=utf-8", csv, count: rows.length };
    });
  }
  private async team(store: RegistrationStore, event: HostedEventScope, teamId: string): Promise<RosterTeam> {
    const value = await store.getTeam(event.eventId, teamId); if (!value || value.organizationId !== event.organizationId) notFound();
    const memberUserIds = await store.memberIds(event.eventId, teamId);
    let eligible = value.status !== "withdrawn" && memberUserIds.length >= event.teams.minSize && memberUserIds.length <= event.teams.maxSize;
    for (const userId of memberUserIds) {
      const registration = await store.getRegistration(event.eventId, userId);
      if (registration?.status !== "approved") eligible = false;
      if (value.status === "locked" && !value.lockedRoster?.some(member => member.userId === userId && member.registrationId === registration?.id && member.registrationRevision === registration?.revision)) eligible = false;
    }
    if (value.status === "locked" && value.lockedRoster?.length !== memberUserIds.length) eligible = false;
    const config = await this.trackConfiguration(store.sql, event.eventId);
    if ((value.track && (!config.configured || !config.options.some(option => option.id === value.track))) || (config.required && !value.track)) eligible = false;
    return { ...value, memberUserIds, eligible };
  }
  private publicTeam(value: RosterTeam, event: HostedEventScope): PublicRosterTeam {
    return { id: value.id, eventId: value.eventId, name: value.name, introduction: value.introduction, track: value.track,
      revision: value.revision, memberCount: value.memberUserIds.length, availableSeats: value.status === "forming" ? Math.max(0, event.teams.maxSize - value.memberUserIds.length) : 0, status: value.status === "locked" ? "locked" : "forming" };
  }
  private captain(principal: OrganizerPrincipal, value: RosterTeam) {
    if (value.captainUserId !== principal.actor.userId || !value.memberUserIds.includes(principal.actor.userId)) denied("只有当前队长可以处理加入请求或确认队伍名单。");
  }
  async listTeams(principal: OrganizerPrincipal, eventId: string, options: { cursor?: string; limit?: number } = {}): Promise<TeamsView> {
    const paging = pageOptions({ cursor: options.cursor, limit: options.limit });
    return this.withEvent(principal, eventId, false, undefined, async (store, event) => {
      const page = await store.listTeams(eventId, paging), items: PublicRosterTeam[] = [];
      for (const item of page.items) items.push(this.publicTeam(await this.team(store, event, item.id), event));
      const ownTeamId = await store.activeTeamId(eventId, principal.actor.userId), ownTeam = ownTeamId ? await this.team(store, event, ownTeamId) : null;
      return { event, teams: { items, nextCursor: page.nextCursor }, ownTeam, ownRequests: await store.ownRequests(eventId, principal.actor.userId),
        incomingRequests: ownTeam?.captainUserId === principal.actor.userId ? await store.pendingRequests(eventId, ownTeam.id) : [], registrationStatus: (await store.getRegistration(eventId, principal.actor.userId))?.status ?? null,
        suggestions: await store.listSuggestions(eventId, principal.actor.userId), trackConfig: await this.trackConfiguration(store.sql, eventId) };
    });
  }
  /**
   * 规划34 D1：本场**报名已通过**的账号标识（只读）。
   * 复用既有 `store.listRegistrations({status:'approved'})` 与调用方传入的同一 executor；不新写查询、不新口径。
   * 分页取完或到达上限（500）后返回，顺序稳定（报名分页的既有顺序）。
   */
  async approvedParticipantIds(sql: SqlExecutor, eventId: string): Promise<readonly string[]> {
    identifier(eventId, "比赛标识");
    const event = await this.deps.events.getEvent(sql, eventId);
    if (!event || event.eventId !== eventId) return [];
    const store = this.repository.store(sql), output: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.listRegistrations(eventId, { status: "approved", limit: 100, ...(cursor ? { cursor } : {}) });
      for (const row of page.items) output.push(row.userId);
      cursor = page.nextCursor ?? undefined;
    } while (cursor && output.length < 500);
    return [...new Set(output)].slice(0, 500);
  }
  /** 规划34 D1：本场公开队伍的最小只读投影（同一 executor；只给标识、名称与方向，不含成员账号）。 */
  async publicTeamsIn(sql: SqlExecutor, eventId: string): Promise<readonly { readonly id: string; readonly name: string; readonly track: string }[]> {
    identifier(eventId, "比赛标识");
    const event = await this.deps.events.getEvent(sql, eventId);
    if (!event || event.eventId !== eventId) return [];
    const store = this.repository.store(sql), page = await store.listTeams(eventId, { limit: 100 }), output: { id: string; name: string; track: string }[] = [];
    for (const item of page.items) { const team = await this.team(store, event, item.id); if (team.status !== "withdrawn") output.push({ id: team.id, name: team.name, track: team.track }); }
    return output;
  }
  async listPublicTeams(eventId: string, options: { cursor?: string; limit?: number } = {}): Promise<{ event: HostedEventScope; teams: Page<PublicRosterTeam> }> {
    const paging = pageOptions({ cursor: options.cursor, limit: options.limit });
    return this.withEvent(null, eventId, false, undefined, async (store, event) => {
      const page = await store.listTeams(eventId, paging), items: PublicRosterTeam[] = [];
      for (const item of page.items) items.push(this.publicTeam(await this.team(store, event, item.id), event));
      return { event, teams: { items, nextCursor: page.nextCursor } };
    });
  }
  async listStaffTeams(principal: OrganizerPrincipal, eventId: string, options: { cursor?: string; limit?: number } = {}): Promise<{ event: HostedEventScope; teams: Page<RosterTeam> }> {
    const paging = pageOptions({ cursor: options.cursor, limit: options.limit });
    return this.withEvent(principal, eventId, false, "teams_manage", async (store, event) => {
      const page = await store.listTeams(eventId, paging), items: RosterTeam[] = [];
      for (const item of page.items) items.push(await this.team(store, event, item.id));
      return { event, teams: { items, nextCursor: page.nextCursor } };
    });
  }
  async getStaffCandidates(principal: OrganizerPrincipal, eventId: string, options: { cursor?: string; limit?: number } = {}): Promise<{ event: HostedEventScope; candidates: Page<TeamCandidate> }> {
    const paging = pageOptions({ cursor: options.cursor, limit: options.limit });
    return this.withEvent(principal, eventId, false, "teams_manage", async (store, event) => {
      const page = await store.listRegistrations(eventId, { ...paging, status: "approved" });
      return { event, candidates: { items: page.items.map(registration => ({ userId: registration.userId, registrationId: registration.id, revision: registration.revision })), nextCursor: page.nextCursor } };
    });
  }
  async createTeam(principal: OrganizerPrincipal, eventId: string, input: CreateTeamInput): Promise<RosterTeam> {
    const name = plainText(input.name, "队伍名称", 100, true), introduction = plainText(input.introduction, "招募说明", 2000), track = plainText(input.track, "参赛方向", 100);
    if (input.suggestionId !== undefined) identifier(input.suggestionId);
    return this.withEvent(principal, eventId, true, undefined, (store, event) => this.replay(store, principal, event, "team.create", input, async () => {
      this.teamsEnabled(event);
      const suggestion = input.suggestionId ? await store.getSuggestion(eventId, input.suggestionId) : null;
      if (input.suggestionId && (!suggestion || suggestion.captainUserId !== principal.actor.userId || suggestion.teamId)) blocked("TEAM_SUGGESTION_UNAVAILABLE", "分组建议已失效或不是为你发起，请联系主办方。");
      if (event.teams.mode === "assigned" && !suggestion) blocked("TEAMS_ASSIGNED", "这场比赛由工作人员建议分组。请联系主办方安排，再由本人确认加入。");
      await this.approved(store, eventId, principal.actor.userId);
      await this.validateTrack(store.sql, eventId, track);
      if (await store.activeTeamId(eventId, principal.actor.userId)) blocked("ALREADY_IN_TEAM", "你已在这场比赛的一个队伍中，请先退出原队伍再加入。");
      const now = this.now();
      const team: RosterTeam = { id: this.deps.ids.next(), eventId, organizationId: event.organizationId, name, introduction, track, captainUserId: principal.actor.userId, memberUserIds: [principal.actor.userId],
        revision: 1, status: "forming", projectId: null, eligible: event.teams.minSize <= 1, lockedRoster: null, lockedAt: null, createdAt: now, updatedAt: now };
      await store.saveTeam(team, 0, principal.actor.userId); await store.acceptMember(eventId, team.id, principal.actor.userId, now);
      if (suggestion) await store.saveSuggestion({ ...suggestion, teamId: team.id });
      return team;
    }));
  }
  async proposeTeam(principal: OrganizerPrincipal, eventId: string, input: ProposeTeamInput): Promise<TeamSuggestion> {
    identifier(input.captainUserId); if (!Array.isArray(input.memberUserIds) || input.memberUserIds.length > 100) invalid("请提供有效的分组建议名单。");
    for (const id of input.memberUserIds) identifier(id);
    const memberUserIds = [...new Set([input.captainUserId, ...input.memberUserIds])], name = plainText(input.name, "建议队伍名称", 100, true), track = plainText(input.track, "参赛方向", 100), note = plainText(input.note, "分组建议说明", 1000, true);
    return this.withEvent(principal, eventId, true, "teams_manage", (store, event) => this.replay(store, principal, event, "team.propose", input, async () => {
      this.teamsEnabled(event);
      await this.validateTrack(store.sql, eventId, track);
      if (memberUserIds.length < event.teams.minSize || memberUserIds.length > event.teams.maxSize) invalid("建议人数不符合这场比赛的队伍人数要求。");
      for (const userId of memberUserIds) { await this.approved(store, eventId, userId); if (await store.activeTeamId(eventId, userId)) blocked("ALREADY_IN_TEAM", "建议名单中已有选手在正式队伍，请先核对本人意愿。"); }
      const suggestion: TeamSuggestion = { id: this.deps.ids.next(), eventId, captainUserId: input.captainUserId, memberUserIds, name, track, note, createdByUserId: principal.actor.userId, createdAt: this.now(), teamId: null };
      await store.saveSuggestion(suggestion); return suggestion;
    }));
  }
  async listTeamSuggestions(principal: OrganizerPrincipal, eventId: string): Promise<TeamSuggestion[]> {
    return this.withEvent(principal, eventId, false, "teams_manage", store => store.listSuggestions(eventId));
  }
  async requestJoin(principal: OrganizerPrincipal, eventId: string, teamId: string, input: JoinTeamInput): Promise<JoinRequest> {
    identifier(teamId); revision(input.expectedTeamRevision); const message = plainText(input.message, "加入说明", 1000);
    return this.withEvent(principal, eventId, true, undefined, (store, event) => this.replay(store, principal, event, `team.join:${teamId}`, input, async () => {
      this.teamsEnabled(event); await this.approved(store, eventId, principal.actor.userId);
      const team = await this.team(store, event, teamId); assertRevision(team.revision, input.expectedTeamRevision);
      await this.validateTrack(store.sql, eventId, team.track);
      if (event.teams.mode === "assigned" && !await store.isSuggestedForTeam(eventId, teamId, principal.actor.userId)) blocked("TEAM_SUGGESTION_REQUIRED", "这场比赛按工作人员建议组队。请从你的分组建议中选择队伍并确认加入。");
      if (team.status !== "forming") blocked("TEAM_LOCKED", "这支队伍已锁定名单或退出，请选择其他队伍。");
      if (await store.activeTeamId(eventId, principal.actor.userId)) blocked("ALREADY_IN_TEAM", "你已在这场比赛的一个队伍中，不能同时占用另一队名额。");
      if (team.memberUserIds.length >= event.teams.maxSize) blocked("TEAM_FULL", "这支队伍已满，请选择其他队伍。");
      const previous = await store.getUserJoin(eventId, teamId, principal.actor.userId);
      if (previous?.status === "pending") return previous;
      if ((await store.ownRequests(eventId, principal.actor.userId)).filter(request => request.status === "pending").length >= 20) blocked("JOIN_REQUEST_LIMIT", "你已有20条待回复的加入请求，请先取消不再需要的请求。");
      const now = this.now();
      const value: JoinRequest = { id: previous?.id ?? this.deps.ids.next(), eventId, teamId, userId: principal.actor.userId, message, status: "pending", revision: (previous?.revision ?? 0) + 1, note: "", createdAt: previous?.createdAt ?? now, updatedAt: now };
      await store.saveJoin(value, previous?.revision ?? 0, principal.actor.userId); return value;
    }));
  }
  async respondJoin(principal: OrganizerPrincipal, eventId: string, teamId: string, requestId: string, input: RespondJoinInput): Promise<JoinRequest> {
    identifier(teamId); identifier(requestId); revision(input.expectedRevision); revision(input.expectedTeamRevision);
    if (!["accepted", "rejected"].includes(input.decision)) invalid("请选择接受或拒绝。");
    const note = plainText(input.note, "回复说明", 1000, input.decision === "rejected");
    return this.withEvent(principal, eventId, true, undefined, (store, event) => this.replay(store, principal, event, `team.respond:${teamId}:${requestId}`, input, async () => {
      this.teamsEnabled(event, input.decision === "accepted");
      const team = await this.team(store, event, teamId); this.captain(principal, team); assertRevision(team.revision, input.expectedTeamRevision);
      const request = await store.getJoin(eventId, teamId, requestId); if (!request) notFound(); assertRevision(request.revision, input.expectedRevision);
      if (request.status !== "pending") blocked("JOIN_ALREADY_HANDLED", "这条加入请求已处理，请刷新查看结果。");
      if (team.status !== "forming") blocked("TEAM_LOCKED", "队伍已锁定或退出，不能再处理加入。");
      if (input.decision === "accepted") {
        await this.validateTrack(store.sql, eventId, team.track);
        await this.approved(store, eventId, request.userId); await this.approved(store, eventId, principal.actor.userId);
        if (await store.activeTeamId(eventId, request.userId)) blocked("ALREADY_IN_TEAM", "这位选手已经加入其他队伍，不能重复占位。");
        if (team.memberUserIds.length >= event.teams.maxSize) blocked("TEAM_FULL", "队伍最后一个名额已被使用，请重新核对名单。");
        await store.acceptMember(eventId, teamId, request.userId, this.now());
        const next = { ...team, memberUserIds: [...team.memberUserIds, request.userId], revision: team.revision + 1, updatedAt: this.now() };
        next.eligible = (await this.team(store, event, teamId)).eligible;
        await store.saveTeam(next, team.revision, principal.actor.userId);
        for (const other of await store.ownRequests(eventId, request.userId)) {
          if (other.status === "pending" && other.id !== request.id) await store.saveJoin({ ...other, status: "cancelled", note: "已加入同赛事的另一支队伍。", revision: other.revision + 1, updatedAt: this.now() }, other.revision, principal.actor.userId);
        }
      }
      const nextRequest: JoinRequest = { ...request, status: input.decision, note, revision: request.revision + 1, updatedAt: this.now() };
      await store.saveJoin(nextRequest, request.revision, principal.actor.userId); return nextRequest;
    }, async () => { this.captain(principal, await this.team(store, event, teamId)); }));
  }
  async cancelJoin(principal: OrganizerPrincipal, eventId: string, teamId: string, requestId: string, input: MutationInput): Promise<JoinRequest> {
    identifier(teamId); identifier(requestId); revision(input.expectedRevision);
    return this.withEvent(principal, eventId, true, undefined, (store, event) => this.replay(store, principal, event, `team.cancel:${teamId}:${requestId}`, input, async () => {
      const request = await store.getJoin(eventId, teamId, requestId); if (!request || request.userId !== principal.actor.userId) notFound(); assertRevision(request.revision, input.expectedRevision);
      if (request.status !== "pending") blocked("JOIN_ALREADY_HANDLED", "加入请求已处理，不能再取消。");
      const next: JoinRequest = { ...request, status: "cancelled", revision: request.revision + 1, updatedAt: this.now() };
      await store.saveJoin(next, request.revision, principal.actor.userId); return next;
    }));
  }
  async leaveTeam(principal: OrganizerPrincipal, eventId: string, teamId: string, input: LeaveTeamInput): Promise<RosterTeam> {
    identifier(teamId); revision(input.expectedRevision); if (input.successorUserId !== undefined) identifier(input.successorUserId);
    return this.withEvent(principal, eventId, true, undefined, (store, event) => this.replay(store, principal, event, `team.leave:${teamId}`, input, async () => {
      const team = await this.team(store, event, teamId); if (!team.memberUserIds.includes(principal.actor.userId)) denied("只有当前队员可以退出自己的队伍。"); assertRevision(team.revision, input.expectedRevision);
      const remaining = team.memberUserIds.filter(id => id !== principal.actor.userId);
      let captainUserId = team.captainUserId;
      if (captainUserId === principal.actor.userId && remaining.length) {
        if (!input.successorUserId || !remaining.includes(input.successorUserId)) blocked("CAPTAIN_SUCCESSOR_REQUIRED", "队长退出前，请选择一位现有队员接任队长。");
        await this.approved(store, eventId, input.successorUserId); captainUserId = input.successorUserId;
      }
      await store.leaveMember(eventId, teamId, principal.actor.userId, this.now());
      const next: RosterTeam = { ...team, captainUserId, memberUserIds: remaining, status: remaining.length ? team.status : "withdrawn", eligible: false, revision: team.revision + 1, updatedAt: this.now() };
      // Leaving a locked roster preserves its original confirmation snapshot; current eligibility becomes false.
      if (team.status === "forming" && remaining.length) next.eligible = (await this.team(store, event, teamId)).eligible;
      await store.saveTeam(next, team.revision, principal.actor.userId); return next;
    }));
  }
  async lockRoster(principal: OrganizerPrincipal, eventId: string, teamId: string, input: MutationInput): Promise<RosterTeam> {
    identifier(teamId); revision(input.expectedRevision);
    return this.withEvent(principal, eventId, true, undefined, (store, event) => this.replay(store, principal, event, `team.lock:${teamId}`, input, async () => {
      this.teamsEnabled(event, false);
      const team = await this.team(store, event, teamId); this.captain(principal, team); assertRevision(team.revision, input.expectedRevision);
      if (team.status !== "forming") blocked("TEAM_LOCKED", "队伍已确认名单或退出，请查看当前状态。");
      if (!team.eligible) blocked("TEAM_INELIGIBLE", `请确认每位队员已通过报名审核，人数在${event.teams.minSize}至${event.teams.maxSize}人之间。`);
      const lockedRoster = [];
      for (const userId of team.memberUserIds) { const reg = await this.approved(store, eventId, userId); lockedRoster.push({ userId, registrationId: reg.id, registrationRevision: reg.revision }); }
      const next: RosterTeam = { ...team, status: "locked", revision: team.revision + 1, lockedRoster, lockedAt: this.now(), updatedAt: this.now() };
      await store.saveTeam(next, team.revision, principal.actor.userId); return next;
    }, async () => { this.captain(principal, await this.team(store, event, teamId)); }));
  }
  async requestProjectLink(principal: OrganizerPrincipal, eventId: string, teamId: string, input: RequestProjectLinkInput): Promise<ProjectLinkRequest> {
    identifier(teamId); identifier(input.projectId, "私人空间标识"); revision(input.expectedRevision);
    return this.withEvent(principal, eventId, true, undefined, (store, event) => this.replay(store, principal, event, `team.project.request:${teamId}`, input, async () => {
      const team = await this.team(store, event, teamId); this.captain(principal, team); assertRevision(team.revision, input.expectedRevision);
      if (team.status === "withdrawn") blocked("TEAM_WITHDRAWN", "队伍已退出，不能关联私人空间。");
      if (team.projectId) blocked("PROJECT_ALREADY_LINKED", "这支队伍已有明确关联的私人空间。");
      const current = await store.getLink(eventId, teamId);
      if (current?.status === "pending") await store.saveLink({ ...current, status: "cancelled", revision: current.revision + 1 }, current.revision, principal.actor.userId);
      const value: ProjectLinkRequest = { id: this.deps.ids.next(), eventId, teamId, projectId: input.projectId, requestedByUserId: principal.actor.userId, status: "pending", revision: 1, expectedTeamRevision: team.revision, createdAt: this.now(), confirmedAt: null };
      await store.saveLink(value, 0, principal.actor.userId); return value;
    }, async () => { this.captain(principal, await this.team(store, event, teamId)); }));
  }
  async reopenRoster(principal: OrganizerPrincipal, eventId: string, teamId: string, input: ReopenRosterInput): Promise<RosterTeam> {
    identifier(teamId); revision(input.expectedRevision); const note = plainText(input.note, "重新开放名单的原因", 1000, true);
    return this.withEvent(principal, eventId, true, "teams_manage", (store, event) => this.replay(store, principal, event, `team.reopen:${teamId}`, input, async () => {
      this.teamsEnabled(event, false);
      const team = await this.team(store, event, teamId); assertRevision(team.revision, input.expectedRevision);
      if (team.status !== "locked") blocked("TEAM_NOT_LOCKED", "只有已锁定的名单需要重新开放。");
      const next: RosterTeam = { ...team, status: "forming", revision: team.revision + 1, lockedAt: null, lockedRoster: null, lastChangeNote: note, updatedAt: this.now() };
      // Original confirmations remain immutable in history. The official deadline still governs new joins.
      await store.saveTeam(next, team.revision, principal.actor.userId); return this.team(store, event, teamId);
    }));
  }
  async getProjectLink(principal: OrganizerPrincipal, eventId: string, teamId: string): Promise<ProjectLinkRequest | null> {
    identifier(teamId);
    return this.withEvent(principal, eventId, false, undefined, async (store, event) => {
      const team = await this.team(store, event, teamId);
      const request = await store.getLink(eventId, teamId);
      if (!team.memberUserIds.includes(principal.actor.userId)) {
        // Nonmember managers need a distinct read check; confirmLink must never be invoked by GET.
        if (!request || !this.deps.projectLinkPreview) denied();
        await this.deps.projectLinkPreview.requireManagerPreview(store.sql, principal, { eventId, teamId, projectId: request.projectId });
      }
      return request;
    });
  }
  async confirmProjectLink(principal: OrganizerPrincipal, eventId: string, teamId: string, requestId: string, input: ConfirmProjectLinkInput): Promise<RosterTeam> {
    identifier(teamId); identifier(requestId); revision(input.expectedRevision); revision(input.expectedProjectRevision); revision(input.expectedTeamRevision);
    return this.withEvent(principal, eventId, true, undefined, (store, event) => this.replay(store, principal, event, `team.project.confirm:${teamId}:${requestId}`, input, async () => {
      const team = await this.team(store, event, teamId), request = await store.getLink(eventId, teamId, requestId); if (!request) notFound();
      assertRevision(team.revision, input.expectedTeamRevision); assertRevision(request.revision, input.expectedRevision);
      if (request.status !== "pending" || request.expectedTeamRevision !== team.revision || team.status === "withdrawn" || team.projectId) blocked("PROJECT_LINK_STALE", "队伍或关联请求已变化，请由队长重新发起关联再确认。");
      // The injected root port must lock/recheck the actual M02 manager and project/event/team mapping.
      await this.deps.projectLinks.confirmLink(store.sql, principal, { eventId, teamId, projectId: request.projectId, expectedProjectRevision: input.expectedProjectRevision });
      await principal.guard(store.sql);
      const next: RosterTeam = { ...team, projectId: request.projectId, revision: team.revision + 1, updatedAt: this.now() };
      await store.saveTeam(next, team.revision, principal.actor.userId);
      await store.saveLink({ ...request, status: "confirmed", revision: request.revision + 1, confirmedAt: this.now() }, request.revision, principal.actor.userId); return next;
    }, async () => {
      const request = await store.getLink(eventId, teamId, requestId); if (!request) notFound();
      if (this.deps.projectLinkPreview) await this.deps.projectLinkPreview.requireManagerPreview(store.sql, principal, { eventId, teamId, projectId: request.projectId });
      else await this.deps.projectLinks.confirmLink(store.sql, principal, { eventId, teamId, projectId: request.projectId, expectedProjectRevision: input.expectedProjectRevision });
    }));
  }
  async listMine(principal: OrganizerPrincipal, options: { cursor?: string; limit?: number } = {}): Promise<Page<MyCompetition>> {
    const paging = pageOptions(options);
    return this.deps.database.transaction(async sql => {
      await principal.guard(sql); const store = this.repository.store(sql), rows = await store.listOwnRegistrations(principal.actor.userId, paging), items: MyCompetition[] = [], checked = new Map<string, HostedEventScope>();
      for (const reg of rows.items) {
        const event = await this.deps.events.getEvent(sql, reg.eventId); if (!event || event.eventId !== reg.eventId || event.organizationId !== reg.organizationId || event.status === "draft") continue;
        const teamId = await store.activeTeamId(reg.eventId, principal.actor.userId), team = teamId ? await store.getTeam(reg.eventId, teamId) : null;
        checked.set(event.eventId, event);
        items.push({ eventId: event.eventId, title: event.title, organizationName: event.organizationName, timezone: event.timezone, startsAt: event.startsAt, registrationClosesAt: event.registrationClosesAt,
          registrationStatus: reg.status, registrationRevision: reg.revision, teamId, teamName: team?.name ?? null });
      }
      await principal.guard(sql);
      for (const item of items) { const after = await this.deps.events.getEvent(sql, item.eventId), before = checked.get(item.eventId)!; if (!after || after.eventId !== item.eventId || after.organizationId !== before.organizationId || after.status === "draft") denied(); if (after.revision !== before.revision) blocked("EVENT_CHANGED", "比赛配置已更新，请重新读取我的比赛。"); }
      return { items, nextCursor: rows.nextCursor };
    });
  }
  /** Trusted inter-module projections; caller owns principal/session and event authorization. */
  async getUsedTracks(sql:SqlExecutor,eventId:string):Promise<string[]> {
    identifier(eventId);
    const event=await this.deps.events.getEvent(sql,eventId);
    if(!event) notFound();
    const store=this.repository.store(sql), tracks=new Set<string>();
    let cursor:string|undefined, count=0;
    do {
      const page=await store.listTeams(eventId,{limit:100,...(cursor?{cursor}:{})});
      for(const row of page.items) if(row.organizationId===event.organizationId&&row.status!=="withdrawn"){tracks.add(row.track);count++;}
      cursor=page.nextCursor??undefined;
      if(count>5000||(count===5000&&cursor)) blocked("TEAM_LIMIT","队伍数量超过一次核查上限，请联系管理员分批处理。");
    }while(cursor);
    return [...tracks];
  }
  async listApprovedUserIds(sql:SqlExecutor,eventId:string):Promise<string[]> {
    identifier(eventId);
    const event=await this.deps.events.getEvent(sql,eventId);
    if(!event||event.status==="draft") notFound();
    const store=this.repository.store(sql), ids:string[]=[];
    let cursor:string|undefined;
    do {
      const page=await store.listRegistrations(eventId,{status:"approved",limit:100,...(cursor?{cursor}:{})});
      for(const row of page.items) if(row.organizationId===event.organizationId&&row.status==="approved") ids.push(row.userId);
      cursor=page.nextCursor??undefined;
      if(ids.length>5000||(ids.length===5000&&cursor)) blocked("PARTICIPANT_LIMIT","当前名单超过一次读取上限，请联系管理员分批处理。");
    }while(cursor);
    return [...new Set(ids)];
  }
  async getRegistration(sql: SqlExecutor, eventId: string, userId: string) {
    identifier(eventId); identifier(userId);
    const value = await this.repository.store(sql).getRegistration(eventId, userId);
    if (!value) return null;
    const event = await this.deps.events.getEvent(sql, eventId);
    if (!event || event.eventId !== eventId || event.organizationId !== value.organizationId) return null;
    return { id: value.id, eventId: value.eventId, userId: value.userId, status: value.status, revision: value.revision };
  }
  async getTeam(sql: SqlExecutor, eventId: string, teamId: string) {
    identifier(eventId); identifier(teamId);
    const event = await this.deps.events.getEvent(sql, eventId); if (!event || event.eventId !== eventId) return null;
    const store = this.repository.store(sql), value = await store.getTeam(eventId, teamId);
    if (!value || value.organizationId !== event.organizationId) return null;
    const team = await this.team(store, event, teamId);
    return { id: team.id, eventId, organizationId: team.organizationId, captainUserId: team.captainUserId, memberUserIds: team.memberUserIds, revision: team.revision, status: team.status, projectId: team.projectId, eligible: team.eligible };
  }
  /**
   * 规划 33 P08：本人在这场比赛的**报名与队伍**只读投影（一个事务内的 `sql`，一次调用拿齐）。
   *
   * 供根把它注入 event-communication 的 `EventOwnFactsPort`——那个模块不查本模块的表，
   * 因此这里给出唯一入口，避免根去碰本模块的私有 `repository`。
   *
   * 语义边界：
   * - 只读，不产生任何写入；
   * - 两者都读不到时返回 `null`（调用方据此区分 `absent` 与 `unread`）；
   * - 只返回展示所需字段，**不含**答卷、邮箱、联系方式或私人空间标识。
   */
  async getOwnFacts(sql: SqlExecutor, eventId: string, userId: string): Promise<{
    readonly registration: { readonly status: Registration["status"]; readonly reviewNote: string } | null;
    readonly team: { readonly id: string; readonly name: string; readonly track: string;
      readonly status: RosterTeam["status"]; readonly captainUserId: string; readonly memberCount: number } | null;
  } | null> {
    identifier(eventId); identifier(userId);
    const store = this.repository.store(sql);
    const [registration, teamId] = await Promise.all([store.getRegistration(eventId, userId), store.activeTeamId(eventId, userId)]);
    const team = teamId ? await store.getTeam(eventId, teamId) : null;
    if (!registration && !team) return null;
    return {
      registration: registration ? { status: registration.status, reviewNote: registration.reviewNote ?? "" } : null,
      team: team ? { id: team.id, name: team.name, track: team.track, status: team.status,
        captainUserId: team.captainUserId, memberCount: team.memberUserIds.length } : null,
    };
  }
}
export function createEventRegistrationService(dependencies: EventRegistrationDependencies): EventRegistrationService { return new EventRegistrationService(dependencies); }
