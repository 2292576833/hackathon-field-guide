import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import { AGENT_IDS } from "../skills/index.ts";
import type { SkillPublicationTarget } from "../skills/publication-types.ts";
import { createOperationsHttpHandler, positiveRevision, requiredString } from "./http.ts";
import type { OperationsHttpDependencies } from "./http.ts";
import type { SkillReviewService } from "./skill-review-service.ts";
import type { SkillReviewExpectation, SkillReviewStatus, SkillReviewVerification } from "./skill-review-types.ts";

function exactKeys(input: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(input).some(key => !keys.includes(key))) throw new DomainError("INVALID_INPUT", "提交包含未支持的字段。");
}
function expectation(input: Record<string, unknown>): SkillReviewExpectation {
  return { expectedCandidateRevision: positiveRevision(input, "expectedCandidateRevision"), expectedContentHash: requiredString(input, "expectedContentHash", 64), expectedManifestHash: requiredString(input, "expectedManifestHash", 64) };
}
const expectedKeys = ["expectedCandidateRevision", "expectedContentHash", "expectedManifestHash"];
function verification(input: unknown): SkillReviewVerification {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new DomainError("INVALID_INPUT", "请填写许可、行为与兼容限制核验信息。");
  const record = input as Record<string, unknown>;
  exactKeys(record, ["licenseChecked", "behaviorChecked", "acknowledgedCompatibility"]);
  const list = record.acknowledgedCompatibility;
  if (record.licenseChecked !== true || record.behaviorChecked !== true || !Array.isArray(list) || list.length > AGENT_IDS.length || list.some(value => !AGENT_IDS.includes(value)) || new Set(list).size !== list.length) throw new DomainError("INVALID_INPUT", "请确认许可、行为及未验证工具限制。");
  return { licenseChecked: true, behaviorChecked: true, acknowledgedCompatibility: list };
}
/** Mutations inherit the mandatory site's session/CSRF hook and bounded JSON parser. */
export function createSkillReviewHandlers(dependencies: OperationsHttpDependencies & { readonly service: SkillReviewService }) {
  const handler = (method: "GET" | "POST", execute: (actor: Actor, input: Record<string, unknown>, requestId: string, request: Request) => Promise<unknown>, successStatus?: number) => createOperationsHttpHandler(dependencies, { method, execute, successStatus });
  return {
    list: handler("GET", (actor, _input, requestId, request) => {
      const params = new URL(request.url).searchParams;
      if ([...params.keys()].some(key => key !== "status" && key !== "limit") || params.getAll("status").length > 1 || params.getAll("limit").length > 1) throw new DomainError("INVALID_INPUT", "审核查询参数无效。");
      return dependencies.service.list(actor, (params.get("status") ?? undefined) as SkillReviewStatus | undefined, params.has("limit") ? Number(params.get("limit")) : 50, requestId);
    }),
    detail: (reviewId: string) => handler("GET", (actor, _input, requestId) => dependencies.service.getDetail(actor, reviewId, requestId)),
    register: (target: SkillPublicationTarget) => handler("POST", (actor, input, requestId) => { exactKeys(input, expectedKeys); return dependencies.service.register(actor, target, expectation(input), requestId); }, 201),
    decide: (reviewId: string) => handler("POST", (actor, input, requestId) => {
      exactKeys(input, [...expectedKeys, "expectedRevision", "decision", "reason", "verification"]);
      if (input.decision !== "approved" && input.decision !== "changes_requested" && input.decision !== "rejected") throw new DomainError("INVALID_INPUT", "审核决定无效。");
      if (input.decision !== "approved" && input.verification !== undefined) throw new DomainError("INVALID_INPUT", "只有通过审核才能记录发布核验信息。");
      return dependencies.service.decide(actor, reviewId, { ...expectation(input), expectedRevision: positiveRevision(input, "expectedRevision"), decision: input.decision,
        reason: requiredString(input, "reason"), verification: input.decision === "approved" ? verification(input.verification) : undefined }, requestId);
    }),
    publish: (reviewId: string) => handler("POST", (actor, input, requestId) => { exactKeys(input, [...expectedKeys, "expectedRevision"]); return dependencies.service.publish(actor, reviewId, { ...expectation(input), expectedRevision: positiveRevision(input, "expectedRevision") }, requestId); }),
    withdraw: (target: SkillPublicationTarget) => handler("POST", (actor, input, requestId) => { exactKeys(input, [...expectedKeys, "operationId", "reason"]); return dependencies.service.withdraw(actor, target, { ...expectation(input), operationId: requiredString(input, "operationId", 256), reason: requiredString(input, "reason") }, requestId); }),
  };
}
