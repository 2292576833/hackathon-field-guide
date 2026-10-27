import type { Actor, IdGenerator } from "../../shared/contracts.ts";
import { DomainError, toErrorEnvelope } from "../../shared/errors.ts";
import type { AssessmentService } from "./service.ts";
import { invalid, keys, object, optionalId, revision, string } from "./validation.ts";

export interface AssessmentHttpOptions {
  readonly service: AssessmentService;
  /** Must resolve a verified session, never request JSON, cookies without validation, or model output. */
  readonly resolveActor: (request: Request) => Promise<Actor | null>;
  readonly requestIds: IdGenerator;
}
export interface ProjectParams { readonly projectId: string }
export interface AttemptParams { readonly attemptId: string }
export interface AssignmentParams { readonly assignmentId: string }
export interface JobParams { readonly jobId: string }
const MAX_BODY_BYTES = 262144;
async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new DomainError("UNSUPPORTED_MEDIA_TYPE", "请使用 JSON 请求。", { status: 415 });
  const reader = request.body?.getReader();
  if (!reader) invalid("请求内容不能为空。");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new DomainError("PAYLOAD_TOO_LARGE", "请求内容过大，请减少单次证据内容。", { status: 413 }); }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), "请求内容"); }
  catch (error) { if (error instanceof DomainError) throw error; return invalid("请求 JSON 格式不正确。"); }
}
export function createAssessmentHttpHandlers(options: AssessmentHttpOptions) {
  const respond = async (request: Request, action: (actor: Actor) => Promise<unknown>, status = 200): Promise<Response> => {
    const requestId = options.requestIds.next();
    try {
      const actor = await options.resolveActor(request);
      if (!actor) throw new DomainError("UNAUTHENTICATED", "请先登录。", { status: 401 });
      // The web composition must use secure SameSite cookies and an Origin/CSRF policy for these mutations.
      const data = await action(actor);
      return Response.json({ data, requestId }, { status, headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return Response.json(toErrorEnvelope(error, requestId), { status: error instanceof DomainError ? error.status : 500, headers: { "Cache-Control": "no-store" } });
    }
  };
  const idempotencyKey = (request: Request) => string(request.headers.get("Idempotency-Key"), "Idempotency-Key 请求头", 200);
  return {
    listAttempts: (request: Request, { projectId }: ProjectParams) => respond(request, (actor) => options.service.listOwnAttempts(actor, projectId)),
    createAttempt: (request: Request, { projectId }: ProjectParams) => respond(request, async (actor) => {
      const data = await body(request); keys(data, ["questionSetId"], "请求内容");
      return options.service.createAttempt(actor, projectId, string(data.questionSetId, "题组 ID", 200));
    }, 201),
    privateReport: (request: Request, { attemptId }: AttemptParams) => respond(request, (actor) => options.service.getPrivateReport(actor, attemptId)),
    saveDraft: (request: Request, { attemptId }: AttemptParams) => respond(request, async (actor) => {
      const data = await body(request); keys(data, ["expectedRevision", "profile", "answers", "followUpAnswers"], "请求内容");
      const { expectedRevision, ...input } = data;
      return options.service.saveDraft(actor, attemptId, revision(expectedRevision), input);
    }),
    addFollowUp: (request: Request, { attemptId }: AttemptParams) => respond(request, async (actor) => {
      const data = await body(request); keys(data, ["expectedRevision", "questionId", "criterionId"], "请求内容");
      return options.service.addFollowUp(actor, attemptId, revision(data.expectedRevision), string(data.questionId, "题目 ID", 200), string(data.criterionId, "评分项 ID", 200));
    }),
    cancelAttempt: (request: Request, { attemptId }: AttemptParams) => respond(request, async (actor) => {
      const data = await body(request); keys(data, ["expectedRevision"], "请求内容");
      return options.service.cancelAttempt(actor, attemptId, revision(data.expectedRevision));
    }),
    submitAttempt: (request: Request, { attemptId }: AttemptParams) => respond(request, async (actor) => {
      const data = await body(request); keys(data, ["expectedRevision"], "请求内容");
      return options.service.submitAttempt(actor, attemptId, revision(data.expectedRevision), idempotencyKey(request));
    }, 202),
    reassess: (request: Request, { attemptId }: AttemptParams) => respond(request, async (actor) => {
      const data = await body(request); keys(data, ["expectedRevision", "correctionReason"], "请求内容");
      return options.service.requestReassessment(actor, attemptId, revision(data.expectedRevision), idempotencyKey(request), string(data.correctionReason, "重新评估理由", 3000));
    }, 202),
    job: (request: Request, { jobId }: JobParams) => respond(request, (actor) => options.service.getJob(actor, jobId)),
    sharing: (request: Request, { attemptId }: AttemptParams) => respond(request, async (actor) => {
      const data = await body(request); keys(data, ["expectedRevision", "selection"], "请求内容");
      return options.service.setSharing(actor, attemptId, revision(data.expectedRevision), data.selection);
    }),
    summaries: (request: Request, { projectId }: ProjectParams) => respond(request, (actor) => options.service.getTeamSummaries(actor, projectId)),
    createAssignment: (request: Request, { projectId }: ProjectParams) => respond(request, async (actor) => {
      const data = await body(request); keys(data, ["baseVersionId", "draft"], "请求内容");
      return options.service.createAssignment(actor, projectId, optionalId(data.baseVersionId, "生效分工基线"), data.draft);
    }, 201),
    assignment: (request: Request, { assignmentId }: AssignmentParams) => respond(request, (actor) => options.service.getAssignment(actor, assignmentId)),
    appliedAssignment: (request: Request, { projectId }: ProjectParams) => respond(request, (actor) => options.service.getAppliedAssignment(actor, projectId)),
    editAssignment: (request: Request, { assignmentId }: AssignmentParams) => respond(request, async (actor) => {
      const data = await body(request); keys(data, ["expectedRevision", "draft"], "请求内容");
      return options.service.editAssignment(actor, assignmentId, revision(data.expectedRevision), data.draft);
    }),
    validateAssignment: (request: Request, { assignmentId }: AssignmentParams) => respond(request, async (actor) => {
      const data = await body(request); keys(data, ["expectedRevision"], "请求内容");
      return options.service.validateAssignment(actor, assignmentId, revision(data.expectedRevision));
    }),
    applyAssignment: (request: Request, { assignmentId }: AssignmentParams) => respond(request, async (actor) => {
      const data = await body(request); keys(data, ["expectedRevision"], "请求内容");
      return options.service.applyAssignment(actor, assignmentId, revision(data.expectedRevision));
    }),
  };
}
