import { createHash, randomUUID } from "node:crypto";
import type { Actor } from "../shared/contracts.ts";
import { matchesLocalTestMutation, validateLocalTestOrigin, withLocalTestAuth, withLocalTestHandlers } from "./local-test-auth.ts";
import { DomainError } from "../shared/errors.ts";
import { safeAuthReturnTo } from "../modules/auth/index.ts";
import { GuanchaLoginService, PostgresGuanchaAttemptStore, createNodeGuanchaCrypto, createGuanchaProvider } from "../modules/guancha-login/index.ts";
import { createGuanchaAuth } from "./guancha-auth.ts";
import { fetchGuanchaAvatar } from "./guancha-avatar.ts";
import { createGuanchaHttp } from "./guancha-http.ts";
import { AuthService, PostgresAuthStore, createNodeAuthCrypto, createAuthHandlers, createLoginEmailAdapter, createSignedProxyClientKeyProvider, AccountCompletionService, PostgresAccountStore, createAccountCompletionHandlers, createAccountEmailAdapter, type TransactionalEmailTransportPort } from "../modules/auth/index.ts";
import { ProjectsService, PostgresProjectsRepository, createInvitationTokens, createProjectsHttpHandlers, ProjectCollaborationService, PostgresProjectCollaborationRepository, createProjectCollaborationHandlers } from "../modules/projects/index.ts";
import { EventsService, PostgresEventsRepository, createEventsHandlers, createEventAnalysisModelAdapter, PostgresOfficialTrackRulesPort } from "../modules/events/index.ts";
import { AssessmentService, PostgresAssessmentRepository, PostgresQuestionCatalog, createAssessmentHttpHandlers, createModelAssessmentScorer, createModelAssignmentSuggestions, createAssignmentGenerationService, createAssignmentGenerationHttpHandlers, createAssessmentCatalogAdministration, createAssessmentCatalogHttpHandlers, createRoleHelpService, createModelRoleHelp, createRoleHelpHttpHandlers } from "../modules/assessments/index.ts";
import { PlanningService, createPostgresPlanningRepository, createMemberAvailabilityValidator, createPlanningWorkflowReader, createPlanningHandlers, createPlanningGenerationService, createPlanningModelAdapter, createPostgresPlanningGenerationRepository, createPlanningGenerationHandlers, createPlanningNotificationHandlers } from "../modules/planning/index.ts";
import { GitService, DeliveryService, GitHubHttpAdapter, PostgresGitRepositoryStore, PostgresDraftStore, PostgresDeliveryStore, PostgresAuthorizationStore, DeliveryMaterialsService, PostgresDeliveryMaterialsStore, summarizeDeliveryMaterials, createGitHubMaintenance, createGitHubHandler, type DeliveryCapabilityPort } from "../modules/github/index.ts";
import { RetrospectiveService, PostgresRetrospectiveRepository, createRetrospectiveHandlers, createRetrospectiveModelAdapter, RetrospectiveEditDraftService, PostgresRetrospectiveEditDraftRepository, PostgresOwnerRetrospectivePort, createRetrospectiveEditDraftHandlers } from "../modules/retrospectives/index.ts";
import { ResourceService, createPostgresResourceRepository, createResourceHandlers } from "../modules/resources/index.ts";
import { createDatabase, type ApplicationDatabase } from "./database.ts";
import { loadConfig, aiServiceSettings, type ApplicationConfig } from "./config.ts";
import { createFactAdapters } from "./facts.ts";
import { createOperationsIntegration, createEventCandidateAdapter } from "./operations.ts";
import { createGitHubIntegration } from "./github-integration.ts";
import { createDshBackend } from "./dsh-backend.ts";
import { createDshJsonModel } from "./dsh-model.ts";
import { startBackgroundWorkers } from "./background.ts";
import { bindWebWorkerCancellation } from "./web-worker-signals.ts";
import { drainAndClose, webRequestDrain } from "./request-drain.ts";
import { createOpenAICompatibleModel, createBudgetedModel, createBudgetedStreamingModel } from "./ai.ts";
import { createOpenAICompatibleStreamingModel, type StreamingJsonModelPort } from "./ai-stream.ts";
import { PostgresAiLedger, createAiWorker, createStandardAiHandlers } from "./ai-jobs.ts";
import { createDiscoveryService } from "./discovery.ts";
import { createDiscoveryLiveService } from "./discovery-live.ts";
import { createInspirationService } from "./inspiration.ts";
import { createInspirationWorker } from "./inspiration-worker.ts";
import { createNodeNetworkPorts, PostgresDiscoveryLedger } from "../modules/operations/index.ts";
import { createProjectDiscoveryService } from "./project-discovery.ts";
import { createDshWebsiteChat, createDshPersonalWorkspace } from "./dsh-chat.ts";
import { createSpaceTodos } from "./space-todos.ts";
import { createSpaceDocuments } from "./space-documents.ts";
import { createSpaceCanvasLayouts } from "./space-canvas-layouts.ts";
import { createSpaceCollaboration } from "./space-collaboration.ts";
import { createSkillsService, createPostgresSkillsRepository, createSkillsHttpHandlers, seedInitialSkills, createReviewedSkillLookupPort } from "../modules/skills/index.ts";
import { createParticipantService } from "../modules/participant/index.ts";
import { createParticipationService } from "../modules/participation/index.ts";
import { createRoadshowService } from "../modules/roadshow/index.ts";
import { createPptService } from "../modules/ppt/index.ts";
import { createParticipationWeatherPort } from "./participation-weather.ts";
import { createSmtpMailTransport } from "./smtp-mail.ts";
import { createPresentationProjectContextPort } from "./presentation-context.ts";
import { OnboardingService } from "../modules/onboarding/index.ts";
import { createSiteSearchSourceReader } from "./site-search-sources.ts";
import { createTeamMissionServices } from "./team-mission.ts";
import { createDeliveryRequirementsPorts } from "./delivery-requirements.ts";
import { createAuditQueryService, createAuditQueryHandlers, PostgresAuditQueryPort } from "../modules/operations/audit-query-index.ts";
import { createPlanningNotifications } from "./planning-notifications.ts";
import { createAccountDataPorts } from "./account-data.ts";
import { createRetentionMaintenance } from "./retention-maintenance.ts";
import { createProjectSkillsIntegration } from "./project-skills.ts";
import { createOperationsObservability } from "./operations-observability.ts";
import { createResourceLinkMaintenance } from "./resource-link-maintenance.ts";
import { createOrganizerIntegration } from "./organizer-integration.ts";
import { createOrganizerRootControls } from "./organizer-root-controls.ts";
import { createOrganizerDeliveryBridge } from "./organizer-delivery-bridge.ts";
import { createOrganizerTrackConfig } from "./organizer-track-config.ts";
import { createOrganizerNotifications } from "./organizer-notifications.ts";
import { createOrganizerOfficialRulesPort } from "./organizer-official-rules.ts";
import { createEventOfficialLinksService, createEventOfficialLinksHttpHandlers } from "../modules/event-official-links/index.ts";
import { createOrganizerMailAccounts } from "./organizer-mail-accounts.ts";
import { verifyOrganizerSmtpCredentials } from "./organizer-smtp-verify.ts";
import { PostgresOrganizerRepository } from "../modules/organizer/index.ts";

export interface ApplicationOverrides { readonly aiStreamModel?: StreamingJsonModelPort | null }
export async function createApplication(config: ApplicationConfig, suppliedDatabase?: ApplicationDatabase, overrides: ApplicationOverrides = {}) {
  const database = suppliedDatabase ?? await createDatabase({ connectionString: config.databaseUrl, localPath: config.localDatabasePath });
  // Local setup is automatic; connected production uses the explicit migration command.
  if (config.mode === "local") await database.migrate();
  const clock = { now: () => new Date() };
  const ids = { next: () => randomUUID() };
  const onboarding = new OnboardingService(database, clock);
  const assertAiActor = async (actorId: string) => {
    const result = await database.query("SELECT id FROM auth_users WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL", [actorId]);
    if (!result.rows.length) throw new DomainError("AI_ACTOR_UNAVAILABLE", "账号当前无法使用 AI，请重新登录后检查账号状态。", { status: 403 });
  };
  const aiSettings = aiServiceSettings(config);
  const aiLedger = new PostgresAiLedger(database, aiSettings?.budget ?? { dailyProjectCallLimit: 40 });
  const aiModel = aiSettings ? createBudgetedModel({ model: aiSettings.provider === "dsh" ? createDshJsonModel(config.dsh!) : createOpenAICompatibleModel(config.ai!), ledger: aiLedger, maxInputBytes: aiSettings.maxInputBytes, maxOutputTokens: aiSettings.maxOutputTokens, maxAttempts: aiSettings.maxAttempts, assertActor: context => assertAiActor(context.actorId) }) : null;
  /**
   * 规划35 P4：只有 OpenAI 兼容提供方能流式；当前部署的 DSH 是子进程一次性返回（见交付文档 §4.1）。
   * 能力为空时 `/page/ai-capability` 会如实报告不支持，界面据此降级为一次性生成。
   */
  const rawStreamModel = overrides.aiStreamModel !== undefined ? overrides.aiStreamModel : aiSettings && aiSettings.provider !== "dsh" && config.ai
    ? (() => { try { return createOpenAICompatibleStreamingModel({ ...config.ai! }); } catch { return null; } })()
    : null;
  // 流式也走同一套账本（reserve/settle/assertActive 完全复用），用量按最终值结算。
  const aiStreamModel = rawStreamModel ? createBudgetedStreamingModel({ model: rawStreamModel, ledger: aiLedger, maxOutputTokens: aiSettings?.maxOutputTokens }) : null;
  const discoveries = createDiscoveryService(database, clock);
  const discoveryLive = createDiscoveryLiveService({ database, config, clock });
  const skillsRepository = createPostgresSkillsRepository(database);
  await seedInitialSkills(skillsRepository);
  const skills = createSkillsService({ repository: skillsRepository, clock, ids });
  const transport: TransactionalEmailTransportPort = config.smtp ? createSmtpMailTransport(config.smtp) : {
    async send(message, options) {
      if (!config.resendKey && config.mode === "local" && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.origin).hostname)) {
        await database.query("DELETE FROM development_mailbox WHERE created_at < now() - interval '15 minutes'");
        await database.query("INSERT INTO development_mailbox(id,recipient,subject,body) VALUES ($1,$2,$3,$4)", [ids.next(), message.to, message.subject, message.text]);
        return;
      }
      if (!config.resendKey) throw new DomainError("EMAIL_NOT_CONFIGURED", "尚未配置真实验证码邮件发送服务，请联系网站管理员。", { status: 503 });
      const response = await fetch("https://api.resend.com/emails", { method: "POST", redirect: "error", signal: options.signal,
        headers: { Authorization: `Bearer ${config.resendKey}`, "Content-Type": "application/json" }, body: JSON.stringify(message) });
      if (!response.ok) throw new DomainError("EMAIL_SEND_FAILED", "邮件未被服务接收，请稍后重试。", { status: 503 });
    },
  };
  const auth = new AuthService({ store: new PostgresAuthStore(database, ids, clock), crypto: createNodeAuthCrypto(config.codePepper), email: createLoginEmailAdapter({ transport, from: config.emailFrom }), clock, ids,
    policy: { maxSendsPerClient: config.globalSendLimit ?? 20, maxVerificationsPerClient: config.globalVerificationLimit ?? 50 } });
  const proxyClients = config.authProxySigners ? createSignedProxyClientKeyProvider({ proxies: config.authProxySigners, origin: config.origin, clock }) : null;
  const authUrl = new URL(config.origin);
  const localLoopbackOrigin = config.mode === "local" && ["localhost", "127.0.0.1", "[::1]"].includes(authUrl.hostname);
  const publicAuthHandlers = createAuthHandlers({ service: auth, origin: config.origin, secure: config.mode !== "local" || authUrl.protocol === "https:", getClientKey: request => proxyClients ? proxyClients.getClientKey(request) : localLoopbackOrigin ? "trusted-loopback" : "conservative-global-client-budget", requestIds: ids });
  const localTestOrigin = validateLocalTestOrigin(config.mode, config.localTestOrigin);
  const localAuthHandlers = localTestOrigin && localTestOrigin !== config.origin ? createAuthHandlers({ service: auth, origin: localTestOrigin, secure: false, getClientKey: () => "conservative-global-client-budget", requestIds: ids }) : null;
  const authHandlers = withLocalTestAuth(publicAuthHandlers, localAuthHandlers, localTestOrigin);
  const guanchaIdentity = createGuanchaAuth({ database, crypto: createNodeAuthCrypto(config.codePepper), clock, ids,
    // 首次关联时继承观猹头像：下载走白名单+字节校验；写入复用招募模块既有的头像存储与校验。
    // `recruiting` 在本函数稍后才解构（组装顺序），因此用惰性闭包——回调只在真正关联时才执行。
    fetchAvatar: async url => {
      const downloaded = await fetchGuanchaAvatar(url);
      return downloaded ? { mimeType: downloaded.mimeType, base64: downloaded.base64 } : null;
    },
    saveAvatar: async (userId, avatar) => {
      const actor = { userId, platformRoles: ["user"] } as const;
      const view = await recruiting.getProfile(actor);
      await recruiting.saveAvatar(actor, { expectedRevision: view.profile.revision, avatar });
    },
  });
  const guanchaLogin = new GuanchaLoginService({ attempts: new PostgresGuanchaAttemptStore(database),
    crypto: createNodeGuanchaCrypto(config.codePepper), identity: guanchaIdentity, clock, safeReturnTo: safeAuthReturnTo,
    ...(config.guancha?.enabled ? { provider: createGuanchaProvider(config.guancha) } : {}),
  });
  const guanchaHandlers = createGuanchaHttp({ service: guanchaLogin, identity: guanchaIdentity, database, origin: config.origin,
    clock, ids, readSessionToken: publicAuthHandlers.readSessionToken,
    currentUserId: async request => (await auth.getActor(publicAuthHandlers.readSessionToken(request)))?.userId ?? null,
    initializeWorkspace: userId => personalWorkspace.session({ userId, platformRoles: ["user"] }),
  });
  const resolveActor = (request: Request) => auth.getActor(authHandlers.readSessionToken(request));
  const resolvePrincipal = async (request:Request) => {
    const actor = await resolveActor(request), token = authHandlers.readSessionToken(request);
    if (!actor || !token) return null;
    const hash = createHash("sha256").update(token).digest("hex");
    return {actor,async guard(sql:import("../shared/persistence.ts").SqlExecutor) {
      const account = await sql.query<{platform_roles:string[]}>("SELECT platform_roles FROM auth_users WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL FOR SHARE", [actor.userId]);
      if(!account.rowCount || JSON.stringify([...account.rows[0].platform_roles].sort()) !== JSON.stringify([...actor.platformRoles].sort())) throw new DomainError("UNAUTHENTICATED","账号或权限已更新，请重新登录。",{status:401});
      const valid = await sql.query("SELECT id FROM auth_sessions WHERE token_hash=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>$3::timestamptz FOR SHARE", [hash,actor.userId,clock.now().toISOString()]);
      if(!valid.rowCount) throw new DomainError("UNAUTHENTICATED","本次登录已失效，请重新登录。",{status:401});
    }};
  };
  const accountStore = new PostgresAccountStore(database, ids, clock);
  const accountCompletion = new AccountCompletionService({store:accountStore,crypto:createNodeAuthCrypto(config.codePepper),email:createAccountEmailAdapter({transport,from:config.emailFrom}),
    ...createAccountDataPorts({database}),clock,ids});
  const publicAccountHandlers = createAccountCompletionHandlers({ service: accountCompletion, origin: config.origin, requestIds: ids,
    clientKeys:{getClientKey: async request => proxyClients ? proxyClients.getClientKey(request) : localLoopbackOrigin ? "trusted-loopback" : "conservative-global-client-budget"},
    readSessionToken: authHandlers.readSessionToken, clearSessionCookie:authHandlers.clearSessionCookie });
  const localAccountHandlers = localAuthHandlers && localTestOrigin ? createAccountCompletionHandlers({
    service: accountCompletion, origin: localTestOrigin, requestIds: ids,
    clientKeys: { getClientKey: async () => "conservative-global-client-budget" },
    readSessionToken: localAuthHandlers.readSessionToken, clearSessionCookie: localAuthHandlers.clearSessionCookie,
  }) : null;
  const accountHandlers = withLocalTestHandlers(publicAccountHandlers, localAccountHandlers, localTestOrigin);
  const retentionMaintenance = createRetentionMaintenance({database,accountStore,clock});
  const operationsObservability = createOperationsObservability({database,clock,resolvePrincipal,requestId:ids.next,
    cursorSecret:createHash("sha256").update("source-observability-v1:").update(config.codePepper).digest("hex"),
    sourceModelConfigured:Boolean(config.dsh),sourceBudget:config.dsh?.sourceBudget});
  const resourceLinkMaintenance = createResourceLinkMaintenance({database,clock,resolvePrincipal,requestId:ids.next,proxyUrl:config.sourceProxyUrl});
  const assertMutationAllowed = async (request: Request) => {
    if (request.headers.get("origin") !== config.origin && !matchesLocalTestMutation(request, localTestOrigin)) throw new DomainError("ORIGIN_FORBIDDEN", "请求来源不匹配，请从本站重新操作。", { status: 403 });
  };
  const projectRepository = new PostgresProjectsRepository(database);
  const requireActiveTarget = async (sql:import("../shared/persistence.ts").SqlExecutor,userId:string) => {
    const account=await sql.query("SELECT id FROM auth_users WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL FOR SHARE",[userId]);
    if(!account.rowCount) throw new DomainError("TARGET_ACCOUNT_UNAVAILABLE","该账号尚未完成邮箱验证或已停用，请对方先检查账号。",{status:409});
  };
  let organizerIntegration:ReturnType<typeof createOrganizerIntegration>;
  const organizerRepository=new PostgresOrganizerRepository();
  const organizerMailAccounts=createOrganizerMailAccounts({database,clock,ids,resolvePrincipal,assertMutationAllowed,encryptionKey:createHash("sha256").update("organizer-mail-credentials:v1:").update(config.codePepper).digest(),requireOrganizationManager:(sql,actor,id)=>organizerIntegration.organizer.requireOrganizationManager(sql,actor,id),getOrganization:(sql,id)=>organizerRepository.getOrganization(sql,id),verifyCredentials:verifyOrganizerSmtpCredentials,createSmtpMailTransport});
  const organizerOfficialLinks=createEventOfficialLinksService({database,clock,ids,getHostedEvent:(...args)=>organizerIntegration.rawEvents.getEvent(...args),rulesPort:createOrganizerOfficialRulesPort()});
  const organizerOfficialLinkHandlers=createEventOfficialLinksHttpHandlers({service:organizerOfficialLinks,resolvePrincipal,authorizeMutation:assertMutationAllowed,requestId:ids.next});
  const organizerControls=createOrganizerRootControls({database,clock,ids,resolvePrincipal,assertMutationAllowed,requireActiveTarget,projectRepository,integration:()=>organizerIntegration});
  const organizerTracks=createOrganizerTrackConfig({database,clock,ids,resolvePrincipal,assertMutationAllowed,getEvents:()=>organizerIntegration.events,getRegistration:()=>organizerIntegration.registration});
  const organizerNotifications=createOrganizerNotifications({database,clock,ids,resolvePrincipal,assertMutationAllowed,getEvents:()=>organizerIntegration.events,getRegistration:()=>organizerIntegration.registration,getCommunication:()=>organizerIntegration.communication,getOrganizationSender:organizerMailAccounts.getSender,countOrganizationSenders:organizerMailAccounts.countConfigured,origin:config.origin,...(config.smtp||config.resendKey?{transport,from:config.emailFrom}:{})});
  const organizerDelivery=new URL(config.origin).protocol==="https:"?createOrganizerDeliveryBridge({projectsRepository:projectRepository,clock,origin:config.origin,
    hostedEvents:{getEvent:(...args)=>organizerIntegration.events.getEvent(...args)},participation:{getTeam:(...args)=>organizerIntegration.registration.getTeam(...args)},validateOfficialMapping:(sql,event)=>organizerOfficialLinks.getLinkedEventId(sql,event,{forUpdate:true})}):null;
  organizerIntegration=createOrganizerIntegration({ ...(aiStreamModel ? { aiStreamModel } : {}),database,clock,ids,resolvePrincipal,assertMutationAllowed,requireActiveTarget,projectRepository,relationshipReviews:organizerControls.relationshipReviews,tracks:organizerTracks.tracks,notification:organizerNotifications.notification,announcementAudience:organizerNotifications.announcementAudience,decorateEventAccess:base=>({async getEvent(sql,id,options){const scope=await base.getEvent(sql,id,options);return scope?{...scope,linkedEventId:await organizerOfficialLinks.getLinkedEventId(sql,scope)}:null;},async requireStaff(sql,actor,id,capability){const scope=await base.requireStaff(sql,actor,id,capability);return {...scope,linkedEventId:await organizerOfficialLinks.getLinkedEventId(sql,scope)};}}),...(organizerDelivery??{}),recruiting:()=>recruiting,aiModel:aiModel??undefined});
  const projectSkills = createProjectSkillsIntegration({database,projectRepository,skillsRepository,clock,ids,resolveActor,assertMutationAllowed});
  await projectSkills.initialize();
  const eventsRepository = new PostgresEventsRepository(database);
  const assessmentRepository = new PostgresAssessmentRepository(database);
  const planningRepository = createPostgresPlanningRepository(database);
  const collaborationRepository = new PostgresProjectCollaborationRepository();
  const officialTrackRules = new PostgresOfficialTrackRulesPort();
  let facts: ReturnType<typeof createFactAdapters>;
  let operations: ReturnType<typeof createOperationsIntegration>;
  let resources: ResourceService;
  const planningWorkflow = createPlanningWorkflowReader(planningRepository);
  const deliveryStore = new PostgresDeliveryStore(database);
  const projects = new ProjectsService({ repository: projectRepository, clock, ids, tokens: createInvitationTokens(),
    identity: { async getVerifiedEmail(userId) {
      const result = await database.query<{ email: string }>("SELECT email FROM auth_users WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL", [userId]);
      return result.rows[0]?.email ?? null;
    } }, availabilityValidator: createMemberAvailabilityValidator(projectRepository),
    publicInvitationDetails: {
      async getPublicDisplayName(userId, transaction) {
        const result = await (transaction ?? database).query<{ display_name: string }>("SELECT display_name FROM auth_users WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL", [userId]);
        return result.rows[0]?.display_name ?? null;
      },
      async getPublicEventName({ projectId, initialEventId }, transaction) {
        const sql = transaction ?? database;
        const confirmation = await sql.query<{event_id:string}>("SELECT body->>'eventId' AS event_id FROM m03_project_rules WHERE id=$1",[projectId]);
        const eventId = confirmation.rows[0]?.event_id ?? initialEventId;
        if (!eventId) return null;
        // Only current public M03 content can appear on an anonymous invitation.
        const result = await sql.query<{name:string}>("SELECT r.body->'metadata'->>'name' AS name FROM m03_events e JOIN m03_rule_versions r ON r.event_id=e.id AND r.version=(e.body->>'publishedVersion')::integer WHERE e.id=$1 AND e.body->>'publicationStatus'<>'archived'",[eventId]);
        return result.rows[0]?.name ?? null;
      },
    },
    workflow: { ...planningWorkflow, async hasSubmissionRecord(projectId) {
      const latest = new Map<string, Awaited<ReturnType<typeof deliveryStore.listSubmissions>>[number]>();
      for (const record of await deliveryStore.listSubmissions(projectId)) if (!latest.has(record.id) || latest.get(record.id)!.version < record.version) latest.set(record.id, record);
      return [...latest.values()].some(record => record.status === "reported" || record.status === "verified");
    } },
    resources: { async getReviewedResource(id, transaction) {
      const result = (await resources.getReviewedResources([id], transaction))[0];
      if (!result) return null;
      return { id: result.id, title: result.name, version: result.version };
    } },
  });
  const events = new EventsService({ repository: eventsRepository, projectAccess: projectRepository,
    projectWriteAccess: { async getMembershipForUpdate(transaction, projectId, userId) {
      if (!transaction) throw new DomainError("TRANSACTION_REQUIRED", "规则修改需要受保护的数据库事务。", { status: 503 });
      const membership = await projectRepository.getMembershipForUpdate(transaction, projectId, userId);
      const state = await transaction.query<{ stage: string }>("SELECT stage FROM projects_project WHERE id=$1", [projectId]);
      if (state.rows[0]?.stage === "archived") throw new DomainError("PROJECT_READ_ONLY", "项目已归档，不能修改规则或分析。", { status: 409 });
      return membership;
    } }, clock, ids, model: aiModel ? createEventAnalysisModelAdapter({ model: aiModel, maxOutputTokens: Math.min(aiSettings!.maxOutputTokens ?? 8192, 4096) }) : undefined,
    projectBackgroundVersion: { async getCurrentBackgroundVersion(projectId) { const result = await database.query<{ revision: number }>("SELECT revision FROM projects_project WHERE id=$1", [projectId]); return result.rows[0]?.revision ?? null; } } });
  const collaboration = new ProjectCollaborationService({ projects: projectRepository, repository: collaborationRepository, officialRules: officialTrackRules, clock, ids });
  const assessments = new AssessmentService({ repository: assessmentRepository, catalog: new PostgresQuestionCatalog(database), projectAccess: projectRepository,
    assignmentContext: { getSnapshot: (...args) => facts.assignmentContext.getSnapshot(...args) }, clock, ids,
    scorer: aiModel ? createModelAssessmentScorer({ model: aiModel, maxOutputTokens: Math.min(aiSettings!.maxOutputTokens ?? 8192, 6000) }) : undefined,
    suggestions: aiModel ? createModelAssignmentSuggestions({ model: aiModel, maxOutputTokens: Math.min(aiSettings!.maxOutputTokens ?? 8192, 6000) }) : undefined });
  const assessmentCatalog = createAssessmentCatalogAdministration({ database, clock, ids });
  const assignmentGeneration = createAssignmentGenerationService({ database, assessments, projectAccess: projectRepository,
    assignmentContext: { getSnapshot: (...args) => facts.assignmentContext.getSnapshot(...args) }, clock, ids, modelTimeoutMs: aiSettings?.timeoutMs });
  const planning = new PlanningService({ repository: planningRepository, access: projectRepository, facts: {
    readInput: (...args) => facts.planningFacts.readInput(...args), lockVersions: (...args) => facts.planningFacts.lockVersions(...args) },
    reviewedSkills: { async get(reference, sql) {
      const scoped = {query: <Row>(statement:string,params?:readonly unknown[]) => sql.query<Row>(statement,params),transaction: <T>(work:(tx:import("../shared/persistence.ts").SqlExecutor)=>Promise<T>) => work(sql)};
      return createReviewedSkillLookupPort(createPostgresSkillsRepository(scoped)).get(reference);
    } },
    resources: { getDisplayableApprovedIds: (...args) => resources.getDisplayableApprovedIds(...args),
      getReviewedResources: (...args) => resources.getReviewedResources(...args),
      validateResourceRefs: (...args) => resources.validateResourceRefs(...args) }, clock, ids });
  const planningGeneration = createPlanningGenerationService({ planning, repository: createPostgresPlanningGenerationRepository(database), access: projectRepository,
    model: aiModel ? createPlanningModelAdapter(aiModel, { maxOutputTokens: Math.min(aiSettings!.maxOutputTokens ?? 8192, 8192) }) : undefined, clock, ids, timeoutMs: aiSettings?.timeoutMs });
  const capabilities: DeliveryCapabilityPort = { async getCapabilities(projectId, userId) {
    const membership = await projectRepository.getMembership(projectId, userId);
    const state = await database.query<{ stage: string }>("SELECT stage FROM projects_project WHERE id=$1", [projectId]);
    const writable = membership?.status === "active" && membership.role === "manager" && state.rows[0]?.stage !== "archived";
    return { saveRepository: writable && Boolean(config.github), verifyDelivery: writable, recordSubmission: writable };
  } };
  const githubIntegration = createGitHubIntegration({ config, database, projectRepository, clock, ids, capabilities, resolveActor, assertMutationAllowed });
  const git = new GitService({ access: projectRepository, capabilities,
    credentials: githubIntegration.credentials,
    github: new GitHubHttpAdapter(), store: new PostgresGitRepositoryStore(database), drafts: new PostgresDraftStore(database), clock, ids });
  const delivery = new DeliveryService({ access: projectRepository, capabilities, store: deliveryStore,
    requirements: { assertConfirmed: input => facts.requirements.assertConfirmed(input) }, clock, ids });
  const deliveryMaterials = new DeliveryMaterialsService({ database, clock, ids, access: projectRepository,
    store: new PostgresDeliveryMaterialsStore(database), ...createDeliveryRequirementsPorts({ database, events, projects: projectRepository }) });
  const githubMaintenance = createGitHubMaintenance({ drafts: new PostgresDraftStore(database), authorization: new PostgresAuthorizationStore(database), clock });
  resources = new ResourceService({ repository: createPostgresResourceRepository(database), clock, ids, projectAccess: projectRepository,
    reviews: { async getApprovedReview() { return null; } },
    projectSharing: { addReviewedResource: (actor, input) => projects.addReviewedResource(actor, input) },
    corrections: { async submit(actor, input) { if (!actor) throw new DomainError("UNAUTHENTICATED", "请登录后反馈。", { status: 401 }); return operations.submitResourceCorrection(actor, input); } },
  });
  facts = createFactAdapters({ database, projectRepository, projects, eventsRepository, events, assessmentRepository, assessments, resources, planningRepository, git, delivery, collaborationRepository, officialTrackRules });
  const roleHelp = createRoleHelpService({ database, assignmentContext: facts.assignmentContext, clock, ids,
    model: aiModel ? createModelRoleHelp({ model: aiModel, maxOutputTokens: Math.min(aiSettings!.maxOutputTokens ?? 8192, 3000) }) : undefined,
    modelTimeoutMs: aiSettings?.timeoutMs,
    assertActor: async (actor, transaction) => {
      const current = await transaction.query("SELECT id FROM auth_users WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL FOR SHARE", [actor.userId]);
      if (!current.rowCount) throw new DomainError("UNAUTHENTICATED", "账号当前无法使用 AI，请重新登录。", { status: 401 });
    },
  });
  const operationsDeps = { database, eventsRepository, events, resources, clock, ids, resolveActor, assertMutationAllowed, executionEnabled: Boolean(config.dsh) };
  operations = createOperationsIntegration(operationsDeps);
  const dshBackend = createDshBackend({ config, database, clock, ids, candidates: createEventCandidateAdapter(operationsDeps), discoveries });
  const inspiration = createInspirationService(database, clock, config);
  const inspirationWorker = config.inspiration && dshBackend.adapter ? createInspirationWorker({ database, clock, model: dshBackend.adapter,
    ledger: new PostgresDiscoveryLedger({ database, clock, id: "inspiration-catalog" }), config: config.inspiration,
    network: createNodeNetworkPorts({ userAgent: config.inspiration.userAgent, proxyUrl: config.sourceProxyUrl }), save: inspiration.save }) : null;
  const retrospectives = new RetrospectiveService({ repository: new PostgresRetrospectiveRepository(database), access: projectRepository,
    projects: { async isArchived(projectId) { const result = await database.query<{ stage: string }>("SELECT stage FROM projects_project WHERE id=$1", [projectId]); return result.rows[0]?.stage === "archived"; } },
    evidence: facts.evidence, finalFactsLock: facts.finalFactsLock,
    model: aiModel ? createRetrospectiveModelAdapter({ transport: aiModel, maxOutputTokens: Math.min(aiSettings!.maxOutputTokens ?? 8192, 3000) }) : undefined,
    generationBudget: aiModel ? aiLedger.generationBudget() : undefined,
    resources: { async isReviewed(id) { return (await resources.getReviewedResource(id)) !== null; } },
    delivery: { async read(actor, projectId) {
      const saves = await git.listOperations(actor, projectId);
      const currentCommit = [...saves].sort((a,b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).find(operation => operation.status === "saved")?.commitSha ?? null;
      const materialSummary = summarizeDeliveryMaterials(await deliveryMaterials.read(actor, projectId), currentCommit);
      return { saves: saves.map(operation => ({ id: operation.id, projectId, revision: operation.revision, status: operation.status,
        repositoryUrl: `https://github.com/${operation.target.owner}/${operation.target.name}`, branch: operation.branch, commitSha: operation.commitSha, recordedAt: operation.updatedAt })),
        verifications: await delivery.listVerifications(actor, projectId), submissions: await delivery.listSubmissions(actor, projectId),
        materials: materialSummary.materials.map(item => ({ id: item.id, label: item.label, status: item.status === "prepared" ? "prepared" as const : item.status === "missing" ? "missing" as const : "unknown" as const })) };
    } }, clock, ids });
  const aiWorker = aiModel ? createAiWorker({ database, ledger: aiLedger, handlers: createStandardAiHandlers({ database, events, assessments, retrospectives, planningGeneration, assignments: assignmentGeneration, roleHelp }), clock: clock.now, leaseMs: aiSettings!.workerLeaseMs, assertActor: assertAiActor }) : null;
  const personalWorkspace = createDshPersonalWorkspace({ config, database, clock, ids });
  const participantProfiles = createParticipantService({ database, clock });
  const participation = createParticipationService({ ai: personalWorkspace, profiles: participantProfiles, clock,
    weather: createParticipationWeatherPort({clock}), events: { async get(id) {
      const item=await discoveries.get(id);
      return { id:item.id,title:item.title,summary:item.summary,
        eventDate:item.eventWindow?.startsAt??item.eventWindow?.startsOn??null,eventStartAt:item.eventWindow?.startsAt??null,
        location:null,city:null,mode:"unknown" as const,sourceUrl:item.canonicalUrl,
        registrationUrl:item.registration?.url??null,status:"unverified",registrationStatus:item.registrationWindow?.status??"unknown",
        registrationDeadline:item.registrationWindow?.closesAt??null,
        fetchedAt:item.lastAnalyzedAt,evidence:item.sources.map(source=>source.excerpt)
      };
    } } });
  const presentationProjectContext = createPresentationProjectContextPort({database,projects,planning,delivery,clock,planningFacts:facts.planningFacts});
  const roadshow=createRoadshowService({ai:personalWorkspace,profiles:participantProfiles,projectContext:presentationProjectContext});
  const ppt=createPptService({ai:personalWorkspace,profiles:participantProfiles,projectContext:presentationProjectContext});
  const navigator = createDshWebsiteChat({ config, database, projects, clock, ids, sessions: personalWorkspace,
    siteSources: createSiteSearchSourceReader({ resources, discoveries, skills, inspiration }) });
  const { recruiting, teamCollaboration, teamAssistant } = createTeamMissionServices({
    database, clock, ids, configured: Boolean(config.dsh), projects, projectRepository,
    collaboration, planning, planningFacts: facts.planningFacts, participantProfiles, personalAi: personalWorkspace, officialRules: officialTrackRules,
  });
  const retrospectiveEditDrafts = new RetrospectiveEditDraftService({ repository: new PostgresRetrospectiveEditDraftRepository(database), access: projectRepository,
    projects: { async isArchived(projectId) { const result = await database.query<{stage:string}>("SELECT stage FROM projects_project WHERE id=$1", [projectId]); return result.rows[0]?.stage === "archived"; } },
    ownerRetrospectives: new PostgresOwnerRetrospectivePort(database), finalFactsLock: facts.finalFactsLock, clock, ids });
  const projectDiscoveries = createProjectDiscoveryService({ database, projects, clock });
  // 本人手动添加的空间待办（规划27 第1期）：只落库这一部分，其余待办为派生视图。
  const spaceTodos = createSpaceTodos({ database, clock, ids });
  // 空间文档（规划27 第1期追加）：团队共享、作者可编辑，不参与任何任务或交付事实。
  const spaceDocuments = createSpaceDocuments({ database, clock, ids });
  // 空间画布摆放（"组件箱 + 自由画布"）：只存本人摆放偏好，不动业务数据。
  const spaceCanvasLayouts = createSpaceCanvasLayouts({ database, clock });
  const spaceCollaboration = createSpaceCollaboration({ database, clock, ids, projects, planning, collaboration, teamAssistant, spaceDocuments });
  const planningNotifications = createPlanningNotifications({ database, planning, projects, readInput: facts.readInputForNotifications, resources, clock, ids });
  const auditQuery = createAuditQueryService({ database, query: new PostgresAuditQueryPort(), clock,
    cursorSecret: createHash("sha256").update("operations-audit-cursor-v1:").update(config.codePepper).digest(),
    authorization: { async assertCurrentAdmin(sql, actor) {
      const current = await sql.query("SELECT id FROM auth_users WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL AND 'admin'=ANY(platform_roles) FOR SHARE", [actor.userId]);
      if (!current.rowCount) throw new DomainError("FORBIDDEN", "审计记录仅管理员可见。", { status: 403 });
    } },
  });
  return { config, database, clock, ids, onboarding, auth, authHandlers, guanchaHandlers, accountCompletion, accountHandlers, retentionMaintenance, projectSkills, operationsObservability, resourceLinkMaintenance, organizerIntegration, organizerControls, organizerTracks, organizerNotifications, organizerOfficialLinks, organizerOfficialLinkHandlers, organizerMailAccounts, resolveActor, resolvePrincipal, assertMutationAllowed, projects, projectRepository, events, eventsRepository, assessments, assessmentRepository,
    planning, planningRepository, planningGeneration, planningNotifications, assignmentGeneration, assessmentCatalog, collaboration, collaborationRepository, officialTrackRules, roleHelp, presentationProjectContext, git, delivery, deliveryMaterials, githubMaintenance, resources, retrospectives, operations, facts, aiWorker, aiLedger, discoveries, discoveryLive, inspiration, inspirationWorker, projectDiscoveries, navigator, personalWorkspace, spaceTodos, spaceDocuments, spaceCanvasLayouts, spaceCollaboration, participantProfiles, participation, roadshow, ppt, recruiting, teamCollaboration, teamAssistant, skills, githubIntegration, dshBackend,
    handlers: {
      auditQuery: createAuditQueryHandlers({ service: auditQuery, resolveActor, assertMutationAllowed, requestId: ids.next }),
      planningNotifications: createPlanningNotificationHandlers({ service: planningNotifications.service, resolveActor, authorizeMutation: assertMutationAllowed, requestIds: ids }),
      retrospectiveEditDrafts: createRetrospectiveEditDraftHandlers({ service: retrospectiveEditDrafts, authenticate: resolveActor, requestId: ids.next }),
      projects: createProjectsHttpHandlers({ service: projects, resolveActor, authorizeMutation: assertMutationAllowed, requestId: ids.next }),
      collaboration: createProjectCollaborationHandlers({service:collaboration, resolveActor, authorizeMutation:assertMutationAllowed, requestId:ids.next}),
      roleHelp: createRoleHelpHttpHandlers({service:roleHelp, resolveActor, authorizeMutation:assertMutationAllowed, requestIds:ids}),
      events: createEventsHandlers({ service: events, resolveActor, requestIds: ids }),
      assessments: createAssessmentHttpHandlers({ service: assessments, resolveActor, requestIds: ids }),
      assessmentCatalog: createAssessmentCatalogHttpHandlers({ service: assessmentCatalog, resolveActor, requestIds: ids }),
      assignmentGeneration: createAssignmentGenerationHttpHandlers({ service: assignmentGeneration, resolveActor, requestIds: ids }),
      planning: createPlanningHandlers({ service: planning, resolveActor, authorizeMutation: assertMutationAllowed, requestIds: ids }),
      planningGeneration: createPlanningGenerationHandlers({ service: planningGeneration, resolveActor, authorizeMutation: assertMutationAllowed, requestIds: ids }),
      skills: createSkillsHttpHandlers({ service: skills, resolveActor, assertMutationAllowed, requestId: ids.next }),
      github: (action: Parameters<typeof createGitHubHandler>[1]) => {
        const handler = createGitHubHandler({ git, delivery, materials: deliveryMaterials, resolveActor, assertMutationAllowed, requestId: ids.next }, action);
        if (!["verifications.create", "submissions.create", "submissions.update"].includes(action)) return handler;
        // Retain the project/member/archive and confirmed-rule roots until the M06 write commits.
        // A module error response must roll back this outer transaction as well.
        return async (request: Request, params: Parameters<typeof handler>[1]) => {
          class RejectedResponse { readonly response: Response; constructor(response: Response) { this.response = response; } }
          try {
            return await database.transaction(async transaction => {
              await transaction.query("SELECT id FROM projects_project WHERE id=$1 FOR UPDATE", [params.projectId]);
              const response = await handler(request, params);
              if (!response.ok) throw new RejectedResponse(response);
              return response;
            });
          } catch (error) { if (error instanceof RejectedResponse) return error.response; throw error; }
        };
      },
      resources: createResourceHandlers({ service: resources, resolveActor, assertMutationAllowed, requestIds: ids }),
      retrospectives: createRetrospectiveHandlers({ service: retrospectives, authenticate: async request => { const actor = await resolveActor(request); if (!actor) throw new DomainError("UNAUTHENTICATED", "请先登录。", { status: 401 }); return actor; }, requestId: ids.next }),
    } };
}
export type Application = Awaited<ReturnType<typeof createApplication>>;
const applicationGlobal = globalThis as typeof globalThis & { hackathonApplication?: Promise<Application>; hackathonWorkers?: ReturnType<typeof startBackgroundWorkers>; hackathonStopping?: Promise<void> };
/** Shared across Next's instrumentation and route bundles: one application, one worker group. */
export function startApplicationWorkers(app: Application) {
  if (!applicationGlobal.hackathonWorkers) {
    applicationGlobal.hackathonWorkers = startBackgroundWorkers(app, { onDiscoveryCycle(report) {
      if (report.status !== "skipped") console.info("[discovery]", JSON.stringify({ status: report.status,
        searched: report.searched, fetched: report.fetched, saved: report.saved, unchanged: report.unchanged, rejected: report.rejected,
        ...(report.reason && /^[A-Z][A-Z0-9_]{0,63}$/.test(report.reason) ? { reason: report.reason } : {}) }));
    }, onInspirationCycle(report) {
      if (report.status !== "skipped") console.info("[inspiration]", JSON.stringify({ status: report.status,
        fetched: report.fetched, saved: report.saved, unchanged: report.unchanged, rejected: report.rejected,
        ...(report.reason && /^[A-Z][A-Z0-9_]{0,63}$/.test(report.reason) ? { reason: report.reason } : {}) }));
    } });
    bindWebWorkerCancellation(applicationGlobal.hackathonWorkers);
  }
  return applicationGlobal.hackathonWorkers;
}
export function getApplication(): Promise<Application> {
  if (!applicationGlobal.hackathonApplication && webRequestDrain.stopping) return Promise.reject(new Error("SERVER_STOPPING"));
  if (!applicationGlobal.hackathonApplication) applicationGlobal.hackathonApplication = loadConfig().then(config => createApplication(config)).catch(error => { applicationGlobal.hackathonApplication = undefined; throw error; });
  return applicationGlobal.hackathonApplication;
}
export function stopApplication(): Promise<void> {
  return applicationGlobal.hackathonStopping ??= (async () => {
    await drainAndClose({ requests: webRequestDrain, workers: applicationGlobal.hackathonWorkers,
      async close() { const app = await applicationGlobal.hackathonApplication; if (app) await app.database.close(); } });
  })();
}
