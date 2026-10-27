import { DomainError, isDomainError, toErrorEnvelope } from "../shared/errors.ts";
import { createMcpTokenService } from "./mcp-tokens.ts";
import { createProjectCharterService } from "./project-charter.ts";
import type { Application } from "./application.ts";
import { createHash } from "node:crypto";
import type { GitHubAuthorizationAction } from "../modules/github/index.ts";
import { readBackgroundStatus } from "./background.ts";
import type { ProjectsHttpRoute } from "../modules/projects/index.ts";
import type { GitHubAction } from "../modules/github/index.ts";
import { getLibraryArticle, listLibraryArticles } from "./library.ts";
import { listEvidenceOptions } from "./evidence-options.ts";
import { attachAiExecutionStatus, type AiExecutionKind } from "./ai-job-status.ts";
import { readBackendDashboard } from "./backend-dashboard.ts";
import { aiServiceSettings } from "./config.ts";
import { createMemberDisplayDecorators } from "./member-display.ts";
import { listAssignmentHistory } from "./assignment-history.ts";
import { OFFICIAL_EVENT_SOURCES } from "../modules/operations/index.ts";
import { createTeamCollaborationHandlers } from "../modules/team-collaboration/index.ts";
import type { RecruitingListFilter } from "../modules/recruiting/index.ts";
import { eventOfficialLinksHttpRoute } from "../modules/event-official-links/index.ts";

/** All module handlers run behind one bounded body, exact Origin and fixed-method boundary. */
async function boundedRequest(request: Request): Promise<Request> {
  if (!request.body || ["GET", "HEAD"].includes(request.method)) return request;
  const maximum = 6 * 1024 * 1024;
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > maximum)) throw new DomainError("BODY_TOO_LARGE", "请求内容超过限制。", { status: 413 });
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new DomainError("BODY_TIMEOUT", "读取请求超时，请重试。", { status: 408 })), 15_000); });
  try {
    for (;;) {
      const result = await Promise.race([reader.read(), timeout]);
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximum) throw new DomainError("BODY_TOO_LARGE", "请求内容超过限制。", { status: 413 });
      chunks.push(result.value);
    }
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { if (timer) clearTimeout(timer); reader.releaseLock(); }
  const data = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  return new Request(request.url, { method: request.method, headers: request.headers, body: data.buffer, signal: request.signal });
}
type RouteHandler = (request: Request) => Promise<Response>;
export async function dispatch(application: Application, incoming: Request, segments: readonly string[]): Promise<Response> {
  const requestId = application.ids.next();
  try {
    if (segments.some(segment => !segment || segment.length > 250 || segment.includes("/") || segment.includes("\\"))) throw new DomainError("INVALID_ROUTE", "路由标识无效。", { status: 400 });
    if (!["GET", "HEAD", "OPTIONS"].includes(incoming.method)) await application.assertMutationAllowed(incoming);
    const path = segments.join("/");
    let matched = false;
    let handler: RouteHandler | undefined;
    const route = (pattern: RegExp, methods: Record<string, (request: Request, match: RegExpMatchArray) => Promise<Response>>) => {
      const match = path.match(pattern);
      if (!match) return;
      matched = true;
      if (methods[incoming.method]) handler = request => methods[incoming.method](request, match);
    };
    const json = async (work: () => Promise<unknown> | unknown, status = 200) => Response.json({ data: await work(), requestId }, { status, headers: { "Cache-Control": "private, no-store" } });
    const executionStatus = async (kind: AiExecutionKind, authorizedResponse: Promise<Response>) => attachAiExecutionStatus(application.database, kind, await authorizedResponse);
    const actor = async (request: Request) => { const current = await application.resolveActor(request); if (!current) throw new DomainError("UNAUTHENTICATED", "请先登录。", { status: 401 }); return current; };
    const auth = application.authHandlers;
    const completeAuth = async (response: Response) => {
      if(response.ok) {
        const payload=await response.clone().json() as {data?:{profile?:{id?:string}}};
        const id=payload.data?.profile?.id;
        if(id) await application.personalWorkspace.session({userId:id,platformRoles:["user"]});
      }
      return response;
    };
    route(/^system\/status$/, { GET: () => json(() => ({ mode: application.config.mode, database: application.database.mode,
      email: application.config.resendKey || application.config.smtp ? "configured" : application.config.mode === "local" && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(application.config.origin).hostname) ? "preview" : "unconfigured", modelConfigured: Boolean(aiServiceSettings(application.config)), githubConfigured: Boolean(application.config.github), dshConfigured: Boolean(application.config.dsh), discoveryConfigured: Boolean(application.config.discovery), discoveryProvider: application.config.discovery ? application.config.discovery.provider ?? "brave" : null, discoverySources: application.config.discovery?.provider === "official_sources" ? OFFICIAL_EVENT_SOURCES.filter(source => application.config.discovery!.worker.queries.includes(source.id)).map(source => ({ name: source.name, url: source.listUrl })) : [] })) });
    const admin = async (request: Request) => { const current = await actor(request); const fresh = await application.database.query("SELECT id FROM auth_users WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL AND 'admin'=ANY(platform_roles)", [current.userId]); if (!fresh.rows.length) throw new DomainError("FORBIDDEN", "此页面需要管理员权限。", { status: 403 }); return current; };
    const principal = async (request: Request) => {
      const current = await actor(request), token = application.authHandlers.readSessionToken(request);
      if (!token) throw new DomainError("UNAUTHENTICATED", "请重新登录。", { status: 401 });
      const tokenHash = createHash("sha256").update(token).digest("hex");
      const guard = async (sql: import("../shared/persistence.ts").SqlExecutor) => {
        const valid = await sql.query("SELECT id FROM auth_sessions WHERE token_hash=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>$3::timestamptz FOR SHARE", [tokenHash,current.userId,application.clock.now().toISOString()]);
        if(!valid.rowCount) throw new DomainError("UNAUTHENTICATED","本次登录已失效，请重新登录。",{status:401});
      };
      return { actor: current, guard };
    };
    const authenticatedResponse = async (request: Request, work: () => Promise<Response>) => {
      const current = await principal(request);
      class RejectedResponse extends Error {
        readonly response: Response;
        constructor(response: Response) { super("Handler rejected request"); this.response = response; }
      }
      try {
        return await application.database.transaction(async sql => {
          const account = await sql.query("SELECT id FROM auth_users WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL FOR SHARE", [current.actor.userId]);
          if (!account.rowCount) throw new DomainError("UNAUTHENTICATED", "账号已失效，请重新登录。", { status: 401 });
          await current.guard(sql);
          const response = await work();
          if (!response.ok) throw new RejectedResponse(response);
          await current.guard(sql);
          return response;
        });
      } catch (error) {
        if (error instanceof RejectedResponse) return error.response;
        throw error;
      }
    };
    route(/^me\/judging-competitions$/, {GET:request=>json(async()=>{
      const current=await application.resolvePrincipal(request);
      if(!current) throw new DomainError("UNAUTHENTICATED","请先登录。",{status:401});
      return application.database.transaction(async sql=>{
        await current.guard(sql);
        const eventIds=await application.organizerIntegration.judging.listAssignedEventIds(current);
        const items:{eventId:string;title:string;organizationName:string;status:string}[]=[];
        for(const eventId of eventIds){const event=await application.organizerIntegration.events.getEvent(sql,eventId);if(event&&["published","ended"].includes(event.status))items.push({eventId:event.eventId,title:event.title,organizationName:event.organizationName,status:event.status});}
        await current.guard(sql);return {items};
      });
    })});
    route(/^admin\/operations\/audit$/, { GET: request => authenticatedResponse(request, () => application.handlers.auditQuery.list(request)) });
    route(/^admin\/sources\/([^/]+)\/observability$/, {GET:(request,m)=>application.operationsObservability.handlers.source(m[1])(request)});
    route(/^admin\/resources\/link-checks$/, {GET:request=>application.resourceLinkMaintenance.handlers.status(request)});
    route(/^admin\/operations\/retention$/, { GET: request => authenticatedResponse(request, () => json(async () => { await admin(request); return application.retentionMaintenance.status(); })) });
    const account = application.accountHandlers;
    route(/^me\/data-controls$/, {GET: account.getDataOverview});
    route(/^me\/data-exports$/, {POST: account.requestExport});
    route(/^me\/data-exports\/prepare$/, {POST: account.prepareExport});
    route(/^me\/data-exports\/download$/, {GET: account.downloadExport});
    route(/^me\/deletion-requests$/, {POST: account.requestDeletion});
    route(/^me\/deletion-requests\/refresh$/, {POST: account.refreshDeletion});
    route(/^me\/deletion-requests\/cancel$/, {POST: account.cancelDeletion});
    route(/^me\/email-change-challenges$/, {POST: account.requestEmailChange});
    // This service consumes the old session intentionally; it owns atomic session checks.
    route(/^me\/email-change-challenges\/verify$/, {POST: account.verifyEmailChange});
    const notifications = application.handlers.planningNotifications;
    route(/^me\/planning-notifications$/, { GET: request => authenticatedResponse(request, () => notifications.listOwn(request)) });
    route(/^me\/planning-notifications\/([^/]+)\/read$/, { POST: (request,m) => authenticatedResponse(request, () => notifications.markRead(request,m[1])) });
    route(/^me\/planning-notifications\/([^/]+)\/dismiss$/, { POST: (request,m) => authenticatedResponse(request, () => notifications.dismissResolved(request,m[1])) });
    route(/^me\/onboarding$/, {
      GET: request => authenticatedResponse(request, () => json(async () => application.onboarding.get(await actor(request)))),
      POST: request => authenticatedResponse(request, () => json(async () => application.onboarding.save(await actor(request), await request.json()))),
    });
    route(/^me\/dsh-session$/, { GET: request => json(async()=>{const current=await principal(request);return application.personalWorkspace.session(current.actor,current.guard);}) });
    route(/^me\/participant-profile$/, { GET: request=>json(async()=>{const current=await principal(request);return application.participantProfiles.get(current.actor,current.guard);}), PATCH: request=>json(async()=>{const current=await principal(request);return application.participantProfiles.update(current.actor,await request.json(),current.guard);}) });
    const recruitingFilter = (request: Request): RecruitingListFilter => {
      const query = new URL(request.url).searchParams;
      return { ...(query.has("role") ? { role: query.get("role")! as RecruitingListFilter["role"] } : {}), ...(query.has("purpose") ? { purpose: query.get("purpose")! as RecruitingListFilter["purpose"] } : {}),
        ...(query.has("keyword") ? { keyword: query.get("keyword")! } : {}), ...(query.has("cursor") ? { cursor: query.get("cursor")! } : {}),
        ...(query.has("limit") ? { limit: Number(query.get("limit")) } : {}) };
    };
    const imageResponse = (value: { bytes: Uint8Array; mimeType: string }) => new Response(new Uint8Array(value.bytes), {
      headers: { "Content-Type": value.mimeType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'" },
    });
    route(/^me\/recruiting-profile$/, {
      GET: request => json(async () => { const p = await principal(request); return application.recruiting.getProfile(p.actor, p.guard); }),
      PATCH: request => json(async () => { const p = await principal(request); return application.recruiting.saveProfile(p.actor, await request.json(), p.guard); }),
    });
    route(/^me\/recruiting-profile\/summary$/, { POST: request => json(async () => { const p = await principal(request); return application.recruiting.generateSummary(p.actor, await request.json(), p.guard); }, 201) });
    route(/^me\/recruiting-profile\/avatar$/, {
      GET: async request => { const p = await principal(request); return imageResponse(await application.recruiting.getOwnAvatar(p.actor, p.guard)); },
      POST: request => json(async () => { const p = await principal(request); return application.recruiting.saveAvatar(p.actor, await request.json(), p.guard); }),
      DELETE: request => json(async () => { const p = await principal(request); return application.recruiting.removeAvatar(p.actor, await request.json(), p.guard); }),
    });
    route(/^me\/recruiting-card\/publish$/, { POST: request => json(async () => { const p = await principal(request); return application.recruiting.publishCard(p.actor, await request.json(), p.guard); }, 201) });
    route(/^me\/recruiting-card\/withdraw$/, { POST: request => json(async () => { const p = await principal(request); return application.recruiting.withdrawCard(p.actor, await request.json(), p.guard); }) });
    route(/^recruiting\/cards$/, { GET: request => json(() => application.recruiting.listCards(recruitingFilter(request))) });
    route(/^recruiting\/cards\/([^/]+)\/avatar$/, { GET: async (request, m) => imageResponse(await application.recruiting.getPublicAvatar(m[1], Number(new URL(request.url).searchParams.get("revision")) || undefined)) });
    route(/^recruiting\/posts$/, { GET: request => json(() => application.recruiting.listPosts(recruitingFilter(request))) });
    route(/^me\/recruiting-applications$/, { GET: request => json(async () => { const p = await principal(request); return application.recruiting.listOwnApplications(p.actor, p.guard); }) });
    route(/^recruiting\/posts\/([^/]+)\/applications$/, { POST: (request,m) => json(async () => { const p = await principal(request); return application.recruiting.apply(p.actor, m[1], await request.json(), p.guard); }, 201) });
    route(/^recruiting\/applications\/([^/]+)\/review$/, { POST: (request,m) => json(async () => { const p = await principal(request); return application.recruiting.reviewApplication(p.actor, m[1], await request.json(), p.guard); }) });
    route(/^recruiting\/applications\/([^/]+)\/withdraw$/, { POST: (request,m) => json(async () => { const p = await principal(request); return application.recruiting.withdrawApplication(p.actor, m[1], await request.json(), p.guard); }) });
    route(/^recruiting\/applications\/([^/]+)\/join$/, { POST: (request,m) => json(async () => { const p = await principal(request); return application.recruiting.joinApproved(p.actor, m[1], await request.json(), p.guard); }) });
    route(/^projects\/([^/]+)\/recruiting-post$/, {
      GET: (request,m) => json(async () => { const p = await principal(request); return application.recruiting.getPost(p.actor,m[1],p.guard); }),
      POST: (request,m) => json(async () => { const p = await principal(request); return application.recruiting.savePost(p.actor,m[1],await request.json(),p.guard); },201),
      PATCH: (request,m) => json(async () => { const p = await principal(request); return application.recruiting.savePost(p.actor,m[1],await request.json(),p.guard); }),
    });
    route(/^projects\/([^/]+)\/recruiting-post\/gaps$/, { GET: (request,m) => json(async () => { const p = await principal(request); return application.recruiting.postGaps(p.actor,m[1],p.guard); }) });
    route(/^projects\/([^/]+)\/recruiting-applications$/, { GET: (request,m) => json(async () => { const p = await principal(request); return application.recruiting.listProjectApplications(p.actor,m[1],p.guard); }) });
    route(/^projects\/([^/]+)\/task-pool$/, { GET: (request,m) => authenticatedResponse(request, () => json(async () => application.planning.getTaskPool(await actor(request),m[1]))) });
    // 本人手动待办（规划27 第1期）：只有本人可读写，队友不可见；派生待办不在此落库。
    route(/^projects\/([^/]+)\/space-todos$/, {
      GET: (request,m) => authenticatedResponse(request, () => json(async () => application.spaceTodos.list(await actor(request), m[1]))),
      POST: (request,m) => authenticatedResponse(request, () => json(async () => application.spaceTodos.create(await actor(request), m[1], await request.json()), 201)),
    });
    for (const operation of ["edit", "remove"] as const) {
      route(new RegExp(`^projects/([^/]+)/space-todos/([^/]+)/${operation}$`), { POST: (request,m) => authenticatedResponse(request, () => json(async () => {
        const user = await actor(request);
        if (operation === "edit") return application.spaceTodos.update(user, m[1], m[2], await request.json());
        return application.spaceTodos.remove(user, m[1], m[2]);
      })) });
    }
    // 空间文档（规划27 第1期追加）：团队成员可读，作者本人可改可删。
    route(/^projects\/([^/]+)\/space-documents$/, {
      GET: (request,m) => authenticatedResponse(request, () => json(async () => application.spaceDocuments.list(await actor(request), m[1]))),
      POST: (request,m) => authenticatedResponse(request, () => json(async () => application.spaceDocuments.create(await actor(request), m[1], await request.json()), 201)),
    });
    route(/^projects\/([^/]+)\/team-supervision$/, {
      GET: (request,m) => json(async () => { const p = await principal(request); return application.spaceCollaboration.supervision.get(p.actor,m[1],p.guard); }),
      PUT: (request,m) => json(async () => { const p = await principal(request); return application.spaceCollaboration.supervision.settings(p.actor,m[1],await request.json(),p.guard); }),
    });
    route(/^projects\/([^/]+)\/team-supervision\/check$/, {
      POST: (request,m) => json(async () => { const p = await principal(request); const body = await request.json(); if (!body || Array.isArray(body) || typeof body !== "object" || Object.keys(body).length) throw new DomainError("INVALID_INPUT","请重新打开协作提醒。",{status:422}); return application.spaceCollaboration.supervision.check(p.actor,m[1],p.guard); }),
    });
    route(/^projects\/([^/]+)\/space-changes$/, {
      GET: (request,m) => json(async () => { const p = await principal(request), url = new URL(request.url), options = { ...(url.searchParams.has("beforeVersion") ? {beforeVersion:Number(url.searchParams.get("beforeVersion"))} : {}), ...(url.searchParams.has("limit") ? {limit:Number(url.searchParams.get("limit"))} : {}) }; return application.spaceCollaboration.changes(p.guard).list(p.actor,m[1],options); }),
    });
    route(/^projects\/([^/]+)\/space-changes\/reconcile$/, {
      POST: (request,m) => json(async () => { const p = await principal(request); const body = await request.json(); if (!body || Array.isArray(body) || typeof body !== "object" || Object.keys(body).length) throw new DomainError("INVALID_INPUT","只可检查当前团队记录。",{status:422}); return application.spaceCollaboration.changes(p.guard).reconcile(p.actor,m[1]); }),
    });
    route(/^projects\/([^/]+)\/space-changes\/acknowledge$/, {
      POST: (request,m) => json(async () => { const p = await principal(request); return application.spaceCollaboration.changes(p.guard).acknowledge(p.actor,m[1],await request.json()); }),
    });
    route(/^projects\/([^/]+)\/document-drafts$/, {
      GET: (request,m) => json(async () => { const p = await principal(request); return application.spaceCollaboration.drafts.list(p.actor,m[1],p.guard); }),
    });
    route(/^projects\/([^/]+)\/document-drafts\/([^/]+)$/, {
      GET: (request,m) => json(async () => { const p = await principal(request); return application.spaceCollaboration.drafts.get(p.actor,m[1],m[2] === "new" ? null : m[2],p.guard); }),
      PUT: (request,m) => json(async () => { const p = await principal(request); return application.spaceCollaboration.drafts.save(p.actor,m[1],m[2] === "new" ? null : m[2],await request.json(),p.guard); }),
    });
    route(/^projects\/([^/]+)\/document-drafts\/([^/]+)\/(remove|publish)$/, {
      POST: (request,m) => json(async () => { const p = await principal(request), slot = m[2] === "new" ? null : m[2], input = await request.json(); return m[3] === "remove" ? application.spaceCollaboration.drafts.remove(p.actor,m[1],slot,input,p.guard) : application.spaceCollaboration.drafts.publish(p.actor,m[1],slot,input,p.guard); }),
    });
    route(/^projects\/([^/]+)\/document-draft-publications\/([^/]+)$/, {
      GET: (request,m) => json(async () => { const p = await principal(request); return application.spaceCollaboration.drafts.getPublication(p.actor,m[1],m[2],p.guard); }),
    });
    // 空间画布摆放（"组件箱 + 自由画布"）：只存本人摆放，不动业务数据；删除只是从画布移除。
    route(/^projects\/([^/]+)\/space-canvas$/, {
      GET: (request,m) => authenticatedResponse(request, () => json(async () => application.spaceCanvasLayouts.get(await actor(request), m[1]))),
      PUT: (request,m) => authenticatedResponse(request, () => json(async () => application.spaceCanvasLayouts.save(await actor(request), m[1], await request.json()))),
    });
    for (const operation of ["edit", "remove", "share"] as const) {
      route(new RegExp(`^projects/([^/]+)/space-documents/([^/]+)/${operation}$`), { POST: (request,m) => authenticatedResponse(request, () => json(async () => {
        const user = await actor(request);
        if (operation === "edit") return application.spaceDocuments.update(user, m[1], m[2], await request.json());
        if (operation === "share") return application.spaceDocuments.share(user, m[1], m[2], await request.json());
        return application.spaceDocuments.remove(user, m[1], m[2]);
      })) });
    }
    for (const operation of ["claim", "release", "assign"] as const) {
      route(new RegExp(`^projects/([^/]+)/plan-versions/([^/]+)/tasks/([^/]+)/${operation}$`), { POST: (request,m) => authenticatedResponse(request, () => json(async () => {
        const user = await actor(request), input = await request.json();
        if (operation === "claim") return application.planning.claimDraftTask(user,m[1],m[2],m[3],input);
        if (operation === "release") return application.planning.releaseDraftTask(user,m[1],m[2],m[3],input);
        return application.planning.assignDraftTask(user,m[1],m[2],m[3],input);
      })) });
    }
    const teamFeed = createTeamCollaborationHandlers({ service: application.teamCollaboration, resolveActor: application.resolveActor,
      authorizeMutation: application.assertMutationAllowed, requestIds: application.ids });
    route(/^projects\/([^/]+)\/team-feed$/, {
      GET: (request,m) => authenticatedResponse(request, () => teamFeed.listFeed(request,{projectId:m[1]})),
      POST: (request,m) => authenticatedResponse(request, () => teamFeed.publish(request,{projectId:m[1]})),
    });
    route(/^projects\/([^/]+)\/team-feed\/([^/]+)$/, { PATCH: (request,m) => authenticatedResponse(request, () => teamFeed.edit(request,{projectId:m[1],suggestionId:m[2]})) });
    route(/^projects\/([^/]+)\/team-feed\/([^/]+)\/withdraw$/, { POST: (request,m) => authenticatedResponse(request, () => teamFeed.withdraw(request,{projectId:m[1],suggestionId:m[2]})) });
    route(/^projects\/([^/]+)\/team-feed\/([^/]+)\/adopt$/, { POST: (request,m) => authenticatedResponse(request, () => teamFeed.adopt(request,{projectId:m[1],suggestionId:m[2]})) });
    // 规划38：项目框架卡（防跑偏的锚点）。AI 只读，写入口只给本人。
    route(/^projects\/([^/]+)\/charter$/, {
      GET: (request, m) => json(async () => {
        const current = await principal(request);
        const service = createProjectCharterService({ database: application.database, clock: application.clock, canAccess: async (userId, projectId) => {
          try { await application.projects.getProject({ userId, platformRoles: [] } as never, projectId); return true; } catch { return false; }
        } });
        return { charter: await service.read(current.actor.userId, m[1]) };
      }),
      PUT: (request, m) => json(async () => {
        const current = await principal(request);
        const service = createProjectCharterService({ database: application.database, clock: application.clock, canAccess: async (userId, projectId) => {
          try { await application.projects.getProject({ userId, platformRoles: [] } as never, projectId); return true; } catch { return false; }
        } });
        return { charter: await service.save(current.actor.userId, m[1], await request.json().catch(() => ({}))) };
      }),
    });

    route(/^projects\/([^/]+)\/assistant\/conversation$/, {
      GET: (request,m) => json(async () => { const p = await principal(request); return application.teamAssistant.conversation(p.actor,m[1],p.guard); }),
      DELETE: (request,m) => json(async () => { const p = await principal(request), input = await request.json(); return application.teamAssistant.clearConversation(p.actor,m[1],input.expectedRevision,p.guard); }),
    });
    route(/^projects\/([^/]+)\/assistant\/messages$/, { POST: (request,m) => json(async () => { const p = await principal(request); return application.teamAssistant.send(p.actor,m[1],await request.json(),p.guard); }) });
    route(/^projects\/([^/]+)\/assistant\/context$/, { GET: (request,m) => json(async () => { const p = await principal(request); return application.teamAssistant.getContext(p.actor,m[1],p.guard); }) });
    route(/^projects\/([^/]+)\/assistant\/feasibility$/, {
      GET: (request,m) => json(async () => { const p = await principal(request); return application.teamAssistant.listFeasibility(p.actor,m[1],p.guard); }),
      POST: (request,m) => json(async () => { const p = await principal(request); return application.teamAssistant.generateFeasibility(p.actor,m[1],await request.json(),p.guard); },201),
    });
    route(/^projects\/([^/]+)\/feasibility-reports$/, {
      GET: (request,m) => json(async () => { const p = await principal(request); return application.teamAssistant.listFeasibility(p.actor,m[1],p.guard); }),
      POST: (request,m) => json(async () => { const p = await principal(request); return application.teamAssistant.generateFeasibility(p.actor,m[1],await request.json(),p.guard); },201),
    });
    const artifactSpace = (item: import("../shared/personal-ai.ts").PersonalArtifact) => {
      if (!["space_assistant_reply", "project_feasibility"].includes(item.kind)) return null;
      const value = item.data && typeof item.data === "object" ? (item.data as Record<string, unknown>).projectId : null;
      if (typeof value !== "string" || !value) throw new DomainError("ARTIFACT_UNAVAILABLE", "这份记录缺少空间依据，暂时无法读取。", { status: 404 });
      return value;
    };
    route(/^me\/artifacts$/, { GET: request => json(async()=>{
      const current=await principal(request);
      const artifacts=await application.personalWorkspace.list(current.actor,new URL(request.url).searchParams.get("kind") as import("../shared/personal-ai.ts").PersonalArtifactKind,current.guard);
      return application.database.transaction(async sql => {
        await current.guard(sql); const available = new Set<string>();
        const scopes = [...new Set(artifacts.map(artifactSpace).filter((id): id is string => id !== null))].sort();
        for(const projectId of scopes) {
          try { await application.projects.getProject(current.actor,projectId); available.add(projectId); }
          catch(error) { if(isDomainError(error) && [403,404].includes(error.status)) continue; throw error; }
        }
        const allowed = artifacts.filter(item => { const projectId = artifactSpace(item); return projectId === null || available.has(projectId); });
        await current.guard(sql);return allowed;
      });
    }) });
    route(/^me\/artifacts\/([^/]+)$/, { GET: (request,m) => json(async()=>{
      const current=await principal(request), item=await application.personalWorkspace.get(current.actor,m[1],current.guard);
      return application.database.transaction(async sql => { await current.guard(sql);const projectId=artifactSpace(item);if(projectId) await application.projects.getProject(current.actor,projectId);await current.guard(sql);return item; });
    }) });
    route(/^me\/participation\/context$/, { GET: request=>json(async()=>{const current=await principal(request);return application.participation.getContext(current.actor,new URL(request.url).searchParams.get("eventId")??"",current.guard);}) });
    route(/^me\/participation\/plans$/, { POST: request=>json(async()=>{const current=await principal(request);return application.participation.generate(current.actor,await request.json(),current.guard);},201) });
    route(/^me\/roadshow\/scripts$/, { POST: request=>json(async()=>{const current=await principal(request);return application.roadshow.generate(current.actor,await request.json(),current.guard);},201) });
    route(/^me\/ppt\/outlines$/, { POST: request=>json(async()=>{const current=await principal(request);return application.ppt.generate(current.actor,await request.json(),current.guard);},201) });
    route(/^me\/presentation-projects\/([^/]+)$/, { GET: (request,m)=>json(async()=>{const current=await principal(request);return application.presentationProjectContext.readSnapshot(current.actor,m[1],current.guard);}) });
    // 规划37 P1：插件接入令牌（PAT）。只存哈希、可撤销、默认只读。
    route(/^me\/mcp-tokens$/, {
      GET: request => json(async () => {
        const current = await principal(request);
        const tokens = createMcpTokenService({ database: application.database, clock: application.clock, ids: application.ids });
        return { tokens: await tokens.list(current.actor.userId) };
      }),
      POST: request => json(async () => {
        const current = await principal(request);
        const tokens = createMcpTokenService({ database: application.database, clock: application.clock, ids: application.ids });
        // 明文只在这里返回一次；后续任何读取都没有 secret。
        return tokens.create(current.actor.userId, await request.json().catch(() => ({})));
      }),
    });
    route(/^me\/mcp-tokens\/([^/]+)$/, {
      DELETE: (request, m) => json(async () => {
        const current = await principal(request);
        const tokens = createMcpTokenService({ database: application.database, clock: application.clock, ids: application.ids });
        return tokens.revoke(current.actor.userId, m[1]);
      }),
    });

    route(/^navigator\/conversation$/, { GET: request => json(async()=>{
      const current=await principal(request),projectId=new URL(request.url).searchParams.get("projectId")??undefined;
      return application.personalWorkspace.conversation(current.actor,projectId,async sql=>{await current.guard(sql);if(projectId) await application.projects.getProject(current.actor,projectId);});
    }), DELETE: request=>json(async()=>{
      const current=await principal(request),projectId=new URL(request.url).searchParams.get("projectId")??undefined;
      return application.personalWorkspace.clearConversation(current.actor,projectId,async sql=>{await current.guard(sql);if(projectId) await application.projects.getProject(current.actor,projectId);});
    }) });
    route(/^admin\/discovery\/status$/, { GET: request => json(async () => { await admin(request); return application.dshBackend.status(); }) });
    route(/^admin\/discovery\/paused$/, { POST: request => json(async () => application.dshBackend.setPaused(await admin(request), await request.json())) });
    route(/^admin\/workers$/, { GET: request => json(async () => { await admin(request); return readBackgroundStatus(application.database); }) });
    route(/^admin\/backend-dashboard$/, { GET: request => json(async () => readBackendDashboard({ database: application.database, config: application.config, clock: application.clock }, await actor(request))) });
    route(/^library$/, { GET: request => json(() => { const params = new URL(request.url).searchParams; return listLibraryArticles(params.get("query") ?? "", params.get("category") ?? ""); }) });
    route(/^library\/([^/]+)$/, { GET: (_request, m) => json(() => getLibraryArticle(m[1])) });
    route(/^event-discoveries$/, { GET: request => json(() => { const params = new URL(request.url).searchParams; return application.discoveries.list({ limit: params.has("limit") ? Number(params.get("limit")) : undefined, query: params.get("query") ?? undefined, cursor: params.get("cursor") ?? undefined }); }) });
    route(/^event-discoveries\/([^/]+)$/, { GET: (_request, m) => json(() => application.discoveries.get(m[1])) });
    route(/^event-discoveries\/live$/, { GET: () => json(() => application.discoveryLive.snapshot()) });
    route(/^inspiration$/, { GET: () => json(() => application.inspiration.snapshot()) });
    route(/^admin\/inspiration\/status$/, { GET: request => json(async () => { await admin(request); return application.inspiration.status(); }) });
    route(/^admin\/inspiration\/paused$/, { POST: request => json(async () => application.inspiration.setPaused(await admin(request), await request.json())) });
    route(/^navigator\/intro$/, { GET: () => json(() => application.navigator.intro()) });
    route(/^navigator\/messages$/, { POST: request => json(async () => {
      const current = await actor(request); const token = application.authHandlers.readSessionToken(request);
      if (!token) throw new DomainError("UNAUTHENTICATED", "请重新登录。", { status: 401 });
      const tokenHash = createHash("sha256").update(token).digest("hex");
      try {
      return await application.navigator.reply(current, await request.json(), async sql => {
        const session = await sql.query("SELECT id FROM auth_sessions WHERE token_hash=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>$3::timestamptz FOR SHARE", [tokenHash, current.userId, application.clock.now().toISOString()]);
        if (!session.rows.length) throw new DomainError("UNAUTHENTICATED", "本次会话已失效，请重新登录。", { status: 401 });
      });
      } catch (error) {
        if (isDomainError(error)) throw error;
        console.error("[navigator] reply failed", (error as { code?: string }).code ?? error?.constructor?.name, (error as { externalState?: string }).externalState ?? "", error instanceof Error ? error.stack ?? error.message : String(error));
        throw new DomainError("AI_UNAVAILABLE", "AI 服务这次没连上（DeepSeek Harness），请稍后再试；网站其它功能不受影响。", { status: 503 });
      }
    }) });
    route(/^dev\/mailbox$/, { GET: request => json(async () => {
      if (application.config.mode !== "local" || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(application.config.origin).hostname) || new URL(request.url).origin !== application.config.origin) throw new DomainError("NOT_FOUND", "页面不存在。", { status: 404 });
      const result = await application.database.query<{ id: string; recipient: string; subject: string; body: string; created_at: Date }>("SELECT id,recipient,subject,body,created_at FROM development_mailbox WHERE created_at >= now() - interval '15 minutes' ORDER BY created_at DESC LIMIT 20");
      return result.rows.map(row => ({ id: row.id, recipient: row.recipient, subject: row.subject, body: row.body, createdAt: new Date(row.created_at).toISOString() }));
    }) });
    route(/^auth\/login-challenges$/, { POST: request => auth.requestLoginChallenge(request) });
    route(/^auth\/login-challenges\/verify$/, { POST: async request => completeAuth(await auth.verify(request)) });
    route(/^auth\/registration-challenges$/, { POST: request => auth.requestRegistrationChallenge(request) });
    route(/^auth\/registration-challenges\/verify$/, { POST: async request => completeAuth(await auth.verifyRegistration(request)) });
    route(/^auth\/guancha\/status$/, { GET: application.guanchaHandlers.status });
    route(/^auth\/guancha\/begin$/, { POST: application.guanchaHandlers.begin });
    route(/^auth\/guancha\/callback$/, { GET: application.guanchaHandlers.callback });
    route(/^auth\/guancha\/confirm$/, { POST: application.guanchaHandlers.confirm });
    route(/^auth\/guancha\/cancel$/, { POST: application.guanchaHandlers.cancel });
    route(/^auth\/logout$/, { POST: request => auth.logout(request) });
    route(/^auth\/logout-all$/, { POST: request => auth.logoutAll(request) });
    route(/^me$/, { GET: request => auth.getMe(request), PATCH: request => auth.patchMe(request) });
    route(/^me\/permissions$/, { GET: request => json(async () => ({ platformRoles: (await actor(request)).platformRoles })) });
    route(/^me\/sessions$/, { GET: request => auth.listSessions(request) });
    route(/^me\/account-settings$/, { GET: request => auth.getAccountSettings(request) });
    route(/^me\/current-session$/, { GET: request => auth.getCurrentSession(request) });
    route(/^me\/sessions\/revoke$/, { POST: request => auth.revokeSession(request) });
    const displays = createMemberDisplayDecorators({ database: application.database });
    const project = (descriptor: (match: RegExpMatchArray) => ProjectsHttpRoute) => async (request: Request, match: RegExpMatchArray) => {
      const target = descriptor(match);
      const work = () => application.handlers.projects.handle(request, target);
      const response = target.kind === "publicInvitationPreview" ? await work() : await authenticatedResponse(request, work);
      if (request.method !== "GET" || !response.ok) return response;
      if (target.kind === "project" || target.kind === "projectMembers") return displays.project(await actor(request), target.projectId, response);
      if (target.kind === "team" || target.kind === "teamMembers") return displays.team(await actor(request), target.teamId, response);
      return response;
    };
    route(/^projects$/, { GET: project(() => ({ kind: "projects" })), POST: project(() => ({ kind: "projects" })) });
    route(/^projects\/([^/]+)$/, { GET: project(m => ({ kind: "project", projectId: m[1] })), PATCH: project(m => ({ kind: "project", projectId: m[1] })) });
    const projectPaths: [string, ProjectsHttpRoute["kind"], string[]][] = [
      ["team", "projectTeam", ["PUT"]], ["invitations", "projectInvitations", ["GET", "POST"]], ["leave", "projectLeave", ["POST"]],
      ["my-availability", "projectAvailability", ["GET", "PUT"]], ["stage", "projectStage", ["POST"]], ["clone", "projectClone", ["POST"]],
      ["activity", "projectActivity", ["GET"]], ["resources", "projectResources", ["GET", "POST"]],
    ];
    for (const [suffix, kind, methods] of projectPaths) route(new RegExp(`^projects/([^/]+)/${suffix}$`), Object.fromEntries(methods.map(method => [method, project(m => ({ kind, projectId: m[1] } as ProjectsHttpRoute))])));
    route(/^projects\/([^/]+)\/members\/([^/]+)$/, { PATCH: project(m => ({ kind: "projectMember", projectId: m[1], userId: m[2] })), DELETE: project(m => ({ kind: "projectMember", projectId: m[1], userId: m[2] })) });
    route(/^projects\/([^/]+)\/members$/, { GET: project(m => ({ kind: "projectMembers", projectId: m[1] })) });
    route(/^projects\/([^/]+)\/management-transfer$/, { POST: project(m => ({ kind: "projectManagementTransfer", projectId: m[1] })) });
    route(/^projects\/([^/]+)\/invitations\/([^/]+)$/, { DELETE: project(m => ({ kind: "projectInvitation", projectId: m[1], invitationId: m[2] })) });
    route(/^projects\/([^/]+)\/resources\/([^/]+)$/, { DELETE: project(m => ({ kind: "projectResource", projectId: m[1], bookmarkId: m[2] })) });
    const collaboration = (kind: "officialTracks" | "trackSelection" | "myIntention" | "sharedIntentions") => (request: Request, m: RegExpMatchArray) => authenticatedResponse(request, () => application.handlers.collaboration.handle(request, { kind, projectId: m[1] }));
    route(/^projects\/([^/]+)\/official-tracks$/, { GET: collaboration("officialTracks") });
    route(/^projects\/([^/]+)\/track-selection$/, { PUT: collaboration("trackSelection") });
    route(/^projects\/([^/]+)\/my-intention$/, { GET: collaboration("myIntention"), PUT: collaboration("myIntention") });
    route(/^projects\/([^/]+)\/shared-intentions$/, { GET: collaboration("sharedIntentions") });
    route(/^projects\/([^/]+)\/role-help-jobs$/, { POST: (request,m) => authenticatedResponse(request, () => application.handlers.roleHelp.queue(request, { projectId: m[1] })) });
    route(/^role-help-jobs\/([^/]+)$/, { GET: (request,m) => executionStatus("m04_role_help", authenticatedResponse(request, () => application.handlers.roleHelp.job(request, { jobId: m[1] }))) });
    route(/^projects\/([^/]+)\/role-help\/latest$/, { GET: (request,m) => authenticatedResponse(request, () => application.handlers.roleHelp.latest(request, { projectId: m[1] })) });
    route(/^projects\/([^/]+)\/evidence-options$/, { GET: (request, m) => json(async () => listEvidenceOptions(application, await actor(request), m[1])) });
    const discoveryDraft = (method: "get" | "save" | "clear") => async (request: Request, m: RegExpMatchArray) => json(async () => {
      const current = await actor(request), token = application.authHandlers.readSessionToken(request);
      if (!token) throw new DomainError("UNAUTHENTICATED", "请重新登录。", { status: 401 });
      const tokenHash = createHash("sha256").update(token).digest("hex");
      const session = async (sql: import("../shared/persistence.ts").SqlExecutor) => {
        const result = await sql.query("SELECT id FROM auth_sessions WHERE token_hash=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>$3::timestamptz FOR SHARE", [tokenHash, current.userId, application.clock.now().toISOString()]);
        if (!result.rowCount) throw new DomainError("UNAUTHENTICATED", "本次会话已失效，请重新登录。", { status: 401 });
      };
      if (method === "get") return application.projectDiscoveries.get(current, m[1], session);
      return application.projectDiscoveries[method](current, m[1], await request.json(), session);
    });
    route(/^projects\/([^/]+)\/discovery-draft$/, { GET: discoveryDraft("get"), POST: discoveryDraft("save"), DELETE: discoveryDraft("clear") });
    route(/^invitations\/([^/]+)\/accept$/, { POST: project(m => ({ kind: "invitationAccept", token: m[1] })) });
    route(/^invitations\/([^/]+)\/public-preview$/, { GET: project(m => ({ kind: "publicInvitationPreview", token: m[1] })) });
    route(/^invitations\/([^/]+)$/, { GET: project(m => ({ kind: "invitationPreview", token: m[1] })) });
    route(/^teams$/, { GET: project(() => ({ kind: "teams" })), POST: project(() => ({ kind: "teams" })) });
    route(/^teams\/([^/]+)$/, { GET: project(m => ({ kind: "team", teamId: m[1] })), PATCH: project(m => ({ kind: "team", teamId: m[1] })), DELETE: project(m => ({ kind: "team", teamId: m[1] })) });
    route(/^teams\/([^/]+)\/invitations$/, { GET: project(m => ({ kind: "teamInvitations", teamId: m[1] })), POST: project(m => ({ kind: "teamInvitations", teamId: m[1] })) });
    route(/^teams\/([^/]+)\/invitations\/([^/]+)$/, { DELETE: project(m => ({ kind: "teamInvitation", teamId: m[1], invitationId: m[2] })) });
    route(/^teams\/([^/]+)\/members\/([^/]+)$/, { PATCH: project(m => ({ kind: "teamMember", teamId: m[1], userId: m[2] })), DELETE: project(m => ({ kind: "teamMember", teamId: m[1], userId: m[2] })) });
    route(/^teams\/([^/]+)\/members$/, { GET: project(m => ({ kind: "teamMembers", teamId: m[1] })) });
    route(/^teams\/([^/]+)\/captain-transfer$/, { POST: project(m => ({ kind: "teamCaptainTransfer", teamId: m[1] })) });
    route(/^teams\/([^/]+)\/leave$/, { POST: project(m => ({ kind: "teamLeave", teamId: m[1] })) });
    const e = application.handlers.events;
    route(/^events$/, { GET: request => e.list(request) });
    route(/^events\/([^/]+)$/, { GET: (request, m) => e.detail(request, m[1]) });
    route(/^projects\/([^/]+)\/rules$/, { GET: (request, m) => e.projectRules(request, m[1]) });
    route(/^projects\/([^/]+)\/rules\/changes$/, { GET: (request, m) => e.projectChanges(request, m[1]) });
    route(/^projects\/([^/]+)\/rules\/confirm$/, { POST: (request, m) => e.confirm(request, m[1]) });
    route(/^projects\/([^/]+)\/analyses$/, { POST: (request, m) => e.manualAnalysis(request, m[1]) });
    route(/^projects\/([^/]+)\/analyses\/([^/]+)$/, { GET: (request, m) => e.analysis(request, m[1], m[2]) });
    route(/^projects\/([^/]+)\/analysis-runs$/, { POST: (request, m) => e.queueAnalysis(request, m[1]) });
    route(/^projects\/([^/]+)\/analysis-runs\/([^/]+)$/, { GET: (request, m) => executionStatus("m03_analysis", e.run(request, m[1], m[2])) });
    route(/^projects\/([^/]+)\/analysis-runs\/([^/]+)\/retry$/, { POST: (request, m) => e.retryRun(request, m[1], m[2]) });
    route(/^projects\/([^/]+)\/analysis-runs\/([^/]+)\/cancel$/, { POST: (request, m) => e.cancelRun(request, m[1], m[2]) });
    const a = application.handlers.assessments;
    route(/^assessment-question-sets$/, { GET: request => json(async () => ({ items: await application.assessmentCatalog.listPublishedQuestionSets(await actor(request)) })) });
    route(/^projects\/([^/]+)\/assessment-attempts$/, { GET: (request, m) => json(async () => ({ items: await application.assessments.listOwnAttempts(await actor(request), m[1]) })), POST: (request, m) => a.createAttempt(request, { projectId: m[1] }) });
    route(/^projects\/([^/]+)\/assessment-summaries$/, { GET: (request, m) => a.summaries(request, { projectId: m[1] }) });
    route(/^assessment-attempts\/([^/]+)\/report$/, { GET: (request, m) => a.privateReport(request, { attemptId: m[1] }) });
    route(/^assessment-attempts\/([^/]+)\/answers$/, { PATCH: (request, m) => a.saveDraft(request, { attemptId: m[1] }) });
    route(/^assessment-attempts\/([^/]+)\/follow-ups$/, { POST: (request, m) => a.addFollowUp(request, { attemptId: m[1] }) });
    route(/^assessment-attempts\/([^/]+)\/cancel$/, { POST: (request, m) => a.cancelAttempt(request, { attemptId: m[1] }) });
    route(/^assessment-attempts\/([^/]+)\/sharing$/, { PATCH: (request, m) => a.sharing(request, { attemptId: m[1] }) });
    route(/^assessment-attempts\/([^/]+)\/submit$/, { POST: (request, m) => a.submitAttempt(request, { attemptId: m[1] }) });
    route(/^assessment-attempts\/([^/]+)\/reassess$/, { POST: (request, m) => a.reassess(request, { attemptId: m[1] }) });
    route(/^assessment-scoring-jobs\/([^/]+)$/, { GET: (request, m) => executionStatus("m04_scoring", a.job(request, { jobId: m[1] })) });
    const catalog = application.handlers.assessmentCatalog;
    route(/^admin\/assessment-question-sets$/, { GET: request => catalog.reviewQueue(request) });
    route(/^admin\/assessment-question-sets\/seed$/, { POST: request => catalog.seedDraft(request) });
    route(/^admin\/assessment-question-sets\/([^/]+)$/, { GET: (request, m) => catalog.details(request, { questionSetId: m[1] }) });
    for (const action of ["review", "publish", "retire"] as const) route(new RegExp(`^admin/assessment-question-sets/([^/]+)/${action}$`), { POST: (request, m) => catalog[action](request, { questionSetId: m[1] }) });
    const ag = application.handlers.assignmentGeneration;
    route(/^projects\/([^/]+)\/assignment-generation-jobs$/, { POST: (request, m) => ag.queue(request, { projectId: m[1] }) });
    route(/^assignment-generation-jobs\/([^/]+)$/, { GET: (request, m) => executionStatus("assignment_suggestion", ag.job(request, { jobId: m[1] })) });
    route(/^projects\/([^/]+)\/assignment-versions$/, { GET: (request, m) => json(async () => listAssignmentHistory(application, await actor(request), m[1])), POST: (request, m) => a.createAssignment(request, { projectId: m[1] }) });
    route(/^projects\/([^/]+)\/assignment-versions\/applied$/, { GET: (request, m) => a.appliedAssignment(request, { projectId: m[1] }) });
    route(/^assignment-versions\/([^/]+)$/, { GET: (request, m) => a.assignment(request, { assignmentId: m[1] }), PATCH: (request, m) => a.editAssignment(request, { assignmentId: m[1] }) });
    route(/^assignment-versions\/([^/]+)\/validate$/, { POST: (request, m) => a.validateAssignment(request, { assignmentId: m[1] }) });
    route(/^assignment-versions\/([^/]+)\/apply$/, { POST: (request, m) => a.applyAssignment(request, { assignmentId: m[1] }) });
    const p = application.handlers.planning;
    route(/^projects\/([^/]+)\/planning-input$/, { GET: (request, m) => json(async () => application.facts.planningFacts.readInput(m[1], application.clock.now().toISOString(), await actor(request))) });
    route(/^projects\/([^/]+)\/plans\/current$/, { GET: (request, m) => p.getCurrent(request, { projectId: m[1] }) });
    route(/^projects\/([^/]+)\/plan-versions$/, { GET: (request, m) => p.listHistory(request, { projectId: m[1] }), POST: (request, m) => p.createDraft(request, { projectId: m[1] }) });
    route(/^projects\/([^/]+)\/plan-versions\/([^/]+)$/, { PATCH: (request, m) => p.editDraft(request, { projectId: m[1], planId: m[2] }) });
    route(/^projects\/([^/]+)\/plan-versions\/([^/]+)\/diff$/, { GET: (request, m) => p.getDiff(request, { projectId: m[1], planId: m[2] }) });
    route(/^projects\/([^/]+)\/plan-versions\/([^/]+)\/apply$/, { POST: (request, m) => p.apply(request, { projectId: m[1], planId: m[2] }) });
    route(/^projects\/([^/]+)\/plan-versions\/([^/]+)\/restore$/, { POST: (request, m) => p.restoreAsDraft(request, { projectId: m[1], planId: m[2] }) });
    route(/^projects\/([^/]+)\/tasks\/([^/]+)\/progress$/, { POST: (request, m) => p.updateProgress(request, { projectId: m[1], taskId: m[2] }) });
    route(/^projects\/([^/]+)\/tasks\/([^/]+)\/acceptance-correction-request$/, { POST: (request,m) => authenticatedResponse(request, () => p.requestAcceptanceCorrection(request, { projectId: m[1], taskId: m[2] })) });
    route(/^projects\/([^/]+)\/tasks\/([^/]+)\/acceptance-correction$/, { POST: (request,m) => authenticatedResponse(request, () => p.correctAcceptance(request, { projectId: m[1], taskId: m[2] })) });
    route(/^projects\/([^/]+)\/progress$/, { GET: (request, m) => p.listProgress(request, { projectId: m[1] }) });
    const pg = application.handlers.planningGeneration;
    route(/^projects\/([^/]+)\/plan-generation-jobs$/, { GET: (request, m) => pg.listGenerationJobs(request, { projectId: m[1] }), POST: (request, m) => pg.queueGeneration(request, { projectId: m[1] }) });
    route(/^projects\/([^/]+)\/plan-generation-jobs\/([^/]+)$/, { GET: (request, m) => executionStatus("m05_planning", pg.getGenerationJob(request, { projectId: m[1], jobId: m[2] })) });
    route(/^projects\/([^/]+)\/plan-generation-jobs\/([^/]+)\/retry$/, { POST: (request, m) => pg.retryGeneration(request, { projectId: m[1], jobId: m[2] }) });
    route(/^projects\/([^/]+)\/plan-generation-jobs\/([^/]+)\/cancel$/, { POST: (request, m) => pg.cancelGeneration(request, { projectId: m[1], jobId: m[2] }) });
    const gh = (action: GitHubAction, params: (m: RegExpMatchArray) => { projectId: string; operationId?: string; recordId?: string }) => (request: Request, m: RegExpMatchArray) => application.handlers.github(action)(request, params(m));
    const gha = (action: GitHubAuthorizationAction, params?: (m: RegExpMatchArray) => { projectId?: string; operationId?: string }) => (request: Request, m: RegExpMatchArray) => application.githubIntegration.handler(action)(request, params?.(m));
    route(/^github\/authorization\/start$/, { POST: gha("authorization.start") });
    route(/^github\/authorization\/callback$/, { GET: gha("authorization.callback") });
    route(/^github\/authorization$/, { GET: gha("authorization.status"), DELETE: gha("authorization.revoke") });
    route(/^github\/installation\/start$/, { POST: gha("installation.start") });
    route(/^github\/installation\/callback$/, { GET: gha("installation.callback") });
    route(/^github\/installations$/, { GET: gha("installations.list") });
    route(/^github\/repositories$/, { GET: gha("repositories.list") });
    route(/^projects\/([^/]+)\/repository-creations\/preview$/, { POST: gha("creation.preview", m => ({ projectId: m[1] })) });
    route(/^projects\/([^/]+)\/repository-creations\/([^/]+)$/, { GET: gha("creation.get", m => ({ projectId: m[1], operationId: m[2] })) });
    route(/^projects\/([^/]+)\/repository-creations\/([^/]+)\/confirm$/, { POST: gha("creation.confirm", m => ({ projectId: m[1], operationId: m[2] })) });
    route(/^projects\/([^/]+)\/repository-creations\/([^/]+)\/reconcile$/, { POST: gha("creation.reconcile", m => ({ projectId: m[1], operationId: m[2] })) });
    route(/^projects\/([^/]+)\/repository-binding$/, { GET: gh("binding.get", m => ({ projectId: m[1] })), PUT: gh("binding.put", m => ({ projectId: m[1] })), DELETE: gh("binding.delete", m => ({ projectId: m[1] })) });
    route(/^projects\/([^/]+)\/git-operations$/, { GET: gh("operations.list", m => ({ projectId: m[1] })), POST: gh("operations.create", m => ({ projectId: m[1] })) });
    route(/^projects\/([^/]+)\/git-operations\/([^/]+)$/, { GET: gh("operations.get", m => ({ projectId: m[1], operationId: m[2] })) });
    for (const [suffix, action, method] of [["draft", "operations.draft", "GET"], ["preview", "operations.preview", "POST"], ["confirm", "operations.confirm", "POST"], ["reconcile", "operations.reconcile", "POST"], ["pull-request", "operations.pull-request", "POST"]] as const) {
      route(new RegExp(`^projects/([^/]+)/git-operations/([^/]+)/${suffix}$`), { [method]: gh(action, m => ({ projectId: m[1], operationId: m[2] })) });
    }
    route(/^projects\/([^/]+)\/delivery-verifications$/, { GET: gh("verifications.list", m => ({ projectId: m[1] })), POST: gh("verifications.create", m => ({ projectId: m[1] })) });
    route(/^projects\/([^/]+)\/submission-records$/, { GET: gh("submissions.list", m => ({ projectId: m[1] })), POST: gh("submissions.create", m => ({ projectId: m[1] })) });
    route(/^projects\/([^/]+)\/submission-records\/([^/]+)$/, { PATCH: gh("submissions.update", m => ({ projectId: m[1], recordId: m[2] })) });
    route(/^projects\/([^/]+)\/delivery-summary$/, { GET: gh("summary", m => ({ projectId: m[1] })) });
    route(/^projects\/([^/]+)\/delivery-materials$/, { GET: gh("materials.get", m => ({ projectId: m[1] })), PUT: (request,m) => authenticatedResponse(request, () => gh("materials.save", m => ({ projectId: m[1] }))(request,m)) });
    route(/^projects\/([^/]+)\/delivery-materials\/history$/, { GET: gh("materials.history", m => ({ projectId: m[1] })) });
    const r = application.handlers.resources;
    route(/^resources$/, { GET: request => r.listResources(request) });
    route(/^resources\/([^/]+)$/, { GET: (request, m) => r.resourceDetail(request, m[1]) });
    route(/^resource-categories$/, { GET: request => r.resourceCategories(request) });
    route(/^me\/resource-bookmarks$/, { GET: request => r.listBookmarks(request), POST: request => r.createBookmark(request) });
    route(/^me\/resource-bookmarks\/([^/]+)$/, { PATCH: (request, m) => r.updateBookmark(request, m[1]), DELETE: (request, m) => r.deleteBookmark(request, m[1]) });
    route(/^resource-corrections$/, { POST: request => r.reportCorrection(request) });
    route(/^resources\/([^/]+)\/share$/, { POST: (request, m) => json(async () => {
      const input = await request.json() as Record<string, unknown>;
      if (!input || Array.isArray(input) || Object.keys(input).some(key => !["projectId", "resourceVersion", "purposeNote"].includes(key))) throw new DomainError("INVALID_INPUT", "共享请求字段无效。");
      return application.resources.shareResource(await actor(request), { resourceId: m[1], projectId: input.projectId as string, resourceVersion: input.resourceVersion as number, purposeNote: input.purposeNote as string });
    }, 201) });
    const retro = application.handlers.retrospectives;
    route(/^experience-cards$/, { GET: request => authenticatedResponse(request, () => retro.listPersonalExperienceCards(request,{})) });
    route(/^retrospectives$/, { GET: request => authenticatedResponse(request, () => retro.listPersonalRetrospectives(request,{})) });
    route(/^experience-reuses$/, { GET: request => authenticatedResponse(request, () => retro.listReuseDrafts(request,{})) });
    const editDrafts = application.handlers.retrospectiveEditDrafts;
    route(/^retrospective-edit-drafts$/, { GET: request => authenticatedResponse(request, () => editDrafts.list(request)) });
    route(/^projects\/([^/]+)\/retrospective-edit-draft$/, { GET: (request,m) => authenticatedResponse(request, () => editDrafts.get(request,{projectId:m[1]})), PUT: (request,m) => authenticatedResponse(request, () => editDrafts.save(request,{projectId:m[1]})) });
    route(/^retrospective-edit-drafts\/([^/]+)$/, { GET: (request,m) => authenticatedResponse(request, () => editDrafts.getById(request,{id:m[1]})), DELETE: (request,m) => authenticatedResponse(request, () => editDrafts.delete(request,{id:m[1]})) });
    route(/^retrospective-edit-drafts\/([^/]+)\/export$/, { POST: (request,m) => authenticatedResponse(request, () => editDrafts.exportDraft(request,{id:m[1]})) });
    route(/^projects\/([^/]+)\/retrospectives$/, { GET: (request, m) => authenticatedResponse(request, () => retro.listRetrospectives(request, { projectId: m[1] })), POST: (request, m) => authenticatedResponse(request, () => retro.createRetrospective(request, { projectId: m[1] })) });
    route(/^retrospectives\/([^/]+)$/, { GET: (request, m) => authenticatedResponse(request, () => retro.getRetrospective(request, { id: m[1] })), PATCH: (request, m) => authenticatedResponse(request, () => retro.updateRetrospective(request, { id: m[1] })), DELETE: (request, m) => authenticatedResponse(request, () => retro.deletePersonal(request, { id: m[1] })) });
    route(/^retrospectives\/([^/]+)\/confirm$/, { POST: (request, m) => authenticatedResponse(request, () => retro.confirmRetrospective(request, { id: m[1] })) });
    route(/^retrospectives\/([^/]+)\/history$/, { GET: (request, m) => authenticatedResponse(request, () => retro.historyVersion(request, { id: m[1] })) });
    route(/^retrospectives\/([^/]+)\/export$/, { POST: (request, m) => authenticatedResponse(request, () => retro.exportDocument(request, { id: m[1] })) });
    route(/^retrospectives\/([^/]+)\/generation-jobs$/, { POST: (request, m) => authenticatedResponse(request, () => retro.enqueueGeneration(request, { id: m[1] })) });
    route(/^retrospective-generation-jobs\/([^/]+)$/, { GET: (request, m) => executionStatus("m07_retrospective", authenticatedResponse(request, () => retro.getGenerationJob(request, { id: m[1] }))) });
    route(/^projects\/([^/]+)\/experience-cards$/, { GET: (request, m) => authenticatedResponse(request, () => retro.listExperienceCards(request, { projectId: m[1] })), POST: (request, m) => authenticatedResponse(request, () => retro.createExperienceCard(request, { projectId: m[1] })) });
    route(/^experience-cards\/([^/]+)$/, { GET: (request, m) => authenticatedResponse(request, () => retro.getExperienceCard(request, { id: m[1] })), PATCH: (request, m) => authenticatedResponse(request, () => retro.updateExperienceCard(request, { id: m[1] })), DELETE: (request, m) => authenticatedResponse(request, () => retro.deletePersonal(request, { id: m[1] })) });
    route(/^experience-cards\/([^/]+)\/confirm$/, { POST: (request, m) => authenticatedResponse(request, () => retro.confirmExperienceCard(request, { id: m[1] })) });
    route(/^experience-cards\/([^/]+)\/export$/, { POST: (request, m) => authenticatedResponse(request, () => retro.exportDocument(request, { id: m[1] })) });
    route(/^experience-cards\/([^/]+)\/history$/, { GET: (request,m) => authenticatedResponse(request, () => retro.historyVersion(request,{id:m[1]})) });
    route(/^projects\/([^/]+)\/experience-reuses$/, { GET: (request,m) => authenticatedResponse(request, () => retro.listReuseDrafts(request,{projectId:m[1]})), POST: (request, m) => authenticatedResponse(request, () => retro.createReuseDraft(request, { projectId: m[1] })) });
    route(/^experience-reuses\/([^/]+)$/, { GET: (request, m) => authenticatedResponse(request, () => retro.getReuseDraft(request, { id: m[1] })), DELETE: (request,m) => authenticatedResponse(request, () => retro.deletePersonal(request,{id:m[1]})) });
    const sk = application.handlers.skills;
    const projectSkills = application.projectSkills.handlers;
    route(/^projects\/([^/]+)\/skills$/, {GET:(request,m)=>projectSkills.selection.read(m[1])(request),PUT:(request,m)=>projectSkills.selection.save(m[1])(request)});
    route(/^projects\/([^/]+)\/skills\/catalog$/, {GET:(request,m)=>projectSkills.selection.catalog(m[1])(request)});
    route(/^projects\/([^/]+)\/skills\/copy$/, {POST:(request,m)=>projectSkills.selection.copy(m[1])(request)});
    const skillTarget = (m:RegExpMatchArray):import("../modules/skills/index.ts").SkillPublicationTarget => {
      if(m[1]!=="skill" && m[1]!=="bundle") throw new DomainError("INVALID_INPUT","技能审核对象类别无效。");
      return {kind:m[1],id:m[2],versionId:m[3]};
    };
    route(/^admin\/skill-candidates$/, {GET:request=>projectSkills.candidates.list(request),POST:request=>projectSkills.candidates.save(request)});
    route(/^admin\/skill-candidates\/([^/]+)\/([^/]+)\/([^/]+)$/, {GET:(request,m)=>projectSkills.candidates.detail(skillTarget(m))(request)});
    route(/^admin\/skill-candidates\/([^/]+)\/([^/]+)\/([^/]+)\/reviews$/, {POST:(request,m)=>projectSkills.reviews.register(skillTarget(m))(request)});
    route(/^admin\/skill-candidates\/([^/]+)\/([^/]+)\/([^/]+)\/withdraw$/, {POST:(request,m)=>projectSkills.reviews.withdraw(skillTarget(m))(request)});
    route(/^admin\/skill-reviews$/, {GET:request=>projectSkills.reviews.list(request)});
    route(/^admin\/skill-reviews\/([^/]+)$/, {GET:(request,m)=>projectSkills.reviews.detail(m[1])(request)});
    route(/^admin\/skill-reviews\/([^/]+)\/decide$/, {POST:(request,m)=>projectSkills.reviews.decide(m[1])(request)});
    route(/^admin\/skill-reviews\/([^/]+)\/publish$/, {POST:(request,m)=>projectSkills.reviews.publish(m[1])(request)});
    route(/^skill-bridge\/download$/, { GET: request => sk.downloadBridge(request) });
    route(/^skills$/, { GET: request => sk.list(request) });
    route(/^skills\/([^/]+)$/, { GET: (request, m) => sk.detail(m[1])(request) });
    route(/^skill-agents$/, { GET: request => sk.agents(request) });
    route(/^skill-bundles$/, { GET: request => sk.bundles(request) });
    route(/^skill-bundles\/([^/]+)$/, { GET: (request, m) => sk.bundle(m[1])(request) });
    route(/^me\/skill-installation-plans$/, { POST: request => sk.createPlan(request) });
    route(/^me\/skill-installation-plans\/([^/]+)$/, { GET: (request, m) => sk.plan(m[1])(request) });
    route(/^me\/skill-installation-plans\/([^/]+)\/manifest$/, { GET: (request, m) => sk.manifest(m[1])(request) });
    route(/^me\/skill-installation-plans\/([^/]+)\/confirm$/, { POST: (request, m) => sk.confirm(m[1])(request) });
    route(/^me\/skill-installations$/, { GET: request => sk.installations(request) });
    route(/^skill-bridge\/authorize$/, { POST: request => sk.authorizeBridge(request) });
    route(/^skill-bridge\/receipts$/, { POST: request => sk.bridgeReceipt(request) });
    route(/^admin\/skills\/([^/]+)\/versions\/([^/]+)\/withdraw$/, { POST: (request, m) => sk.withdraw(m[1], m[2])(request) });
    // M08 owns all public review/publish and correction writes; no direct M03 publish route exists.
    const administrative = application.operations.resolveRoute?.(incoming.method, segments);
    // Exact root routes take precedence over the module's generic entity routes.
    if (administrative && !matched) { matched = true; handler = administrative; }
    const organizerHandler=application.organizerIntegration.match(segments);
    const officialLinkRoute=eventOfficialLinksHttpRoute(segments);
    if(officialLinkRoute&&!matched){matched=true;handler=request=>application.organizerOfficialLinkHandlers.handle(request,officialLinkRoute);}
    if(organizerHandler&&!matched){matched=true;handler=organizerHandler;}
    if(/^organizer\/events\/[^/]+\/(?:account-lookup|logistics-participants|judging\/(?:relationship-review|relationship-targets))$/.test(path)&&!matched){matched=true;handler=async request=>(await application.organizerControls.handle(request,segments))!;}
    if(/^organizer\/events\/[^/]+\/tracks$/.test(path)&&!matched){matched=true;handler=async request=>(await application.organizerTracks.handle(request,segments))!;}
    if(/^organizer\/organizations\/[^/]+\/mail-account(?:\/disable)?$/.test(path)&&!matched){matched=true;handler=async request=>(await application.organizerMailAccounts.handle(request,segments))!;}
    if(/^(?:organizer\/events\/[^/]+\/(?:selection-notice-template|selection-notices)|competitions\/[^/]+\/selection-notices)$/.test(path)&&!matched){matched=true;handler=async request=>(await application.organizerNotifications.handle(request,segments))!;}
    if(path==='admin/organizer/notification-status'&&!matched){matched=true;if(incoming.method==='GET')handler=request=>json(async()=>{const person=await application.resolvePrincipal(request);if(!person)throw new DomainError('UNAUTHENTICATED','请先登录。',{status:401});return application.database.transaction(async sql=>{await person.guard(sql);await admin(request);const value=await application.organizerNotifications.counts();await person.guard(sql);return value;});});}
    if (!handler) throw new DomainError(matched ? "METHOD_NOT_ALLOWED" : "NOT_FOUND", matched ? "此接口不支持该请求方法。" : "接口不存在。", { status: matched ? 405 : 404 });
    return await handler(await boundedRequest(incoming));
  } catch (error) {
    // 未预期的异常不再只回一句兜底话：记下 requestId 与堆栈，便于定位是哪个接口。
    if (!isDomainError(error)) console.error("[dispatch] unexpected", requestId, error instanceof Error ? error.stack ?? error.message : String(error));
    return Response.json(toErrorEnvelope(error, requestId), { status: isDomainError(error) ? error.status : 500, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  }
}
