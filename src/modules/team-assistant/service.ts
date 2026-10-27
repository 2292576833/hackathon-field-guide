import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { Actor, Clock, IdGenerator } from "../../shared/contracts.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { FreshSessionGuard } from "../../shared/personal-ai.ts";
import { DomainError, isDomainError } from "../../shared/errors.ts";
import type { AssistantContextCoverage, AssistantConversation, AssistantMessage, AssistantMessageInput, AssistantReply, FeasibilityReportInput, FeasibilityReportRecord, SavedFeasibilityData, TeamAssistantContextSnapshot, TeamAssistantMemorySnapshot } from "./model.ts";
import type { TeamAssistantPorts } from "./ports.ts";
import { ASSISTANT_PROMPT_VERSION, ASSISTANT_SYSTEM_PROMPT, FEASIBILITY_OUTPUT_EXAMPLE, FEASIBILITY_PROMPT_VERSION, FEASIBILITY_SYSTEM_PROMPT, safeAssistantHref, validateAssistantAnswer, validateFeasibilityReport } from "./generation.ts";
import { clearMessages, ensureConversation, finishRequest, insertMessage, insertRequest, readLastRequest, readMessage, readMessages, readRequest, readUncertainRequestByHash, updateSession } from "./postgres.ts";

export interface TeamAssistantDependencies extends TeamAssistantPorts {
  database: DatabasePort; clock: Clock; ids: IdGenerator;
  /** Must exceed the root runner's provider timeout/lease. */
  requestLeaseMs?: number;
}
export function createTeamAssistantService(deps: TeamAssistantDependencies) {
  async function context(sql: SqlExecutor, actor: Actor, projectId: string, guard?: FreshSessionGuard) {
    assertScope(actor, projectId); await guard?.(sql);
    const snapshot = await deps.context.read(actor, projectId, sql);
    if (snapshot.projectId !== projectId || !snapshot.fingerprint || Buffer.byteLength(JSON.stringify(snapshot)) > 64000)
      throw new DomainError("ASSISTANT_CONTEXT_INVALID", "当前空间资料暂时无法安全读取，请刷新后继续。", { status: 503 });
    return { ...snapshot, links: snapshot.links.filter(link => safeAssistantHref(link.href, projectId)) };
  }
  async function activeSession(sql: SqlExecutor, actor: Actor, projectId: string) {
    let session = await ensureConversation(sql, actor.userId, projectId, deps.clock.now().toISOString());
    if (session.activeRequestId) {
      const request = await readRequest(sql, actor.userId, projectId, session.activeRequestId);
      if (!request || request.status !== "running" || Date.parse(request.expiresAt) <= deps.clock.now().getTime()) {
        if (request?.status === "running") await finishRequest(sql, actor.userId, projectId, request.requestId, "unknown", null, "ASSISTANT_LEASE_EXPIRED");
        session = await updateSession(sql, actor.userId, projectId, session.revision, null, deps.clock.now().toISOString()) ?? conflict(session.revision);
      }
    }
    return session;
  }
  async function recheck(sql: SqlExecutor, actor: Actor, snapshot: TeamAssistantContextSnapshot, memory: TeamAssistantMemorySnapshot | null, guard?: FreshSessionGuard) {
    await guard?.(sql);
    await deps.context.assertCurrent(actor, snapshot, sql);
    if (memory) await deps.memory.assertCurrent(actor, memory, sql);
  }
  return {
    async getContext(actor: Actor, projectId: string, guard?: FreshSessionGuard): Promise<TeamAssistantContextSnapshot> {
      return deps.database.transaction(sql => context(sql, actor, projectId, guard));
    },
    async conversation(actor: Actor, projectId: string, guard?: FreshSessionGuard): Promise<AssistantConversation> {
      return deps.database.transaction(async sql => {
        await context(sql, actor, projectId, guard);
        const session = await activeSession(sql, actor, projectId), latest = await readLastRequest(sql, actor.userId, projectId);
        return { projectId, revision: session.revision, messages: await readMessages(sql, actor.userId, projectId),
          pending: latest ? { requestId: latest.requestId, message: latest.message, status: latest.status, errorCode: latest.errorCode, createdAt: latest.createdAt } : null,
          configured: deps.runner.configured, provider: "dsh" };
      });
    },
    async clearConversation(actor: Actor, projectId: string, expectedRevision: number, guard?: FreshSessionGuard): Promise<{ cleared: true; revision: number }> {
      assertRevision(expectedRevision);
      return deps.database.transaction(async sql => {
        const snapshot = await context(sql, actor, projectId, guard); await recheck(sql, actor, snapshot, null, guard);
        const session = await activeSession(sql, actor, projectId);
        if (session.revision !== expectedRevision) conflict(session.revision);
        if (session.activeRequestId) busy();
        await clearMessages(sql, actor.userId, projectId);
        const next = await updateSession(sql, actor.userId, projectId, session.revision, null, deps.clock.now().toISOString()) ?? conflict(session.revision);
        return { cleared: true, revision: next.revision };
      });
    },
    async send(actor: Actor, projectId: string, input: AssistantMessageInput, guard?: FreshSessionGuard): Promise<AssistantReply> {
      const message = inputText(input?.message, 6000), requestId = identifier(input?.requestId); assertRevision(input?.expectedRevision);
      const prepared = await deps.database.transaction(async sql => {
        const snapshot = await context(sql, actor, projectId, guard), session = await activeSession(sql, actor, projectId);
        const previous = await readRequest(sql, actor.userId, projectId, requestId);
        if (previous) {
          if (previous.message !== message) throw new DomainError("ASSISTANT_REQUEST_ID_REUSED", "同一次请求的内容发生变化，请重新明确发起。", { status: 409 });
          if (previous.status === "succeeded" && previous.responseId) {
            const saved = await readMessage(sql, actor.userId, projectId, previous.responseId);
            if (saved) return { replay: { message: saved, revision: session.revision, requestId, provider: "dsh" as const } };
            throw new DomainError("ASSISTANT_CONVERSATION_CLEARED", "这次回复的对话已被本人清空，不会重新发送模型。", { status: 409 });
          }
          requestBlocked(previous.status);
        }
        if (!deps.runner.configured) throw new DomainError("DSH_NOT_CONFIGURED", "空间助手尚未连接 DSH，可以先查看当前任务和资料。", { status: 503 });
        if (session.revision !== input.expectedRevision) conflict(session.revision);
        if (session.activeRequestId) busy();
        const originalMemory = await deps.memory.select(actor, { projectId, question: message, maxItems: 20, maxBytes: 16000 }, sql);
        const memory = boundedMemory(originalMemory);
        await recheck(sql, actor, snapshot, originalMemory, guard);
        const history = boundedHistory(await readMessages(sql, actor.userId, projectId, 100), snapshot.fingerprint, originalMemory.fingerprint);
        // Clearing history, changing facts or using another requestId cannot authorize an uncertain replay.
        const requestIdentity = { projectId, message };
        const hash = stableHash(requestIdentity);
        const uncertain = await readUncertainRequestByHash(sql, actor.userId, projectId, hash);
        if (uncertain) requestBlocked(uncertain.status);
        const now = deps.clock.now(), expiresAt = new Date(now.getTime() + Math.max(deps.requestLeaseMs ?? 300000, 180000)).toISOString();
        await insertRequest(sql, { userId: actor.userId, projectId, requestId, requestHash: hash, message, status: "running", responseId: null, errorCode: null, createdAt: now.toISOString(), expiresAt });
        const claimed = await updateSession(sql, actor.userId, projectId, session.revision, requestId, now.toISOString()) ?? conflict(session.revision);
        return { snapshot, memory, originalMemory, history, requestIdentity, claimed };
      });
      if ("replay" in prepared) return prepared.replay!;
      const { snapshot, memory, originalMemory, history, requestIdentity, claimed } = prepared;
      const finalGuard: FreshSessionGuard = async sql => {
        await recheck(sql, actor, snapshot, originalMemory, guard);
        const session = await ensureConversation(sql, actor.userId, projectId, deps.clock.now().toISOString());
        const request = await readRequest(sql, actor.userId, projectId, requestId);
        if (session.activeRequestId !== requestId || session.revision !== claimed.revision || request?.status !== "running" || Date.parse(request.expiresAt) <= deps.clock.now().getTime())
          throw new DomainError("ASSISTANT_REQUEST_CHANGED", "这次请求状态已变化，旧回复没有保存为当前答案。", { status: 409 });
      };
      let responseReceived = false;
      try {
        const result = await deps.runner.run(actor, {
          projectId, requestIdentity, systemPrompt: ASSISTANT_SYSTEM_PROMPT,
          input: { question: message, context: snapshot.facts, memory: memory.items, history, sources: [...snapshot.sources, ...memory.sources], missing: [...snapshot.missing, ...memory.missing], memoryCoverage: memory.coverage, allowedLinks: snapshot.links },
          promptVersion: ASSISTANT_PROMPT_VERSION, outputExample: { reply: "先查看本人可做任务，准备成果和检查方式。", linkIds: [] }, maxOutputTokens: 1500,
          validate: value => validateAssistantAnswer(value, snapshot.links), finalGuard,
        }, guard);
        responseReceived = true;
        if (result.provider !== "dsh" || !result.executionId) throw new DomainError("ASSISTANT_PROVIDER_INVALID", "空间助手没有得到可用的 DSH 回答。", { status: 503 });
        const answer = validateAssistantAnswer(result.data, snapshot.links), now = deps.clock.now().toISOString();
        const coverage: AssistantContextCoverage = { contextFingerprint: snapshot.fingerprint, memoryFingerprint: originalMemory.fingerprint, memory: memory.coverage,
          sources: [...snapshot.sources, ...memory.sources], missing: [...snapshot.missing, ...memory.missing], capturedAt: snapshot.capturedAt };
        const saved: AssistantMessage = { id: result.executionId, role: "assistant", content: answer.reply, createdAt: now, provider: "dsh", links: snapshot.links.filter(link => answer.linkIds.includes(link.id)), coverage };
        return await deps.database.transaction(async sql => {
          await finalGuard(sql);
          const finished = await finishRequest(sql, actor.userId, projectId, requestId, "succeeded", saved.id, null);
          if (!finished) throw new DomainError("ASSISTANT_REQUEST_CHANGED", "请求状态已变化，未保存旧回复。", { status: 409 });
          await insertMessage(sql, actor.userId, projectId, requestId, { id: deps.ids.next(), role: "user", content: message, createdAt: now, provider: null, links: [], coverage: null });
          await insertMessage(sql, actor.userId, projectId, requestId, saved);
          const next = await updateSession(sql, actor.userId, projectId, claimed.revision, null, now) ?? conflict(claimed.revision);
          return { message: saved, revision: next.revision, requestId, provider: "dsh" };
        });
      } catch (error) {
        // A timeout, crash or unclassified failure is not evidence that the paid request was never sent.
        const externalState = error && typeof error === "object" && "externalState" in error ? error.externalState : undefined;
        const safeCode = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code) ? error.code : "ASSISTANT_RESULT_UNKNOWN";
        const preflightOrValidated = ["DSH_NOT_CONFIGURED", "DSH_SESSION_BUSY", "NAVIGATOR_RATE_LIMITED", "INVALID_ARTIFACT_KIND", "INVALID_ARTIFACT_INPUT", "AI_RESPONSE_INVALID", "ASSISTANT_CONTEXT_CHANGED", "ASSISTANT_MEMORY_CHANGED", "TEAM_ASSISTANT_CONTEXT_CHANGED", "TEAM_ASSISTANT_CONTEXT_INPUT_INVALID", "UNAUTHENTICATED", "PROJECT_ACCESS_DENIED", "PROJECT_UNAVAILABLE", "PROJECT_ARCHIVED"].includes(safeCode);
        const known = externalState !== "unknown" && (responseReceived || externalState === "not_sent" || externalState === "rejected" || externalState === "response_received" || isDomainError(error) && preflightOrValidated);
        const code = safeCode;
        await deps.database.transaction(async sql => {
          const session = await ensureConversation(sql, actor.userId, projectId, deps.clock.now().toISOString());
          await finishRequest(sql, actor.userId, projectId, requestId, known ? "failed" : "unknown", null, /^[A-Z][A-Z0-9_]{0,127}$/.test(code) ? code : "ASSISTANT_FAILED");
          if (session.activeRequestId === requestId) await updateSession(sql, actor.userId, projectId, session.revision, null, deps.clock.now().toISOString());
        });
        throw error;
      }
    },
    async generateFeasibility(actor: Actor, projectId: string, input: FeasibilityReportInput, guard?: FreshSessionGuard): Promise<FeasibilityReportRecord> {
      const idea = inputText(input?.idea, 12000), fingerprint = inputText(input?.expectedContextFingerprint, 500);
      const snapshot = await deps.database.transaction(async sql => {
        const s = await context(sql, actor, projectId, guard); await recheck(sql, actor, s, null, guard);
        if (s.fingerprint !== fingerprint) throw new DomainError("ASSISTANT_CONTEXT_CHANGED", "主题、规则、任务或共享建议已变化，请先刷新选题检查依据。", { status: 409 });
        return s;
      });
      const sourceIds = snapshot.sources.map(source => source.id);
      const finalGuard: FreshSessionGuard = sql => recheck(sql, actor, snapshot, null, guard);
      const artifact = await deps.personalAi.generate<SavedFeasibilityData>(actor, {
        kind: "project_feasibility", title: "本场选题检查", input: { idea, context: snapshot.facts, sources: snapshot.sources, missing: snapshot.missing },
        requestIdentity: { projectId, idea, contextFingerprint: snapshot.fingerprint }, systemPrompt: FEASIBILITY_SYSTEM_PROMPT,
        promptVersion: FEASIBILITY_PROMPT_VERSION, outputExample: FEASIBILITY_OUTPUT_EXAMPLE, maxOutputTokens: 4096,
        validate: value => ({ projectId, idea, contextFingerprint: snapshot.fingerprint, sources: snapshot.sources, missing: snapshot.missing, report: validateFeasibilityReport(value, sourceIds) }),
      }, finalGuard);
      // The PersonalAiPort persists the private report in its final guarded transaction.
      await deps.database.transaction(sql => finalGuard(sql));
      return reportRecord(artifact, snapshot.fingerprint, projectId);
    },
    async listFeasibility(actor: Actor, projectId: string, guard?: FreshSessionGuard): Promise<FeasibilityReportRecord[]> {
      await deps.database.transaction(sql => context(sql, actor, projectId, guard));
      const artifacts = await deps.personalAi.list(actor, "project_feasibility", guard);
      return deps.database.transaction(async sql => {
        const latest = await context(sql, actor, projectId, guard);
        return artifacts.filter(item => isReportData(item.data) && item.data.projectId === projectId).map(item => reportRecord(item, latest.fingerprint, projectId));
      });
    },
    /** Optional publish-entry guard; avoid calling full context recursively from a shared-context resolver. */
    async getShareSource(actor: Actor, projectId: string, sourceKind: "space_assistant" | "feasibility", sourceId: string, guard?: FreshSessionGuard): Promise<{ sourceKind: typeof sourceKind; sourceId: string; content: string }> {
      identifier(sourceId);
      if (sourceKind === "space_assistant") return deps.database.transaction(async sql => {
        await context(sql, actor, projectId, guard);
        const message = await readMessage(sql, actor.userId, projectId, sourceId);
        if (!message || message.role !== "assistant" || message.provider !== "dsh") notFound();
        return { sourceKind, sourceId, content: message.content };
      });
      if (sourceKind !== "feasibility") notFound();
      await deps.database.transaction(sql => context(sql, actor, projectId, guard));
      const artifact = await deps.personalAi.get(actor, sourceId, guard);
      const latest = await deps.database.transaction(sql => context(sql, actor, projectId, guard));
      const report = reportRecord(artifact, latest.fingerprint, projectId);
      if (report.stale) throw new DomainError("ASSISTANT_REPORT_STALE", "这份选题检查依据已变化，请重新检查后再分享到团队。", { status: 409 });
      return { sourceKind, sourceId, content: formatFeasibilityForSharing(report.data) };
    },
  };
}
export type TeamAssistantService = ReturnType<typeof createTeamAssistantService>;

export function formatFeasibilityForSharing(data: SavedFeasibilityData): string {
  const report = data.report, findings = (title: string, rows: typeof report.ruleFit) => `${title}\n${rows.map(row => `${row.title}（${row.knowledge === "known" ? "有依据" : row.knowledge === "unknown" ? "未知" : "待验证"}）：${row.detail}`).join("\n")}`;
  return [report.summary, findings("规则适配", report.ruleFit), `最小演示\n${report.minimumDemo.flow.join(" → ")}\n检查：${report.minimumDemo.successCheck}\n暂不做：${report.minimumDemo.excluded.join("、")}`,
    findings("技术检查", report.technicalChecks), findings("团队与时间", report.teamAndTime), findings("风险", report.risks),
    `验证任务\n${report.validationTasks.map(task => `${task.title}：交${task.deliverable}；检查${task.check}；建议职责${task.suggestedRole}；依赖${task.dependsOn.join("、") || "无"}`).join("\n")}`,
    `未知项\n${report.unknowns.join("\n")}`].join("\n\n");
}
function isReportData(value: unknown): value is SavedFeasibilityData {
  return Boolean(value && typeof value === "object" && "projectId" in value && "contextFingerprint" in value && "report" in value && typeof value.projectId === "string" && typeof value.contextFingerprint === "string");
}
function reportRecord(artifact: { id: string; kind: string; title: string; data: unknown; createdAt: string; provider: string }, fingerprint: string, projectId: string): FeasibilityReportRecord {
  if (artifact.kind !== "project_feasibility" || artifact.provider !== "dsh" || !isReportData(artifact.data) || artifact.data.projectId !== projectId) notFound();
  return { id: artifact.id, title: artifact.title, data: artifact.data, createdAt: artifact.createdAt, provider: "dsh", stale: artifact.data.contextFingerprint !== fingerprint };
}
function boundedMemory(snapshot: TeamAssistantMemorySnapshot): TeamAssistantMemorySnapshot {
  let bytes = 0;
  const items = snapshot.items.filter(item => {
    const size = Buffer.byteLength(item.content, "utf8");
    if (size > 16000 || bytes + size > 16000) return false;
    bytes += size; return true;
  }).slice(0, 20);
  return { ...snapshot, items, coverage: { ...snapshot.coverage, selectedCount: items.length }, missing: [...snapshot.missing, ...(items.length < snapshot.items.length ? ["部分记忆超过本次长度上限，未发送给模型。"] : [])] };
}
function boundedHistory(messages: readonly AssistantMessage[], fingerprint: string, memoryFingerprint: string) {
  // Old answers may contain withdrawn shared advice or memory from a now-revoked source project.
  const current = (item: AssistantMessage | undefined) => item?.role === "assistant" && item.coverage?.contextFingerprint === fingerprint && item.coverage?.memoryFingerprint === memoryFingerprint;
  const items = messages.filter((item, index) => item.role === "assistant" ? current(item) : current(messages[index + 1])).slice(-10).map(item => ({ role: item.role, content: item.content }));
  let bytes = items.reduce((sum, item) => sum + Buffer.byteLength(item.content, "utf8"), 0);
  while (items.length && (bytes > 24000 || items.some(item => Buffer.byteLength(item.content, "utf8") > 16000))) bytes -= Buffer.byteLength(items.shift()!.content, "utf8");
  return items;
}
function stableHash(value: unknown) { return createHash("sha256").update(JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest("hex"); }
function assertScope(actor: Actor, projectId: string) { if (!actor?.userId) throw new DomainError("UNAUTHENTICATED", "请先登录。", { status: 401 }); identifier(projectId); }
function identifier(value: unknown): string { if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new DomainError("ASSISTANT_INVALID_INPUT", "请求或空间地址无效。", { status: 422 }); return value; }
function inputText(value: unknown, maxBytes: number): string { if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maxBytes || value.includes("\0")) throw new DomainError("ASSISTANT_INVALID_INPUT", "请填写有效内容，并缩短过长的输入。", { status: 422 }); return value.trim(); }
function assertRevision(value: unknown): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new DomainError("ASSISTANT_INVALID_REVISION", "请先读取当前对话版本。", { status: 422 }); }
function conflict(revision: number): never { throw new DomainError("ASSISTANT_REVISION_CONFLICT", "另一个页面更新了本空间对话，已保留你的输入，请先刷新记录。", { status: 409, latestRevision: revision }); }
function busy(): never { throw new DomainError("ASSISTANT_BUSY", "本空间正在等待上一条 DSH 回复，请先查看请求状态。", { status: 409 }); }
function requestBlocked(status: string): never { throw new DomainError(status === "unknown" ? "AI_PREVIOUS_REQUEST_UNKNOWN" : status === "running" ? "ASSISTANT_BUSY" : "ASSISTANT_REQUEST_FAILED", status === "unknown" ? "上次相同内容的请求结果尚未确认，已暂停重复发送，请联系管理员核查。" : status === "running" ? "同一请求正在处理中，请查看对话状态，不要重复发送。" : "这次请求已失败，输入仍保留；确认失败原因后可以明确发起新的请求。", { status: 409 }); }
function notFound(): never { throw new DomainError("ASSISTANT_SOURCE_NOT_FOUND", "该回答或报告不存在、已清空，或不属于当前账号和空间。", { status: 404 }); }
