import type { Actor } from "../../shared/contracts.ts";
import { DomainError, isDomainError, toErrorEnvelope } from "../../shared/errors.ts";
import type { SkillCandidateDocument, SkillCandidateEvidence, SkillPublicationTarget } from "./publication-types.ts";
import type { createSkillCandidateService } from "./publication.ts";

export function createSkillCandidateHandlers(deps: {
  service: ReturnType<typeof createSkillCandidateService>;
  resolveActor(request: Request): Promise<Actor | null>;
  assertMutationAllowed(request: Request, actor: Actor): Promise<void>;
  /** Root rechecks trusted session validity inside the database transaction. */
  requestId(): string;
}) {
  const handler = (method: "GET"|"POST", run: (actor: Actor, input: Record<string,unknown>)=>Promise<unknown>) => async (request: Request) => {
    const requestId = deps.requestId();
    try {
      if (request.method!==method) throw new DomainError("METHOD_NOT_ALLOWED", "方法不支持。",{status:405});
      const actor = await deps.resolveActor(request); if (!actor) throw new DomainError("UNAUTHENTICATED", "请先登录。",{status:401});
      if (!actor.platformRoles.some(role=>role==="admin" || role==="reviewer")) throw new DomainError("SKILL_REVIEW_FORBIDDEN", "需要技能运营审核权限。",{status:403});
      let input: Record<string,unknown> = {};
      if (method==="POST") {
        await deps.assertMutationAllowed(request,actor);
        if (request.headers.get("content-type")?.split(";",1)[0]!=="application/json") throw new DomainError("JSON_REQUIRED", "请提交 JSON。",{status:415});
        let size = 0; const chunks: Uint8Array[]=[];
        if (!request.body) throw new DomainError("INVALID_JSON", "候选不能为空。");
        for await (const chunk of request.body as unknown as AsyncIterable<Uint8Array>) { size+=chunk.byteLength; if (size>512*1024) throw new DomainError("BODY_TOO_LARGE", "候选内容超过限制。",{status:413}); chunks.push(chunk); }
        try { const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!body || typeof body!=="object" || Array.isArray(body)) throw new Error(); input=body as Record<string,unknown>; } catch { throw new DomainError("INVALID_JSON", "JSON 格式无效。"); }
        if (Object.keys(input).some(key=>!["expectedRevision","document","evidence"].includes(key))) throw new DomainError("INVALID_INPUT", "候选包含未支持字段。");
      }
      const result=await run(actor,input);
      const current=await deps.resolveActor(request); if (!current || current.userId!==actor.userId || !current.platformRoles.some(role=>role==="admin" || role==="reviewer")) throw new DomainError("UNAUTHENTICATED", "会话已变化，请重新登录。",{status:401});
      return Response.json({data:result,requestId},{headers:{"Cache-Control":"no-store"}});
    } catch(error) { return Response.json(toErrorEnvelope(error,requestId),{status:isDomainError(error)?error.status:500,headers:{"Cache-Control":"no-store"}}); }
  };
  return {
    list:handler("GET",actor=>deps.service.list(actor)),
    detail:(target:SkillPublicationTarget)=>handler("GET",actor=>deps.service.get(actor,target)),
    save:handler("POST",(actor,input)=>deps.service.save(actor,{expectedRevision:input.expectedRevision as number,document:input.document as SkillCandidateDocument,evidence:input.evidence as SkillCandidateEvidence})),
  };
}
