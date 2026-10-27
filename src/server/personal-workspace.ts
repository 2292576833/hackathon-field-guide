import { createHash } from "node:crypto";
import type { Actor, Clock, IdGenerator } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import type { FreshSessionGuard, PersonalAiPort, PersonalArtifact, PersonalArtifactKind, PersonalGenerationRequest } from "../shared/personal-ai.ts";
import { DomainError, isDomainError } from "../shared/errors.ts";
import { AiProviderError, withAiExecutionContext, type JsonModelPort } from "./ai.ts";

export interface DshAccountSession { id: string; provider: "dsh"; createdAt: string; updatedAt: string; busy: boolean }
type SessionRow = { id: string; user_id: string; active_job_id: string | null; created_at: Date | string; updated_at: Date | string };
type ArtifactRow = { id: string; kind: PersonalArtifactKind; title: string; data: unknown; created_at: Date | string; session_id: string };
const iso = (value: Date | string) => new Date(value).toISOString();
const artifact = (row: ArtifactRow): PersonalArtifact => ({ id: row.id, kind: row.kind, title: row.title, data: row.data, createdAt: iso(row.created_at), provider: "dsh", sessionId: row.session_id });
const kinds: PersonalArtifactKind[] = ["participation_plan", "roadshow", "ppt", "profile_summary", "project_feasibility", "space_assistant_reply"];
export function personalRequestHash(request: Pick<PersonalGenerationRequest<unknown>, "kind" | "input" | "requestIdentity">): string {
  const canonical = JSON.stringify([request.kind, request.requestIdentity ?? request.input], (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
  // A deployment/prompt update or a new day cannot authorize an uncertain replay.
  return createHash("sha256").update(canonical).digest("hex");
}
export function createPersonalWorkspace(deps: { database: DatabasePort; clock: Clock; ids: IdGenerator; model: JsonModelPort | null;
  ledger?: { recoverReservations(id: string, time: string): Promise<void> }; timeoutMs?: number; maxOutputTokens?: number }) {
  async function assertActor(sql: SqlExecutor, actor: Actor, guard?: FreshSessionGuard) {
    const user = await sql.query("SELECT id FROM auth_users WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL FOR SHARE", [actor.userId]);
    if (!user.rowCount) throw new DomainError("UNAUTHENTICATED", "请先登录后使用专属工作台。", { status: 401 });
    await guard?.(sql);
  }
  async function ensure(sql: SqlExecutor, actor: Actor, guard?: FreshSessionGuard): Promise<SessionRow> {
    await assertActor(sql, actor, guard);
    const now = deps.clock.now().toISOString();
    await sql.query("INSERT INTO personal_dsh_sessions(id,user_id,created_at,updated_at) VALUES($1,$2,$3::timestamptz,$3::timestamptz) ON CONFLICT(user_id) DO NOTHING", [deps.ids.next(), actor.userId, now]);
    const result = await sql.query<SessionRow>("SELECT * FROM personal_dsh_sessions WHERE user_id=$1 FOR UPDATE", [actor.userId]);
    const row=result.rows[0]!;
    if(row.active_job_id) {
      const jobs=await sql.query<{status:string;lease_until:Date|string|null}>("SELECT status,lease_until FROM ai_execution_jobs WHERE id=$1",[row.active_job_id]);
      const job=jobs.rows[0];
      const active=job?.status==="running"&&job.lease_until&&Date.parse(iso(job.lease_until))>deps.clock.now().getTime();
      if(!active) {
        // A crashed or timed-out provider call stays uncertain in the ledger;
        // reclaim the UI lock without refunding or replaying the request.
        if(job?.status==="running") await sql.query("UPDATE ai_execution_jobs SET status='unknown',external_state='unknown',error_code='AI_LEASE_EXPIRED',lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=$2::timestamptz WHERE id=$1 AND status='running'",[row.active_job_id,now]);
        await sql.query("UPDATE personal_dsh_sessions SET active_job_id=NULL,updated_at=$2::timestamptz WHERE user_id=$1",[actor.userId,now]);
        row.active_job_id=null;
      }
    }
    return row;
  }
  async function claim(sql: SqlExecutor, actor: Actor, executionId: string) {
    const session = await ensure(sql, actor);
    if (session.active_job_id) {
      const job = await sql.query<{ status: string; lease_until: Date | string | null }>("SELECT status,lease_until FROM ai_execution_jobs WHERE id=$1", [session.active_job_id]);
      const current = job.rows[0];
      if (current?.status === "running" && current.lease_until && Date.parse(iso(current.lease_until)) > deps.clock.now().getTime())
        throw new DomainError("DSH_SESSION_BUSY", "你的 DSH 正在处理上一项请求，请等结果返回后再继续。", { status: 409 });
      if (current?.status === "running") await sql.query("UPDATE ai_execution_jobs SET status='unknown',external_state='unknown',error_code='AI_LEASE_EXPIRED',lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=$2::timestamptz WHERE id=$1 AND status='running'", [session.active_job_id,deps.clock.now().toISOString()]);
    }
    await sql.query("UPDATE personal_dsh_sessions SET active_job_id=$2,updated_at=$3::timestamptz WHERE user_id=$1", [actor.userId, executionId, deps.clock.now().toISOString()]);
    return session.id;
  }
  async function release(sql: SqlExecutor, actor: Actor, executionId: string) {
    await sql.query("UPDATE personal_dsh_sessions SET active_job_id=NULL,updated_at=$3::timestamptz WHERE user_id=$1 AND active_job_id=$2", [actor.userId, executionId, deps.clock.now().toISOString()]);
  }
  async function historyRows(sql: SqlExecutor, actor: Actor, projectId?: string) {
    const result = await sql.query<{ id: string | number; role: "user" | "assistant"; content: string }>("SELECT m.id,m.role,m.content FROM personal_dsh_messages m JOIN personal_dsh_sessions s ON s.id=m.session_id WHERE s.user_id=$1 AND m.project_id IS NOT DISTINCT FROM $2 ORDER BY m.id DESC LIMIT 10", [actor.userId, projectId ?? null]);
    const items = [...result.rows].reverse().map(item => ({ ...item, id: String(item.id) }));
    let bytes = items.reduce((sum, item) => sum + Buffer.byteLength(item.content, "utf8"), 0);
    while (bytes > 24000 && items.length) bytes -= Buffer.byteLength(items.shift()!.content, "utf8");
    return items;
  }
  async function history(sql: SqlExecutor, actor: Actor, projectId?: string) {
    return (await historyRows(sql, actor, projectId)).map(({ role, content }) => ({ role, content }));
  }
  async function append(sql: SqlExecutor, actor: Actor, projectId: string | undefined, message: string, reply: string) {
    const session = await ensure(sql, actor), now = deps.clock.now().toISOString();
    const saved = await sql.query<{id:string|number;role:string}>("INSERT INTO personal_dsh_messages(session_id,project_id,role,content,created_at) VALUES($1,$2,'user',$3,$5::timestamptz),($1,$2,'assistant',$4,$5::timestamptz) RETURNING id,role", [session.id, projectId ?? null, message, reply, now]);
    // Full account memory stays durable. Model/history reads remain bounded;
    // only an explicit user clear removes the selected conversation.
    return { userMessageId: String(saved.rows.find(row => row.role === "user")!.id), assistantMessageId: String(saved.rows.find(row => row.role === "assistant")!.id) };
  }
  const service: PersonalAiPort & { session(actor: Actor, guard?: FreshSessionGuard): Promise<DshAccountSession>; claim: typeof claim; release: typeof release; history: typeof history; append: typeof append;
    conversation(actor: Actor, projectId?: string, guard?: FreshSessionGuard): Promise<{ session: DshAccountSession; messages: {role:"user"|"assistant";content:string}[]; messageIds: string[] }>;
    clearConversation(actor: Actor, projectId?: string, guard?: FreshSessionGuard): Promise<{ cleared: true }> } = {
    async session(actor, guard) {
      return deps.database.transaction(async sql => { const row = await ensure(sql, actor, guard); return { id: row.id, provider: "dsh", createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), busy: Boolean(row.active_job_id) }; });
    }, claim, release, history, append,
    async conversation(actor, projectId, guard) {
      return deps.database.transaction(async sql => { const row = await ensure(sql, actor, guard), items = await historyRows(sql, actor, projectId); return { session: { id: row.id, provider: "dsh", createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), busy: Boolean(row.active_job_id) }, messages: items.map(({role,content})=>({role,content})), messageIds: items.map(item=>item.id) }; });
    },
    async clearConversation(actor, projectId, guard) {
      return deps.database.transaction(async sql => { const row = await ensure(sql, actor, guard); if (row.active_job_id) throw new DomainError("DSH_SESSION_BUSY", "请等 DSH 当前回复完成后再清空对话。", { status: 409 });
        await sql.query("DELETE FROM personal_dsh_messages WHERE session_id=$1 AND project_id IS NOT DISTINCT FROM $2", [row.id, projectId ?? null]); return { cleared: true }; });
    },
    async list(actor, kind, guard) {
      if (!kinds.includes(kind)) throw new DomainError("INVALID_ARTIFACT_KIND", "请选择参赛计划、路演或 PPT 记录。", { status: 422 });
      return deps.database.transaction(async sql => { await assertActor(sql, actor, guard); const result = await sql.query<ArtifactRow>("SELECT id,kind,title,data,created_at,session_id FROM personal_ai_artifacts WHERE user_id=$1 AND kind=$2 ORDER BY created_at DESC,id DESC LIMIT 30", [actor.userId, kind]); return result.rows.map(artifact); });
    },
    async get(actor, id, guard) {
      if (typeof id !== "string" || id.length > 200 || !/^[A-Za-z0-9_-]+$/.test(id)) throw new DomainError("INVALID_ARTIFACT_ID", "记录地址无效。", { status: 422 });
      return deps.database.transaction(async sql => { await assertActor(sql, actor, guard); const result = await sql.query<ArtifactRow>("SELECT id,kind,title,data,created_at,session_id FROM personal_ai_artifacts WHERE user_id=$1 AND id=$2", [actor.userId, id]); if (!result.rows.length) throw new DomainError("ARTIFACT_NOT_FOUND", "这份记录不存在或不属于当前账号。", { status: 404 }); return artifact(result.rows[0]!); });
    },
    async generate<T>(actor: Actor, request: PersonalGenerationRequest<T>, guard?: FreshSessionGuard): Promise<PersonalArtifact<T>> {
      if (!deps.model) throw new DomainError("DSH_NOT_CONFIGURED", "DSH 尚未配置，当前可以先填写资料和查看模板。", { status: 503 });
      if (!kinds.includes(request.kind) || !request.title.trim() || request.title.length > 200) throw new DomainError("INVALID_ARTIFACT_INPUT", "生成内容无效。", { status: 422 });
      const hash = personalRequestHash(request);
      const id = deps.ids.next(), leaseToken = deps.ids.next(), now = deps.clock.now(), projectId = `navigator-user:${actor.userId}`;
      let sessionId = "";
      await deps.database.transaction(async sql => {
        await assertActor(sql, actor, guard);
        sessionId = await claim(sql, actor, id);
        const unknown = await sql.query("SELECT r.execution_id FROM personal_ai_requests r JOIN ai_execution_jobs j ON j.id=r.execution_id WHERE r.user_id=$1 AND r.request_hash=$2 AND j.status='unknown' LIMIT 1", [actor.userId, hash]);
        if (unknown.rowCount) throw new DomainError("AI_PREVIOUS_REQUEST_UNKNOWN", "上次同一内容的请求结果尚未确认，已暂停重复发送。请先联系管理员核查请求状态。", { status: 409 });
        const window = new Date(Math.floor(now.getTime()/900000)*900000).toISOString();
        const budget = await sql.query("INSERT INTO navigator_request_budgets(actor_id,window_start,calls) VALUES($1,$2::timestamptz,1) ON CONFLICT(actor_id,window_start) DO UPDATE SET calls=navigator_request_budgets.calls+1 WHERE navigator_request_budgets.calls<10 RETURNING calls", [actor.userId, window]);
        if (!budget.rowCount) throw new DomainError("NAVIGATOR_RATE_LIMITED", "本轮 AI 请求较多，请稍后继续。", { status: 429 });
        const leaseMs = Math.max(180000,(deps.timeoutMs??90000)+30000);
        await sql.query("INSERT INTO ai_execution_jobs(id,kind,module_job_id,source_revision,project_id,actor_id,status,attempts,lease_owner,lease_token,lease_until,created_at,updated_at) VALUES($1,'personal_artifact',$1,1,$2,$3,'running',1,'personal-http',$4,$5::timestamptz,$6::timestamptz,$6::timestamptz)", [id,projectId,actor.userId,leaseToken,new Date(now.getTime()+leaseMs).toISOString(),now.toISOString()]);
        await sql.query("INSERT INTO personal_ai_requests(execution_id,user_id,request_hash,created_at) VALUES($1,$2,$3,$4::timestamptz)",[id,actor.userId,hash,now.toISOString()]);
      });
      try {
        const result = await withAiExecutionContext({ executionId:id,leaseToken,projectId,actorId:actor.userId },()=>deps.model!.completeJSON({
          systemPrompt:request.systemPrompt,input:request.input,promptVersion:request.promptVersion,outputExample:request.outputExample,
          maxOutputTokens:Math.min(request.maxOutputTokens??4096,deps.maxOutputTokens??4096)
        },AbortSignal.timeout(deps.timeoutMs??90000)));
        const data = request.validate(result.content);
        if (Buffer.byteLength(JSON.stringify(data),"utf8")>100000) throw new DomainError("AI_RESPONSE_INVALID","DSH 结果过长，未保存为可用计划。",{status:503});
        const createdAt = deps.clock.now().toISOString();
        return await deps.database.transaction(async sql => {
          await assertActor(sql,actor,guard); await ensure(sql,actor);
          const finished=await sql.query("UPDATE ai_execution_jobs SET status='succeeded',external_state='response_received',lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=$3::timestamptz WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>$3::timestamptz RETURNING id",[id,leaseToken,createdAt]);
          if(finished.rowCount!==1) throw new AiProviderError("AI_LEASE_LOST","response_received");
          await sql.query("INSERT INTO personal_ai_artifacts(id,user_id,session_id,kind,title,data,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz)",[id,actor.userId,sessionId,request.kind,request.title,JSON.stringify(data),createdAt]);
          await release(sql,actor,id);
          return {id,kind:request.kind,title:request.title,data,createdAt,provider:"dsh",sessionId};
        });
      } catch(error) {
        const pending=await deps.database.query("SELECT id FROM ai_usage_attempts WHERE execution_id=$1 AND status='reserved' LIMIT 1",[id]);
        let cleanupFailed=false; try { await deps.ledger?.recoverReservations(id,deps.clock.now().toISOString()); } catch { cleanupFailed=true; }
        const uncertain=pending.rowCount>0||cleanupFailed||(error instanceof AiProviderError&&(error.externalState==="unknown"||error.code==="AI_LEASE_LOST"));
        await deps.database.transaction(async sql=>{
          await sql.query("UPDATE ai_execution_jobs SET status=$3,external_state=$4,error_code=$5,lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=$6::timestamptz WHERE id=$1 AND lease_token=$2 AND status='running'",[id,leaseToken,uncertain?"unknown":"failed",uncertain?"unknown":error instanceof AiProviderError?error.externalState:"response_received",isDomainError(error)&&/^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)?error.code:"PERSONAL_AI_FAILED",deps.clock.now().toISOString()]);
          await release(sql,actor,id);
        });
        throw error;
      }
    }
  };
  return service;
}
