import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDatabase } from "./database.ts";
import { createDshWebsiteChat } from "./dsh-chat.ts";
import type { ApplicationConfig } from "./config.ts";
import { DomainError } from "../shared/errors.ts";
import { DEEPSEEK_HARNESS_PACKAGE, DEEPSEEK_HARNESS_VERSION } from "../modules/operations/index.ts";

const httpConfig: ApplicationConfig = {
  mode: "local", origin: "http://localhost:3000", codePepper: "explicit-test-pepper-never-used-for-live-login", emailFrom: "test@example.test",
  aiProvider: "http", ai: { baseUrl: "http://127.0.0.1:1", apiKey: "NONLIVE_FIXTURE_ONLY", model: "http-model-must-not-handle-chat",
    allowInsecureLoopback: true, budget: { dailyProjectCallLimit: 20 }, workerPollMs: 2000, workerLeaseMs: 180_000, maxAttempts: 1 },
};
const projects = { async getProject(): Promise<never> { throw new DomainError("NOT_FOUND", "No project in this fixture."); } };
const clock = { now: () => new Date() };
const actor = { userId: "dsh-chat-factory-fixture", platformRoles: ["user"] as const };

test("website chat never uses an available HTTP model when DSH is missing", async () => {
  const database = await createDatabase({});
  try {
    await database.migrate();
    const chat = createDshWebsiteChat({ config: httpConfig, database, projects, clock, ids: { next: randomUUID } });
    assert.deepEqual(chat.intro().chat, { provider: "dsh", configured: false });
    await assert.rejects(chat.reply(actor, { message: "你好", pagePath: "/events" }), { code: "NAVIGATOR_NOT_CONFIGURED" });
    assert.equal((await database.query("SELECT id FROM ai_execution_jobs")).rowCount, 0);
  } finally { await database.close(); }
});

test("website chat selects the DSH subprocess even with AI_PROVIDER=http, and never falls back on DSH failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "website-dsh-chat-test-"));
  const database = await createDatabase({});
  try {
    const runtime = join(directory, "runtime"), work = join(directory, "work");
    await mkdir(join(runtime, "lib"), { recursive: true });
    const packagePath = join(runtime, "package.json");
    await writeFile(packagePath, JSON.stringify({ name: DEEPSEEK_HARNESS_PACKAGE, version: DEEPSEEK_HARNESS_VERSION, type: "module", bin: { dsh: "lib/bin.js" } }));
    // Explicit harmless RPC fixture. It exercises the actual factory/adapter/
    // process path without contacting a provider or using personal credentials.
    await writeFile(join(runtime, "lib", "bin.js"), `
import readline from 'node:readline';
let initialization;
const send=message=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...message})+'\\n');
const event=(sessionId,type,data)=>send({method:'session.event',params:{sessionId,event:{type,seq:1,time:1,data}}});
readline.createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);
 if(request.method==='initialize'){initialization=request.params;send({id:request.id,result:{serverInfo:{name:'deepseek-harness-sdk-runtime',version:'0.0.1'}}});return;}
 if(request.method==='shutdown'){send({id:request.id,result:{}});process.exit(0);}
 if(request.method!=='session/prompt')throw Error('fixture protocol');
 const sessionId=request.params.sessionId;
 send({id:request.id,result:{messageId:'fixture-admission'}});
 event(sessionId,'agent/inbox/spliced',{inserted:[{id:'fixture-admission'}]});
 event(sessionId,'request/header',{header:{tools:[]}});
 event(sessionId,'assistant/message',{message:{content:[{type:'text',text:JSON.stringify({reply:'DSH fixture cap '+initialization.maxTokens,linkIds:[]})}]},usage:{inputTokens:20,outputTokens:15}});
 event(sessionId,'turn/end',{reason:{kind:'completed'}});
 send({method:'session.status',params:{sessionId,status:'idle'}});
});`);
    await database.migrate();
    await database.query("INSERT INTO auth_users(id,email,display_name,timezone,email_verified_at,created_at) VALUES($1,'factory@example.test','DSH fixture','UTC',$2,$2)", [actor.userId, clock.now().toISOString()]);
    const config: ApplicationConfig = { ...httpConfig, dsh: {
      runtimePackageDirectory: runtime, workingDirectory: work, apiKey: "DSH_NONLIVE_FIXTURE_ONLY", modelVersion: "dsh-only-fixture-model", promptVersion: "fixture-config",
      timeoutMs: 3000, maxTokens: 8192, maxInputBytes: 131_072, currency: "USD", inputCostMicrosPerMillionTokens: 1, outputCostMicrosPerMillionTokens: 1,
      budget: { dailyProjectCallLimit: 20 }, sourceBudget: { dailyProjectCallLimit: 20 },
    } };
    const chat = createDshWebsiteChat({ config, database, projects, clock, ids: { next: randomUUID } });
    assert.deepEqual(chat.intro().chat, { provider: "dsh", configured: true });
    const reply = await chat.reply(actor, { message: "你好", pagePath: "/events" });
    assert.equal(reply.provider, "dsh");
    assert.equal(reply.reply, "DSH fixture cap 1500");
    const usage = (await database.query<{ model_version: string; usage_verified: boolean }>("SELECT model_version,usage_verified FROM ai_usage_attempts")).rows[0]!;
    assert.equal(usage.model_version, "dsh-only-fixture-model");
    assert.equal(usage.usage_verified, true);
    await writeFile(packagePath, JSON.stringify({ name: DEEPSEEK_HARNESS_PACKAGE, version: "invalid-fixture-version", bin: { dsh: "lib/bin.js" } }));
    await assert.rejects(chat.reply(actor, { message: "继续", pagePath: "/events" }), { code: "AI_DSH_VERSION_MISMATCH" });
  } finally {
    await database.close();
    assert.equal(dirname(directory), tmpdir());
    assert.ok(directory.startsWith(join(tmpdir(), "website-dsh-chat-test-")));
    await rm(directory, { recursive: true, force: true });
  }
});
