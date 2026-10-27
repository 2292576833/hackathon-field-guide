import type { Actor } from "../../shared/contracts.ts";
import { DomainError, toErrorEnvelope } from "../../shared/errors.ts";
import type { AgentId, InstallationReceipt } from "./domain.ts";
import type { SkillsHttpDependencies } from "./ports.ts";
import { STANDALONE_BRIDGE_SOURCE } from "./standalone.ts";
async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") throw new DomainError("JSON_REQUIRED", "请提交 JSON。", { status: 415 });
  if (!request.body) throw new DomainError("INVALID_JSON", "请求内容不能为空。");
  let size = 0; const chunks = []; for await (const chunk of request.body as unknown as AsyncIterable<Uint8Array>) { size += chunk.byteLength; if (size > 512 * 1024) throw new DomainError("BODY_TOO_LARGE", "请求过大。", { status: 413 }); chunks.push(chunk); }
  try { const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value as Record<string, unknown>; } catch { throw new DomainError("INVALID_JSON", "请求 JSON 格式无效。"); }
}
type Handler = (request: Request) => Promise<Response>;
export function createSkillsHttpHandlers(deps: SkillsHttpDependencies) {
  const handler = (method: string, access: "public" | "session" | "bridge", execute: (input: Record<string, unknown>, actor: Actor | null, request: Request) => Promise<unknown> | unknown): Handler => async request => {
    const requestId = deps.requestId(); try { if (request.method !== method) throw new DomainError("METHOD_NOT_ALLOWED", "方法不支持。", { status: 405 }); const actor = access === "session" ? await deps.resolveActor(request) : null; if (access === "session" && !actor) throw new DomainError("UNAUTHENTICATED", "请登录。", { status: 401 }); if (method !== "GET" && actor) await deps.assertMutationAllowed(request, actor); const input = method === "GET" ? {} : await body(request); return Response.json({ data: await execute(input, actor, request), requestId }, { headers: { "Cache-Control": "no-store" } }); } catch (error) { return Response.json(toErrorEnvelope(error, requestId), { status: error instanceof DomainError ? error.status : 500, headers: { "Cache-Control": "no-store" } }); }
  };
  const bridgeInput = (input: Record<string, unknown>) => ({ planId: input.planId as string, manifestHash: input.manifestHash as string, bridgeToken: input.bridgeToken as string });
  return {
    downloadBridge: async (request: Request): Promise<Response> => request.method === "GET" ? new Response(STANDALONE_BRIDGE_SOURCE, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Content-Disposition": "attachment; filename=hackathon-skills-bridge.mjs", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }) : Response.json({ error: { code: "METHOD_NOT_ALLOWED", message: "方法不支持。" }, requestId: deps.requestId() }, { status: 405 }),
    agents: handler("GET", "public", () => deps.service.agents()),
    list: handler("GET", "public", (_input, _actor, request) => deps.service.list(Object.fromEntries(new URL(request.url).searchParams))),
    detail: (id: string) => handler("GET", "public", () => deps.service.detail(id)),
    bundles: handler("GET", "public", () => deps.service.bundles()), bundle: (id: string) => handler("GET", "public", () => deps.service.bundle(id)),
    createPlan: handler("POST", "session", (input, actor) => deps.service.createPlan(actor, { agentId: input.agentId as AgentId, bundleId: input.bundleId as string | undefined, skillVersionIds: input.skillVersionIds as readonly string[] | undefined, scope: input.scope as "project", acknowledgeUnverifiedCompatibility: input.acknowledgeUnverifiedCompatibility === true })),
    plan: (id: string) => handler("GET", "session", (_input, actor) => deps.service.getPlan(actor, id)),
    manifest: (id: string) => handler("GET", "session", (_input, actor) => deps.service.manifest(actor, id)),
    confirm: (id: string) => handler("POST", "session", (input, actor) => deps.service.confirm(actor, id, { manifestHash: input.manifestHash as string, confirm: input.confirm === true })),
    installations: handler("GET", "session", (_input, actor) => deps.service.installations(actor)),
    authorizeBridge: handler("POST", "bridge", input => deps.service.authorizeBridge(bridgeInput(input))),
    bridgeReceipt: handler("POST", "bridge", input => deps.service.recordBridgeReceipt({ ...bridgeInput(input), receipt: input.receipt as InstallationReceipt })),
    withdraw: (id: string, versionId: string) => handler("POST", "session", (input, actor) => deps.service.withdraw(actor!, id, versionId, input.reason as string)),
  };
}
