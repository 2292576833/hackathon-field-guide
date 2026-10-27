import type { IdGenerator } from "../../shared/contracts.ts";
import type { OrganizerPrincipal } from "../../shared/organizer-contracts.ts";
import { DomainError, isDomainError, toErrorEnvelope } from "../../shared/errors.ts";
import type { EventJudgingService } from "./service.ts";
import type { JudgingConfig, SubmissionMaterials, SubmissionInput, PublishInput, ScoreInput, AppealInput, AppealResolutionInput, WorkDisclosureInput, WorkDisclosureWithdrawInput, WorkCommentInput, WorkCommentHideInput, WorkCommentReportInput } from "./model.ts";

export interface EventJudgingHttpDependencies {
  service: EventJudgingService;
  /** Root resolves a real account/session and its transaction-aware guard. */
  resolvePrincipal(request: Request): Promise<OrganizerPrincipal | null>;
  authorizeMutation(request: Request, principal: OrganizerPrincipal): Promise<void>;
  requestIds: IdGenerator;
}
export interface EventJudgingRouteParams { eventId: string; roundId?: string; assignmentId?: string; appealId?: string; teamId?: string; snapshotId?: string; commentId?: string }
export function createEventJudgingHandlers(deps: EventJudgingHttpDependencies) {
  const handler = (method: string, work: (principal: OrganizerPrincipal, request: Request, params: EventJudgingRouteParams) => Promise<unknown>) => async (request: Request, params: EventJudgingRouteParams): Promise<Response> => {
    const requestId = deps.requestIds.next(); const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
    try {
      if (request.method !== method) throw new DomainError("METHOD_NOT_ALLOWED", "该入口不支持此请求方法。", { status: 405 });
      routeId(params?.eventId, "赛事");
      const principal = await deps.resolvePrincipal(request);
      if (!principal) throw new DomainError("UNAUTHENTICATED", "请先登录，继续当前比赛的操作。", { status: 401 });
      if (method !== "GET") await deps.authorizeMutation(request, principal);
      return Response.json({ data: await work(principal, request, params), requestId }, { headers });
    } catch (error) { return Response.json(toErrorEnvelope(error, requestId), { status: isDomainError(error) ? error.status : 500, headers }); }
  };
  return {
    previewSubmission: handler("POST", async (p, r, a) => deps.service.previewSubmission(p, a.eventId, await body(r) as unknown as { teamId: string; materials: SubmissionMaterials })),
    submit: handler("POST", async (p, r, a) => {
      const input = await body(r); const headerKey = r.headers.get("idempotency-key");
      if (headerKey && input.idempotencyKey && headerKey !== input.idempotencyKey) throw new DomainError("IDEMPOTENCY_KEY_MISMATCH", "请求重试标识不一致，请重新预览。", { status: 400 });
      return deps.service.submit(p, a.eventId, { ...input, idempotencyKey: headerKey ?? input.idempotencyKey } as unknown as SubmissionInput);
    }),
    mySubmissions: handler("GET", (p, r, a) => deps.service.mySubmissions(p, a.eventId, routeId(new URL(r.url).searchParams.get("teamId"), "队伍"))),
    workspace: handler("GET", (p, _r, a) => deps.service.workspace(p, a.eventId)),
    saveConfig: handler("PUT", async (p, r, a) => deps.service.saveConfig(p, a.eventId, await body(r) as unknown as { roundId?: string; expectedRevision: number; config: JudgingConfig })),
    startRound: handler("POST", async (p, r, a) => deps.service.startRound(p, a.eventId, routeId(a.roundId, "评审轮"), (await body(r)).expectedRevision as number)),
    lockRound: handler("POST", async (p, r, a) => deps.service.lockRound(p, a.eventId, routeId(a.roundId, "评审轮"), (await body(r)).expectedRevision as number)),
    reopenRound: handler("POST", async (p, r, a) => deps.service.reopenRound(p, a.eventId, routeId(a.roundId, "评审轮"), await body(r) as unknown as { expectedRevision: number; reason: string })),
    assignJudge: handler("POST", async (p, r, a) => deps.service.assignJudge(p, a.eventId, await body(r) as unknown as { roundId: string; snapshotId: string; judgeUserId: string; expectedRoundRevision: number })),
    reviewAssignment: handler("POST", async (p, r, a) => deps.service.reviewAssignment(p, a.eventId, routeId(a.assignmentId, "指派"), await body(r) as unknown as { expectedRevision: number; reason: string })),
    revokeAssignment: handler("POST", async (p, r, a) => deps.service.revokeAssignment(p, a.eventId, routeId(a.assignmentId, "指派"), await body(r) as unknown as { expectedRevision: number; reason: string })),
    judgeAssignments: handler("GET", (p, _r, a) => deps.service.judgeAssignments(p, a.eventId)),
    judgeMaterials: handler("GET", (p, _r, a) => deps.service.judgeMaterials(p, a.eventId, routeId(a.assignmentId, "指派"))),
    declareConflict: handler("POST", async (p, r, a) => deps.service.declareConflict(p, a.eventId, routeId(a.assignmentId, "指派"), await body(r) as unknown as { expectedRevision: number; hasConflict: boolean; reason: string })),
    saveScore: handler("POST", async (p, r, a) => deps.service.saveScore(p, a.eventId, routeId(a.assignmentId, "指派"), await body(r) as unknown as ScoreInput)),
    submitScore: handler("POST", async (p, r, a) => deps.service.submitScore(p, a.eventId, routeId(a.assignmentId, "指派"), await body(r) as unknown as ScoreInput)),
    previewResults: handler("POST", async (p, r, a) => deps.service.previewResults(p, a.eventId, routeId((await body(r)).roundId, "评审轮"))),
    /** Organizer-only derived view: raw scores and ranks are never replaced by calibration. */
    calibration: handler("GET", (p, _r, a) => deps.service.calibration(p, a.eventId, routeId(a.roundId, "评审轮"))),
    /** Organizer-only read-only boundary self-check; it never changes scores, assignments or publications. */
    integrity: handler("GET", (p, _r, a) => deps.service.integrity(p, a.eventId, routeId(a.roundId, "评审轮"))),
    /** Organizer-only derived view of who has not submitted yet; it never notifies or changes anything. */
    progress: handler("GET", (p, _r, a) => deps.service.progress(p, a.eventId, routeId(a.roundId, "评审轮"))),
    publishResults: handler("POST", async (p, r, a) => { const input = await body(r); return deps.service.publishResults(p, a.eventId, routeId(input.roundId, "评审轮"), input as unknown as PublishInput); }),
    withdrawResults: handler("POST", async (p, r, a) => { const input = await body(r); return deps.service.withdrawResults(p, a.eventId, routeId(input.roundId, "评审轮"), input as unknown as { expectedRevision: number; reason: string }); }),
    myResults: handler("GET", (p, _r, a) => deps.service.myResults(p, a.eventId)),
    /** 公开公平规则包与需人工确认的扣分建议：只读派生，不自动扣分。 */
    fairness: handler("GET", (p, _r, a) => deps.service.fairness(p, a.eventId, routeId(a.roundId, "评审轮"))),
    /** 赛前自检与赛后只读复用清单：只看本人队伍自己的事实。 */
    myChecklists: handler("GET", (p, r, a) => deps.service.myChecklists(p, a.eventId, routeId(new URL(r.url).searchParams.get("teamId"), "队伍"))),
    /** 参赛者对已公布结果的申诉：只写申诉事实，不改变分数、名次或公布。 */
    fileAppeal: handler("POST", async (p, r, a) => {
      const input = await body(r); const headerKey = r.headers.get("idempotency-key");
      if (headerKey && input.idempotencyKey && headerKey !== input.idempotencyKey) throw new DomainError("IDEMPOTENCY_KEY_MISMATCH", "请求重试标识不一致，请重新填写。", { status: 400 });
      return deps.service.fileAppeal(p, a.eventId, { ...input, idempotencyKey: headerKey ?? input.idempotencyKey } as unknown as AppealInput);
    }),
    ownAppeals: handler("GET", (p, _r, a) => deps.service.ownAppeals(p, a.eventId)),
    withdrawAppeal: handler("POST", async (p, r, a) => deps.service.withdrawAppeal(p, a.eventId, routeId(a.appealId, "申诉"), await body(r) as unknown as { expectedRevision: number; reason: string })),
    eventAppeals: handler("GET", (p, _r, a) => deps.service.eventAppeals(p, a.eventId)),
    /** 相似/重复材料的人工复核线索：只读派生，不给分数也不下判定。 */
    duplicates: handler("GET", (p, _r, a) => deps.service.duplicates(p, a.eventId)),
    resolveAppeal: handler("POST", async (p, r, a) => {
      const input = await body(r); return deps.service.resolveAppeal(p, a.eventId, routeId(a.appealId, "申诉"), input as unknown as AppealResolutionInput);
    }),
    /**
     * 规划 34 C①：作品展示（队伍可选公开）。
     * 赛事开关 `community.workShowcase` 为假时四条入口一律 403，**不返回空数组**充当"没有作品"。
     */
    works: handler("GET", (p, _r, a) => deps.service.works(p, a.eventId)),
    /** 队伍侧：本队当前公开范围与历史（只读）。 */
    myWorkDisclosure: handler("GET", (p, _r, a) => deps.service.myWorkDisclosure(p, a.eventId, routeId(a.teamId, "队伍"))),
    /** 队伍侧：提交/重新提交公开范围；仅当前队伍成员且在该队最新正式收件成员快照内的人可提交。 */
    submitWorkDisclosure: handler("POST", async (p, r, a) => {
      const input = await body(r); const headerKey = r.headers.get("idempotency-key");
      if (headerKey && input.idempotencyKey && headerKey !== input.idempotencyKey) throw new DomainError("IDEMPOTENCY_KEY_MISMATCH", "请求重试标识不一致，请重新核对选择。", { status: 400 });
      return deps.service.submitWorkDisclosure(p, a.eventId, routeId(a.teamId, "队伍"), { ...input, idempotencyKey: headerKey ?? input.idempotencyKey } as unknown as WorkDisclosureInput);
    }),
    /** 队伍侧：撤回公开范围（可选第四条路由；撤回后可重新提交）。 */
    withdrawWorkDisclosure: handler("POST", async (p, r, a) => deps.service.withdrawWorkDisclosure(p, a.eventId, routeId(a.teamId, "队伍"), await body(r) as unknown as WorkDisclosureWithdrawInput)),
    /** 主办方侧：已选择公开的作品 + 未公开队伍数量（不含身份）。只读派生，不改分数/名次/公布。 */
    eventWorkShowcase: handler("GET", (p, _r, a) => deps.service.eventWorkShowcase(p, a.eventId)),
    /**
     * 规划 34 C②：作品文字留言（与数值互评分列，绝不并入结果）。
     * 三层门禁（community.workShowcase + community.peerFeedback + 队伍本人选择公开）任一不满足 → 403；
     * 未登录由本 handler 统一 401（公开档的留言同样要求已登录）。与作品展示共用同一个 service 实现。
     */
    workComments: handler("GET", (p, _r, a) => deps.service.workComments(p, a.eventId, routeId(a.snapshotId, "作品"))),
    createWorkComment: handler("POST", async (p, r, a) => {
      const input = await body(r); const headerKey = r.headers.get("idempotency-key");
      if (headerKey && input.idempotencyKey && headerKey !== input.idempotencyKey) throw new DomainError("IDEMPOTENCY_KEY_MISMATCH", "请求重试标识不一致，请重新填写留言。", { status: 400 });
      return deps.service.createWorkComment(p, a.eventId, routeId(a.snapshotId, "作品"), { ...input, idempotencyKey: headerKey ?? input.idempotencyKey } as unknown as WorkCommentInput);
    }),
    /** 留言作者本人或本场 judging_manage 工作人员可隐藏；已隐藏的重复请求幂等返回原记录。 */
    hideWorkComment: handler("POST", async (p, r, a) => deps.service.hideWorkComment(p, a.eventId, routeId(a.snapshotId, "作品"), routeId(a.commentId, "留言"), await body(r) as unknown as WorkCommentHideInput)),
    /** 任一可见者都可举报；只记录举报事实，不做裁决，不改变留言状态。 */
    reportWorkComment: handler("POST", async (p, r, a) => deps.service.reportWorkComment(p, a.eventId, routeId(a.snapshotId, "作品"), routeId(a.commentId, "留言"), await body(r) as unknown as WorkCommentReportInput)),
    exportScores: handler("GET", (p, _r, a) => deps.service.exportScores(p, a.eventId)),
    /** 已公布结果的留档导出：与 exportScores 口径不同，只含公开投影字段，不含评委身份。 */
    exportResults: handler("GET", (p, _r, a) => deps.service.exportResults(p, a.eventId, routeId(a.roundId, "评审轮"))),
    auditHistory: handler("GET", (p, _r, a) => deps.service.auditHistory(p, a.eventId)),
    /** 作品展示的访客入口（与 publicResults 同形）：只看队伍选择`公开（含访客）`的作品；开关未开启同样 403。 */
    publicWorks: async (request: Request, params: EventJudgingRouteParams): Promise<Response> => {
      const requestId = deps.requestIds.next(), headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
      try {
        if (request.method !== "GET") throw new DomainError("METHOD_NOT_ALLOWED", "该入口仅供读取已公开的作品。", { status: 405 });
        return Response.json({ data: await deps.service.publicWorks(routeId(params?.eventId, "赛事")), requestId }, { headers });
      } catch (error) { return Response.json(toErrorEnvelope(error, requestId), { status: isDomainError(error) ? error.status : 500, headers }); }
    },
    /** Public projection only; conservatively no-store, even when participant views use a nearby URL. */
    publicResults: async (request: Request, params: EventJudgingRouteParams): Promise<Response> => {
      const requestId = deps.requestIds.next(), headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
      try {
        if (request.method !== "GET") throw new DomainError("METHOD_NOT_ALLOWED", "该入口仅供读取已公布结果。", { status: 405 });
        return Response.json({ data: await deps.service.publicResults(routeId(params?.eventId, "赛事")), requestId }, { headers });
      } catch (error) { return Response.json(toErrorEnvelope(error, requestId), { status: isDomainError(error) ? error.status : 500, headers }); }
    },
  };
}
function routeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 160) throw new DomainError("INVALID_ROUTE", `缺少有效的${label}地址。`, { status: 400 });
  return value;
}
async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" || (request.headers.get("content-encoding") && request.headers.get("content-encoding")?.toLowerCase() !== "identity")) throw new DomainError("JSON_REQUIRED", "请提交未压缩的JSON内容。", { status: 415 });
  const max = 65536, length = request.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > max) throw new DomainError("PAYLOAD_TOO_LARGE", "输入超过64KB，请缩短后继续。", { status: 413 });
  const reader = request.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
  if (reader) try {
    while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength;
      if (size > max) { void reader.cancel().catch(() => {}); throw new DomainError("PAYLOAD_TOO_LARGE", "输入超过64KB，请缩短后继续。", { status: 413 }); } chunks.push(chunk.value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value: unknown; try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new DomainError("INVALID_JSON", "请提交有效JSON内容。", { status: 400 }); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DomainError("JUDGING_INVALID_INPUT", "输入内容格式不正确。");
  return value as Record<string, unknown>;
}
