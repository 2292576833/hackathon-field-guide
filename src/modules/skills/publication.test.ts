import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { Actor } from "../../shared/contracts.ts";
import { INITIAL_SKILLS, INITIAL_BUNDLES, seedInitialSkills } from "./seed.ts";
import { createPostgresSkillsRepository } from "./postgres.ts";
import { createSkillsService } from "./service.ts";
import { createSkillCandidateService, createSkillPublicationPort, bundleLicenseReviewHash, importPublishedSkillCandidates } from "./publication.ts";
import { createSkillCandidateHandlers } from "./candidate-http.ts";
import type { SkillCandidate, SkillCandidateDocument, SkillCandidateEvidence, SkillPublicationInput } from "./publication-types.ts";
import { hash } from "./domain.ts";

const actor: Actor = {userId:"reviewer-a",platformRoles:["reviewer"]};
const at = "2026-10-10T04:00:00.000Z";
function skillDocument(): SkillCandidateDocument {
  const skill = structuredClone(INITIAL_SKILLS.find(value=>value.id==="create-readme")!); const version=skill.versions[0];
  version.commit="a".repeat(40); version.id=`${skill.id}@${version.commit}`; version.version="new-fixed";
  version.files=version.files.map(file=>({...file,downloadUrl:file.downloadUrl.replace(INITIAL_SKILLS.find(value=>value.id===skill.id)!.versions[0].commit,version.commit)}));
  version.contentHash=hash(version.files); version.license.sourceUrl=version.files.find(file=>file.relativePath===version.license.filePath)!.downloadUrl;
  skill.sourceUrl=`https://github.com/${version.repository}/tree/${version.commit}/${version.skillPath}`;
  return {kind:"skill",skill};
}
function evidence(document:SkillCandidateDocument):SkillCandidateEvidence {
  const version=document.kind==="skill"?document.skill.versions[0]:null;
  return {license:{status:"verified",sourceUrl:version?.license.sourceUrl??"https://github.com/github/awesome-copilot",sha256:version?.license.sha256??bundleLicenseReviewHash(INITIAL_SKILLS.filter(skill=>[...(document as {kind:"bundle";bundle:typeof INITIAL_BUNDLES[number]}).bundle.skillVersionIds,...(document as {kind:"bundle";bundle:typeof INITIAL_BUNDLES[number]}).bundle.optionalSkillVersionIds].includes(skill.versions[0].id)).map(skill=>skill.versions[0])),checkedBy:actor.userId,checkedAt:at,noticesIncluded:true},behavior:{status:"reviewed",checkedBy:actor.userId,checkedAt:at,note:"隔离夹具：人工核对文件与权限，未运行第三方脚本。"},compatibility:[{agentId:"codex",level:"unknown",source:"official_documentation",clientVersion:null,os:null,checkedAt:null,evidenceUrl:null,task:null,limitation:"没有客户端加载与任务实测。"}]};
}
async function setup() {
  const pg=new PGlite(); await pg.exec(await readFile(new URL("schema.sql",import.meta.url),"utf8")); await pg.exec(await readFile(new URL("candidate-schema.sql",import.meta.url),"utf8"));
  const unit=(sql:{query(query:string,params?:unknown[]):Promise<{rows:unknown[];affectedRows?:number}>}):SqlExecutor=>({async query<Row>(query:string,params?:readonly unknown[]){const result=await sql.query(query,params?[...params]:undefined);return {rows:result.rows as Row[],rowCount:result.affectedRows??result.rows.length};}});
  const db:DatabasePort={...unit(pg),transaction:work=>pg.transaction(tx=>work(unit(tx)))}; const repository=createPostgresSkillsRepository(db); await seedInitialSkills(repository);
  let id=0; const ids={next:()=>`skill-test-${++id}`}; const clock={now:()=>new Date(at)};
  const candidates=createSkillCandidateService({database:db,ids,clock}); const publications=createSkillPublicationPort();
  return {pg,db,repository,candidates,publications,skills:createSkillsService({repository,ids,clock})};
}
function input(candidate:SkillCandidate,operationId:string):SkillPublicationInput { return {kind:candidate.kind,id:candidate.id,versionId:candidate.versionId,actor,expectedRevision:candidate.revision,expectedContentHash:candidate.contentHash,expectedManifestHash:candidate.manifestHash,reviewOperationId:operationId,reviewedBy:actor.userId,reviewedAt:at,reason:"隔离审核夹具",requestId:"request-test"}; }

test("persistent candidates lock exact revision/hash; old reviews, tampered sources and unknown licenses cannot publish",async()=>{
  const {pg,db,candidates,publications}=await setup(); try {
    const document=skillDocument(), checks=evidence(document); const first=await candidates.save(actor,{expectedRevision:0,document,evidence:checks});
    assert.equal((await candidates.list(actor)).length,1); assert.equal((await candidates.get(actor,first))!.revision,1);
    const changed=structuredClone(document); if(changed.kind==="skill") changed.skill.summary="新修订依据";
    const next=await candidates.save(actor,{expectedRevision:1,document:changed,evidence:checks});
    await assert.rejects(db.transaction(tx=>publications.publishReviewed(tx,input(first,"stale-review"))),/已变化/);
    await assert.rejects(candidates.save(actor,{expectedRevision:1,document:changed,evidence:checks}),/已变化/);
    const unknown=await candidates.save(actor,{expectedRevision:2,document:changed,evidence:{...checks,license:{...checks.license,status:"unknown"}}});
    assert.ok((await candidates.get(actor,unknown))!.validationErrors.some(error=>error.includes("许可")));
    await assert.rejects(db.transaction(tx=>publications.publishReviewed(tx,input(unknown,"unknown-license"))),/不可发布/);
    const invalid=structuredClone(document); if(invalid.kind==="skill") invalid.skill.versions[0].files=invalid.skill.versions[0].files.map((file,index)=>index===0?{...file,downloadUrl:"http://127.0.0.1/private"}:file);
    await assert.rejects(candidates.save(actor,{expectedRevision:next.revision,document:invalid,evidence:checks}),/锁定官方仓库/);
    const tampered=structuredClone(unknown); if(tampered.document.kind==="skill") tampered.document.skill.summary="直接篡改数据库夹具";
    await db.query("UPDATE skill_candidates SET document=$1::jsonb",[JSON.stringify(tampered)]);
    await assert.rejects(candidates.get(actor,unknown),/哈希不一致/);
    await assert.rejects(candidates.list({userId:"member",platformRoles:["user"]}),/审核权限/);
  } finally {await pg.close();}
});

test("publication preserves old fixed versions; withdrawal blocks pending plans and replay cannot revive",async()=>{
  const {pg,db,candidates,publications,skills,repository}=await setup(); try {
    const document=skillDocument(); const candidate=await candidates.save(actor,{expectedRevision:0,document,evidence:evidence(document)}); const request=input(candidate,"publish-exact");
    const published=await db.transaction(tx=>publications.publishReviewed(tx,request)); assert.equal(published.revision,1);
    assert.equal((await skills.detail(candidate.id)).versions.length,2);
    const detail=(await skills.detail(candidate.id)).versions.find(version=>version.id===candidate.versionId)!;
    assert.equal(detail.compatibilityEvidence?.[0].level,"unknown"); assert.equal(detail.compatibility[0].taskEvaluation,"not_tested");
    const plan=await skills.createPlan(actor,{agentId:"codex",scope:"project",skillVersionIds:[candidate.versionId],acknowledgeUnverifiedCompatibility:true});
    await db.transaction(tx=>publications.withdraw(tx,input(candidate,"withdraw-exact")));
    assert.equal((await candidates.get(actor,candidate))!.state,"withdrawn");
    await assert.rejects(skills.confirm(actor,plan.planId,{manifestHash:plan.manifestHash,confirm:true}),/撤回/);
    await db.transaction(tx=>publications.publishReviewed(tx,request));
    await assert.rejects(db.transaction(tx=>publications.publishReviewed(tx,input(candidate,"new-publish"))),/不可发布/);
    assert.equal((await repository.listSkills()).find(skill=>skill.id===candidate.id)!.versions.find(version=>version.id===candidate.versionId)!.status,"withdrawn");
    await assert.rejects(candidates.save(actor,{expectedRevision:1,document,evidence:evidence(document)}),/不可修改/);
    assert.equal((await skills.installations(actor)).receipts.length,0);
  } finally {await pg.close();}
});

test("new bundle versions retain old rows and pin child files/licenses; withdrawn children invalidate approvals",async()=>{
  const {pg,db,candidates,publications,skills,repository}=await setup(); try {
    const bundle=structuredClone(INITIAL_BUNDLES[0]); bundle.version="2"; const document:SkillCandidateDocument={kind:"bundle",bundle};
    const candidate=await candidates.save(actor,{expectedRevision:0,document,evidence:evidence(document)});
    assert.ok(candidate.resolvedSkillHashes?.length); await db.transaction(tx=>publications.publishReviewed(tx,input(candidate,"bundle-publish")));
    assert.equal((await skills.bundle(bundle.id)).version,"1"); assert.equal((await skills.bundle(candidate.versionId)).version,"2");
    const pending=structuredClone(bundle); pending.version="3"; const pendingDoc:SkillCandidateDocument={kind:"bundle",bundle:pending};
    const later=await candidates.save(actor,{expectedRevision:0,document:pendingDoc,evidence:evidence(pendingDoc)});
    await skills.withdraw(actor,"create-readme",INITIAL_SKILLS.find(skill=>skill.id==="create-readme")!.versions[0].id,"fixture撤回");
    await assert.rejects(db.transaction(tx=>publications.publishReviewed(tx,input(later,"stale-child-publish"))),/不可发布/);
    assert.equal((await repository.listBundles()).length,4);
  } finally {await pg.close();}
});

test("model or user reports cannot become platform compatibility and joint bundle evidence must cover all required refs",async()=>{
  const {pg,candidates}=await setup(); try {
    const document=skillDocument(), checks=evidence(document); checks.compatibility=[{...checks.compatibility[0],level:"task_verified",source:"model",clientVersion:"1",os:"Windows",checkedAt:at,evidenceUrl:"https://example.com/evidence",task:"fixture"}];
    await assert.rejects(candidates.save(actor,{expectedRevision:0,document,evidence:checks}),/模型或用户自报/);
    checks.compatibility=[{...checks.compatibility[0],source:"user_reported"}]; await assert.rejects(candidates.save(actor,{expectedRevision:0,document,evidence:checks}),/模型或用户自报/);
    const bundle={...INITIAL_BUNDLES[0],version:"9"}; const bundleDoc:SkillCandidateDocument={kind:"bundle",bundle}; const bundleChecks=evidence(bundleDoc); bundleChecks.compatibility=[{...checks.compatibility[0],source:"platform_test",requiredVersionIds:[bundle.skillVersionIds[0]]}];
    await assert.rejects(candidates.save(actor,{expectedRevision:0,document:bundleDoc,evidence:bundleChecks}),/覆盖全部必需/);
  } finally {await pg.close();}
});

test("candidate HTTP rejects anonymous/forged writes and transactions roll back revoked current actors",async()=>{
  const {pg,db,candidates}=await setup(); try {
    const document=skillDocument(); let mutations=0;
    const handlers=createSkillCandidateHandlers({service:candidates,resolveActor:async()=>actor,assertMutationAllowed:async()=>{mutations++;},requestId:()=>"r"});
    const request=(data:unknown)=>new Request("https://website.test/admin/skills/candidates",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});
    assert.equal((await handlers.save(request({expectedRevision:0,document,evidence:evidence(document),userId:"forged"}))).status,422); assert.equal(mutations,1);
    const anonymous=createSkillCandidateHandlers({service:candidates,resolveActor:async()=>null,assertMutationAllowed:async()=>{},requestId:()=>"r"}); assert.equal((await anonymous.list(new Request("https://website.test"))).status,401);
    let checks=0; const guarded=createSkillCandidateService({database:db,clock:{now:()=>new Date(at)},ids:{next:()=>"audit-guarded"},assertActorCurrent:async()=>{if(++checks===2)throw new Error("revoked");}});
    await assert.rejects(guarded.save(actor,{expectedRevision:0,document,evidence:evidence(document)}),/revoked/); assert.equal((await candidates.list(actor)).length,0);
  } finally {await pg.close();}
});

test("startup import preserves legacy versions and never revives withdrawal or claims live compatibility",async()=>{
  const {pg,db,candidates,publications,skills}=await setup(); try {
    let sequence=0; const dependencies={database:db,clock:{now:()=>new Date(at)},ids:{next:()=>`import-${++sequence}`}};
    await importPublishedSkillCandidates(dependencies); assert.equal((await candidates.list(actor)).length,11);
    const selected=(await candidates.list(actor)).find(value=>value.kind==="skill" && value.id==="create-readme")!;
    assert.ok(selected.evidence.compatibility.every(value=>value.level==="installer_declared"));
    await db.transaction(tx=>publications.withdraw(tx,input(selected,"legacy-withdraw")));
    await importPublishedSkillCandidates(dependencies); assert.equal((await candidates.get(actor,selected))!.state,"withdrawn");
    assert.equal((await skills.detail("frontend-design")).versions.length,1);
  } finally {await pg.close();}
});

test("first bootstrap after legacy child withdrawal still starts without reviving the child",async()=>{
  const {pg,db,candidates,skills}=await setup(); try {
    await skills.withdraw(actor,"create-readme",INITIAL_SKILLS.find(skill=>skill.id==="create-readme")!.versions[0].id,"legacy撤回");
    let sequence=0; await importPublishedSkillCandidates({database:db,clock:{now:()=>new Date(at)},ids:{next:()=>`import-after-${++sequence}`}});
    const list=await candidates.list(actor); assert.equal(list.length,10); assert.ok(!list.some(value=>value.kind==="skill"&&value.id==="create-readme"));
    const bundle=list.find(value=>value.kind==="bundle"&&value.id==="game-prototype")!;
    assert.ok((await candidates.get(actor,bundle))!.validationErrors.some(error=>error.includes("撤回")));
  } finally {await pg.close();}
});

test("untyped candidate input cannot publish missing, floating or object version labels",async()=>{
  const {pg,candidates}=await setup(); try {
    for(const invalidVersion of ["","latest",{bad:"object"}]) {
      const document=skillDocument(); if(document.kind==="skill") (document.skill.versions[0] as unknown as {version:unknown}).version=invalidVersion;
      await assert.rejects(candidates.save(actor,{expectedRevision:0,document,evidence:evidence(document)}),/版本标签/);
    }
    const bundleDoc:SkillCandidateDocument={kind:"bundle",bundle:{...INITIAL_BUNDLES[0],version:"latest"}};
    await assert.rejects(candidates.save(actor,{expectedRevision:0,document:bundleDoc,evidence:evidence(bundleDoc)}),/版本或兼容/);
  } finally {await pg.close();}
});

test("bundle review cannot publish a package with conflicting commits of the same skill",async()=>{
  const {pg,candidates}=await setup(); try {
    const readme=INITIAL_SKILLS.find(skill=>skill.id==="create-readme")!.versions[0];
    const document:SkillCandidateDocument={kind:"bundle",bundle:{...INITIAL_BUNDLES[0],version:"conflict",skillVersionIds:[readme.id,`${readme.skillId}@${"a".repeat(40)}`],optionalSkillVersionIds:[]}};
    await assert.rejects(candidates.save(actor,{expectedRevision:0,document,evidence:evidence(document)}),/同一技能不能同时/);
  } finally {await pg.close();}
});
