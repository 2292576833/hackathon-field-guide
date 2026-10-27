import type { Actor, IdGenerator } from "../../shared/contracts.ts";
import type { FreshSessionGuard } from "../../shared/personal-ai.ts";
import { DomainError, isDomainError, toErrorEnvelope } from "../../shared/errors.ts";
import type { TeamSupervisionService } from "./service.ts";
export interface TeamSupervisionHttpDependencies {
  service: TeamSupervisionService; resolveActor(request: Request): Promise<Actor | null>;
  authorizeMutation(request: Request, actor: Actor): Promise<void>;
  freshSessionGuard(request: Request, actor: Actor): FreshSessionGuard; requestIds: IdGenerator;
}
export function createTeamSupervisionHandlers(deps: TeamSupervisionHttpDependencies) {
  const route = (method: string, work: (actor: Actor, request: Request, projectId: string, guard: FreshSessionGuard) => Promise<unknown>) => async (request: Request, params: { projectId: string }) => {
    const requestId = deps.requestIds.next(), headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
    try {
      if (request.method !== method) throw new DomainError("METHOD_NOT_ALLOWED", "此入口不支持该方法。", {status:405});
      const actor = await deps.resolveActor(request); if (!actor) throw new DomainError("UNAUTHENTICATED", "请先登录。", {status:401});
      if (method !== "GET") await deps.authorizeMutation(request, actor);
      return Response.json({ data: await work(actor,request,params.projectId,deps.freshSessionGuard(request,actor)), requestId }, {headers});
    } catch (error) { return Response.json(toErrorEnvelope(error,requestId), {headers,status:isDomainError(error)?error.status:500}); }
  };
  return {
    get: route("GET", (actor,_request,id,guard) => deps.service.get(actor,id,guard)),
    settings: route("PUT", async (actor,request,id,guard) => { const input=await body(request,["enabled","expectedRevision"]); return deps.service.settings(actor,id,{enabled:input.enabled as boolean,expectedRevision:input.expectedRevision as number},guard); }),
    check: route("POST", async (actor,request,id,guard) => { await body(request,[]); return deps.service.check(actor,id,guard); }),
  };
}
async function body(request: Request, allowed: readonly string[]): Promise<Record<string,unknown>> {
  if (request.headers.get("content-type")?.split(";",1)[0].trim().toLowerCase() !== "application/json" || request.headers.get("content-encoding") && request.headers.get("content-encoding") !== "identity")
    throw new DomainError("JSON_REQUIRED", "请提交未压缩JSON。", {status:415});
  const reader=request.body?.getReader(); let bytes=0; const chunks: Uint8Array[]=[];
  if(reader) try { while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>2048){void reader.cancel().catch(()=>{});throw new DomainError("PAYLOAD_TOO_LARGE","设置内容过长。",{status:413});}chunks.push(part.value);} } finally {reader.releaseLock();}
  const all=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){all.set(chunk,offset);offset+=chunk.byteLength;}
  let value: unknown;try{value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(all));}catch{throw new DomainError("INVALID_JSON","JSON内容无效。",{status:400});}
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw new DomainError("SUPERVISION_INVALID_INPUT","只接受护航设置，不接受客户端事实。");
  return value as Record<string,unknown>;
}
