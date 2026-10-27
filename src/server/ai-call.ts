import type { Clock, IdGenerator } from "../shared/contracts.ts";
import type { DatabasePort } from "../shared/persistence.ts";
import { withAiExecutionContext, type AiTokenUsage, type JsonModelPort } from "./ai.ts";

/** 一次带预算与账本的 JSON 调用（同步请求/响应，不是后台作业）。 */
export interface BudgetedJsonCall {
  readonly available: boolean;
  readonly modelVersion: string;
  complete(request: {
    /** 稳定的调用作用域键，写进 `ai_execution_jobs.project_id`（例如 `organizer-page:<eventId>`）。 */
    readonly scopeKey: string;
    readonly systemPrompt: string;
    readonly input: string;
    readonly maxOutputTokens: number;
    /** 账本里的提示词版本；缺省 `v1`。 */
    readonly promptVersion?: string;
    readonly timeoutMs?: number;
  }): Promise<{ readonly content: unknown; readonly usage: AiTokenUsage | null; readonly requestId: string | null }>;
}

const INSERT_JOB = `INSERT INTO ai_execution_jobs(id,kind,module_job_id,source_revision,project_id,actor_id,status,attempts,lease_owner,lease_token,lease_until,external_state,created_at,updated_at) VALUES($1,$2,$1,1,$3,$4,'running',0,'budgeted-json',$5,$6::timestamptz,'not_sent',$7::timestamptz,$7::timestamptz)`;
const SUCCEEDED_JOB = `UPDATE ai_execution_jobs SET status='succeeded',attempts=attempts+1,lease_owner=NULL,lease_token=NULL,lease_until=NULL,external_state='response_received',updated_at=$2::timestamptz WHERE id=$1`;
const FAILED_JOB = `UPDATE ai_execution_jobs SET status='failed',attempts=attempts+1,lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=$2::timestamptz WHERE id=$1`;

/**
 * 规划35 P2：编辑器里的生成调用。
 *
 * 复用既有 AI 账本与预算（`ai_execution_jobs` ＋ `createBudgetedModel` 的 reserve/settle）：
 * 每次调用先落一条最薄的执行行承载这次同步请求，结束后置终态；失败置 failed 并原样抛出。
 * 没有模型时 `available:false`，调用方据此返回「不可用」而不是假装成功。
 */
export function createBudgetedJsonCall(options: {
  readonly database: DatabasePort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly model: JsonModelPort | null;
  /** `ai_execution_jobs.kind`，用于在账本里区分调用来源。 */
  readonly kind: string;
  readonly actorId: (request: { readonly scopeKey: string }) => string;
}): BudgetedJsonCall {
  const model = options.model;
  return {
    available: model !== null,
    modelVersion: model ? model.modelVersion : "unconfigured",
    async complete(request) {
      if (model === null) throw new Error("AI_UNCONFIGURED");
      const executionId = options.ids.next(), leaseToken = options.ids.next();
      const actorId = options.actorId(request);
      const now = options.clock.now();
      const until = new Date(now.getTime() + 300_000).toISOString();
      const at = now.toISOString();
      await options.database.query(INSERT_JOB, [executionId, options.kind, request.scopeKey, actorId, leaseToken, until, at]);
      try {
        const result = await withAiExecutionContext(
          { executionId, leaseToken, projectId: request.scopeKey, actorId },
          () => model.completeJSON({
            systemPrompt: request.systemPrompt, input: request.input,
            promptVersion: request.promptVersion ?? "v1", maxOutputTokens: request.maxOutputTokens,
          }, AbortSignal.timeout(request.timeoutMs ?? 120_000)),
        );
        await options.database.query(SUCCEEDED_JOB, [executionId, options.clock.now().toISOString()]);
        return { content: result.content, usage: result.usage, requestId: result.requestId };
      } catch (error) {
        await options.database.query(FAILED_JOB, [executionId, options.clock.now().toISOString()]).catch(() => undefined);
        throw error;
      }
    },
  };
}
