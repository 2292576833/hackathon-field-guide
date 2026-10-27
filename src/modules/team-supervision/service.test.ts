import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Actor } from "../../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { DomainError } from "../../shared/errors.ts";
import type { SupervisionAssistantPort, SupervisionFactsPort } from "./ports.ts";
import type { SupervisionFacts, SupervisionTask } from "./model.ts";
import { createTeamSupervisionService, supervisionFingerprint, supervisionRequestId } from "./service.ts";
import { deriveSupervisionHints } from "./derive.ts";
import { createTeamSupervisionHandlers } from "./http.ts";
import { claimRun, finish, hold, readClaim, readSettings } from "./postgres.ts";
const alice: Actor={userId:"alice",platformRoles:["user"]},bob: Actor={userId:"bob",platformRoles:["user"]};
function facts(userId="alice",projectId="one"):SupervisionFacts{return{projectId,projectName:"演示项目",archived:false,membershipId:`${userId}-${projectId}`,userId,membershipStatus:"active",responsibility:{confirmed:true,version:"role1",summary:"前端交互"},plan:{id:"plan1",version:"1",status:"active"},version:"1",tasks:[]};}
function task(id:string,patch:Partial<SupervisionTask>={}):SupervisionTask{return{id,title:id,status:"todo",ownerMembershipId:"alice-one",reviewerMembershipId:"bob-one",dependencyTaskIds:[],accepted:false,blocker:null,deadlineAt:null,scheduledFinishAt:null,...patch};}
async function setup(){
  const engine=new PGlite();await engine.waitReady;await engine.exec(await readFile(new URL("./schema.sql",import.meta.url),"utf8"));
  const adapter=(executor:Pick<PGlite,"query">):SqlExecutor=>({async query<Row>(statement:string,parameters:readonly unknown[]=[]){const result=await executor.query<Row>(statement,[...parameters]);return{rows:result.rows,rowCount:result.affectedRows??result.rows.length};}});
  const database:DatabasePort={...adapter(engine),transaction:work=>engine.transaction(tx=>work(adapter(tx as unknown as PGlite)))};
  let now=new Date("2026-10-12T00:00:00Z"),calls=0,conversations=0,configured=true,pending:null|{requestId:string;status:"running"|"unknown"}=null,hook:(()=>Promise<void>)|null=null;
  const records=new Map<string,SupervisionFacts>(),requests:{message:string;requestId:string;expectedRevision:number}[]=[],versions=new Map<string,number>();
  const getFacts=(userId:string,projectId:string)=>{const key=`${userId}:${projectId}`;if(!records.has(key))records.set(key,facts(userId,projectId));return records.get(key)!;};
  const port:SupervisionFactsPort={async authorize(sql,actor,id,write,guard){await guard?.(sql);const f=getFacts(actor.userId,id);if(f.membershipStatus!=="active")throw new DomainError("PROJECT_ACCESS_DENIED","离队",{status:403});if(write&&f.archived)throw new DomainError("PROJECT_ARCHIVED","归档",{status:409});},async readFacts(sql,actor,id,guard){await guard?.(sql);return structuredClone(getFacts(actor.userId,id));}};
  const assistant:SupervisionAssistantPort={async conversation(actor,id,guard){conversations++;await database.transaction(async sql=>port.authorize(sql,actor,id,false,guard));return{revision:versions.get(`${actor.userId}:${id}`)??0,configured,provider:"dsh",pending};},async send(actor,id,input,guard){
    await database.transaction(async sql=>guard?.(sql));const key=`${actor.userId}:${id}`;if((versions.get(key)??0)!==input.expectedRevision)throw new DomainError("ASSISTANT_REVISION_CONFLICT","已变化",{status:409});calls++;requests.push(input);await hook?.();await database.transaction(async sql=>guard?.(sql));versions.set(key,input.expectedRevision+2);return{requestId:input.requestId,provider:"dsh",message:{id:`reply-${calls}`,role:"assistant",content:`${actor.userId}本人的真实假模型回执`,provider:"dsh"}};
  }};
  const deps={database,clock:{now:()=>new Date(now)},facts:port,assistant},service=createTeamSupervisionService(deps);
  return{engine,database,service,port,getFacts,requests,calls:()=>calls,conversations:()=>conversations,advance:(ms:number)=>{now=new Date(now.getTime()+ms);},setHook:(fn:typeof hook)=>{hook=fn;},setPending:(p:typeof pending)=>{pending=p;},setConfigured:(v:boolean)=>{configured=v;},restart:()=>createTeamSupervisionService(deps)};
}
async function fixture(work:(f:Awaited<ReturnType<typeof setup>>)=>Promise<void>){const f=await setup();try{await work(f);}finally{await f.engine.close();}}
const code=(name:string)=>(error:unknown)=>error instanceof DomainError&&error.code===name;
async function enable(f:Awaited<ReturnType<typeof setup>>,actor=alice,id="one"){const s=await f.service.get(actor,id);return f.service.settings(actor,id,{enabled:true,expectedRevision:s.revision});}

test("GET is read-only and default disabled, never initializes assistant or settings",async()=>fixture(async f=>{
  for(let i=0;i<3;i++){const s=await f.service.get(alice,"one");assert.equal(s.enabled,false);assert.equal(s.revision,0);assert.equal(s.reason,"disabled");await f.service.check(alice,"one");}
  assert.equal(f.calls(),0);assert.equal(f.conversations(),0);assert.equal((await f.engine.query("SELECT * FROM team_supervision_settings")).rows.length,0);assert.equal((await f.engine.query("SELECT * FROM team_supervision_runs")).rows.length,0);
}));
test("settings CAS and race reject stale window; consent bound to current membership",async()=>fixture(async f=>{
  const results=await Promise.allSettled([enable(f),enable(f)]);assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
  await assert.rejects(f.service.settings(alice,"one",{enabled:false,expectedRevision:0}),code("SUPERVISION_VERSION_CONFLICT"));
  f.getFacts("alice","one").membershipId="alice-rejoined";assert.equal((await f.service.check(alice,"one")).reason,"membership_changed");assert.equal(f.calls(),0);
  await enable(f);assert.equal((await f.service.check(alice,"one")).reason,"suggested");
}));
test("unconfirmed role, draft, missing and stale plan block automatic model",async()=>fixture(async f=>{
  await enable(f);const facts=f.getFacts("alice","one");facts.responsibility.confirmed=false;assert.equal((await f.service.check(alice,"one")).reason,"responsibility_unconfirmed");facts.responsibility.confirmed=true;
  for(const status of ["draft","missing","stale"] as const){facts.plan.status=status;assert.match((await f.service.check(alice,"one")).reason,/plan_/);}
  assert.equal(f.calls(),0);assert.equal(f.conversations(),0);
}));
test("same fact once, concurrent checks claim one request and preserve private DSH report",async()=>fixture(async f=>{
  await enable(f);await Promise.all([f.service.check(alice,"one"),f.service.check(alice,"one")]);assert.equal(f.calls(),1);assert.equal((await f.service.check(alice,"one")).reason,"unchanged");
  const s=await f.service.get(alice,"one");assert.equal(s.report?.provider,"dsh");assert.equal(s.report?.stale,false);assert.match(s.report!.content,/alice/);assert.equal((await f.service.get(bob,"one")).report,null);assert.equal((await f.service.get(alice,"two")).report,null);
  f.getFacts("alice","one").version="2";assert.equal((await f.service.get(alice,"one")).report?.stale,true);assert.equal((await f.service.check(alice,"one")).reason,"cooldown");f.advance(600_000);await f.service.check(alice,"one");assert.equal(f.calls(),2);
}));
test("24 per UTC day, all attempts counted, new day cannot replay old fingerprint",async()=>fixture(async f=>{
  await enable(f);for(let i=0;i<24;i++){f.getFacts("alice","one").version=String(i);assert.equal((await f.service.check(alice,"one")).reason,"suggested");f.advance(600_000);}
  f.getFacts("alice","one").version="limit";assert.equal((await f.service.check(alice,"one")).reason,"daily_limit");assert.equal(f.calls(),24);f.advance(86_400_000);await f.service.check(alice,"one");assert.equal(f.calls(),25);f.advance(86_400_000);assert.equal((await f.service.check(alice,"one")).reason,"unchanged");
}));
test("unknown survives restart, changed facts, UTC day, consent toggles and new membership; GET never clears",async()=>fixture(async f=>{
  await enable(f);f.setHook(async()=>{throw new Error("provider timeout");});const s=await f.service.check(alice,"one");assert.equal(s.reason,"hold");assert.ok(s.holdRequestId);f.setHook(null);f.advance(172_800_000);f.getFacts("alice","one").version="changed";
  const off=await f.service.settings(alice,"one",{enabled:false,expectedRevision:s.revision});f.getFacts("alice","one").membershipId="new-membership";await f.service.settings(alice,"one",{enabled:true,expectedRevision:off.revision});
  const restarted=f.restart();assert.equal((await restarted.check(alice,"one")).reason,"hold");assert.equal((await restarted.get(alice,"one")).holdRequestId,s.holdRequestId);assert.equal(f.calls(),1);
  const receipt=(await f.engine.query("SELECT * FROM team_supervision_runs")).rows;await restarted.get(alice,"one");assert.deepEqual((await f.engine.query("SELECT * FROM team_supervision_runs")).rows,receipt);
}));
test("original assistant running pauses; unknown creates durable hold without sending",async()=>fixture(async f=>{
  await enable(f);f.setPending({requestId:"manual",status:"running"});assert.equal((await f.service.check(alice,"one")).reason,"assistant_busy");f.setPending({requestId:"manual",status:"unknown"});assert.equal((await f.service.check(alice,"one")).reason,"hold");f.setPending(null);assert.equal((await f.restart().check(alice,"one")).reason,"hold");assert.equal(f.calls(),0);
}));
test("archive and departure reject settings/check, and revoked access during model never exposes reply",async()=>fixture(async f=>{
  await enable(f);const facts=f.getFacts("alice","one");facts.archived=true;assert.equal((await f.service.check(alice,"one")).reason,"archived");await assert.rejects(enable(f),code("PROJECT_ARCHIVED"));facts.archived=false;facts.membershipStatus="left";await assert.rejects(f.service.get(alice,"one"),code("PROJECT_ACCESS_DENIED"));facts.membershipStatus="active";
  f.setHook(async()=>{facts.membershipStatus="removed";});await assert.rejects(f.service.check(alice,"one"),code("PROJECT_ACCESS_DENIED"));assert.equal((await f.engine.query<{response_text:string|null}>("SELECT response_text FROM team_supervision_runs")).rows[0]?.response_text,null);assert.equal((await f.service.get(bob,"one")).report,null);
}));
test("expiry and changed facts cannot turn a late response into a current report or replay",async()=>fixture(async f=>{
  await enable(f);f.setHook(async()=>{f.advance(600_001);});assert.equal((await f.service.check(alice,"one")).reason,"hold");assert.equal((await f.service.get(alice,"one")).report,null);f.setHook(null);f.getFacts("alice","one").version="new";await f.service.check(alice,"one");assert.equal(f.calls(),1);
}));
test("explicit not_sent failure is consumed once without hold; later facts obey interval",async()=>fixture(async f=>{
  await enable(f);f.setHook(async()=>{throw Object.assign(new Error("not sent"),{externalState:"not_sent"});});const failed=await f.service.check(alice,"one");assert.equal(failed.reason,"failed");assert.equal(failed.holdRequestId,null);f.setHook(null);assert.equal((await f.service.check(alice,"one")).reason,"failed");assert.equal(f.calls(),1);f.getFacts("alice","one").version="2";assert.equal((await f.service.check(alice,"one")).reason,"cooldown");
}));
test("not configured is free; source changes and disabling during request do not save an old reply",async()=>fixture(async f=>{
  await enable(f);f.setConfigured(false);assert.equal((await f.service.check(alice,"one")).reason,"not_configured");assert.equal(f.calls(),0);assert.equal((await f.engine.query("SELECT * FROM team_supervision_runs")).rows.length,0);f.setConfigured(true);
  f.setHook(async()=>{f.getFacts("alice","one").version="changed-during-send";});const held=await f.service.check(alice,"one");assert.equal(held.reason,"hold");assert.equal(held.report,null);
  await enable(f,bob);f.setHook(async()=>{const current=await f.service.get(bob,"one");await f.service.settings(bob,"one",{enabled:false,expectedRevision:current.revision});});assert.equal((await f.service.check(bob,"one")).reason,"hold");assert.equal((await f.service.get(bob,"one")).report,null);
}));
test("request session guard is checked before writes and again at the model boundary",async()=>fixture(async f=>{
  let valid=false;const guard=async()=>{if(!valid)throw new DomainError("UNAUTHENTICATED","登录失效",{status:401});};
  await assert.rejects(f.service.settings(alice,"one",{enabled:true,expectedRevision:0},guard),code("UNAUTHENTICATED"));assert.equal((await f.engine.query("SELECT * FROM team_supervision_settings")).rows.length,0);valid=true;await enable(f);f.setHook(async()=>{valid=false;});await assert.rejects(f.service.check(alice,"one",guard),code("UNAUTHENTICATED"));assert.equal((await f.engine.query<{response_text:string|null}>("SELECT response_text FROM team_supervision_runs")).rows[0]?.response_text,null);
}));
test("rule hints require effective checked dependencies, preserve unknown timing and never fake DSH",()=>{
  const f=facts();f.tasks=[task("parent",{status:"done",accepted:false}),task("child",{dependencyTaskIds:["parent"]}),task("blocked",{status:"blocked",blocker:"等接口"}),task("review",{status:"review",reviewerMembershipId:"alice-one"}),task("late",{deadlineAt:"2026-10-11T00:00:00Z"})];
  let h=deriveSupervisionHints(f,new Date("2026-10-12T00:00:00Z"));assert.equal(h.filter(x=>x.kind==="ready").length,0);assert.ok(h.some(x=>x.kind==="review"&&x.taskId==="parent"));assert.ok(h.some(x=>x.kind==="blocked"));assert.ok(h.some(x=>x.kind==="time_risk"));f.tasks[0]!.accepted=true;h=deriveSupervisionHints(f,new Date());assert.ok(h.some(x=>x.kind==="ready"&&x.taskId==="child"));f.plan.status="stale";assert.equal(deriveSupervisionHints(f,new Date()).filter(x=>x.kind==="ready").length,0);
});
test("deterministic identities distinguish user/member/project, ignore property/task order",()=>{
  const a=facts();a.tasks=[task("b"),task("a")];const b={...a,tasks:[...a.tasks].reverse()};const now=new Date("2026-10-12T00:00:00Z");assert.equal(supervisionFingerprint(a,now),supervisionFingerprint(b,now));const fp=supervisionFingerprint(a,now);assert.notEqual(supervisionRequestId("alice","m1","one",fp),supervisionRequestId("bob","m1","one",fp));assert.notEqual(supervisionRequestId("alice","m1","one",fp),supervisionRequestId("alice","m2","one",fp));
});
test("HTTP uses session actor/guard, mutation authorization and strict body; GET cannot send",async()=>fixture(async f=>{
  let mutations=0,guards=0;const handlers=createTeamSupervisionHandlers({service:f.service,resolveActor:async()=>alice,authorizeMutation:async()=>{mutations++;},freshSessionGuard:()=>async()=>{guards++;},requestIds:{next:()=>"http1"}});
  const get=await handlers.get(new Request("https://test/one"),{projectId:"one"});assert.equal(get.status,200);assert.equal(mutations,0);assert.ok(guards>0);assert.equal(f.conversations(),0);
  const forged=await handlers.check(new Request("https://test/one",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({userId:"bob",factsFingerprint:"fake"})}),{projectId:"one"});assert.equal(forged.status,422);assert.equal(mutations,1);assert.equal(f.calls(),0);
}));

test("claim requires one settings CAS row and rolls back its receipt on missing/stale/paused settings",async()=>fixture(async f=>{
  const now="2026-10-12T00:00:00Z",expires="2026-10-12T00:10:00Z";
  const claim=(revision=1,membership="alice-one")=>f.database.transaction(sql=>claimRun(sql,"alice","one",membership,"claim-1","facts-1",now,expires,revision));
  await assert.rejects(claim(),code("SUPERVISION_CLAIM_CONFLICT"));assert.equal((await f.engine.query("SELECT * FROM team_supervision_runs")).rows.length,0);
  await enable(f);await assert.rejects(claim(99),code("SUPERVISION_CLAIM_CONFLICT"));await assert.rejects(claim(1,"old-member"),code("SUPERVISION_CLAIM_CONFLICT"));
  await f.service.settings(alice,"one",{enabled:false,expectedRevision:1});await assert.rejects(claim(2),code("SUPERVISION_CLAIM_CONFLICT"));
  await f.service.settings(alice,"one",{enabled:true,expectedRevision:2});await f.database.transaction(sql=>hold(sql,"alice","one","external-unknown"));await assert.rejects(claim(3),code("SUPERVISION_CLAIM_CONFLICT"));
  assert.equal((await f.engine.query("SELECT * FROM team_supervision_runs")).rows.length,0);assert.equal((await readSettings(f.database,"alice","one"))?.last_started_at,null);
}));
test("cooldown CAS rejects a second claim and hold zero-row is an error, preserving the first hold",async()=>fixture(async f=>{
  await assert.rejects(f.database.transaction(sql=>hold(sql,"alice","one","missing")),code("SUPERVISION_HOLD_CONFLICT"));await enable(f);
  await f.database.transaction(sql=>claimRun(sql,"alice","one","alice-one","first","first-facts","2026-10-12T00:00:00Z","2026-10-12T00:10:00Z",1));
  await assert.rejects(f.database.transaction(sql=>claimRun(sql,"alice","one","alice-one","second","second-facts","2026-10-12T00:01:00Z","2026-10-12T00:11:00Z",1)),code("SUPERVISION_CLAIM_CONFLICT"));
  assert.equal((await f.engine.query("SELECT * FROM team_supervision_runs")).rows.length,1);
  await f.database.transaction(sql=>hold(sql,"alice","one","first-unknown"));await f.database.transaction(sql=>hold(sql,"alice","one","later-unknown"));assert.equal((await readSettings(f.database,"alice","one"))?.hold_request_id,"first-unknown");
}));
test("settlement rejects zero rows and stale consent, and late success/failure cannot overwrite unknown",async()=>fixture(async f=>{
  const now="2026-10-12T00:01:00Z";
  await enable(f);await assert.rejects(f.database.transaction(sql=>finish(sql,"alice","one","missing","unknown",now)),code("SUPERVISION_SETTLEMENT_CONFLICT"));assert.equal((await readSettings(f.database,"alice","one"))?.hold_request_id,null);
  await f.database.transaction(sql=>claimRun(sql,"alice","one","alice-one","late","late-facts","2026-10-12T00:00:00Z","2026-10-12T00:10:00Z",1));
  await assert.rejects(f.database.transaction(sql=>finish(sql,"alice","one","late","succeeded",now,"reply","old reply",null,2)),code("SUPERVISION_SETTLEMENT_CONFLICT"));assert.equal((await readClaim(f.database,"alice","one","late"))?.status,"running");
  await f.database.transaction(sql=>finish(sql,"alice","one","late","unknown",now,null,null,"TIMEOUT"));const before=await readClaim(f.database,"alice","one","late");
  for(const status of ["succeeded","failed","unknown"] as const)await assert.rejects(f.database.transaction(sql=>finish(sql,"alice","one","late",status,now,"late-reply","must not be saved",null,1)),code("SUPERVISION_SETTLEMENT_CONFLICT"));
  assert.deepEqual(await readClaim(f.database,"alice","one","late"),before);assert.equal((await readSettings(f.database,"alice","one"))?.hold_request_id,"late");assert.equal((await f.service.get(alice,"one")).reason,"hold");
}));
test("a request marked unknown while the assistant is running cannot be reported as successfully settled",async()=>fixture(async f=>{
  await enable(f);f.setHook(async()=>{const requestId=f.requests[0]!.requestId;await f.database.transaction(sql=>finish(sql,"alice","one",requestId,"unknown","2026-10-12T00:01:00Z",null,null,"TIMEOUT"));});
  await assert.rejects(f.service.check(alice,"one"),code("SUPERVISION_SETTLEMENT_CONFLICT"));const state=await f.service.get(alice,"one");assert.equal(state.reason,"hold");assert.equal(state.report,null);assert.equal(f.calls(),1);
  f.setHook(null);f.getFacts("alice","one").version="new-facts";f.advance(86_400_000);assert.equal((await f.service.check(alice,"one")).reason,"hold");assert.equal(f.calls(),1);
}));
