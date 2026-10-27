import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DomainError } from "../../shared/errors.ts";
import {
  createDeepSeekHarnessAdapter,
  DEEPSEEK_HARNESS_PACKAGE,
  DEEPSEEK_HARNESS_VERSION,
  probeDshNodeAccount,
  type DeepSeekHarnessConfiguration,
  type DeepSeekHarnessGenerationRequest,
  type DeepSeekHarnessProcessLauncher,
} from "./deepseek-harness.ts";

const secret = "fixture-only-not-a-provider-credential";
interface FixtureOptions { mode?: string; version?: string; output?: string; providerStatus?: number; account?: boolean }
async function fixture(options: FixtureOptions = {}) {
  const base = await mkdtemp(join(tmpdir(), "m08-dsh-test-"));
  const runtime = options.account ? join(base, "node_modules", "@deepseek-ai", "dsh") : join(base, "runtime");
  const work = join(base, "work");
  const credentials = join(base, "account.yaml");
  const originalGrant = JSON.stringify({ version: 1, records: { "deepseek-account-platform/default": { kind: "grant", payload: { version: 1, issuer: "https://platform.deepseek.com", token: secret, discarded: "private-device" } }, "unrelated/default": { kind: "grant", payload: { token: "unrelated-private-grant" } } } });
  await mkdir(join(runtime, "lib"), { recursive: true });
  await mkdir(work);
  if (options.account) {
    await writeFile(credentials, originalGrant, { mode: 0o600 });
    for (const name of ["dsh-credentials-local", "dsh-authorization", "dsh-deepseek-account-platform", "dsh-llm-deepseek-account"]) {
      const root = join(base, "node_modules", "@deepseek-ai", name);
      await mkdir(join(root, "lib"), { recursive: true });
      await writeFile(join(root, "package.json"), JSON.stringify({ name: `@deepseek-ai/${name}`, version: DEEPSEEK_HARNESS_VERSION }));
      await writeFile(join(root, "lib", "index.js"), "");
    }
    const yaml = join(base, "node_modules", "yaml"); await mkdir(yaml);
    await writeFile(join(yaml, "index.js"), "exports.parseDocument=raw=>({errors:[],toJS:()=>JSON.parse(raw)});");
  }
  await writeFile(join(runtime, "package.json"), JSON.stringify({ name: DEEPSEEK_HARNESS_PACKAGE, version: options.version ?? DEEPSEEK_HARNESS_VERSION, type: "module", bin: { dsh: "lib/bin.js" } }));
  // Harmless local fake CLI fixture. The real child tests transport only, never provider inference.
  await writeFile(join(runtime, "lib", "bin.js"), `
import readline from 'node:readline';
const options = ${JSON.stringify(options)};
const output = options.output ?? JSON.stringify({cards:[{title:'公开比赛',verificationStatus:'unverified'}]});
const send = (message) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...message})+'\\n');
const event = (sessionId,type,data) => send({method:'session.event',params:{sessionId,event:{type,seq:1,time:1,data}}});
const reader = readline.createInterface({input:process.stdin});
reader.on('line',(line)=>{
  const request=JSON.parse(line);
  if(request.method==='initialize') {
    if(request.params.provider!==(options.account?'deepseek-account':'deepseek-official'))throw Error('unexpected provider');
    if(options.mode==='rpc_error') { process.stderr.write(process.env.DEEPSEEK_API_KEY); send({id:request.id,error:{code:-32000,message:process.env.DEEPSEEK_API_KEY}}); return; }
    if(options.mode==='stderr_limit') { process.stderr.write('x'.repeat(100000)); return; }
    if(options.mode==='bad_wire') { process.stdout.write('not json\\n'); return; }
    send({id:request.id,result:{serverInfo:{name:options.mode==='bad_identity'?'wrong':'deepseek-harness-sdk-runtime',version:'0.0.1'}}}); return;
  }
  if(request.method==='shutdown') { send({id:request.id,result:{}}); process.exit(0); }
  if(request.method!=='session/prompt') throw Error('unexpected request');
  const sessionId=request.params.sessionId;
  event(sessionId,'agent/inbox/spliced',{inserted:[{id:'accepted-message'}]});
  // Deliberately send notifications before the prompt receipt response: the adapter must buffer them.
  send({id:request.id,result:{messageId:'accepted-message'}});
  if(options.mode==='hang') return;
  if(options.mode==='subagent') { send({method:'subagent.started',params:{parentSessionId:sessionId,childSessionId:'child'}}); return; }
  event(sessionId,'request/header',{header:{config:{model:request.params.model},...(options.mode==='tools'?{tools:[{name:'bash'}]}:{})}});
  if(options.mode==='tools') return;
  event(sessionId,'assistant/message',{turn:1,step:1,interrupted:options.mode==='interrupted',message:{content:[{type:'reasoning',text:'fixture'},{type:'text',text:output}]},...(options.mode==='no_usage'?{}:{usage:{inputTokens:options.mode==='bad_usage'?-1:10,outputTokens:20,cacheReadTokens:3,cacheWriteTokens:2}})});
  if(options.mode!=='missing_finish')event(sessionId,'turn/end',{turn:1,reason:{kind:options.mode==='model_error'?'error':options.mode==='max_tokens'?'max-tokens':'completed',error:{message:process.env.DEEPSEEK_API_KEY,status:options.providerStatus}}});
  if(options.mode==='stale_complete')event(sessionId,'assistant/message',{turn:2,step:1,message:{content:[{type:'text',text:output}]},usage:{inputTokens:10,outputTokens:20}});
  send({method:'session.status',params:{sessionId,status:'idle'}});
});
`);
  const config: DeepSeekHarnessConfiguration = {
    runtimePackageDirectory: runtime, workingDirectory: work, ...(options.account ? { accountCredentialsFile: credentials } : { apiKey: secret }),
    modelVersion: "deepseek-v4-flash", promptVersion: "m08-evidence-v1",
    timeoutMs: 2000, currency: "USD", inputCostMicrosPerMillionTokens: 1_000_000,
    outputCostMicrosPerMillionTokens: 2_000_000,
  };
  return { base, work, runtime, credentials, originalGrant, config, async close() {
    const owned = relative(tmpdir(), base);
    assert.equal(dirname(base), tmpdir());
    assert.ok(owned.startsWith("m08-dsh-test-") && !owned.includes(sep));
    await rm(base, { recursive: true, force: true });
  } };
}
function request(patch: Partial<DeepSeekHarnessGenerationRequest> = {}): DeepSeekHarnessGenerationRequest {
  return { taskId: "job-1", purpose: "event_discovery", schemaVersion: "m08-discovery-v1", modelVersion: "deepseek-v4-flash", promptVersion: "m08-evidence-v1", systemPrompt: "从证据构建未审核赛事卡片。", input: { evidence: [{ url: "https://example.com/event", excerpt: "公开赛事信息" }] }, signal: new AbortController().signal, ...patch };
}
function code(expected: string) {
  return (failure: unknown) => {
    assert.ok(failure instanceof DomainError);
    assert.equal(failure.code, expected);
    assert.ok(!failure.message.includes(secret));
    return true;
  };
}

test("actual local subprocess follows official RPC receipt→idle contract and measures cached input", async () => {
  const f = await fixture();
  try {
    let launches = 0;
    let home: string | undefined;
    const launch: DeepSeekHarnessProcessLauncher = (executable, args, options) => {
      launches++;
      assert.equal(executable, process.execPath);
      // Windows 下 TMP 目录的大小写可能被规范化（C:\Windows\Temp 与 C:\WINDOWS\TEMP 指向同一目录），
      // 因此按规范化后的路径比较，而不是逐字符比较大小写。
      const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
      assert.deepEqual(args.map(normalize), [join(f.runtime, "lib", "bin.js"), "--profile", "m08-json"].map(normalize));
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      assert.equal(options.env?.NODE_ENV, "production");
      assert.equal(options.env?.DEEPSEEK_API_KEY, secret);
      assert.equal(options.env?.NODE_OPTIONS, undefined);
      assert.equal(options.env?.PATH, undefined);
      home = options.env?.DSH_HOME;
      return spawn(executable, [...args], { ...options, stdio: ["pipe", "pipe", "pipe"] });
    };
    const adapter = createDeepSeekHarnessAdapter(f.config, { launch });
    const result = await adapter.generate(request());
    assert.equal(launches, 1);
    assert.deepEqual(result.data, { cards: [{ title: "公开比赛", verificationStatus: "unverified" }] });
    assert.deepEqual(result.usage, { inputTokens: 15, outputTokens: 20, estimatedCostMicros: 55, currency: "USD" });
    assert.deepEqual(result.runtime.tools, []);
    assert.equal(result.runtime.usageMeasured, true);
    assert.equal(result.runtime.version, DEEPSEEK_HARNESS_VERSION);
    assert.ok(home);
    assert.deepEqual(await readdir(f.work), []);
  } finally { await f.close(); }
});

test("profile is fixed empty-root JSON/YAML without tools, shell, MCP, skills or instructions", async () => {
  const f = await fixture();
  try {
    const patchFiles: Promise<string>[] = [];
    const launch: DeepSeekHarnessProcessLauncher = (executable, args, options) => {
      const home = options.env!.DSH_HOME!;
      patchFiles.push(readFile(join(home, "profiles", "m08-json", "cordis.patch.yml"), "utf8"));
      patchFiles.push(readFile(join(home, "profiles", "m08-json", "package.json"), "utf8"));
      return spawn(executable, [...args], { ...options, stdio: ["pipe", "pipe", "pipe"] });
    };
    await createDeepSeekHarnessAdapter(f.config, { launch }).request({ task: "navigator", prompt: "回答导航建议。!!js process.exit()", input: {}, signal: new AbortController().signal });
    const [patch, manifest] = await Promise.all(patchFiles);
    const rows = JSON.parse(patch!)[0].insert as { name: string; config?: { personaPrefix?: string; baseURL?: string } }[];
    assert.deepEqual(JSON.parse(manifest!).dsh.profile.bundles, []);
    assert.ok(rows.every(row => !/(tool-|subprocess|sandbox|terminal|mcp|skill|instructions|session-log|inventory|fs-local)/u.test(row.name)));
    assert.ok(rows.find(row => row.name === "@deepseek-ai/dsh-system-prompt")?.config?.personaPrefix?.includes("!!js process.exit()"));
    assert.equal(rows.find(row => row.name === "@deepseek-ai/dsh-llm-deepseek-api-key")?.config?.baseURL, "https://api.deepseek.com/anthropic");
  } finally { await f.close(); }
});

test("missing configuration is explicit unavailable and performs no fake inference", async () => {
  const adapter = createDeepSeekHarnessAdapter({ modelVersion: "deepseek-v4-flash", promptVersion: "m08-evidence-v1", currency: "CNY", inputCostMicrosPerMillionTokens: 0, outputCostMicrosPerMillionTokens: 0 }, { launch: () => { throw new Error("must not spawn"); } });
  await assert.rejects(adapter.generate(request()), code("DSH_UNCONFIGURED"));
});
test("exact package pin mismatch prevents launch", async () => {
  const f = await fixture({ version: "0.2.1-alpha.2" });
  try { await assert.rejects(createDeepSeekHarnessAdapter(f.config, { launch: () => { throw new Error("must not spawn"); } }).generate(request()), code("DSH_VERSION_MISMATCH")); }
  finally { await f.close(); }
});
test("web task cannot override fixed model or prompt version", async () => {
  const f = await fixture();
  try {
    const adapter = createDeepSeekHarnessAdapter(f.config, { launch: () => { throw new Error("must not spawn"); } });
    await assert.rejects(adapter.generate(request({ modelVersion: "other-model" })), code("DSH_INVALID_REQUEST"));
    await assert.rejects(adapter.generate(request({ promptVersion: "other-prompt" })), code("DSH_INVALID_REQUEST"));
    assert.deepEqual(await readdir(f.work), []);
  } finally { await f.close(); }
});
test("bounded input rejects oversized data before launch", async () => {
  const f = await fixture();
  try { await assert.rejects(createDeepSeekHarnessAdapter({ ...f.config, maxInputBytes: 100 }).generate(request({ input: "x".repeat(500) })), code("DSH_INPUT_LIMIT")); }
  finally { await f.close(); }
});
test("pre-aborted request never launches a runtime", async () => {
  const f = await fixture();
  try {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(createDeepSeekHarnessAdapter(f.config, { launch: () => { throw new Error("must not spawn"); } }).generate(request({ signal: controller.signal })), code("DSH_CANCELLED"));
  } finally { await f.close(); }
});
for (const [mode, expected] of [
  ["bad_identity", "DSH_PROTOCOL_ERROR"], ["bad_wire", "DSH_PROTOCOL_ERROR"],
  ["rpc_error", "DSH_RUNTIME_REJECTED"], ["no_usage", "DSH_USAGE_UNAVAILABLE"],
  ["tools", "DSH_CAPABILITY_VIOLATION"], ["subagent", "DSH_CAPABILITY_VIOLATION"],
  ["model_error", "DSH_MODEL_FAILED"],
] as const) {
  test(`${mode} rejects with safe error and cleans up isolated files`, async () => {
    const f = await fixture({ mode });
    try {
      await assert.rejects(createDeepSeekHarnessAdapter(f.config).generate(request()), code(expected));
      assert.deepEqual(await readdir(f.work), []);
    } finally { await f.close(); }
  });
}
test("one pure JSON fence is accepted without changing measured usage", async () => {
  const f = await fixture({ output: '```json\n{"cards":[]}\n```' });
  try {
    const result = await createDeepSeekHarnessAdapter(f.config).generate(request());
    assert.deepEqual(result.data, { cards: [] });
    assert.deepEqual(result.usage, { inputTokens: 15, outputTokens: 20, estimatedCostMicros: 55, currency: "USD" });
    assert.deepEqual(await readdir(f.work), []);
  }
  finally { await f.close(); }
});

test("malformed fences, mixed commentary and multiple objects fail once with safe format metadata", async () => {
  for (const [output, outputFormat] of [
    ['```json\n{"private":"FIXTURE_ONLY_SECRET"}\n```\ntrailing commentary', "invalid_fence"],
    ['{"private":"FIXTURE_ONLY_SECRET"}\n{"second":true}', "invalid_json"],
    ['```json\n{"private":"FIXTURE_ONLY_SECRET"\n```', "invalid_json_fence"],
  ] as const) {
    const f = await fixture({ output });
    let launches = 0;
    const launch: DeepSeekHarnessProcessLauncher = (command, args, options) => { launches++; return spawn(command, [...args], { ...options, stdio: ["pipe", "pipe", "pipe"] }); };
    try {
      await assert.rejects(createDeepSeekHarnessAdapter(f.config, { launch }).generate(request()), failure => {
        code("DSH_INVALID_JSON")(failure);
        const diagnostic = failure as DomainError & { outputFormat: string; outputBytes: number };
        assert.equal(diagnostic.outputFormat, outputFormat);
        assert.equal(diagnostic.outputBytes, Buffer.byteLength(output));
        assert.doesNotMatch(JSON.stringify(diagnostic), /FIXTURE_ONLY_SECRET|trailing commentary|second/);
        return true;
      });
      assert.equal(launches, 1);
      assert.deepEqual(await readdir(f.work), []);
    } finally { await f.close(); }
  }
});

test("a fenced response keeps its full byte limit before removing the wrapper", async () => {
  const output = '```json\n{"ok":true}\n```', f = await fixture({ output });
  try { await assert.rejects(createDeepSeekHarnessAdapter({ ...f.config, maxJsonOutputBytes: Buffer.byteLength('{"ok":true}') }).generate(request()), code("DSH_OUTPUT_LIMIT")); }
  finally { await f.close(); }
});

test("fence compatibility never bypasses complete-turn admission or usage validation", async () => {
  for (const [mode, expected] of [["interrupted", "DSH_PROTOCOL_ERROR"], ["missing_finish", "DSH_MODEL_FAILED"], ["stale_complete", "DSH_MODEL_FAILED"], ["no_usage", "DSH_USAGE_UNAVAILABLE"], ["bad_usage", "DSH_USAGE_UNAVAILABLE"]] as const) {
    const f = await fixture({ mode, output: '```json\n{"cards":[]}\n```' });
    try {
      await assert.rejects(createDeepSeekHarnessAdapter(f.config).generate(request()), code(expected));
      assert.deepEqual(await readdir(f.work), []);
    } finally { await f.close(); }
  }
});
test("transport stderr budget is bounded without returning diagnostics", async () => {
  const f = await fixture({ mode: "stderr_limit" });
  try { await assert.rejects(createDeepSeekHarnessAdapter({ ...f.config, maxTransportBytes: 1000 }).generate(request()), code("DSH_OUTPUT_LIMIT")); }
  finally { await f.close(); }
});
test("wall-clock timeout terminates actual owned subprocess and removes temporary home", async () => {
  const f = await fixture({ mode: "hang" });
  try {
    await assert.rejects(createDeepSeekHarnessAdapter({ ...f.config, timeoutMs: 100 }).generate(request()), code("DSH_TIMEOUT"));
    assert.deepEqual(await readdir(f.work), []);
  } finally { await f.close(); }
});
test("AbortSignal cancels actual owned runtime since official wire has no mid-turn cancellation", async () => {
  const f = await fixture({ mode: "hang" });
  try {
    const controller = new AbortController();
    const adapter = createDeepSeekHarnessAdapter(f.config, { launch: (executable, args, options) => {
        const child = spawn(executable, [...args], { ...options, stdio: ["pipe", "pipe", "pipe"] });
        child.stdout.once("data", () => { controller.abort(); });
        return child;
    } });
    await assert.rejects(adapter.generate(request({ signal: controller.signal })), code("DSH_CANCELLED"));
    assert.deepEqual(await readdir(f.work), []);
  } finally { await f.close(); }
});
test("trusted endpoint configuration uses HTTPS Messages root and refuses URL credentials", () => {
  const base: DeepSeekHarnessConfiguration = { modelVersion: "deepseek-v4-flash", promptVersion: "p1", currency: "USD", inputCostMicrosPerMillionTokens: 0, outputCostMicrosPerMillionTokens: 0 };
  assert.throws(() => createDeepSeekHarnessAdapter({ ...base, baseUrl: "https://user:secret@example.com/v1" }), code("DSH_INVALID_CONFIG"));
  assert.throws(() => createDeepSeekHarnessAdapter({ ...base, baseUrl: "http://127.0.0.1/api" }), code("DSH_INVALID_CONFIG"));
});
for (const [providerStatus, expected] of [[401, "DSH_PROVIDER_CREDENTIAL_REJECTED"], [429, "DSH_PROVIDER_RATE_LIMITED"]] as const) {
  test(`provider status ${providerStatus} yields concrete safe feedback`, async () => {
    const f = await fixture({ mode: "model_error", providerStatus });
    try { await assert.rejects(createDeepSeekHarnessAdapter(f.config).generate(request()), code(expected)); }
    finally { await f.close(); }
  });
}
test("max-token turn never becomes a successful parsed draft", async () => {
  const f = await fixture({ mode: "max_tokens", output: '```json\n{"cards":[]}\n```' });
  try { await assert.rejects(createDeepSeekHarnessAdapter(f.config).generate(request()), code("DSH_MAX_TOKENS")); }
  finally { await f.close(); }
});

const installedRuntime = process.env.DSH_TEST_RUNTIME_DIRECTORY ?? fileURLToPath(new URL("../../../.runtime/dsh-runtime/node_modules/@deepseek-ai/dsh", import.meta.url));
test("Node account copies only the selected grant, uses account provider and cleans its private HOME", async () => {
  const f = await fixture({ account: true });
  try {
    const snapshots: Promise<string>[] = []; let launches = 0;
    const launch: DeepSeekHarnessProcessLauncher = (command, args, options) => {
      launches++; assert.equal(command, process.execPath); assert.doesNotMatch(args.join(" "), /fixture-only|account.yaml/);
      const allowed = new Set(["NODE_ENV", "NARB_DISABLE_NATIVE_CACHE", "DSH_HOME", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "SystemRoot"]);
      assert.ok(Object.keys(options.env!).every(name => allowed.has(name)));
      assert.equal(options.env!.NARB_DISABLE_NATIVE_CACHE, "1");
      const home = options.env!.DSH_HOME!;
      snapshots.push(readFile(join(home, ".credentials.yaml"), "utf8"), readFile(join(home, "profiles", "m08-json", "cordis.patch.yml"), "utf8"));
      return spawn(command, [...args], options);
    };
    assert.deepEqual(await probeDshNodeAccount(f.config), { version: DEEPSEEK_HARNESS_VERSION, grantConfigured: true, remoteVerified: false });
    const result = await createDeepSeekHarnessAdapter({ ...f.config, apiKey: "", desktopInstallationDirectory: "", desktopCredentialsFile: "" }, { launch }).generate(request());
    assert.equal(launches, 1); assert.equal(result.usage.inputTokens, 15); assert.deepEqual(result.runtime.tools, []);
    const [grant, patch] = await Promise.all(snapshots);
    assert.deepEqual(Object.keys(JSON.parse(grant!).records), ["deepseek-account-platform/default"]);
    assert.doesNotMatch(grant!, /unrelated|private-device|discarded/);
    const rows = JSON.parse(patch!)[0].insert;
    const provider = rows.find((row: { name: string }) => row.name === "@deepseek-ai/dsh-llm-deepseek-account");
    assert.equal(provider.config.retryPolicy.maxRetries, 0);
    assert.ok(rows.some((row: { name: string }) => row.name === "@deepseek-ai/dsh-deepseek-account-platform"));
    assert.ok(rows.every((row: { name: string }) => !/(api-key|tool-|mcp|skill|subprocess|session-log|instructions)/.test(row.name)));
    assert.equal(await readFile(f.credentials, "utf8"), f.originalGrant); assert.deepEqual(await readdir(f.work), []);
  } finally { await f.close(); }
});

test("Node account refuses mixed credentials, nonofficial endpoint and malformed grants before launch", async () => {
  const f = await fixture({ account: true });
  try {
    for (const patch of [{ apiKey: secret }, { desktopInstallationDirectory: f.base }, { desktopCredentialsFile: f.credentials }, { accountCredentialsFile: "relative.yaml" }, { baseUrl: "https://example.org/anthropic" }]) {
      assert.throws(() => createDeepSeekHarnessAdapter({ ...f.config, ...patch }), code("DSH_INVALID_CONFIG"));
    }
    for (const content of ["bad-yaml", f.originalGrant.replace("https://platform.deepseek.com", "https://example.org"), f.originalGrant.replace(secret, "dsh_mock_fixture"), f.originalGrant.replace('"version":1', '"version":2'), "x".repeat(1_048_577)]) {
      await writeFile(f.credentials, content);
      await assert.rejects(createDeepSeekHarnessAdapter(f.config, { launch() { assert.fail("must not launch"); } }).generate(request()), code("DSH_ACCOUNT_CREDENTIAL_INVALID"));
      assert.deepEqual(await readdir(f.work), []);
    }
    if (process.platform !== "win32") {
      await writeFile(f.credentials, f.originalGrant); await chmod(f.credentials, 0o644);
      await assert.rejects(probeDshNodeAccount(f.config), code("DSH_ACCOUNT_CREDENTIAL_INVALID"));
    }
  } finally { await f.close(); }
});

test("Node account errors, timeout, cancellation and grant echo clean sessions without retry", async () => {
  for (const [mode, output, expected] of [["hang", undefined, "DSH_TIMEOUT"], ["no_usage", undefined, "DSH_USAGE_UNAVAILABLE"], ["success", JSON.stringify({ leaked: secret }), "DSH_PROTOCOL_ERROR"], ["max_tokens", undefined, "DSH_MAX_TOKENS"]] as const) {
    const f = await fixture({ account: true, mode, output }); let launches = 0;
    try {
      const adapter = createDeepSeekHarnessAdapter({ ...f.config, timeoutMs: mode === "hang" ? 150 : 2000 }, { launch(command, args, options) { launches++; return spawn(command, [...args], options); } });
      await assert.rejects(adapter.generate(request()), code(expected)); assert.equal(launches, 1);
      assert.deepEqual(await readdir(f.work), []); assert.equal(await readFile(f.credentials, "utf8"), f.originalGrant);
      const controller = new AbortController(); controller.abort();
      await assert.rejects(adapter.generate(request({ signal: controller.signal })), code("DSH_CANCELLED")); assert.equal(launches, 1);
    } finally { await f.close(); }
  }
});

test("official YAML parser accepts minimal account grant and rejects duplicate keys and aliases", { skip: !existsSync(join(installedRuntime, "package.json")) }, async () => {
  const f = await fixture({ account: true });
  const yaml = `version: 1\nrecords:\n  deepseek-account-platform/default:\n    kind: grant\n    payload:\n      version: 1\n      issuer: https://platform.deepseek.com\n      token: ${secret}\n`;
  try {
    const config = { ...f.config, runtimePackageDirectory: installedRuntime };
    await writeFile(f.credentials, yaml);
    assert.equal((await probeDshNodeAccount(config)).remoteVerified, false);
    for (const content of [yaml + "version: 1\n", yaml.replace(`token: ${secret}`, `token: ${secret}\n      token: duplicate`), yaml.replace(`token: ${secret}`, "token: &value [*value]")]) {
      await writeFile(f.credentials, content);
      await assert.rejects(probeDshNodeAccount(config), code("DSH_ACCOUNT_CREDENTIAL_INVALID"));
    }
    assert.deepEqual(await readdir(f.work), []);
  } finally { await f.close(); }
});

test("installed official Node account profile completes offline handshake with fixture grant", { skip: !existsSync(join(installedRuntime, "package.json")) }, async () => {
  const f = await fixture({ account: true }); const controller = new AbortController(); let handshake = false;
  try {
    const launch: DeepSeekHarnessProcessLauncher = (command, args, options) => {
      const dump = spawnSync(command, [...args, "--dump-config"], { cwd: options.cwd, env: options.env, encoding: "utf8", timeout: 10000, maxBuffer: 1048576, windowsHide: true });
      assert.equal(dump.status, 0, "official account profile composes");
      assert.match(dump.stdout, /dsh-llm-deepseek-account/); assert.doesNotMatch(dump.stdout, /dsh-llm-deepseek-api-key|dsh-tool-|dsh-mcp|dsh-skill/);
      const blocker = "data:text/javascript," + encodeURIComponent("globalThis.fetch=async()=>{throw Error('OFFLINE_TEST_ONLY');};");
      const child = spawn(command, ["--import", blocker, ...args], options); let output = "";
      child.stdout.on("data", chunk => {
        output += String(chunk); let newline: number;
        while ((newline = output.indexOf("\n")) >= 0) {
          const raw = output.slice(0, newline); output = output.slice(newline + 1); if (!raw.trim()) continue;
          const value = JSON.parse(raw);
          if (value.id === 1 && value.result?.serverInfo?.name === "deepseek-harness-sdk-runtime") { handshake = true; controller.abort(); }
        }
      }); return child;
    };
    await assert.rejects(createDeepSeekHarnessAdapter({ ...f.config, runtimePackageDirectory: installedRuntime, timeoutMs: 15000 }, { launch }).generate(request({ signal: controller.signal })), code("DSH_CANCELLED"));
    assert.equal(handshake, true); assert.deepEqual(await readdir(f.work), []); assert.equal(await readFile(f.credentials, "utf8"), f.originalGrant);
  } finally { await f.close(); }
});

test("installed official Node account provider completes one offline Messages request without tools or API key", { skip: !existsSync(join(installedRuntime, "package.json")) }, async () => {
  const f = await fixture({ account: true }); let launches = 0;
  try {
    const launch: DeepSeekHarnessProcessLauncher = (command, args, options) => {
      launches++;
      const script = `
        import fs from 'node:fs';
        let calls=0;
        globalThis.fetch=async(input,init)=>{
          const request=new Request(input,init),body=await request.json();
          const grant=JSON.parse(fs.readFileSync(process.env.DSH_HOME+'/.credentials.yaml','utf8')).records['deepseek-account-platform/default'].payload.token;
          if(++calls!==1||request.url!=='https://api.deepseek.com/anthropic/v1/messages'||request.method!=='POST'||request.headers.get('x-dsh-auth-token')!==grant||request.headers.has('x-api-key')||request.headers.has('authorization')||(body.tools??[]).length!==0||body.model!=='deepseek-v4-flash'||body.stream!==true)throw Error('OFFLINE_SCOPE');
          const events=[
            ['message_start',{type:'message_start',message:{id:'fixture-message',type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:0,cache_read_input_tokens:3,cache_creation_input_tokens:2}}}],
            ['content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}}],
            ['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'{"ok":true}'}}],
            ['content_block_stop',{type:'content_block_stop',index:0}],
            ['message_delta',{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:5}}],
            ['message_stop',{type:'message_stop'}]
          ];
          return new Response(events.map(([event,data])=>'event: '+event+'\\ndata: '+JSON.stringify(data)+'\\n\\n').join(''),{status:200,headers:{'content-type':'text/event-stream'}});
        };
      `;
      return spawn(command, ["--import", "data:text/javascript," + encodeURIComponent(script), ...args], options);
    };
    const result = await createDeepSeekHarnessAdapter({ ...f.config, runtimePackageDirectory: installedRuntime, timeoutMs: 15000 }, { launch }).generate(request());
    assert.deepEqual(result.data, { ok: true }); assert.equal(launches, 1);
    assert.deepEqual(result.usage, { inputTokens: 15, outputTokens: 5, estimatedCostMicros: 25, currency: "USD" });
    assert.equal(await readFile(f.credentials, "utf8"), f.originalGrant); assert.deepEqual(await readdir(f.work), []);
  } finally { await f.close(); }
});

test("official Node account rejection keeps the source grant unchanged and never retries", { skip: !existsSync(join(installedRuntime, "package.json")) }, async () => {
  const f = await fixture({ account: true }); let launches = 0;
  const counter = join(f.base, "offline-request-count.txt");
  try {
    const launch: DeepSeekHarnessProcessLauncher = (command, args, options) => {
      launches++;
      const script = `import fs from 'node:fs';let calls=0;globalThis.fetch=async(input,init)=>{
        const req=new Request(input,init);if(req.url!=='https://api.deepseek.com/anthropic/v1/messages')throw Error('OFFLINE_SCOPE');
        fs.writeFileSync(${JSON.stringify(counter)},String(++calls));
        return new Response(JSON.stringify({type:'error',error:{type:'authentication_error',message:${JSON.stringify(secret)}}}),{status:401,headers:{'content-type':'application/json'}});
      };`;
      return spawn(command, ["--import", "data:text/javascript," + encodeURIComponent(script), ...args], options);
    };
    await assert.rejects(createDeepSeekHarnessAdapter({ ...f.config, runtimePackageDirectory: installedRuntime, timeoutMs: 15000 }, { launch }).generate(request()), code("DSH_MODEL_FAILED"));
    assert.equal(launches, 1); assert.equal(await readFile(counter, "utf8"), "1");
    assert.equal(await readFile(f.credentials, "utf8"), f.originalGrant); assert.deepEqual(await readdir(f.work), []);
  } finally { await f.close(); }
});

test("installed official pinned CLI composes no-tools profile and completes offline SDK handshake", { skip: !existsSync(join(installedRuntime, "package.json")) }, async () => {
  const f = await fixture();
  try {
    let handshake = false;
    let composed = false;
    const controller = new AbortController();
    const launch: DeepSeekHarnessProcessLauncher = (executable, args, options) => {
      // Config dump does not boot plugins or send any model request; the ordinary CLI owns the grammar.
      const dump = spawnSync(executable, [...args, "--dump-config"], { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, encoding: "utf8", timeout: 10_000, maxBuffer: 1_048_576 });
      assert.equal(dump.status, 0, "official CLI configuration dump must succeed");
      assert.ok(dump.stdout.includes("@deepseek-ai/dsh-sdk-jsonrpc-server"));
      assert.ok(dump.stdout.includes("@deepseek-ai/dsh-agent-loop"));
      assert.ok(!/(dsh-tool-|dsh-subprocess|dsh-sandbox|dsh-terminal|dsh-mcp|dsh-skill|dsh-agent-instructions|dsh-session-log)/u.test(dump.stdout));
      composed = true;
      const child = spawn(executable, [...args], { ...options, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", chunk => {
        stdout += String(chunk);
        let newline: number;
        while ((newline = stdout.indexOf("\n")) >= 0) {
          const line = stdout.slice(0, newline);
          stdout = stdout.slice(newline + 1);
          if (!line.trim()) continue;
          const frame = JSON.parse(line) as { id?: number; result?: { serverInfo?: { name?: string; version?: string } } };
          if (frame.id === 1 && frame.result?.serverInfo?.name === "deepseek-harness-sdk-runtime") {
            assert.equal(frame.result.serverInfo.version, "0.0.1");
            handshake = true;
            // Abort synchronously before the adapter receives initialize's response and can send session/prompt.
            controller.abort();
          }
        }
      });
      return child;
    };
    const adapter = createDeepSeekHarnessAdapter({ ...f.config, runtimePackageDirectory: installedRuntime, timeoutMs: 15_000 }, { launch });
    await assert.rejects(adapter.generate(request({ signal: controller.signal })), code("DSH_CANCELLED"));
    assert.equal(composed, true);
    assert.equal(handshake, true);
    assert.deepEqual(await readdir(f.work), []);
  } finally { await f.close(); }
});
