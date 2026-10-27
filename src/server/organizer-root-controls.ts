import { createHash } from "node:crypto";
import type { Clock, IdGenerator } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import type { EventJudgeConflictPort, OrganizerPrincipal } from "../shared/organizer-contracts.ts";
import { DomainError, isDomainError, toErrorEnvelope } from "../shared/errors.ts";
import type { OrganizerIntegration } from "./organizer-integration.ts";
import type { ProjectsRepository } from "../modules/projects/index.ts";

interface Dependencies {
 database: DatabasePort; clock: Clock; ids: IdGenerator;
 resolvePrincipal(request: Request): Promise<OrganizerPrincipal | null>;
 assertMutationAllowed(request: Request): Promise<void>;
 requireActiveTarget(sql: SqlExecutor, userId: string): Promise<void>;
 integration(): OrganizerIntegration;
 projectRepository: Pick<ProjectsRepository,"withProject">;
}
function input(value: unknown, keys: string[]): Record<string, unknown> {
 if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new DomainError("INVALID_INPUT", "请填写页面要求的信息。");
 return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max = 200): string {
 if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new DomainError("INVALID_INPUT", `${label}格式不正确。`);
 return value.trim();
}
/** Adds root identity checks without giving organizer staff access to private projects. */
export function createOrganizerRootControls(deps: Dependencies) {
 const relationshipReviews: EventJudgeConflictPort = {
  async inspect(sql, value) {
   const team = await deps.integration().registration.getTeam(sql, value.eventId, value.teamId);
   if (!team) return { status: "needs_review", reasons: ["正式队伍当前无法核对。"] };
   const result = await sql.query<{state:"clear"|"conflict"; team_revision:number; expires_at:Date|string}>(
    "SELECT state,team_revision,expires_at FROM organizer_relationship_reviews WHERE event_id=$1 AND team_id=$2 AND judge_user_id=$3 AND organization_id=$4 ORDER BY sequence DESC LIMIT 1",
    [value.eventId,value.teamId,value.judgeUserId,team.organizationId]);
   const review = result.rows[0];
   if (!review || review.team_revision !== team.revision || new Date(review.expires_at).getTime() <= deps.clock.now().getTime()) return { status: "needs_review", reasons: ["请负责人核查线下辅导等关系；名单变化或核查到期需重新确认。"] };
   return {status:review.state,reasons: review.state === "clear" ? [] : ["负责人已记录需回避的关联关系。"]};
  }
 };
 async function principal(request:Request) {
  const value = await deps.resolvePrincipal(request);
  if (!value) throw new DomainError("UNAUTHENTICATED","请先登录。",{status:401});
  return value;
 }
 async function body(request:Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new DomainError("INVALID_CONTENT_TYPE","请通过本站表单提交。",{status:415});
  const source=await request.text();
  if (Buffer.byteLength(source)>8192) throw new DomainError("BODY_TOO_LARGE","提交内容过长。",{status:413});
  try { return JSON.parse(source) as unknown; } catch { throw new DomainError("INVALID_JSON","提交格式无效，请重试。"); }
 }
 async function accountLookup(request:Request,eventId:string) {
  const person=await principal(request), data=input(await body(request),["email"]), email=text(data.email,"邮箱",254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new DomainError("INVALID_INPUT","请输入完整邮箱。");
  return deps.database.transaction(async sql=>{
   await person.guard(sql);
   let event;
   try { event = await deps.integration().events.requireStaff(sql,person.actor,eventId,"event_manage"); }
   catch (error) { if(!isDomainError(error)||error.status!==403) throw error; event = await deps.integration().events.requireStaff(sql,person.actor,eventId,"judging_manage"); }
   await person.guard(sql);
   // 邮箱查询会暴露"某邮箱是否是本站已激活账号"，因此限流并写审计，且审计不保存明文邮箱。
   // 限流按 赛事 + 工作人员 的滚动窗口计数；使用本模块自己的 organizer_lookup_limits（迁移 056），不借用 auth 专用表。
   const now = deps.clock.now(), windowMs = 60 * 60 * 1000, maximum = 60;
   const instant = now.toISOString();
   const bound = new Date(now.getTime() + windowMs).toISOString();
   await sql.query("INSERT INTO organizer_lookup_limits (organization_id,event_id,actor_user_id,window_started_at,attempts) VALUES ($1,$2,$3,$4,0) ON CONFLICT (event_id,actor_user_id) DO NOTHING", [event.organizationId, eventId, person.actor.userId, instant]);
   const rate = (await sql.query<{ window_started_at: Date|string; attempts: number }>("SELECT window_started_at, attempts FROM organizer_lookup_limits WHERE event_id=$1 AND actor_user_id=$2 FOR UPDATE", [eventId, person.actor.userId])).rows[0]!;
   const windowStart = new Date(rate.window_started_at), expired = now.getTime() >= windowStart.getTime() + windowMs;
   if (!expired && rate.attempts >= maximum) throw new DomainError("ORGANIZER_ACCOUNT_LOOKUP_RATE_LIMIT","本场邮箱查询过于频繁，本次没有执行。请稍后再试，或改为在报名名单中查找。",{status:429,recoveryAction:`请在 ${new Date(windowStart.getTime() + windowMs).toISOString()} 后再次提交。`});
   await sql.query("UPDATE organizer_lookup_limits SET window_started_at=$3, attempts=$4, last_attempt_at=$5 WHERE event_id=$1 AND actor_user_id=$2",[eventId, person.actor.userId, expired ? instant : windowStart.toISOString(), expired ? 1 : rate.attempts + 1, instant]);
   const account=await sql.query<{id:string;display_name:string}>("SELECT id,display_name FROM auth_users WHERE lower(email)=$1 AND status='active' AND email_verified_at IS NOT NULL",[email]);
   const emailDigest = createHash("sha256").update(email).digest("hex");
   // entity_id 只保存邮箱哈希，审计可追溯查询次数但不留明文邮箱。
   await sql.query("INSERT INTO organizer_audit_events(id,organization_id,event_id,actor_user_id,action,entity_id,revision,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
     [deps.ids.next(), event.organizationId, eventId, person.actor.userId, account.rows[0] ? "account_lookup_found" : "account_lookup_missing", `account:${emailDigest}`, 0, instant]);
   await person.guard(sql);
   if(!account.rows[0]) throw new DomainError("ACCOUNT_NOT_FOUND","没有找到可用账号，请对方先注册并验证该邮箱。",{status:404});
   return {userId:account.rows[0].id,label:account.rows[0].display_name||"已验证账号"};
  });
 }
 async function review(request:Request,eventId:string) {
  const person=await principal(request), data=input(await body(request),["teamId","judgeUserId","status","note","expectedTeamRevision"]);
  const teamId=text(data.teamId,"队伍"), judgeUserId=text(data.judgeUserId,"评委账号"), note=text(data.note,"核查依据",2000);
  if(!["clear","conflict"].includes(data.status as string)||!Number.isSafeInteger(data.expectedTeamRevision)||Number(data.expectedTeamRevision)<1) throw new DomainError("INVALID_INPUT","请核对结论及当前名单版本。");
  if(judgeUserId===person.actor.userId) throw new DomainError("SELF_REVIEW_FORBIDDEN","本人不能审核自己的评审关系，请另一位负责人核查。",{status:403});
  return deps.database.transaction(async sql=>{
   await person.guard(sql);
   const event=await deps.integration().events.requireStaff(sql,person.actor,eventId,"judging_manage");
   const team=await deps.integration().registration.getTeam(sql,eventId,teamId);
   if(!team||team.organizationId!==event.organizationId||team.status==="withdrawn") throw new DomainError("TEAM_NOT_FOUND","请核对这场比赛的正式队伍。",{status:404});
   if(team.revision!==data.expectedTeamRevision) throw new DomainError("REVISION_CONFLICT","队伍名单已更新，请重新核查。",{status:409,latestRevision:team.revision});
   await deps.requireActiveTarget(sql,judgeUserId);
   if(data.status==="clear"&&team.memberUserIds.includes(judgeUserId)) throw new DomainError("JUDGE_CONFLICT","评委是当前队员，不能确认无关联。",{status:409});
   if(data.status==="clear") {
    if(team.projectId) await deps.projectRepository.withProject(team.projectId,async (aggregate,executor)=>{
     if(executor!==sql) throw new DomainError("TRANSACTION_MISMATCH","无法核对当前关联，请重试。",{status:503});
     if(aggregate.members.some(member=>member.userId===judgeUserId)) throw new DomainError("JUDGE_CONFLICT","系统已有空间参与记录，不能用人工核查覆盖。",{status:409});
    });
   }
   const now=deps.clock.now(), id=deps.ids.next(), expiresAt=new Date(Math.min(now.getTime()+30*86400000,Math.max(now.getTime()+86400000,new Date(event.endsAt).getTime()+7*86400000))).toISOString();
   await sql.query("INSERT INTO organizer_relationship_reviews(id,organization_id,event_id,team_id,judge_user_id,reviewed_by,team_revision,state,note,reviewed_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",[id,event.organizationId,eventId,teamId,judgeUserId,person.actor.userId,team.revision,data.status,note,now.toISOString(),expiresAt]);
   await person.guard(sql);
   return {id,state:data.status,teamRevision:team.revision,expiresAt};
  });
 }
 async function targets(request:Request,eventId:string) {
  const person=await principal(request);
  return deps.database.transaction(async sql=>{
   await person.guard(sql);
   await deps.integration().events.requireStaff(sql,person.actor,eventId,"judging_manage");
   const workspace=await deps.integration().judging.workspace(person,eventId);
   const items:{teamId:string;title:string;revision:number}[]=[];
   const seen=new Set<string>();
   for(const receipt of [...workspace.submissions].sort((a,b)=>b.version-a.version)){
    if(seen.has(receipt.teamId)) continue;
    seen.add(receipt.teamId);
    const team=await deps.integration().registration.getTeam(sql,eventId,receipt.teamId);
    if(team&&team.status!=="withdrawn") items.push({teamId:team.id,title:receipt.materials.title,revision:team.revision});
   }
   await person.guard(sql); return {items};
  });
 }
 async function participants(request:Request,eventId:string){
  const person=await principal(request);
  return deps.database.transaction(async sql=>{
   await person.guard(sql);
   await deps.integration().events.requireStaff(sql,person.actor,eventId,"logistics_manage");
   const userIds=await deps.integration().registration.listApprovedUserIds(sql,eventId);
   const rows=userIds.length?(await sql.query<{id:string;display_name:string}>("SELECT id,display_name FROM auth_users WHERE id=ANY($1::text[]) AND status='active' AND email_verified_at IS NOT NULL ORDER BY display_name,id",[userIds])).rows:[];
   await person.guard(sql);return {items:rows.map(row=>({userId:row.id,label:row.display_name||"已报名选手"}))};
  });
 }
 return {relationshipReviews,async handle(request:Request,segments:readonly string[]):Promise<Response|null>{
  const route=segments.join("/").match(/^organizer\/events\/([^/]+)\/(account-lookup|logistics-participants|judging\/relationship-review|judging\/relationship-targets)$/);
  if(!route) return null;
  const requestId=deps.ids.next();
  try {
   const allowed=["judging/relationship-targets","logistics-participants"].includes(route[2])?"GET":"POST";
   if(request.method!==allowed) throw new DomainError("METHOD_NOT_ALLOWED","请通过页面按钮操作。",{status:405});
   if(allowed==="POST") await deps.assertMutationAllowed(request);
   const data=await (route[2]==="logistics-participants"?participants(request,route[1]):allowed==="GET"?targets(request,route[1]):route[2]==="account-lookup"?accountLookup(request,route[1]):review(request,route[1]));
   return Response.json({data,requestId},{headers:{"Cache-Control":"private, no-store","Vary":"Cookie","X-Content-Type-Options":"nosniff"}});
  }catch(error){return Response.json(toErrorEnvelope(error,requestId),{status:isDomainError(error)?error.status:500,headers:{"Cache-Control":"private, no-store","Vary":"Cookie","X-Content-Type-Options":"nosniff",...(isDomainError(error)&&error.status===405?{Allow:["judging/relationship-targets","logistics-participants"].includes(route[2])?"GET":"POST"}:{})}});}
 }};
}
