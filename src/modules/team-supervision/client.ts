import type { SupervisionApiClient } from "./ports.ts";
import type { SupervisionState } from "./model.ts";
export class SupervisionApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
export function createSupervisionApiClient(fetcher: typeof fetch = (...args) => fetch(...args)): SupervisionApiClient {
  async function request(projectId: string, method: string, body?: unknown, signal?: AbortSignal): Promise<SupervisionState> {
    const suffix=method==="POST"?"/check":"";
    const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), method === "POST" ? 240_000 : 15_000);
    try {
    const response=await fetcher(`/api/v1/projects/${encodeURIComponent(projectId)}/team-supervision${suffix}`,{method,credentials:"same-origin",cache:"no-store",signal: signal ?? timeout.signal,
      ...(body===undefined?{}:{headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})});
    const envelope=await response.json() as {data?:SupervisionState;error?:{message?:string}};
    if(!response.ok||envelope.error||!envelope.data){ if(response.status===401&&typeof window!=="undefined")window.dispatchEvent(new Event("hackathon:unauthenticated")); throw new SupervisionApiError(envelope.error?.message??"护航状态尚未核对，请刷新记录。",response.status); }
    if(envelope.data.projectId!==projectId)throw new SupervisionApiError("当前空间已变化，请重新打开协作提醒。",403);
    return envelope.data;
    } finally { clearTimeout(timer); }
  }
  return {get:(id,signal)=>request(id,"GET",undefined,signal),settings:(id,input)=>request(id,"PUT",input),check:id=>request(id,"POST",{})};
}
