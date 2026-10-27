import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeepSeekHarnessConfiguration, DeepSeekHarnessProcessLauncher } from "../modules/operations/deepseek-harness.ts";
import { DEEPSEEK_HARNESS_VERSION } from "../modules/operations/deepseek-harness.ts";
import { createDshNativeSearchRuntime, DSH_NATIVE_SEARCH_MODEL, DshNativeSearchError } from "./dsh-search-runtime.ts";
import { DSH_DESKTOP_VERSION } from "./dsh-runtime.ts";

const GRANT = "FIXTURE_ONLY_NATIVE_ACCOUNT_GRANT", UNRELATED = "FIXTURE_ONLY_UNRELATED_GRANT";
type Mode = "success" | "no_blocks" | "missing_usage" | "bad_usage" | "exit" | "rejected" | "leak" | "large" | "wait";
const endpoint = "https://api.deepseek.com/anthropic/v1/messages";
function fakeTransport(mode: Mode): string {
  return `const transport=async(destination,init)=>{
    const fs=require('node:fs');const store=JSON.parse(fs.readFileSync(process.env.DSH_HOME+'/.credentials.yaml','utf8'));
    if(Object.keys(store.records).join()!=='deepseek-account-platform/default'||JSON.stringify(store).includes(${JSON.stringify(UNRELATED)})||JSON.stringify(store).includes('discard'))throw Error('fixture credential isolation');
    const headers=new Headers(init.headers),body=JSON.parse(init.body);
    if(String(destination)!==${JSON.stringify(endpoint)}||headers.get('x-dsh-auth-token')!==${JSON.stringify(GRANT)}||headers.has('authorization')||headers.has('x-api-key')||body.tools.length!==1||body.tools[0].max_uses!==1||body.max_tokens!==128||body.model!==${JSON.stringify(DSH_NATIVE_SEARCH_MODEL)}||init.redirect!=='error')throw Error('fixture request');
    if(${JSON.stringify(mode)}==='exit'){process.stderr.write(${JSON.stringify(GRANT)});process.exit(2);}
    if(${JSON.stringify(mode)}==='wait')await new Promise(()=>{setInterval(()=>{},1000);});
    if(${JSON.stringify(mode)}==='rejected')return new Response(JSON.stringify({error:{message:${JSON.stringify(GRANT)}}}),{status:401});
    const content=${JSON.stringify(mode)}==='no_blocks'?[{type:'text',text:'Found https://untrusted.example/fabricated in prose'}]:[
     {type:'web_search_tool_result',content:[{type:'web_search_result',url:'https://example.org/hackathon',title:'黑客松',page_age:'2026-10-09'},{type:'web_search_result',url:'https://example.org/hackathon',title:'duplicate'},{type:'web_search_result',url:'https://example.org/second',title:'second'}]},
     {type:'text',text:'provider prose ignored',citations:[{url:'https://example.org/hackathon',cited_text:${JSON.stringify(mode)}==='leak'?${JSON.stringify(GRANT)}:${JSON.stringify(mode)}==='large'?'x'.repeat(50000):'公开报名线索'}]}
    ];
    const result={content,...(${JSON.stringify(mode)}==='missing_usage'?{}:{usage:{input_tokens:10,output_tokens:5,cache_read_input_tokens:${JSON.stringify(mode)}==='bad_usage'?'bad':3,cache_creation_input_tokens:2}})};
    return new Response(JSON.stringify(result),{status:200});
  };`;
}

/** A harmless Node executable and minimal fixture implementations of the
 * published package seams; no personal grant, HTTP or live account is used. */
async function fixture(nodeAccount = false) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-native-fixture-")), installation = join(directory, "installation");
  const packages = nodeAccount ? join(installation, "node_modules") : join(installation, "resources", "app.asar", "dsh", "node_modules"), work = join(directory, "work"), credentials = join(directory, "credentials.yaml");
  await mkdir(packages, { recursive: true }); await mkdir(work);
  const executable = nodeAccount ? process.execPath : join(installation, "DeepSeek Harness.exe");
  if (!nodeAccount) { await copyFile(process.execPath, executable); if (process.platform !== "win32") await chmod(executable, 0o700); }
  const original = JSON.stringify({ version: 1, records: {
    "deepseek-account-platform/default": { kind: "grant", payload: { version: 1, issuer: "https://platform.deepseek.com", token: GRANT, irrelevant: "discard" } },
    "other/default": { kind: "grant", payload: { token: UNRELATED } },
  } });
  await writeFile(credentials, original, { mode: 0o600 });
  async function module(name: string, source: string) {
    const path = join(packages, "@deepseek-ai", name); await mkdir(join(path, "lib"), { recursive: true });
    await writeFile(join(path, "package.json"), JSON.stringify({ name: `@deepseek-ai/${name}`, version: nodeAccount ? DEEPSEEK_HARNESS_VERSION : DSH_DESKTOP_VERSION, type: "module", ...(name === "dsh" ? { bin: { dsh: "lib/bin.js" } } : {}) }));
    await writeFile(join(path, "lib", "index.js"), source);
    if (name === "dsh") await writeFile(join(path, "lib", "bin.js"), "");
  }
  await mkdir(join(packages, "yaml")); await writeFile(join(packages, "yaml", "index.js"), "exports.parseDocument=raw=>({errors:[],toJS:()=>JSON.parse(raw)});");
  await module("dsh", ""); await module("dsh-desktop-host", ""); await module("dsh-llm-deepseek-account", "");
  await module("cordis", `export class Context {
    constructor(){this.values=new Map();this.fiber={dispose:async()=>{}};}
    plugin(Plugin,config){new Plugin(this,config);return {await:async()=>{},state:2};}
    provide(name,value){this.values.set(name,value);this[name]=value;}
    get(name){return this.values.get(name);}
  }`);
  await module("dsh-credentials-local", `import fs from 'node:fs';export default class {
    constructor(ctx,config){const records=JSON.parse(fs.readFileSync(config.path,'utf8')).records;
      ctx.provide('credentials',{readRecord:async key=>records[key],resolve:async()=>undefined});}
  }`);
  await module("dsh-authorization", "export default class {constructor(ctx){ctx.provide('authorization',{});}}");
  await module("dsh-deepseek-account-platform", `export default class {constructor(ctx,config){ctx.provide('deepseekAccount',{
    resolveToken:async destination=>new URL(destination).origin===config.inferenceOrigin?(await ctx.credentials.readRecord('deepseek-account-platform/default'))?.payload.token:undefined
  });}}`);
  await module("dsh-web", `export default class {constructor(ctx){this.provider=null;ctx.provide('web',this);}
    registerSearchProvider(provider){this.provider=provider;}
    async search(request){const value=await this.provider.search(request);return {sources:value.sources.slice(0,request.maxResults),truncated:value.sources.length>request.maxResults};}
  }`);
  await module("dsh-web-search-deepseek", `export function apply(ctx,config){ctx.web.registerSearchProvider({async search(request){
    const token=ctx.get('agents')?.currentInitiator()?.session.requestContext()?.provider==='deepseek-account'?await ctx.get('deepseekAccount')?.resolveToken(config.baseURL.get()+'/messages'):undefined;
    if(!token)throw Error('credential missing');
    const response=await fetch(config.baseURL.get()+'/messages',{method:'POST',redirect:'error',headers:{'x-dsh-auth-token':token},body:JSON.stringify({model:config.model.get(),max_tokens:config.maxTokens.get(),messages:[{role:'user',content:[{type:'text',text:'Perform a web search for the query: '+request.query}]}],tools:[{type:'web_search_20250305',name:'web_search',max_uses:config.maxUses.get()}]})});
    const data=await response.json();if(!response.ok)throw Error(data.error.message);
    const blocks=data.content.filter(block=>block.type==='web_search_tool_result');if(!blocks.length)throw Error('no native block');
    const snippets=new Map();for(const block of data.content)for(const cite of block.citations??[])if(!snippets.has(cite.url))snippets.set(cite.url,cite.cited_text);
    const sources=[],seen=new Set();for(const block of blocks)for(const item of block.content??[])if(item.type==='web_search_result'&&!seen.has(item.url)){seen.add(item.url);sources.push({url:item.url,title:item.title,publishedAt:item.page_age,...(snippets.has(item.url)?{snippet:snippets.get(item.url)}:{})});}
    return {sources,truncated:false};
  }});}`);
  let mode: Mode = "success", launches = 0;
  const config: DeepSeekHarnessConfiguration = { ...(nodeAccount ? { runtimePackageDirectory: join(packages, "@deepseek-ai", "dsh"), accountCredentialsFile: credentials } : { desktopInstallationDirectory: installation, desktopCredentialsFile: credentials }), workingDirectory: work,
    modelVersion: "fixture-chat-model", promptVersion: "fixture-prompt", currency: "USD", inputCostMicrosPerMillionTokens: 1, outputCostMicrosPerMillionTokens: 1, maxTransportBytes: 32768 };
  const launch: DeepSeekHarnessProcessLauncher = (command, args, options) => {
    launches++;
    assert.equal(command, executable); assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    assert.doesNotMatch(args.join(" "), /FIXTURE_ONLY_/);
    const allowed = new Set(["ELECTRON_RUN_AS_NODE", "NARB_DISABLE_NATIVE_CACHE", "NODE_ENV", "SystemRoot", "DSH_HOME", "HOME", "USERPROFILE", "TMP", "TEMP", "TMPDIR"]);
    assert.ok(Object.keys(options.env!).every(key => allowed.has(key))); assert.equal(options.env!.HOME, options.env!.DSH_HOME);
    if (nodeAccount) { assert.equal(options.env!.ELECTRON_RUN_AS_NODE, undefined); assert.equal(options.env!.NARB_DISABLE_NATIVE_CACHE, "1"); assert.equal(args[0], "-e"); }
    else assert.equal(options.env!.NARB_DISABLE_NATIVE_CACHE, undefined);
    const code = args.at(-1)!.replace("const transport=globalThis.fetch;", fakeTransport(mode));
    assert.notEqual(code, args.at(-1));
    return spawn(command, [...args.slice(0, -1), code], options);
  };
  return { config, launch, packages, work, credentials, setMode: (next: Mode) => { mode = next; }, launches: () => launches,
    async unchanged() { assert.equal(await readFile(credentials, "utf8"), original); assert.deepEqual(await readdir(work), []); },
    async close() { const owned = relative(tmpdir(), directory); assert.equal(dirname(directory), tmpdir()); assert.ok(owned.startsWith("dsh-native-fixture-") && !owned.includes(sep) && !isAbsolute(owned)); await rm(directory, { recursive: true, force: true }); }
  };
}
const search = { query: "2026 中文黑客松公开报名", count: 1, signal: new AbortController().signal };
const rejects = (state: "not_sent" | "unknown") => (error: unknown) => {
  assert.ok(error instanceof DshNativeSearchError); assert.equal(error.externalState, state); assert.equal(error.details.externalState, state); assert.equal(error.retryable, false);
  assert.doesNotMatch(JSON.stringify(error), /FIXTURE_ONLY_|untrusted.example|公开报名/); return true;
};
function runtime(f: Awaited<ReturnType<typeof fixture>>, timeoutMs = 3000) { return createDshNativeSearchRuntime(f.config, { maxTokens: 128, timeoutMs }, { launch: f.launch }); }

test("native search uses the isolated selected grant and structured sources, with cache-inclusive usage", async () => {
  const f = await fixture();
  try {
    const run = runtime(f); assert.deepEqual(run.identity, { modelVersion: DSH_NATIVE_SEARCH_MODEL, promptVersion: "field-dsh-native-search-v1", maxTokens: 128, maxUses: 1 });
    assert.deepEqual(await run.search(search), { sources: [{ url: "https://example.org/hackathon", title: "黑客松", snippet: "公开报名线索", publishedAt: "2026-10-09" }], usage: { inputTokens: 15, outputTokens: 5 }, truncated: true });
    assert.equal(f.launches(), 1); await f.unchanged();
  } finally { await f.close(); }
});

test("missing or malformed native usage remains unknown without invalidating structured sources", async () => {
  const f = await fixture();
  try {
    for (const mode of ["missing_usage", "bad_usage"] as const) {
      f.setMode(mode); const value = await runtime(f).search(search); assert.equal(value.sources.length, 1); assert.equal(value.usage, null); await f.unchanged();
    }
    assert.equal(f.launches(), 2);
  } finally { await f.close(); }
});

test("plaintext-only responses, credential-containing sources, rejected HTTP and process loss never retry", async () => {
  const f = await fixture();
  try {
    for (const mode of ["no_blocks", "leak", "rejected", "exit", "large"] as const) {
      f.setMode(mode); await assert.rejects(runtime(f).search(search), rejects("unknown")); await f.unchanged();
    }
    assert.equal(f.launches(), 5);
  } finally { await f.close(); }
});

test("bounded cancellation and query validation prevent dispatch; timeouts after launch stay uncertain", async () => {
  const f = await fixture();
  try {
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(runtime(f).search({ ...search, signal: aborted.signal }), rejects("not_sent"));
    await assert.rejects(runtime(f).search({ ...search, query: "x".repeat(601) }), rejects("not_sent"));
    await assert.rejects(runtime(f).search({ ...search, count: 21 }), rejects("not_sent"));
    assert.equal(f.launches(), 0); f.setMode("wait");
    await assert.rejects(runtime(f, 400).search(search), error => { rejects("unknown")(error); assert.equal((error as DshNativeSearchError).code, "DSH_SEARCH_TIMEOUT_UNCERTAIN"); return true; }); assert.equal(f.launches(), 1); await f.unchanged();
    const cancelled = new AbortController();
    const launch: DeepSeekHarnessProcessLauncher = (command, args, options) => { const child = f.launch(command, args, options); child.stdout.on("data", chunk => { if (chunk.toString().includes('"kind":"dispatched"')) cancelled.abort(); }); return child; };
    await assert.rejects(createDshNativeSearchRuntime(f.config, { maxTokens: 128, timeoutMs: 3000 }, { launch }).search({ ...search, signal: cancelled.signal }), error => { rejects("unknown")(error); assert.equal((error as DshNativeSearchError).code, "DSH_SEARCH_CANCELLED_UNCERTAIN"); return true; });
    assert.equal(f.launches(), 2); await f.unchanged();
  } finally { await f.close(); }
});

test("package mismatch and malformed selected grant fail before native dispatch", async () => {
  const f = await fixture();
  try {
    const packagePath = join(f.packages, "@deepseek-ai", "dsh-web-search-deepseek", "package.json");
    const originalPackage = await readFile(packagePath, "utf8");
    await writeFile(packagePath, originalPackage.replace(DSH_DESKTOP_VERSION, "wrong"));
    await assert.rejects(runtime(f).search(search), rejects("not_sent")); await f.unchanged();
    await writeFile(packagePath, originalPackage);
    const originalCredential = await readFile(f.credentials, "utf8");
    await writeFile(f.credentials, originalCredential.replace(GRANT, "dsh_mock_not_live"));
    await assert.rejects(runtime(f).search(search), rejects("not_sent"));
    await writeFile(f.credentials, originalCredential); await f.unchanged();
    assert.equal(f.launches(), 1);
  } finally { await f.close(); }
});

/** Explicit opt-in compatibility check against installed public modules. It
 * uses a fixture grant and replaces transport before any call can reach HTTP. */
test("Node native search preserves account isolation, native citations, usage and unknown failures", async () => {
    const f = await fixture(true);
    try {
      const run = createDshNativeSearchRuntime({ ...f.config, apiKey: "", desktopInstallationDirectory: "", desktopCredentialsFile: "" }, { maxTokens: 128, timeoutMs: 3000 }, { launch: f.launch });
      assert.deepEqual(await run.search(search), { sources: [{ url: "https://example.org/hackathon", title: "黑客松", snippet: "公开报名线索", publishedAt: "2026-10-09" }], usage: { inputTokens: 15, outputTokens: 5 }, truncated: true });
      for (const mode of ["missing_usage", "bad_usage"] as const) { f.setMode(mode); assert.equal((await run.search(search)).usage, null); await f.unchanged(); }
      for (const mode of ["no_blocks", "leak", "rejected", "exit", "large"] as const) { f.setMode(mode); await assert.rejects(run.search(search), rejects("unknown")); await f.unchanged(); }
      assert.equal(f.launches(), 8);
      f.setMode("wait"); await assert.rejects(runtime(f, 400).search(search), rejects("unknown")); await f.unchanged();
      const aborted = new AbortController(); aborted.abort();
      await assert.rejects(run.search({ ...search, signal: aborted.signal }), rejects("not_sent")); assert.equal(f.launches(), 9);
      const cancelled = new AbortController();
      const launch: DeepSeekHarnessProcessLauncher = (command, args, options) => {
        const child = f.launch(command, args, options);
        child.stdout.on("data", chunk => { if (String(chunk).includes('"kind":"dispatched"')) cancelled.abort(); }); return child;
      };
      await assert.rejects(createDshNativeSearchRuntime(f.config, { maxTokens: 128, timeoutMs: 3000 }, { launch }).search({ ...search, signal: cancelled.signal }), rejects("unknown"));
      assert.equal(f.launches(), 10); await f.unchanged();
    } finally { await f.close(); }
});

test("Node native search rejects invalid private grants and package versions before launch", async () => {
  const f = await fixture(true);
  try {
    assert.throws(() => createDshNativeSearchRuntime({ ...f.config, apiKey: "fixture-key" }), rejects("not_sent"));
    assert.throws(() => createDshNativeSearchRuntime({ ...f.config, desktopInstallationDirectory: f.work }), rejects("not_sent"));
    assert.throws(() => createDshNativeSearchRuntime({ ...f.config, baseUrl: "https://example.org" }), rejects("not_sent"));
    const original = await readFile(f.credentials, "utf8");
    await writeFile(f.credentials, original.replace(GRANT, "dsh_mock_fixture"));
    await assert.rejects(runtime(f).search(search), rejects("not_sent"));
    await writeFile(f.credentials, original);
    const packagePath = join(f.packages, "@deepseek-ai", "dsh-web-search-deepseek", "package.json");
    await writeFile(packagePath, (await readFile(packagePath, "utf8")).replace(DEEPSEEK_HARNESS_VERSION, "wrong"));
    await assert.rejects(runtime(f).search(search), rejects("not_sent"));
    assert.equal(f.launches(), 0); await f.unchanged();
  } finally { await f.close(); }
});

const installedNode = fileURLToPath(new URL("../../.runtime/dsh-runtime/node_modules/@deepseek-ai/dsh", import.meta.url));
test("installed official Node packages perform native account search with fixture transport only", { skip: !existsSync(join(installedNode, "package.json")) }, async () => {
  const f = await fixture(true);
  try {
    let launches = 0;
    const launch: DeepSeekHarnessProcessLauncher = (command, args, options) => {
      launches++; assert.equal(command, process.execPath);
      let code = args.at(-1)!.replace("const transport=globalThis.fetch;", fakeTransport("success")); assert.notEqual(code, args.at(-1));
      // Block network before plugin initialization too. The fixture transport is the only allowed request path.
      code = "globalThis.fetch=async()=>{throw Error('OFFLINE_TEST_ONLY');};" + code;
      return spawn(command, [...args.slice(0, -1), code], options);
    };
    const run = createDshNativeSearchRuntime({ ...f.config, runtimePackageDirectory: installedNode }, { maxTokens: 128, timeoutMs: 10000 }, { launch });
    const result = await run.search(search);
    assert.equal(launches, 1); assert.equal(result.sources[0]!.snippet, "公开报名线索"); assert.deepEqual(result.usage, { inputTokens: 15, outputTokens: 5 });
    await f.unchanged();
  } finally { await f.close(); }
});

test("installed official desktop packages support the isolated account/native-search composition", { skip: !process.env.DSH_NATIVE_TEST_DESKTOP }, async () => {
  const f = await fixture();
  try {
    const desktop = process.env.DSH_NATIVE_TEST_DESKTOP!;
    const launch: DeepSeekHarnessProcessLauncher = (command, args, options) => {
      const code = args[2]!.replace("const transport=globalThis.fetch;", fakeTransport("success")); assert.notEqual(code, args[2]);
      return spawn(command, [args[0]!, args[1]!, code], options);
    };
    const run = createDshNativeSearchRuntime({ ...f.config, desktopInstallationDirectory: desktop }, { maxTokens: 128, timeoutMs: 8000 }, { launch });
    const value = await run.search(search);
    assert.equal(value.sources[0]!.url, "https://example.org/hackathon"); assert.equal(value.sources[0]!.snippet, "公开报名线索");
    assert.deepEqual(value.usage, { inputTokens: 15, outputTokens: 5 }); await f.unchanged();
  } finally { await f.close(); }
});
