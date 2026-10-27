import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes } from "node:crypto";
import type { Actor } from "../shared/contracts.ts";
import { DomainError } from "../shared/errors.ts";
import { createDatabase } from "./database.ts";
import { createApplication } from "./application.ts";
import { dispatch } from "./router.ts";
import { createBudgetedModel, AiProviderError } from "./ai.ts";
import { createAiWorker, createStandardAiHandlers, PostgresAiLedger } from "./ai-jobs.ts";
import { createModelRoleHelp, createRoleHelpService, contextFingerprint, inputSnapshot } from "../modules/assessments/index.ts";
import type { EventRuleVersion } from "../modules/events/index.ts";

const alice:Actor={userId:"ux-alice",platformRoles:["user"]};
const bob:Actor={userId:"ux-bob",platformRoles:["user"]};
const reviewer:Actor={userId:"ux-reviewer",platformRoles:["reviewer"]};
const origin="http://localhost:3000";
const answers={experience:"会整理资料",interests:"想尝试文档",constraints:"可投入两个小时"};
const intention={expectedRevision:0,duties:["design","documentation"],experience:"PRIVATE_UNSHARED_EXPERIENCE",wantsAiHelp:true,helpQuestion:"PRIVATE_UNSHARED_QUESTION",share:{duties:true,experience:false,wantsAiHelp:false,helpQuestion:false}};

async function fixture(){
  const database=await createDatabase({});
  const app=await createApplication({mode:"local",origin,codePepper:"explicit-isolated-test-pepper-material-only",emailFrom:"test@example.test"},database);
  const now=app.clock.now().toISOString();
  const tokens=new Map<string,string>();
  for(const actor of [alice,bob,reviewer]){
    await database.query("INSERT INTO auth_users(id,email,display_name,timezone,status,platform_roles,email_verified_at,created_at,revision) VALUES($1,$2,$3,'Asia/Shanghai','active',$4,$5,$5,1)",[actor.userId,`${actor.userId}@example.test`,`${actor.userId}昵称`,actor.platformRoles,now]);
    const token=randomBytes(32).toString("base64url");tokens.set(actor.userId,token);
    await database.query("INSERT INTO auth_sessions(id,user_id,token_hash,created_at,authenticated_at,expires_at) VALUES($1,$2,$3,$4,$4,$5)",[`${actor.userId}-session`,actor.userId,createHash("sha256").update(token).digest("hex"),now,new Date(app.clock.now().getTime()+3600000).toISOString()]);
  }
  const project=await app.projects.createProject(alice,{name:"新手协作空间",timezone:"Asia/Shanghai",goal:"做出可演示的原型"});
  const request=(actor:Actor,path:string,method="GET",body?:unknown)=>new Request(`${origin}/api/v1/${path}`,{method,headers:{Cookie:`hackathon_session=${tokens.get(actor.userId)}`,Origin:origin,...(body===undefined?{}:{"Content-Type":"application/json"})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const route=(actor:Actor,path:string,method="GET",body?:unknown)=>dispatch(app,request(actor,path,method,body),path.split("/"));
  return{app,database,project,request,route};
}
function officialRules(now:string):EventRuleVersion{
  return{eventId:"ux-event",version:1,createdAt:now,
    metadata:{name:"官方原型黑客松",organizer:"测试主办方",format:"online",region:"线上",officialUrl:"https://example.test/rules"},
    sources:[{id:"source",eventId:"ux-event",version:1,sourceConfigId:null,url:"https://example.test/rules",kind:"official",contentHash:"a".repeat(64),fetchedAt:now,trustScope:"official_rules",status:"available"}],
    evidence:[{id:"proof",eventId:"ux-event",version:1,sourceId:"source",fieldKey:"official_tracks",excerpt:"主办方设置原型赛道，需要可运行原型。",locator:"#tracks",rawDateText:null,verifiedBy:reviewer.userId,verifiedAt:now,conflictsWith:[]}],
    facts:["eligibility","fees","team_size","ai_policy"].map(key=>({key,statement:"待确认",status:"unknown",evidenceIds:[]})),
    stages:[],requirements:[{id:"demo",label:"可运行原型",necessity:"required",stageId:null,evidenceIds:["proof"]}],qualityFlags:["missing_information"],
    officialTracks:{status:"confirmed",evidenceIds:["proof"],tracks:[{id:"prototype",name:"主办方原型赛道",evidenceIds:["proof"],eligibility:null,scoringFocus:{text:"原型可演示",evidenceIds:["proof"]},deliverables:[{requirementId:"demo",evidenceIds:["proof"]}]}]},
  };
}
async function confirm(f:Awaited<ReturnType<typeof fixture>>){
  await f.app.events.createCandidate(reviewer,officialRules(f.app.clock.now().toISOString()),0);
  await f.app.events.requestReview(reviewer,"ux-event",1);
  await f.app.events.publishCandidate(reviewer,"ux-event",2);
  return f.app.events.confirmProjectRules(alice,f.project.id,"ux-event",1,0);
}
async function data(response:Response){assert.equal(response.ok,true,await response.clone().text());return (await response.json()).data;}

test("root migration and dispatch expose real official tracks, own opt-in intentions and versioned planning inputs",async()=>{
  const f=await fixture();try{
    const unknown=await data(await f.route(alice,`projects/${f.project.id}/official-tracks`));assert.equal(unknown.rules,null);
    const confirmation=await confirm(f);
    await data(await f.route(alice,`projects/${f.project.id}/track-selection`,"PUT",{expectedRevision:0,eventId:"ux-event",rulesVersion:1,confirmationRevision:confirmation.revision,trackId:"prototype",reason:"选择主办方原型赛道"}));
    await data(await f.route(alice,`projects/${f.project.id}/my-intention`,"PUT",intention));
    const shared=await data(await f.route(alice,`projects/${f.project.id}/shared-intentions`));
    assert.deepEqual(shared.intentions[0].duties,["design","documentation"]);
    assert.equal(JSON.stringify(shared).includes("PRIVATE_UNSHARED"),false);
    await f.app.projects.updateMyAvailability(alice,f.project.id,{expectedRevision:0,timezone:"Asia/Shanghai",windows:[{id:"window",startsAt:"2026-10-10T10:00:00+08:00",endsAt:"2026-10-10T12:00:00+08:00",effectiveMinutes:120}]});
    const snapshot=await f.app.facts.assignmentContext.getSnapshot(f.project.id);
    assert.equal(snapshot.officialTracks?.selectedTrackId,"prototype");assert.equal(snapshot.officialTracks?.needsReview,false);
    assert.equal(snapshot.trackSelectionRevision,1);assert.equal(snapshot.members[0]?.availableMinutes,120);
    assert.equal(snapshot.confirmedRequirements?.[0]?.text,"可运行原型");assert.equal(JSON.stringify(snapshot).includes("PRIVATE_UNSHARED"),false);
    const stored=inputSnapshot(snapshot,[]);assert.equal(stored.members[0]?.sharedIntention?.duties,undefined);assert.equal(contextFingerprint(stored),contextFingerprint(snapshot));
    const input=await f.app.facts.planningFacts.readInput(f.project.id,f.app.clock.now().toISOString(),alice);
    assert.deepEqual(input.memberIntentionRefs,snapshot.memberIntentionRefs);assert.equal(input.trackSelectionRevision,1);
    const locked=await f.database.transaction(sql=>f.app.facts.planningFacts.lockVersions(f.project.id,sql,alice));assert.deepEqual(locked.memberIntentionRefs,input.memberIntentionRefs);
    const foreign=await f.route(bob,`projects/${f.project.id}/my-intention`,"PUT",intention);assert.ok([403,404].includes(foreign.status));
    const conflict=await f.route(alice,`projects/${f.project.id}/my-intention`,"PUT",intention);assert.equal(conflict.status,409);
    await data(await f.route(alice,`projects/${f.project.id}/my-intention`,"PUT",{...intention,expectedRevision:1,share:{duties:false,experience:false,wantsAiHelp:false,helpQuestion:false}}));
    const withdrawn=await f.app.facts.assignmentContext.getSnapshot(f.project.id);assert.equal(withdrawn.members[0]?.sharedIntention?.duties,undefined);
    assert.equal(withdrawn.memberIntentionRefs?.[0]?.revision,2);assert.notEqual(contextFingerprint(snapshot),contextFingerprint(withdrawn));
  }finally{await f.database.close();}
});

test("anonymous invitation shows public event and nickname, capacity is persistent, expired login cannot write",async()=>{
  const f=await fixture();try{
    await confirm(f);
    const project=await f.app.projects.getProject(alice,f.project.id);
    const invitation=await f.app.projects.createProjectInvitation(alice,f.project.id,{expectedRevision:project.project.revision,maxUses:3});
    const previewPath=`invitations/${invitation.token}/public-preview`;
    const preview=await data(await dispatch(f.app,new Request(`${origin}/api/v1/${previewPath}`),previewPath.split("/")));
    assert.equal(preview.eventName,"官方原型黑客松");assert.equal(preview.inviterDisplayName,`${alice.userId}昵称`);assert.equal(preview.remainingUses,3);
    for(const field of ["email","scopeId","tokenHash","acceptances","goal"]){assert.equal(Object.hasOwn(preview,field),false);}
    await f.app.projects.acceptInvitation(bob,invitation.token);
    const accepted=await f.app.projects.acceptInvitation(bob,invitation.token);assert.equal(accepted.membership.role,"member");
    assert.equal((await f.app.projects.previewPublicSpaceInvitation(invitation.token)).remainingUses,2);
    const rows=await f.database.query<{used_uses:number}>("SELECT used_uses FROM projects_invitation WHERE id=$1",[invitation.invitation.id]);assert.equal(rows.rows[0]?.used_uses,1);
    await f.database.query("UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1",[alice.userId]);
    const denied=await f.route(alice,`projects/${f.project.id}/my-intention`,"PUT",intention);assert.equal(denied.status,401);
    const untouched=await f.database.query("SELECT project_id FROM projects_member_intention WHERE project_id=$1",[f.project.id]);assert.equal(untouched.rowCount,0);
    const noModel=await f.route(bob,`projects/${f.project.id}/role-help/latest`);assert.equal(noModel.status,200);
    assert.equal((await noModel.json()).data.job,null);
  }finally{await f.database.close();}
});

test("role-help standard worker uses a real lease and shared budget, preserves unknown call across a new key",async()=>{
  const f=await fixture();try{
    let calls=0;const ledger=new PostgresAiLedger(f.database,{dailyProjectCallLimit:4});
    const model=createBudgetedModel({model:{modelVersion:"isolated-fixture-model",async completeJSON(){calls+=1;throw new AiProviderError("AI_NETWORK_UNCERTAIN","unknown");}},ledger,maxAttempts:1});
    const service=createRoleHelpService({database:f.database,clock:f.app.clock,ids:f.app.ids,assignmentContext:f.app.facts.assignmentContext,model:createModelRoleHelp({model}),assertActor:async(actor,sql)=>{const current=await sql.query("SELECT id FROM auth_users WHERE id=$1 AND status='active' FOR SHARE",[actor.userId]);if(!current.rowCount)throw new DomainError("UNAUTHENTICATED","账号已停用。",{status:401});}});
    const queued=await service.queue(alice,f.project.id,answers,"original");assert.equal(calls,0);
    const handlers=createStandardAiHandlers({database:f.database,events:f.app.events,assessments:f.app.assessments,retrospectives:f.app.retrospectives,roleHelp:service});
    const worker=createAiWorker({database:f.database,ledger,handlers,clock:f.app.clock.now});
    const result=await worker.runOnce();assert.equal(result.status,"unknown");assert.equal(calls,1);
    const row=await f.database.query<{kind:string;status:string;attempts:number}>("SELECT kind,status,attempts FROM ai_execution_jobs WHERE module_job_id=$1",[queued.id]);assert.equal(row.rows[0]?.kind,"m04_role_help");assert.equal(row.rows[0]?.attempts,1);
    const usage=await f.database.query<{status:string;external_state:string}>("SELECT status,external_state FROM ai_usage_attempts WHERE project_id=$1",[f.project.id]);assert.deepEqual(usage.rows,[{status:"settled",external_state:"unknown"}]);
    assert.equal((await worker.runOnce()).processed,false);assert.equal(calls,1);
    await assert.rejects(service.queue(alice,f.project.id,answers,"changed-key"),(error:unknown)=>error instanceof DomainError&&error.code==="AI_REQUEST_UNRESOLVED");
    assert.equal((await service.getJob(alice,queued.id)).execution?.canRetry,false);
  }finally{await f.database.close();}
});
