import { AsyncLocalStorage } from "node:async_hooks";
import type { Actor, Clock, IdGenerator, ProjectMembershipAccess } from "../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../shared/persistence.ts";
import { DomainError, isDomainError, toErrorEnvelope } from "../shared/errors.ts";
import type { PostgresProjectsRepository } from "../modules/projects/index.ts";
import { createPostgresSkillsRepository, createReviewedSkillLookupPort, createProjectSkillSelectionService,
  createProjectSkillSelectionHttpHandlers, createSkillCandidateService, createSkillCandidateHandlers,
  createSkillPublicationPort, importPublishedSkillCandidates, parseTaskSkillReferences } from "../modules/skills/index.ts";
import type { ProjectSkillSelectionState, ProjectSkillSelectionPort, ProjectSkillSelectionTransaction, SkillsRepository, SkillPublicationTarget } from "../modules/skills/index.ts";
import { createPostgresSkillReviewRepository, createSkillReviewService, createSkillReviewHandlers } from "../modules/operations/skill-review.ts";
import type { SkillReview } from "../modules/operations/skill-review.ts";

type Handler = (request:Request)=>Promise<Response>;
interface RequestScope { request:Request; actor:Actor|null }
export interface ProjectSkillsIntegrationDependencies {
  database:DatabasePort;
  projectRepository:Pick<PostgresProjectsRepository,"getMembershipForShare">;
  /** Existing root repository accepted for composition; protected queries use the scoped public SQL factory. */
  skillsRepository?:SkillsRepository;
  clock:Clock; ids:IdGenerator;
  resolveActor(request:Request):Promise<Actor|null>;
  assertMutationAllowed(request:Request,actor:Actor):Promise<void>;
}
function id(value:unknown):string { if(typeof value!=="string"||!value||value.length>240||!/^[a-zA-Z0-9_.@+-]+$/.test(value)) throw new DomainError("INVALID_INPUT","空间或版本标识无效。");return value; }
function sameRoles(a:Actor,b:Actor) { return JSON.stringify([...a.platformRoles].sort())===JSON.stringify([...b.platformRoles].sort()); }
class RejectedResponse { readonly response:Response; constructor(response:Response){this.response=response;} }

/** One transaction owns request identity, M04 heads, M02 facts, selection CAS and all M10/M08 queries. */
export function createProjectSkillsIntegration(deps:ProjectSkillsIntegrationDependencies) {
  const transactions=new AsyncLocalStorage<SqlExecutor>();
  const requests=new AsyncLocalStorage<RequestScope>();
  const database:DatabasePort={
    query:(sql,params)=> (transactions.getStore()??deps.database).query(sql,params),
    transaction:work=>{ const active=transactions.getStore(); return active?work(active):deps.database.transaction(sql=>transactions.run(sql,()=>work(sql))); },
  };
  async function resolveActor(request:Request) { const actor=await deps.resolveActor(request); const scope=requests.getStore(); if(scope) {if(scope.actor&&(!actor||actor.userId!==scope.actor.userId||!sameRoles(actor,scope.actor))) throw new DomainError("SESSION_CHANGED","登录账号或权限已变化，请重新进入页面。",{status:401}); if(actor)scope.actor=actor;} return actor; }
  async function assertActorCurrent(sql:SqlExecutor,actor:Actor) {
    const scope=requests.getStore(); if(!scope)throw new DomainError("SESSION_CONTEXT_REQUIRED","此操作需要当前请求会话。",{status:401});
    const current=await resolveActor(scope.request); if(!current||current.userId!==actor.userId||!sameRoles(current,actor))throw new DomainError("SESSION_CHANGED","登录账号或权限已变化。",{status:401});
    const row=(await sql.query<{platform_roles:Actor["platformRoles"]}>("SELECT platform_roles FROM auth_users WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL FOR UPDATE",[actor.userId])).rows[0];
    if(!row||!sameRoles(actor,{userId:actor.userId,platformRoles:row.platform_roles}))throw new DomainError("UNAUTHENTICATED","账号当前无法操作，请重新登录。",{status:401});
  }
  async function protectProjects(sql:SqlExecutor,actor:Actor,projectIds:readonly string[]) {
    await assertActorCurrent(sql,actor);
    const ids=[...new Set(projectIds.map(id))].sort();
    // M04 never waits behind a selection-owned M02 lock: all heads precede all projects.
    for(const projectId of ids)await sql.query("SELECT project_id FROM assessments_assignment_heads WHERE project_id=$1 FOR UPDATE",[projectId]);
    for(const projectId of ids)await sql.query("SELECT id FROM projects_project WHERE id=$1 FOR UPDATE",[projectId]);
  }
  const selections:ProjectSkillSelectionPort={transaction:work=>database.transaction(async sql=>{
    const scope=requests.getStore(); if(!scope?.actor)throw new DomainError("SESSION_CONTEXT_REQUIRED","此操作需要当前请求会话。",{status:401});
    await assertActorCurrent(sql,scope.actor);
    const tx:ProjectSkillSelectionTransaction={
      async getProject(projectId) { const row=(await sql.query<{id:string;stage:string}>("SELECT id,stage FROM projects_project WHERE id=$1 FOR UPDATE",[id(projectId)])).rows[0];return row?{id:row.id,archived:row.stage==="archived",readOnly:row.stage==="archived"}:null; },
      async get(projectId,lock=false) { return (await sql.query<{document:ProjectSkillSelectionState}>(`SELECT document FROM project_skill_selections WHERE project_id=$1${lock?" FOR UPDATE":""}`,[id(projectId)])).rows[0]?.document??null; },
      async save(state,expectedRevision) {
        const actor=requests.getStore()?.actor; if(!actor)throw new DomainError("SESSION_CONTEXT_REQUIRED","会话不可用。",{status:401});
        await assertActorCurrent(sql,actor); if(state.updatedBy!==actor.userId)throw new DomainError("FORBIDDEN","保存身份不匹配。",{status:403});
        const checked=parseTaskSkillReferences(state.selections)!; if(state.revision!==expectedRevision+1)throw new DomainError("VERSION_CONFLICT","技能选择修订无效。",{status:409});
        const project=(await sql.query<{stage:string}>("SELECT stage FROM projects_project WHERE id=$1 FOR UPDATE",[state.projectId])).rows[0];
        const member=await deps.projectRepository.getMembershipForShare(sql,state.projectId,actor.userId);
        if(!member||member.status!=="active"||member.role!=="manager")throw new DomainError("FORBIDDEN","只有当前空间管理员可以保存技能选择。",{status:403});
        if(!project||project.stage==="archived")throw new DomainError("PROJECT_READ_ONLY","此空间只读。",{status:409});
        const document={...state,selections:checked}; const params=[state.projectId,state.revision,state.updatedBy,state.updatedAt,JSON.stringify(document)];
        const saved=expectedRevision===0?await sql.query("INSERT INTO project_skill_selections(project_id,revision,updated_by,updated_at,document) VALUES($1,$2,$3,$4::timestamptz,$5::jsonb) ON CONFLICT DO NOTHING",params):await sql.query("UPDATE project_skill_selections SET revision=$2,updated_by=$3,updated_at=$4::timestamptz,document=$5::jsonb WHERE project_id=$1 AND revision=$6",[...params,expectedRevision]);
        if(!saved.rowCount)throw new DomainError("VERSION_CONFLICT","队友已修改技能选择，请刷新并保留本地输入。",{status:409});
        await sql.query("INSERT INTO project_skill_selection_history(project_id,revision,saved_by,saved_at,document) VALUES($1,$2,$3,$4::timestamptz,$5::jsonb)",params);
        await assertActorCurrent(sql,actor);
      },
    };
    const result=await work(tx);await assertActorCurrent(sql,scope.actor);return result;
  })};
  const skillsRepository=createPostgresSkillsRepository(database);
  const reviewedLookup=createReviewedSkillLookupPort(skillsRepository);
  const projectAccess={async getMembership(projectId:string,userId:string):Promise<ProjectMembershipAccess|null>{return database.transaction(async sql=>{const actor=requests.getStore()?.actor;if(!actor||actor.userId!==userId)throw new DomainError("SESSION_CHANGED","登录账号已变化。",{status:401});return deps.projectRepository.getMembershipForShare(sql,id(projectId),userId);});}};
  const selectionService=createProjectSkillSelectionService({selections,projectAccess,reviewedSkills:reviewedLookup,clock:deps.clock});
  // Prelock sorted roots before the module performs source/target checks, including opposite-direction copies.
  const read=selectionService.read.bind(selectionService),catalog=selectionService.catalog.bind(selectionService),save=selectionService.save.bind(selectionService),copy=selectionService.copy.bind(selectionService);
  const protectedWork=<T>(actor:Actor|null,projectIds:readonly string[],work:()=>Promise<T>)=>database.transaction(async sql=>{if(!actor)throw new DomainError("UNAUTHENTICATED","请先登录。",{status:401});await protectProjects(sql,actor,projectIds);const result=await work();await assertActorCurrent(sql,actor);return result;});
  selectionService.read=(actor,projectId)=>protectedWork(actor,[projectId],()=>read(actor,projectId));
  selectionService.catalog=(actor,projectId)=>protectedWork(actor,[projectId],()=>catalog(actor,projectId));
  selectionService.save=(actor,projectId,input)=>protectedWork(actor,[projectId],()=>save(actor,projectId,input));
  selectionService.copy=(actor,source,target,expected)=>protectedWork(actor,[source,target],()=>copy(actor,source,target,expected));
  const candidateService=createSkillCandidateService({database,clock:deps.clock,ids:deps.ids,assertActorCurrent});
  const reviewService=createSkillReviewService({repository:createPostgresSkillReviewRepository(database),skills:createSkillPublicationPort(),clock:deps.clock,ids:deps.ids,assertActorCurrent});
  async function withRequest<T>(request:Request,work:()=>Promise<T>):Promise<T> {return database.transaction(sql=>requests.run({request,actor:null},async()=>{const actor=await resolveActor(request);if(!actor)throw new DomainError("UNAUTHENTICATED","请先登录。",{status:401});await assertActorCurrent(sql,actor);const result=await work();await assertActorCurrent(sql,actor);return result;}));}
  const wrap=(handler:Handler):Handler=>async request=>{try{return await withRequest(request,async()=>{const response=await handler(request);if(!response.ok)throw new RejectedResponse(response);return response;});}catch(error){if(error instanceof RejectedResponse)return error.response;return Response.json(toErrorEnvelope(error,deps.ids.next()),{status:isDomainError(error)?error.status:500,headers:{"Cache-Control":"no-store"}});}};
  const http={resolveActor,assertMutationAllowed:deps.assertMutationAllowed,requestId:()=>deps.ids.next()};
  const selectionRaw=createProjectSkillSelectionHttpHandlers({...http,service:selectionService});
  const candidateRaw=createSkillCandidateHandlers({...http,service:candidateService});
  const reviewRaw=createSkillReviewHandlers({...http,service:reviewService});
  const reviewList:Handler=async request=>{
    const url=new URL(request.url);const value={kind:url.searchParams.get("kind"),id:url.searchParams.get("id"),versionId:url.searchParams.get("versionId")};
    if(!value.kind&&!value.id&&!value.versionId)return reviewRaw.list(request);
    const requestId=deps.ids.next();try{
      if(request.method!=="GET")throw new DomainError("METHOD_NOT_ALLOWED","方法不支持。",{status:405});
      if([...url.searchParams.keys()].some(key=>!["kind","id","versionId","limit"].includes(key))||["kind","id","versionId","limit"].some(key=>url.searchParams.getAll(key).length>1)||!["skill","bundle"].includes(value.kind??"")||!value.id||!value.versionId)throw new DomainError("INVALID_INPUT","请提供完整精确审核对象。");
      const limit=Number(url.searchParams.get("limit")??100);if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new DomainError("INVALID_INPUT","数量须为1到100。");
      const actor=await resolveActor(request);if(!actor)throw new DomainError("UNAUTHENTICATED","请先登录。",{status:401});if(!actor.platformRoles.some(role=>role==="admin"||role==="reviewer"))throw new DomainError("FORBIDDEN","需要技能审核权限。",{status:403});
      const result=await database.transaction(async sql=>{await assertActorCurrent(sql,actor);const rows=(await sql.query<{payload:SkillReview}>("SELECT payload FROM operations_skill_reviews WHERE target_kind=$1 AND target_id=$2 AND version_id=$3 ORDER BY candidate_revision DESC LIMIT $4",[value.kind,id(value.id),id(value.versionId),limit])).rows.map(row=>row.payload);await assertActorCurrent(sql,actor);return rows;});
      return Response.json({data:result,requestId},{headers:{"Cache-Control":"no-store"}});
    }catch(error){return Response.json(toErrorEnvelope(error,requestId),{status:isDomainError(error)?error.status:500,headers:{"Cache-Control":"no-store"}});}
  };
  return {selectionService,reviewedLookup,candidateService,reviewService,selections,withRequest,
    initialize:()=>importPublishedSkillCandidates({database,clock:deps.clock,ids:deps.ids}),
    handlers:{
      selection:{read:(projectId:string)=>wrap(selectionRaw.read(projectId)),catalog:(projectId:string)=>wrap(selectionRaw.catalog(projectId)),save:(projectId:string)=>wrap(selectionRaw.save(projectId)),copy:(projectId:string)=>wrap(selectionRaw.copy(projectId))},
      candidates:{list:wrap(candidateRaw.list),detail:(target:SkillPublicationTarget)=>wrap(candidateRaw.detail(target)),save:wrap(candidateRaw.save)},
      reviews:{list:wrap(reviewList),detail:(reviewId:string)=>wrap(reviewRaw.detail(reviewId)),register:(target:SkillPublicationTarget)=>wrap(reviewRaw.register(target)),decide:(reviewId:string)=>wrap(reviewRaw.decide(reviewId)),publish:(reviewId:string)=>wrap(reviewRaw.publish(reviewId)),withdraw:(target:SkillPublicationTarget)=>wrap(reviewRaw.withdraw(target))},
    }
  };
}
