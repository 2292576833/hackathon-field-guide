import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { DomainError } from "../shared/errors.ts";
import { protectPrivateDirectory } from "../shared/private-directory.ts";
import type { DeepSeekHarnessConfiguration, DeepSeekHarnessProcessLauncher } from "../modules/operations/deepseek-harness.ts";
import { DEEPSEEK_HARNESS_VERSION, inspectDshNodeAccountRuntime, readDshNodeAccountGrant } from "../modules/operations/deepseek-harness.ts";
import { DSH_DESKTOP_VERSION, probeDesktopDsh } from "./dsh-runtime.ts";

/** The installed 0.2.1-rc.2 native provider exports this default independently
 * of the conversation model. One search is one paid Messages request. */
export const DSH_NATIVE_SEARCH_MODEL = "deepseek-v4-flash";
export const DSH_NATIVE_SEARCH_PROMPT_VERSION = "field-dsh-native-search-v1";
export interface DshNativeSearchOptions {
  modelVersion?: string;
  maxTokens?: number;
  maxUses?: number;
  timeoutMs?: number;
}
export interface DshNativeSearchSource { url: string; title: string; snippet?: string; publishedAt?: string }
export interface DshNativeSearchResult {
  sources: DshNativeSearchSource[];
  /** Missing or malformed native usage is unknown, never zero. */
  usage: { inputTokens: number; outputTokens: number } | null;
  truncated: boolean;
}
export class DshNativeSearchError extends DomainError {
  readonly externalState: "not_sent" | "unknown";
  readonly retryable = false;
  readonly details: { externalState: "not_sent" | "unknown"; retryable: false };
  constructor(code: string, externalState: "not_sent" | "unknown") {
    super(code, "DSH 原生搜索暂未产生可采用的结构化结果，请查看采集任务状态。", { status: 503, recoveryAction: "review_discovery_run" });
    this.externalState = externalState;
    this.details = { externalState, retryable: false };
  }
}
const fail = (code: string, state: "not_sent" | "unknown" = "not_sent") => new DshNativeSearchError(code, state);
function bounded(value: number | undefined, fallback: number, maximum: number): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1 || n > maximum) throw fail("DSH_SEARCH_INVALID_CONFIG");
  return n;
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function tokenUsage(value: unknown): DshNativeSearchResult["usage"] {
  if (!object(value) || !Number.isSafeInteger(value.inputTokens) || !Number.isSafeInteger(value.outputTokens)) return null;
  const inputTokens = value.inputTokens as number, outputTokens = value.outputTokens as number;
  return inputTokens >= 0 && inputTokens <= 1_000_000_000 && outputTokens >= 0 && outputTokens <= 1_000_000_000 ? { inputTokens, outputTokens } : null;
}
function result(value: unknown, count: number): DshNativeSearchResult {
  if (!object(value) || value.nativeBlocks !== true || !Array.isArray(value.sources) || value.sources.length > count || typeof value.truncated !== "boolean") throw fail("DSH_SEARCH_PROTOCOL_INVALID", "unknown");
  const sources: DshNativeSearchSource[] = [], seen = new Set<string>();
  for (const source of value.sources) {
    if (!object(source) || typeof source.url !== "string" || source.url.length > 8192 || typeof source.title !== "string" || source.title.length > 4096) throw fail("DSH_SEARCH_PROTOCOL_INVALID", "unknown");
    let url: URL; try { url = new URL(source.url); } catch { throw fail("DSH_SEARCH_PROTOCOL_INVALID", "unknown"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !url.hostname || seen.has(source.url)) throw fail("DSH_SEARCH_PROTOCOL_INVALID", "unknown");
    if ((source.snippet !== undefined && (typeof source.snippet !== "string" || source.snippet.length > 16384)) || (source.publishedAt !== undefined && (typeof source.publishedAt !== "string" || source.publishedAt.length > 256))) throw fail("DSH_SEARCH_PROTOCOL_INVALID", "unknown");
    seen.add(source.url);
    sources.push({ url: source.url, title: source.title, ...(typeof source.snippet === "string" ? { snippet: source.snippet } : {}), ...(typeof source.publishedAt === "string" ? { publishedAt: source.publishedAt } : {}) });
  }
  return { sources, usage: tokenUsage(value.usage), truncated: value.truncated };
}

/** Only official package modules are loaded. The synthetic initiator supplies
 * the trusted account route required by the official provider; it is unrelated
 * to any personal desktop conversation and carries no tools or browser state. */
function bootstrap(runtime: string, credentials: string, home: string, limits: { model: string; maxTokens: number; maxUses: number; maxBytes: number }, nodeAccount = false): string {
  return `const fs=require('node:fs'),{pathToFileURL}=require('node:url');
const root=${JSON.stringify(runtime)},home=${JSON.stringify(home)},credentialFile=${JSON.stringify(credentials)},limits=${JSON.stringify(limits)};
const emit=process.stdout.write.bind(process.stdout); let dispatched=false,completed=false;
const send=value=>emit(JSON.stringify(value)+'\\n');
for(const key of ['log','info','warn','error','debug','trace'])console[key]=()=>{};
const stop=code=>{if(!completed){completed=true;send({kind:'error',code,dispatched});}process.exitCode=1;};
process.on('uncaughtException',()=>stop('DSH_SEARCH_RUNTIME_FAILED'));
process.on('unhandledRejection',()=>stop('DSH_SEARCH_RUNTIME_FAILED'));
(async()=>{
 let record;
 try {
  if(fs.statSync(credentialFile).size>1048576)throw Error();
  const YAML=require(root+'/node_modules/yaml');
  const doc=YAML.parseDocument(fs.readFileSync(credentialFile,'utf8'),{uniqueKeys:true});if(doc.errors.length)throw Error();
  const store=doc.toJS(),selected=store?.records?.['deepseek-account-platform/default'];
  if(store?.version!==1||selected?.kind!=='grant'||selected.payload?.version!==1||selected.payload?.issuer!=='https://platform.deepseek.com'||typeof selected.payload?.token!=='string'||!/^[\\x21-\\x7e]+$/.test(selected.payload.token)||selected.payload.token.startsWith('dsh_mock_'))throw Error();
  record={kind:'grant',payload:{version:1,issuer:'https://platform.deepseek.com',token:selected.payload.token}};
  ${nodeAccount ? "// The parent already copied only the validated grant into this private HOME." : "fs.writeFileSync(home+'/.credentials.yaml',JSON.stringify({version:1,records:{'deepseek-account-platform/default':record}}),{mode:0o600,flag:'wx'});"}
 }catch{stop('DSH_SEARCH_CREDENTIAL_INVALID');return;}
 const packages=['dsh-web-search-deepseek','dsh-web','dsh-deepseek-account-platform','dsh-credentials-local','dsh-authorization'];
 try{for(const name of packages){const p=JSON.parse(fs.readFileSync(root+'/node_modules/@deepseek-ai/'+name+'/package.json','utf8'));if(p.name!=='@deepseek-ai/'+name||p.version!==${JSON.stringify(nodeAccount ? DEEPSEEK_HARNESS_VERSION : DSH_DESKTOP_VERSION)})throw Error();}}catch{stop('DSH_SEARCH_VERSION_MISMATCH');return;}
 const load=name=>import(pathToFileURL(root+'/node_modules/@deepseek-ai/'+name+'/lib/index.js').href);
 let ctx;
 try {
  const [{Context},credentialsModule,authorizationModule,accountModule,webModule,providerModule]=await Promise.all(['cordis','dsh-credentials-local','dsh-authorization','dsh-deepseek-account-platform','dsh-web','dsh-web-search-deepseek'].map(load));
  ctx=new Context();
  const activate=async(plugin,config)=>{const fiber=ctx.plugin(plugin,config);await fiber.await();if(fiber.state!==2)throw Error();};
  await activate(credentialsModule.default,{path:home+'/.credentials.yaml',dshHome:home,watch:false});
  await activate(authorizationModule.default);
  await activate(accountModule.default,{platformOrigin:'https://platform.deepseek.com',inferenceOrigin:'https://api.deepseek.com',desktopPlatform:${nodeAccount ? "null" : "'win32'"}});
  await activate(webModule.default,{searchProvider:'deepseek-official'});
  const session={requestContext:()=>({provider:'deepseek-account'}),append:()=>{}};
  ctx.provide('agents',{currentInitiator:()=>({session})});
  const config={apiKey:undefined,apiKeyEnv:'DEEPSEEK_API_KEY',baseURL:'https://api.deepseek.com/anthropic/v1',model:limits.model,apiVersion:'2023-06-01',maxTokens:limits.maxTokens,maxUses:limits.maxUses};
  providerModule.apply(ctx,Object.fromEntries(Object.entries(config).map(([key,value])=>[key,{get:()=>value}])));
 }catch{stop('DSH_SEARCH_RUNTIME_UNAVAILABLE');if(ctx)await ctx.fiber.dispose();return;}
 let raw='',usage=null,nativeBlocks=false,requests=0;
 const transport=globalThis.fetch;
 globalThis.fetch=async(destination,init)=>{
  if(String(destination)!=='https://api.deepseek.com/anthropic/v1/messages'||init?.method!=='POST'||init.redirect!=='error'||++requests!==1)throw Error('scope');
  const headers=new Headers(init.headers);if(headers.get('x-dsh-auth-token')!==record.payload.token||headers.has('x-api-key')||headers.has('authorization'))throw Error('scope');
  const body=JSON.parse(init.body);if(body.model!==limits.model||body.max_tokens!==limits.maxTokens||body.tools?.length!==1||body.tools[0].type!=='web_search_20250305'||body.tools[0].name!=='web_search'||body.tools[0].max_uses!==limits.maxUses)throw Error('scope');
  dispatched=true;send({kind:'dispatched'});
  const response=await transport(destination,init);
  let parsedPromise;
  const json=()=>parsedPromise??=(async()=>{
   const reader=response.body?.getReader();if(!reader)throw Error();
   const buffers=[];let size=0;
   try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>limits.maxBytes){await reader.cancel();throw Error();}buffers.push(Buffer.from(part.value));}}finally{reader.releaseLock();}
   const parsed=JSON.parse(Buffer.concat(buffers).toString('utf8'));
   nativeBlocks=Array.isArray(parsed.content)&&parsed.content.some(block=>block?.type==='web_search_tool_result'&&Array.isArray(block.content));
   const u=parsed.usage;
   if(u&&Number.isSafeInteger(u.input_tokens)&&u.input_tokens>=0&&Number.isSafeInteger(u.output_tokens)&&u.output_tokens>=0){
    const cacheRead=u.cache_read_input_tokens??0,cacheCreate=u.cache_creation_input_tokens??0;
    if([cacheRead,cacheCreate].every(n=>Number.isSafeInteger(n)&&n>=0)){
     const total=u.input_tokens+cacheRead+cacheCreate;
     if(Number.isSafeInteger(total)&&total<=1000000000&&u.output_tokens<=1000000000)usage={inputTokens:total,outputTokens:u.output_tokens};
    }
   }
   return parsed;
  })();
  return {ok:response.ok,status:response.status,json};
 };
 try {
  for await(const chunk of process.stdin){raw+=chunk.toString('utf8');if(Buffer.byteLength(raw)>8192)throw Error();}
  const request=JSON.parse(raw);if(typeof request.query!=='string'||request.query.length>600||!request.query.trim()||!Number.isSafeInteger(request.count)||request.count<1||request.count>20)throw Error();
  const value=await ctx.web.search({query:request.query,maxResults:request.count});
  if(!nativeBlocks||!Array.isArray(value.sources))throw Error();
  const sources=value.sources.map(source=>({url:source.url,title:source.title??'',...(source.snippet!==undefined?{snippet:source.snippet}:{}),...(source.publishedAt!==undefined?{publishedAt:source.publishedAt}:{})}));
  if(JSON.stringify(sources).includes(record.payload.token))throw Error('secret');
  send({kind:'result',nativeBlocks:true,sources,usage,truncated:value.truncated===true});completed=true;
 }catch{stop(dispatched?'DSH_SEARCH_PROVIDER_UNCERTAIN':'DSH_SEARCH_NOT_SENT');}
 finally{globalThis.fetch=transport;await ctx.fiber.dispose();}
})().catch(()=>stop('DSH_SEARCH_RUNTIME_FAILED'));`;
}

export function createDshNativeSearchRuntime(configuration: DeepSeekHarnessConfiguration, options: DshNativeSearchOptions = {}, dependencies: { launch?: DeepSeekHarnessProcessLauncher } = {}) {
  const config = Object.freeze({ ...configuration });
  const nodeAccount = Boolean(config.accountCredentialsFile?.trim());
  const directory = config.desktopInstallationDirectory, credentials = nodeAccount ? config.accountCredentialsFile : config.desktopCredentialsFile;
  if (!credentials || !isAbsolute(credentials) || config.apiKey?.trim() || (config.baseUrl && config.baseUrl !== "https://api.deepseek.com/anthropic") || (nodeAccount
    ? !config.runtimePackageDirectory || !isAbsolute(config.runtimePackageDirectory) || directory?.trim() || config.desktopCredentialsFile?.trim()
    : !directory || !isAbsolute(directory))) throw fail("DSH_SEARCH_INVALID_CONFIG");
  const model = options.modelVersion ?? DSH_NATIVE_SEARCH_MODEL;
  if (!/^[A-Za-z0-9_.:/-]{1,160}$/.test(model)) throw fail("DSH_SEARCH_INVALID_CONFIG");
  const maxTokens = bounded(options.maxTokens, 2048, 2048), maxUses = bounded(options.maxUses, 1, 2), timeoutMs = bounded(options.timeoutMs, 90_000, 120_000);
  const maxBytes = bounded(config.maxTransportBytes, 1_048_576, 4_194_304);
  const executable = nodeAccount ? process.execPath : join(directory!, "DeepSeek Harness.exe");
  const launch = dependencies.launch ?? ((command, args, launchOptions) => spawn(command, [...args], launchOptions));
  return {
    identity: Object.freeze({ modelVersion: model, promptVersion: DSH_NATIVE_SEARCH_PROMPT_VERSION, maxTokens, maxUses }),
    async search(request: { query: string; count: number; signal: AbortSignal }): Promise<DshNativeSearchResult> {
      if (request.signal.aborted) throw fail("DSH_SEARCH_CANCELLED");
      if (typeof request.query !== "string" || !request.query.trim() || request.query.length > 600 || /[\u0000-\u001f\u007f]/.test(request.query) || !Number.isSafeInteger(request.count) || request.count < 1 || request.count > 20) throw fail("DSH_SEARCH_INVALID_REQUEST");
      let runtime: string;
      try { if (nodeAccount) runtime = (await inspectDshNodeAccountRuntime(config.runtimePackageDirectory!, true)).installationRoot;
        else { await probeDesktopDsh(config); runtime = join(directory!, "resources", "app.asar", "dsh"); }
      } catch { throw fail("DSH_SEARCH_RUNTIME_UNAVAILABLE"); }
      if (request.signal.aborted) throw fail("DSH_SEARCH_CANCELLED");
      const workRoot = resolve(config.workingDirectory ?? tmpdir()); await mkdir(workRoot, { recursive: true });
      const canonicalRoot = await realpath(workRoot), ownedDirectory = await mkdtemp(join(canonicalRoot, "field-dsh-search-"));
      const home = join(ownedDirectory, "home"), workspace = join(ownedDirectory, "workspace");
      try {
        try { await protectPrivateDirectory(ownedDirectory); } catch { throw fail("DSH_SEARCH_PRIVACY_UNAVAILABLE"); }
        await mkdir(home); await mkdir(workspace);
        const selectedCredentials = nodeAccount ? join(home, ".credentials.yaml") : credentials;
        if (nodeAccount) {
          try {
            const grant = await readDshNodeAccountGrant(join(runtime, "node_modules", "@deepseek-ai", "dsh"), credentials);
            await writeFile(selectedCredentials, JSON.stringify(grant), { flag: "wx", mode: 0o600 });
          } catch { throw fail("DSH_SEARCH_CREDENTIAL_INVALID"); }
        }
        if (request.signal.aborted) throw fail("DSH_SEARCH_CANCELLED");
        return await new Promise<DshNativeSearchResult>((resolveSearch, rejectSearch) => {
          let child: ReturnType<DeepSeekHarnessProcessLauncher>;
          try { child = launch(executable, [...(nodeAccount ? [] : ["--expose-internals"]), "-e", bootstrap(runtime, selectedCredentials, home, { model, maxTokens, maxUses, maxBytes }, nodeAccount)], {
            cwd: workspace, env: { ...(!nodeAccount ? { ELECTRON_RUN_AS_NODE: "1" } : { NARB_DISABLE_NATIVE_CACHE: "1" }), NODE_ENV: "production", ...(process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), DSH_HOME: home, HOME: home, USERPROFILE: home, TMP: ownedDirectory, TEMP: ownedDirectory, TMPDIR: ownedDirectory },
            shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
          }); } catch { rejectSearch(fail("DSH_SEARCH_RUNTIME_UNAVAILABLE")); return; }
          let output = "", bytes = 0, terminal: Record<string, unknown> | undefined, invalid = false, timedOut = false, cancelled = false, dispatches = 0;
          const decoder = new StringDecoder("utf8");
          const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
          const abort = () => { cancelled = true; child.kill(); };
          request.signal.addEventListener("abort", abort, { once: true });
          child.stdout.on("data", chunk => {
            bytes += chunk.length; if (bytes > 524_288) { invalid = true; child.kill(); return; }
            output += decoder.write(chunk);
            let newline: number;
            while ((newline = output.indexOf("\n")) >= 0) {
              const line = output.slice(0, newline); output = output.slice(newline + 1);
              try {
                const message: unknown = JSON.parse(line);
                if (!object(message) || terminal || !["dispatched", "result", "error"].includes(String(message.kind))) throw new Error();
                if (message.kind === "dispatched" && ++dispatches !== 1) throw new Error();
                if (message.kind !== "dispatched") terminal = message;
              } catch { invalid = true; child.kill(); }
            }
          });
          // Provider diagnostics never enter application logs or thrown errors.
          child.stderr.on("data", chunk => { bytes += chunk.length; if (bytes > 524_288) { invalid = true; child.kill(); } });
          child.on("error", () => { invalid = true; });
          child.stdin.on("error", () => { invalid = true; child.kill(); });
          child.on("close", code => {
            clearTimeout(timer); request.signal.removeEventListener("abort", abort);
            output += decoder.end();
            if (timedOut || cancelled || invalid || output.trim() || !terminal) { rejectSearch(fail(timedOut ? "DSH_SEARCH_TIMEOUT_UNCERTAIN" : cancelled ? "DSH_SEARCH_CANCELLED_UNCERTAIN" : "DSH_SEARCH_TRANSPORT_UNCERTAIN", "unknown")); return; }
            if (terminal.kind === "error") {
              const allowed = new Set(["DSH_SEARCH_CREDENTIAL_INVALID", "DSH_SEARCH_VERSION_MISMATCH", "DSH_SEARCH_RUNTIME_UNAVAILABLE", "DSH_SEARCH_NOT_SENT", "DSH_SEARCH_RUNTIME_FAILED", "DSH_SEARCH_PROVIDER_UNCERTAIN"]);
              const errorCode = typeof terminal.code === "string" && allowed.has(terminal.code) ? terminal.code : "DSH_SEARCH_RUNTIME_FAILED";
              rejectSearch(fail(errorCode, terminal.dispatched === false && dispatches === 0 ? "not_sent" : "unknown")); return;
            }
            if (code !== 0 || dispatches !== 1) { rejectSearch(fail("DSH_SEARCH_TRANSPORT_UNCERTAIN", "unknown")); return; }
            try { resolveSearch(result(terminal, request.count)); } catch (error) { rejectSearch(error); }
          });
          if (request.signal.aborted) abort(); else child.stdin.end(JSON.stringify({ query: request.query, count: request.count }));
        });
      } finally {
        const owned = relative(canonicalRoot, ownedDirectory);
        if (dirname(ownedDirectory) === canonicalRoot && owned.startsWith("field-dsh-search-") && !owned.includes(sep) && !isAbsolute(owned)) await rm(ownedDirectory, { recursive: true, force: true });
      }
    },
  };
}
