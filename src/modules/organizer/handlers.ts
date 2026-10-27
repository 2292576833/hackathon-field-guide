import type { OrganizerPrincipal } from "../../shared/organizer-contracts.ts";
import { DomainError, isDomainError, toErrorEnvelope } from "../../shared/errors.ts";
import type { OrganizerService } from "./service.ts";
import { parseDashboardFilter } from "./dashboard.ts";

export interface OrganizerHttpDependencies {
  readonly service: OrganizerService;
  /** Must create actor/guard from the verified request session, never from body fields. */
  readonly authenticate: (request: Request) => Promise<OrganizerPrincipal>;
  /** Root enforces configured Origin/CSRF here, before any mutation. */
  readonly authorizeMutation: (request: Request) => Promise<void>;
  readonly requestId: () => string;
}
export type OrganizerHttpRoute =
  | { readonly kind: "applications" | "mineApplications" | "reviewApplications" | "organizations" | "templates" | "competitions" | "identities" | "reviewClaims" }
  | { readonly kind: "application" | "reviewApplication"; readonly applicationId: string }
  | { readonly kind: "claimCandidate"; readonly discoveryId: string }
  | { readonly kind: "organization" | "organizationEvents" | "staffGrants" | "staffInvitations" | "claimCandidates" | "claims"; readonly organizationId: string }
  /** P3 受限邀请：机构管理员撤销，以及领取人的只读预览与领取。 */
  | { readonly kind: "revokeInvitation"; readonly invitationId: string }
  | { readonly kind: "myInvitation" | "claimInvitation"; readonly token: string }
  /** P05：复制来源列表属于机构范围（不是某一场比赛），因此单独成一型，避免与 eventId 型混淆。 */
  | { readonly kind: "duplicateSources"; readonly organizationId: string }
  | { readonly kind: "event" | "preview" | "publish" | "archive" | "end" | "competition" | "history" | "publicationChanges" | "responsible" | "readiness" | "duplicateEvent" | "dashboard" | "assistantSwitches" | "setAssistantSwitch"; readonly eventId: string }
  | { readonly kind: "claim" | "reviewClaim" | "linkClaim"; readonly claimId: string }
  | { readonly kind: "revokeGrant"; readonly grantId: string };
const methods: Record<OrganizerHttpRoute["kind"], readonly string[]> = {
  applications:["GET","POST"],mineApplications:["GET"],reviewApplications:["GET"],application:["PATCH"],reviewApplication:["POST"],
  organizations:["GET"],organization:["PATCH"],templates:["GET"],organizationEvents:["GET","POST"],staffGrants:["GET","POST"],staffInvitations:["GET","POST"],
  revokeInvitation:["POST"],myInvitation:["GET"],claimInvitation:["POST"],
  event:["GET","PATCH"],preview:["GET"],publish:["POST"],archive:["POST"],end:["POST"],competition:["GET"],competitions:["GET"],identities:["GET"],revokeGrant:["POST"],history:["GET"],publicationChanges:["GET"],responsible:["POST"],readiness:["GET","PATCH"],dashboard:["GET"],
  // P4：助手开关 GET 读 / POST 写。`organizerHttpRoute` 只接收路径（无 method 入参），
  // 因此默认解析为 `assistantSwitches`（同 kind 两方法，与既有 readiness/staffGrants 一致）；
  // `setAssistantSwitch` 供根在方法已知时显式按 POST 分派（GET 会被 methods 表判 405）。
  assistantSwitches:["GET","POST"],setAssistantSwitch:["POST"],
  duplicateEvent:["POST"],duplicateSources:["GET"],
  claimCandidates:["GET"],claims:["GET","POST"],claim:["POST"],reviewClaims:["GET"],reviewClaim:["POST"],linkClaim:["POST"],claimCandidate:["GET"],
};
async function body(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) throw new DomainError("UNSUPPORTED_MEDIA_TYPE","请使用JSON表单提交。",{status:415});
  const limit=96*1024,declared=Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared>limit) throw new DomainError("REQUEST_TOO_LARGE","表单内容过长，请缩短说明。",{status:413});
  if (!request.body) throw new DomainError("INVALID_JSON","表单内容缺失。",{status:400});
  const reader=request.body.getReader(),parts: Uint8Array[]= [];let size=0;
  try {while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>limit){await reader.cancel();throw new DomainError("REQUEST_TOO_LARGE","表单内容过长，请缩短说明。",{status:413});}parts.push(part.value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
  try {return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));} catch {throw new DomainError("INVALID_JSON","表单无法读取，请核对后重试。",{status:400});}
}
/** GET 看板的查询串转成纯对象；同名参数取第一个，交给纯函数校验。 */
function queryOf(request: Request): Record<string,string> {
  const result: Record<string,string>={};
  for (const [key,value] of new URL(request.url).searchParams) if (!Object.hasOwn(result,key)) result[key]=value;
  return result;
}
/** No app routes are installed here. Root selects a fixed route after /api/v1. */
export function createOrganizerHttpHandlers(deps: OrganizerHttpDependencies) {
  return { async handle(request: Request,route: OrganizerHttpRoute): Promise<Response> {
    const requestId=deps.requestId(),headers={"Cache-Control":"private, no-store","Vary":"Cookie","X-Content-Type-Options":"nosniff"};
    try {
      const allowed=methods[route.kind];if(!allowed.includes(request.method)) return Response.json({error:{code:"METHOD_NOT_ALLOWED",message:"该入口不支持此操作。"},requestId},{status:405,headers:{...headers,Allow:allowed.join(", ")}});
      const service=deps.service;
      if(route.kind === "templates") return Response.json({data:service.listTemplates(),requestId},{headers});
      if(route.kind === "competitions") return Response.json({data:await service.listPublicCompetitions(),requestId},{headers});
      if(route.kind === "competition") return Response.json({data:await service.getPublicCompetition(route.eventId),requestId},{headers});
      const principal=await deps.authenticate(request);
      if(request.method !== "GET") await deps.authorizeMutation(request);
      const input=request.method === "GET" ? undefined : await body(request);let data: unknown;
      switch(route.kind) {
        case "applications":data=request.method === "GET" ? await service.listOwnApplications(principal):await service.createApplication(principal,input);break;
        case "mineApplications":data=await service.listOwnApplications(principal);break;
        case "application":data=await service.updateApplication(principal,route.applicationId,input);break;
        case "reviewApplications":data=await service.listApplicationsForReview(principal);break;
        case "reviewApplication":data=await service.reviewApplication(principal,route.applicationId,input);break;
        case "organizations":data=await service.listOrganizations(principal);break;
        case "organization":data=await service.updateOrganization(principal,route.organizationId,input);break;
        case "organizationEvents":data=request.method === "GET" ? await service.listOrganizationEvents(principal,route.organizationId):await service.createEvent(principal,route.organizationId,input);break;
        case "staffGrants":data=request.method === "GET" ? await service.listStaffGrants(principal,route.organizationId):await service.grantStaff(principal,route.organizationId,input);break;
        case "revokeGrant":data=await service.revokeStaff(principal,route.grantId,input);break;
        // P3 受限邀请：生成/列表限机构管理员；领取页只读预览与领取由当前 principal 决定。
        case "staffInvitations":data=request.method === "GET" ? await service.listStaffInvitations(principal,route.organizationId):await service.createStaffInvitation(principal,route.organizationId,input);break;
        case "revokeInvitation":data=await service.revokeStaffInvitation(principal,route.invitationId,input);break;
        case "myInvitation":data=await service.previewStaffInvitation(principal,route.token);break;
        case "claimInvitation":data=await service.claimStaffInvitation(principal,route.token);break;
        case "event":data=request.method === "GET" ? await service.getManagedEvent(principal,route.eventId):await service.updateEvent(principal,route.eventId,input);break;
        case "preview":data=await service.previewEvent(principal,route.eventId);break;
        case "publish":data=await service.publishEvent(principal,route.eventId,input);break;
        case "archive":data=await service.archiveEvent(principal,route.eventId,input);break;
        case "end":data=await service.endEvent(principal,route.eventId,input);break;
        case "identities":data=await service.listCompetitionIdentities(principal);break;
        case "history":data=await service.listPublicationHistory(principal,route.eventId);break;
        case "publicationChanges":data=await service.listPublicationChanges(principal,route.eventId);break;
        case "responsible":data=await service.changeEventResponsible(principal,route.eventId,input);break;
        case "claimCandidates":data=await service.listClaimCandidates(principal,route.organizationId);break;
        case "claims":data=request.method === "GET" ? await service.listClaims(principal,route.organizationId):await service.createClaim(principal,route.organizationId,input);break;
        case "claim":data=await service.withdrawClaim(principal,route.claimId,input);break;
        case "linkClaim":data=await service.linkClaimToEvent(principal,route.claimId,input);break;
        case "reviewClaims":data=await service.listClaimsForReview(principal);break;
        case "reviewClaim":data=await service.reviewClaim(principal,route.claimId,input);break;
        case "readiness":data=request.method === "GET" ? await service.listEventReadiness(principal,route.eventId):await service.updateEventReadiness(principal,route.eventId,input);break;
        // P07：仅 GET 的只读看板；筛选条件来自查询串，非法值由 parseDashboardFilter 抛 422。
        case "dashboard":data=await service.dashboard(principal,route.eventId,parseDashboardFilter(queryOf(request)));break;
        // P4 模块助手开关：GET 读本场开关集，POST 写单个开关（body {assistantKey,enabled,expectedRevision}）。
        case "assistantSwitches":data=request.method === "GET" ? await service.listEventAssistantSwitches(principal,route.eventId):await service.setEventAssistantSwitch(principal,route.eventId,input);break;
        case "setAssistantSwitch":data=await service.setEventAssistantSwitch(principal,route.eventId,input);break;
        case "duplicateSources":data=await service.listDuplicateSources(principal,route.organizationId);break;
        case "duplicateEvent":data=await service.duplicateEvent(principal,route.eventId,input);break;
        case "claimCandidate":data=await service.getClaimCandidate(principal,route.discoveryId);break;
      }
      return Response.json({data,requestId},{headers});
    } catch(error) {return Response.json(toErrorEnvelope(error,requestId),{status:isDomainError(error)?error.status:500,headers});}
  } };
}
export function organizerHttpRoute(path: readonly string[]): OrganizerHttpRoute | null {
  const fixed: Record<string,OrganizerHttpRoute>={"organizer/applications":{kind:"applications"},"organizer/applications/mine":{kind:"mineApplications"},"admin/organizer/applications":{kind:"reviewApplications"},"organizer/organizations":{kind:"organizations"},"organizer/templates":{kind:"templates"},"competitions":{kind:"competitions"},"me/competition-identities":{kind:"identities"}};
  const joined=path.join("/");if(Object.hasOwn(fixed,joined))return fixed[joined];
  if(path.length === 3 && path[0] === "organizer" && path[1] === "applications")return{kind:"application",applicationId:path[2]};
  if(path.length === 5 && path[0] === "admin" && path[1] === "organizer" && path[2] === "applications" && path[4] === "review")return{kind:"reviewApplication",applicationId:path[3]};
  if(path[0] === "organizer" && path[1] === "organizations") {
    if(path.length === 3)return{kind:"organization",organizationId:path[2]};
    if(path.length === 4 && path[3] === "events")return{kind:"organizationEvents",organizationId:path[2]};
    if(path.length === 4 && path[3] === "staff-grants")return{kind:"staffGrants",organizationId:path[2]};
    // P3：受限邀请的生成与状态列表（机构管理员）。
    if(path.length === 4 && path[3] === "staff-invitations")return{kind:"staffInvitations",organizationId:path[2]};
    if(path.length === 4 && path[3] === "claim-candidates")return{kind:"claimCandidates",organizationId:path[2]};
    if(path.length === 4 && path[3] === "claims")return{kind:"claims",organizationId:path[2]};
    // P05：可作为复制来源的赛事（只读 GET，挂在既有机构路由族下，不新增入口页面）。
    if(path.length === 4 && path[3] === "duplicate-sources")return{kind:"duplicateSources",organizationId:path[2]};
  }
  if(path.length === 4 && path[0] === "organizer" && path[1] === "staff-grants" && path[3] === "revoke")return{kind:"revokeGrant",grantId:path[2]};
  // P3：撤销邀请（机构管理员）；领取人的只读预览与领取挂在 my/ 下，与任一模块既有前缀都不冲突。
  if(path.length === 4 && path[0] === "organizer" && path[1] === "staff-invitations" && path[3] === "revoke")return{kind:"revokeInvitation",invitationId:path[2]};
  if(path.length === 3 && path[0] === "my" && path[1] === "staff-invitations")return{kind:"myInvitation",token:path[2]};
  if(path.length === 4 && path[0] === "my" && path[1] === "staff-invitations" && path[3] === "claim")return{kind:"claimInvitation",token:path[2]};
  if(path.length === 4 && path[0] === "organizer" && path[1] === "claims" && path[3] === "withdraw")return{kind:"claim",claimId:path[2]};
  if(path.length === 4 && path[0] === "organizer" && path[1] === "claims" && path[3] === "link")return{kind:"linkClaim",claimId:path[2]};
  // 比赛页入口：按线索 ID 取候选（认证后返回本人可认领机构）
  if(path.length === 3 && path[0] === "organizer" && path[1] === "claim-candidates")return{kind:"claimCandidate",discoveryId:path[2]};
  if(path.length === 5 && path[0] === "admin" && path[1] === "organizer" && path[2] === "claims" && path[4] === "review")return{kind:"reviewClaim",claimId:path[3]};
  if(path.length === 3 && path[0] === "admin" && path[1] === "organizer" && path[2] === "claims")return{kind:"reviewClaims"};
  if(path[0] === "organizer" && path[1] === "events") {
    if(path.length === 3)return{kind:"event",eventId:path[2]};
    const actions: Record<string,"preview"|"publish"|"archive"|"end"|"history"|"publicationChanges"|"responsible"|"readiness"|"duplicateEvent"|"dashboard">={preview:"preview",publish:"publish",archive:"archive",end:"end",history:"history","publication-changes":"publicationChanges",responsible:"responsible",readiness:"readiness",duplicate:"duplicateEvent",dashboard:"dashboard"};
    if(path.length === 4 && Object.hasOwn(actions,path[3]))return{kind:actions[path[3]],eventId:path[2]};
    // P4：赛事级模块助手开关（两个 kind 共用这一条路径；POST 写单个开关）。
    if(path.length === 4 && path[3] === "module-assistant-switches")return{kind:"assistantSwitches",eventId:path[2]};
  }
  if(path.length === 2 && path[0] === "competitions")return{kind:"competition",eventId:path[1]};
  return null;
}
