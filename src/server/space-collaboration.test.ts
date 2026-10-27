import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test, { type TestContext } from "node:test";
import { createDatabase } from "./database.ts";
import { createApplication } from "./application.ts";
import { dispatch } from "./router.ts";
import type { Actor } from "../shared/contracts.ts";
import type { Project } from "../modules/projects/index.ts";
import type { DocumentDraft, DocumentDraftCollection, DraftPublicationOutcome } from "../modules/document-drafts/index.ts";
import type { SpaceChangesList } from "../modules/space-changes/index.ts";
import type { SupervisionState } from "../modules/team-supervision/index.ts";
import type { SpaceDocument } from "./space-documents.ts";
import { createSupervisionAssistantBridge } from "./space-collaboration.ts";
import { DomainError } from "../shared/errors.ts";

const origin = "http://localhost:3000";
type Identity = { actor: Actor; cookie: string; sessionId: string };
async function fixture(t: TestContext) {
  const originalFetch = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = async () => { outbound++; throw new Error("Isolated collaboration checks cannot contact a real service"); };
  const database = await createDatabase({});
  t.after(async () => { await database.close(); globalThis.fetch = originalFetch; assert.equal(outbound, 0); });
  const app = await createApplication({ mode: "local", origin, codePepper: "collaboration-fixture-only-32bytes", emailFrom: "fixture@localhost.invalid" }, database);
  async function seed(id: string, roles: Actor["platformRoles"] = ["user"]): Promise<Identity> {
    const now = app.clock.now(), token = randomBytes(32).toString("base64url"), sessionId = `${id}-session`;
    await database.query("INSERT INTO auth_users(id,email,display_name,timezone,status,platform_roles,email_verified_at,created_at,revision) VALUES($1,$2,$1,'Asia/Shanghai','active',$3,$4,$4,1)", [id, `${id}@example.test`, [...roles], now.toISOString()]);
    await database.query("INSERT INTO auth_sessions(id,user_id,token_hash,created_at,authenticated_at,expires_at) VALUES($1,$2,$3,$4,$4,$5)", [sessionId,id,createHash("sha256").update(token).digest("hex"),now.toISOString(),new Date(now.getTime()+3600_000).toISOString()]);
    return { actor: { userId: id, platformRoles: roles }, cookie: `hackathon_session=${token}`, sessionId };
  }
  const owner = await seed("collab-owner"), member = await seed("collab-member"), outsider = await seed("collab-stranger", ["admin"]);
  async function request<T = unknown>(who: Identity | null, path: string, method = "GET", body?: unknown, expected = 200, requestOrigin = origin): Promise<T> {
    const headers = new Headers({ origin: requestOrigin, "content-type": "application/json" });
    if (who) headers.set("cookie", who.cookie);
    const url = new URL(`/api/v1/${path}`, origin);
    const response = await dispatch(app,new Request(url,{method,headers,...(body === undefined ? {} : {body:JSON.stringify(body)})}),url.pathname.slice("/api/v1/".length).split("/").map(decodeURIComponent));
    const envelope = await response.json() as { data: T; error?: {code:string} };
    assert.equal(response.status,expected,`${method} collaboration handler: ${envelope.error?.code ?? "success"}`);
    return envelope.data;
  }
  const project = await request<Project>(owner,"projects","POST",{name:"隔离协作护航",timezone:"Asia/Shanghai",goal:"做一条核心流程",minimumDeliverable:"可复现的演示"},201);
  const root = `projects/${project.id}`;
  async function detail() { return request<{project:Project}>(owner,root); }
  const invite = await request<{token:string}>(owner,`${root}/invitations`,"POST",{expectedRevision:project.revision,maxUses:1},201);
  await request(member,`invitations/${invite.token}/accept`,"POST",{});
  async function counts() {
    const result: Record<string,number> = {};
    for (const table of ["document_drafts","document_draft_publications","space_change_heads","space_change_versions","space_changes","space_change_acknowledgements","team_supervision_settings","team_supervision_runs","team_assistant_conversations","team_assistant_requests","personal_ai_artifacts"]) {
      // Fixed internal table identifiers only, never client-controlled SQL.
      const found = await database.query<{n:number}>(`SELECT count(*)::int AS n FROM ${table}`); result[table] = found.rows[0]!.n;
    }
    return result;
  }
  return { app,database,owner,member,outsider,project,root,detail,request,counts };
}

test("new collaboration GETs are read-only and neither strangers nor platform admins acquire team access", async t => {
  const f = await fixture(t), before = await f.counts();
  const own = await f.request<DocumentDraftCollection>(f.owner,`${f.root}/document-drafts`);
  assert.deepEqual(own.items,[]);
  assert.equal((await f.request<DocumentDraft>(f.owner,`${f.root}/document-drafts/new`)).revision,0);
  assert.equal((await f.request<SupervisionState>(f.owner,`${f.root}/team-supervision`)).reason,"disabled");
  assert.equal((await f.request<SpaceChangesList>(f.owner,`${f.root}/space-changes`)).pendingCount,0);
  assert.deepEqual(await f.counts(),before);
  for (const suffix of ["document-drafts","team-supervision","space-changes"]) {
    await f.request(f.outsider,`${f.root}/${suffix}`,"GET",undefined,403);
    await f.request(null,`${f.root}/${suffix}`,"GET",undefined,401);
  }
  await f.request(f.owner,`${f.root}/team-supervision`,"PUT",{enabled:true,expectedRevision:0},403,"https://untrusted.example");
  assert.deepEqual(await f.counts(),before);
});

test("private autosave survives reads, protects CAS and publishes exactly one real document with its immutable receipt", async t => {
  const f = await fixture(t), path = `${f.root}/document-drafts/new`, body = "核心演示交接\n私下还在整理，点保存才给队友看。";
  const saved = await f.request<DocumentDraft>(f.owner,path,"PUT",{expectedRevision:0,body,baseDocumentRevision:null});
  assert.equal((await f.request<DocumentDraft>(f.owner,path)).body,body);
  assert.equal((await f.request<DocumentDraftCollection>(f.member,`${f.root}/document-drafts`)).items.length,0);
  assert.equal((await f.request<SpaceDocument[]>(f.member,`${f.root}/space-documents`)).length,0);
  await f.request(f.owner,path,"PUT",{expectedRevision:0,body:"不能覆盖",baseDocumentRevision:null},409);
  const input = {expectedRevision:saved.revision,attemptId:"root-publication-1"};
  const published = await f.request<DraftPublicationOutcome>(f.owner,`${path}/publish`,"POST",input);
  assert.equal(published.receipt.status,"succeeded"); assert.equal(published.draft.body,null);
  const replay = await f.request<DraftPublicationOutcome>(f.owner,`${path}/publish`,"POST",input);
  assert.deepEqual(replay.receipt.result,published.receipt.result);
  const docs = await f.request<SpaceDocument[]>(f.member,`${f.root}/space-documents`);
  assert.equal(docs.length,1); assert.equal(docs[0]!.body,body);
  assert.equal((await f.request<{status:string}>(f.owner,`${f.root}/document-draft-publications/${input.attemptId}`)).status,"succeeded");
  assert.equal(await f.request(f.member,`${f.root}/document-draft-publications/${input.attemptId}`),null);
});

test("a withdrawn shared-edit permission cannot publish a teammate's protected draft", async t => {
  const f = await fixture(t);
  const doc = await f.request<SpaceDocument>(f.owner,`${f.root}/space-documents`,"POST",{title:"交接",body:"原正文"},201);
  const shared = await f.request<SpaceDocument>(f.owner,`${f.root}/space-documents/${doc.id}/share`,"POST",{teamEditable:true,expectedRevision:doc.revision});
  const path = `${f.root}/document-drafts/${doc.id}`;
  const draft = await f.request<DocumentDraft>(f.member,path,"PUT",{expectedRevision:0,body:"本人未发布草稿",baseDocumentRevision:shared.revision});
  await f.request(f.owner,`${f.root}/space-documents/${doc.id}/share`,"POST",{teamEditable:false,expectedRevision:shared.revision});
  const result = await f.request<DraftPublicationOutcome>(f.member,`${path}/publish`,"POST",{expectedRevision:draft.revision,attemptId:"withdrawn-publication"});
  assert.equal(result.receipt.status,"failed"); assert.equal(result.draft.body,"本人未发布草稿");
  assert.equal((await f.request<SpaceDocument[]>(f.owner,`${f.root}/space-documents`))[0]!.body,"原正文");
});

test("goal/scope changes notify both actual members; acknowledgement does not change project, plan or tasks", async t => {
  const f = await fixture(t);
  assert.equal((await f.request<SpaceChangesList>(f.owner,`${f.root}/space-changes`)).pendingCount,0);
  const first = await f.request<{baselineCreated:boolean}>(f.owner,`${f.root}/space-changes/reconcile`,"POST",{});
  assert.equal(first.baselineCreated,true);
  await f.request(f.owner,f.root,"PATCH",{expectedRevision:(await f.detail()).project.revision,goal:"改为一条更小的流程",minimumDeliverable:"一份可打开的演示"});
  await f.request(f.member,`${f.root}/space-changes/reconcile`,"POST",{});
  const mine = await f.request<SpaceChangesList>(f.owner,`${f.root}/space-changes`), theirs = await f.request<SpaceChangesList>(f.member,`${f.root}/space-changes`);
  assert.equal(mine.pendingCount,2); assert.equal(theirs.pendingCount,2);
  const beforeProject = (await f.detail()).project, beforeTasks = await f.request(f.owner,`${f.root}/plans/current`);
  const change = theirs.items[0]!;
  const input = {changeId:change.id,version:change.version,understood:true};
  await f.request(f.member,`${f.root}/space-changes/acknowledge`,"POST",input);
  await f.request(f.member,`${f.root}/space-changes/acknowledge`,"POST",input);
  assert.equal((await f.request<SpaceChangesList>(f.member,`${f.root}/space-changes`)).pendingCount,1);
  assert.equal((await f.request<SpaceChangesList>(f.owner,`${f.root}/space-changes`)).pendingCount,2);
  assert.deepEqual((await f.detail()).project,beforeProject);
  assert.deepEqual(await f.request(f.owner,`${f.root}/plans/current`),beforeTasks);
  assert.equal((await f.request<{changeCount:number}>(f.owner,`${f.root}/space-changes/reconcile`,"POST",{})).changeCount,0);
});

test("unconfirmed duties never cause a DSH call; expired sessions cannot protect drafts, read teammates' changes or enable automation", async t => {
  const f = await fixture(t), before = await f.counts();
  const enabled = await f.request<SupervisionState>(f.owner,`${f.root}/team-supervision`,"PUT",{enabled:true,expectedRevision:0});
  assert.equal(enabled.reason,"responsibility_unconfirmed");
  const checked = await f.request<SupervisionState>(f.owner,`${f.root}/team-supervision/check`,"POST",{});
  assert.equal(checked.reason,"responsibility_unconfirmed");
  const after = await f.counts();
  assert.equal(after.team_supervision_runs,0); assert.equal(after.team_assistant_requests,before.team_assistant_requests);
  assert.equal(after.personal_ai_artifacts,before.personal_ai_artifacts);
  await f.database.query("UPDATE auth_sessions SET revoked_at=now() WHERE id=$1",[f.owner.sessionId]);
  await f.request(f.owner,`${f.root}/document-drafts/new`,"PUT",{expectedRevision:0,body:"失效账号输入",baseDocumentRevision:null},401);
  await f.request(f.owner,`${f.root}/space-changes`,"GET",undefined,401);
  await f.request(f.owner,`${f.root}/team-supervision`,"PUT",{enabled:false,expectedRevision:enabled.revision},401);
  assert.deepEqual(await f.counts(),after);
});

test("an original assistant's durable failure distinguishes a changed snapshot from an unknown paid outcome", async t => {
  const f = await fixture(t);
  await f.app.teamAssistant.conversation(f.owner.actor,f.project.id);
  const bridge = createSupervisionAssistantBridge(f.database,f.app.teamAssistant);
  const original = f.app.teamAssistant.send;
  t.after(() => { f.app.teamAssistant.send = original; });
  for (const state of ["failed","unknown","running","absent"] as const) {
    const requestId = `bridge-${state}`, now = f.app.clock.now().toISOString();
    if (state !== "absent") await f.database.query("INSERT INTO team_assistant_requests(user_id,project_id,request_id,request_hash,message,status,created_at,expires_at) VALUES($1,$2,$3,$4,'fixture question',$5,$6,$6)",[f.owner.actor.userId,f.project.id,requestId,createHash("sha256").update(requestId).digest("hex"),state,now]);
    f.app.teamAssistant.send = async () => { throw new DomainError("SUPERVISION_FACTS_CHANGED","队友更新了任务，请核对新版本。",{status:409}); };
    await assert.rejects(bridge.send(f.owner.actor,f.project.id,{requestId,expectedRevision:0,message:"fixture question"}), reason => {
      assert.ok(reason instanceof DomainError);
      assert.equal((reason as DomainError & {externalState?:string}).externalState,state === "failed" ? "response_received" : state === "absent" ? "not_sent" : undefined);
      return true;
    });
  }
});
