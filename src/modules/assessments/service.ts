import { createHash } from "node:crypto";
import type { Actor, Clock, IdGenerator, ProjectAccessPort, ProjectMembershipAccess } from "../../shared/contracts.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import { DomainError } from "../../shared/errors.ts";
import type { AssessmentRepository, AssessmentScorerPort, AssessmentTransaction, AssignmentContextPort, AssignmentSuggestionPort, QuestionCatalogPort } from "./ports.ts";
import type { AssessmentAttempt, AssessmentEvent, AssessmentScore, AssignmentContextSnapshot, AssignmentHead, AssignmentInputSnapshot, AssignmentVersion, AssignmentVersionView, FollowUp, ScoringJob, TeamAssessmentSummary } from "./types.ts";
import { assignmentChanges, ensureSnapshotCurrent, inputSnapshot, isSnapshotCurrent, validateAssignmentDraft } from "./assignment-rules.ts";
import { array, ensureSubmittable, invalid, keys, object, revision, string, strings, validateAnswers, validateProfile, validateSharing } from "./validation.ts";
import { calculateDimensionResults, SCORE_MEANING, validateScoringOutput } from "./scoring-rules.ts";
import { validateQuestionCatalog } from "./catalog.ts";
import { MODEL_TRANSPORT_FAILURE_CODES } from "./model-failures.ts";

export interface AssessmentServiceOptions {
  readonly repository: AssessmentRepository;
  readonly catalog: QuestionCatalogPort;
  readonly projectAccess: ProjectAccessPort;
  readonly assignmentContext: AssignmentContextPort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly scorer?: AssessmentScorerPort;
  readonly suggestions?: AssignmentSuggestionPort;
  readonly modelTimeoutMs?: number;
  readonly maxScoringRuns?: number;
  /** Never enable for real trials. Allows explicitly labelled scorer fixtures only. */
  readonly allowTestFixtureScorer?: boolean;
}
const EMPTY_PROFILE = { experience: "", tools: [], preferredTasks: [], memberAvailabilityVersionId: null } as const;
export class AssessmentService {
  private readonly options: AssessmentServiceOptions;
  private readonly timeoutMs: number;
  private readonly maxScoringRuns: number;
  constructor(options: AssessmentServiceOptions) {
    this.options = options;
    this.timeoutMs = options.modelTimeoutMs ?? 20000;
    this.maxScoringRuns = options.maxScoringRuns ?? 3;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120000 || !Number.isSafeInteger(this.maxScoringRuns) || this.maxScoringRuns < 1 || this.maxScoringRuns > 10) invalid("模型超时或重试配置无效。");
  }
  private now(): string { return this.options.clock.now().toISOString(); }
  /** Root must additionally verify that its trusted worker is registered/running. */
  isModelAvailable(kind: "scoring" | "assignment" = "scoring"): boolean {
    if (kind === "assignment") return this.options.suggestions !== undefined;
    return this.options.scorer !== undefined && (this.options.scorer.provenance !== "test_fixture" || this.options.allowTestFixtureScorer === true);
  }
  private async member(actor: Actor, projectId: string, manager = false): Promise<ProjectMembershipAccess> {
    if (!actor.userId) throw new DomainError("UNAUTHENTICATED", "请先登录。", { status: 401 });
    const member = await this.options.projectAccess.getMembership(projectId, actor.userId);
    if (!member || member.projectId !== projectId || member.userId !== actor.userId || member.status !== "active" || (manager && member.role !== "manager")) {
      throw new DomainError("FORBIDDEN", manager ? "只有活跃项目管理员可以管理分工。" : "需要本项目的活跃成员权限。", { status: 403 });
    }
    return member;
  }
  private ensureWritable(context: AssignmentContextSnapshot): void {
    if (context.readOnly === true || context.stage === "archived") throw new DomainError("PROJECT_READ_ONLY", "项目已归档或设为只读，可以查看历史记录，无法继续修改测评或分工。", { status: 409, recoveryAction: "view_project_history" });
  }
  private async ownedTransaction<T>(actor: Actor, id: string, work: (tx: AssessmentTransaction, attempt: AssessmentAttempt, context: AssignmentContextSnapshot) => Promise<T>, write = false): Promise<T> {
    // Resolve scope in a short transaction. Never ask a separate pool connection for
    // membership while holding the assessment transaction: a small pool could stall.
    const reference = await this.options.repository.transaction((tx) => tx.getAttempt(id));
    if (!reference || reference.userId !== actor.userId) throw new DomainError("NOT_FOUND", "未找到本人测评。", { status: 404 });
    await this.member(actor, reference.projectId);
    return this.options.repository.transaction(async (tx) => {
      // Context/member locks precede attempt locks, matching assignment application.
      const context = await this.options.assignmentContext.getSnapshot(reference.projectId, tx.sql);
      if (context.projectId !== reference.projectId) invalid("测评上下文必须来自当前项目。");
      this.contextMember(actor, context, false);
      if (!context.members.some((member) => member.userId === actor.userId && member.status === "active" && member.membershipId === reference.membershipId)) throw new DomainError("FORBIDDEN", "本次测评的原项目成员关系已失效。", { status: 403 });
      if (write) this.ensureWritable(context);
      const attempt = await tx.getAttempt(id);
      if (!attempt || attempt.userId !== actor.userId || attempt.projectId !== reference.projectId || attempt.membershipId !== reference.membershipId) throw new DomainError("NOT_FOUND", "未找到本人测评。", { status: 404 });
      return work(tx, attempt, context);
    });
  }
  private expected(actual: number, expected: number): void {
    revision(expected);
    if (actual !== expected) throw new DomainError("VERSION_CONFLICT", "这份资料已更新，请对照最新版本后保存。", { status: 409, latestRevision: actual, recoveryAction: "review_latest_version" });
  }
  private event(tx: AssessmentTransaction, type: AssessmentEvent["type"], aggregateId: string, projectId: string, version: number, payload: AssessmentEvent["payload"] = {}): Promise<void> {
    return tx.appendEvent({ eventId: this.options.ids.next(), type, aggregateId, projectId, version, occurredAt: this.now(), payload });
  }
  async createAttempt(actor: Actor, projectId: string, questionSetId: string): Promise<AssessmentAttempt> {
    const member = await this.member(actor, projectId);
    const set = await this.options.catalog.getQuestionSet(string(questionSetId, "题组 ID", 200));
    if (!set || set.status !== "published") throw new DomainError("QUESTION_SET_UNAVAILABLE", "题组尚未发布或已停用，请使用手动分工。", { status: 422 });
    const rubric = await this.options.catalog.getRubric(set.rubricVersionId);
    if (!rubric) throw new DomainError("RUBRIC_UNAVAILABLE", "题组的评分量规尚未就绪。");
    validateQuestionCatalog(set, rubric);
    const now = this.now();
    const attempt: AssessmentAttempt = {
      id: this.options.ids.next(), projectId, membershipId: member.membershipId, userId: actor.userId,
      questionSetId: set.id, rubricVersionId: rubric.id,
      questionSetSnapshot: structuredClone(set), rubricSnapshot: structuredClone(rubric),
      profile: structuredClone(EMPTY_PROFILE), answers: [], followUps: [], sharing: { confirmedTasks: [], criterionIds: [] },
      status: "draft", revision: 1, latestScoreId: null, activeJobId: null, scoringRuns: 0,
      createdAt: now, updatedAt: now, submittedAt: null,
    };
    return this.options.repository.transaction(async (tx) => {
      const context = await this.options.assignmentContext.getSnapshot(projectId, tx.sql);
      if (context.projectId !== projectId || !context.members.some((entry) => entry.userId === actor.userId && entry.membershipId === member.membershipId && entry.status === "active")) throw new DomainError("FORBIDDEN", "当前项目成员关系已变化。", { status: 403 });
      this.ensureWritable(context);
      const currentSet = await this.options.catalog.getQuestionSet(set.id, tx.sql);
      if (!currentSet || currentSet.status !== "published") throw new DomainError("QUESTION_SET_UNAVAILABLE", "题组已停用，请选择其他已发布题组或使用手动分工。");
      await tx.saveAttempt(attempt, null); return attempt;
    });
  }
  async getPrivateReport(actor: Actor, attemptId: string) {
    return this.ownedTransaction(actor, attemptId, async (tx, attempt) => {
      const scores = await tx.getScores(attempt.id);
      return { attempt, scores, dimensionResults: scores.map((score) => ({ scoreId: score.id, dimensions: calculateDimensionResults(score, attempt.rubricSnapshot) })), scoreMeaning: SCORE_MEANING };
    });
  }
  /** Resumable author-only index; no answers, profile or model explanations enter it. */
  async listOwnAttempts(actor: Actor, projectId: string) {
    await this.member(actor, projectId);
    return this.options.repository.transaction(async (tx) => {
      const context = await this.options.assignmentContext.getSnapshot(projectId, tx.sql);
      if (context.projectId !== projectId) invalid("测评上下文必须来自当前项目。");
      this.contextMember(actor, context, false);
      const member = context.members.find((entry) => entry.userId === actor.userId && entry.status === "active")!;
      const attempts = await tx.listOwnAttempts(projectId, actor.userId, member.membershipId);
      return attempts.filter((entry) => entry.projectId === projectId && entry.userId === actor.userId && entry.membershipId === member.membershipId).map((entry) => ({
        id: entry.id, projectId: entry.projectId, membershipId: entry.membershipId,
        questionSetId: entry.questionSetId, rubricVersionId: entry.rubricVersionId,
        status: entry.status, revision: entry.revision, latestScoreId: entry.latestScoreId, activeJobId: entry.activeJobId,
        scoringRuns: entry.scoringRuns, sharing: entry.sharing,
        createdAt: entry.createdAt, updatedAt: entry.updatedAt, submittedAt: entry.submittedAt,
      }));
    });
  }
  async saveDraft(actor: Actor, attemptId: string, expectedRevision: number, input: unknown): Promise<AssessmentAttempt> {
    return this.ownedTransaction(actor, attemptId, async (tx, attempt, context) => {
      this.expected(attempt.revision, expectedRevision);
      if (!["draft", "in_progress"].includes(attempt.status)) throw new DomainError("ATTEMPT_LOCKED", "已提交的回答不能覆盖；可申请重新评估。");
      const data = object(input, "草稿");
      keys(data, ["profile", "answers", "followUpAnswers"], "草稿");
      let followUps = attempt.followUps;
      if (data.followUpAnswers !== undefined) {
        const entries = array(data.followUpAnswers, "追问回答", attempt.questionSetSnapshot.maxFollowUps).map((entry) => {
          const value = object(entry, "追问回答"); keys(value, ["id", "answer"], "追问回答");
          return { id: string(value.id, "追问 ID", 200), answer: string(value.answer, "追问回答", 10000, true) };
        });
        if (new Set(entries.map((entry) => entry.id)).size !== entries.length || entries.some((entry) => !followUps.some((followUp) => followUp.id === entry.id))) invalid("追问回答包含重复或不存在的 ID。");
        followUps = followUps.map((followUp) => ({ ...followUp, answer: entries.find((entry) => entry.id === followUp.id)?.answer ?? followUp.answer }));
      }
      const profile = data.profile === undefined ? attempt.profile : validateProfile(data.profile);
      if (data.profile !== undefined && profile.memberAvailabilityVersionId !== null && !context.members.some((member) => member.membershipId === attempt.membershipId && member.memberAvailabilityVersionId === profile.memberAvailabilityVersionId)) invalid("可用时间引用必须是本人当前项目的集合版本。");
      const next: AssessmentAttempt = {
        ...attempt,
        profile,
        answers: data.answers === undefined ? attempt.answers : validateAnswers(data.answers, attempt),
        followUps, status: "in_progress", revision: attempt.revision + 1, updatedAt: this.now(),
      };
      await tx.saveAttempt(next, attempt.revision); return next;
    }, true);
  }
  /** Deterministic follow-up text stays within a published criterion; no arbitrary model question reaches a member. */
  async addFollowUp(actor: Actor, attemptId: string, expectedRevision: number, questionId: string, criterionId: string): Promise<AssessmentAttempt> {
    return this.ownedTransaction(actor, attemptId, async (tx, attempt) => {
      this.expected(attempt.revision, expectedRevision);
      if (!["draft", "in_progress"].includes(attempt.status)) throw new DomainError("ATTEMPT_LOCKED", "只能在提交前补充问题。");
      if (attempt.followUps.length >= attempt.questionSetSnapshot.maxFollowUps) throw new DomainError("FOLLOW_UP_LIMIT", "本次补充问题已达上限，可直接完成或取消测评。");
      const question = attempt.questionSetSnapshot.questions.find((entry) => entry.id === questionId);
      const criterion = attempt.rubricSnapshot.criteria.find((entry) => entry.id === criterionId);
      if (!question || !criterion || !question.criterionIds.includes(criterionId)) invalid("追问必须补充原题的已有评分项。");
      if (attempt.followUps.some((entry) => entry.questionId === questionId && entry.criterionId === criterionId)) invalid("同一题的同一评分项已追加补充问题。");
      const followUp: FollowUp = { id: this.options.ids.next(), questionId, criterionId, prompt: `请补充“${criterion.label}”的证据：你实际做了什么、预期结果是什么，哪些部分尚未验证？`, answer: null };
      const next = { ...attempt, followUps: [...attempt.followUps, followUp], status: "in_progress" as const, revision: attempt.revision + 1, updatedAt: this.now() };
      await tx.saveAttempt(next, attempt.revision); return next;
    }, true);
  }
  async cancelAttempt(actor: Actor, attemptId: string, expectedRevision: number): Promise<AssessmentAttempt> {
    return this.ownedTransaction(actor, attemptId, async (tx, attempt) => {
      this.expected(attempt.revision, expectedRevision);
      if (!["draft", "in_progress"].includes(attempt.status)) throw new DomainError("ATTEMPT_LOCKED", "只能取消尚未提交的测评。");
      const next = { ...attempt, status: "cancelled" as const, revision: attempt.revision + 1, updatedAt: this.now() };
      await tx.saveAttempt(next, attempt.revision); return next;
    }, true);
  }
  async setSharing(actor: Actor, attemptId: string, expectedRevision: number, input: unknown): Promise<AssessmentAttempt> {
    return this.ownedTransaction(actor, attemptId, async (tx, attempt) => {
      this.expected(attempt.revision, expectedRevision);
      const next = { ...attempt, sharing: validateSharing(input, attempt), revision: attempt.revision + 1, updatedAt: this.now() };
      await tx.saveAttempt(next, attempt.revision);
      await this.event(tx, "AssessmentSummaryUpdated", attempt.id, attempt.projectId, next.revision);
      return next;
    }, true);
  }
  private fingerprint(attempt: AssessmentAttempt, correctionReason: string | null): string {
    return createHash("sha256").update(JSON.stringify({ id: attempt.id, questionSet: attempt.questionSetSnapshot, rubric: attempt.rubricSnapshot, profile: attempt.profile, answers: attempt.answers, followUps: attempt.followUps, correctionReason })).digest("hex");
  }
  async submitAttempt(actor: Actor, attemptId: string, expectedRevision: number, idempotencyKey: string): Promise<ScoringJob> {
    return this.queueScoring(actor, attemptId, expectedRevision, idempotencyKey, null, false);
  }
  async requestReassessment(actor: Actor, attemptId: string, expectedRevision: number, idempotencyKey: string, correctionReason: string): Promise<ScoringJob> {
    return this.queueScoring(actor, attemptId, expectedRevision, idempotencyKey, string(correctionReason, "重新评估理由", 3000), true);
  }
  private async queueScoring(actor: Actor, attemptId: string, expectedRevision: number, idempotencyKey: string, correctionReason: string | null, reassessment: boolean): Promise<ScoringJob> {
    const key = string(idempotencyKey, "幂等键", 200);
    return this.ownedTransaction(actor, attemptId, async (tx, attempt) => {
      const fingerprint = this.fingerprint(attempt, correctionReason);
      const old = await tx.findJob(attempt.id, actor.userId, key);
      if (old) {
        if (old.inputFingerprint !== fingerprint) throw new DomainError("IDEMPOTENCY_CONFLICT", "同一幂等键不能用于不同的评分输入。", { status: 409 });
        if (old.status === "queued" && !this.isModelAvailable()) throw new DomainError("MODEL_UNAVAILABLE", "评分模型暂未接入，可以继续保存回答或手动分工。", { status: 503 });
        return old;
      }
      if (!this.options.scorer) throw new DomainError("MODEL_UNAVAILABLE", "评分模型暂未接入，可以继续保存回答或手动分工。", { status: 503 });
      if (!this.isModelAvailable()) throw new DomainError("TEST_SCORER_DISABLED", "测试评分器不能用于实际试用。", { status: 503 });
      this.expected(attempt.revision, expectedRevision);
      const allowed = reassessment ? ["completed", "scoring_failed"] : ["draft", "in_progress", "scoring_failed"];
      if (!allowed.includes(attempt.status)) throw new DomainError("ATTEMPT_LOCKED", "评分正在进行或本次测评已提交，请查看现有任务。");
      if (attempt.scoringRuns >= this.maxScoringRuns) throw new DomainError("SCORING_RETRY_LIMIT", "本次评分已达重试上限；可保留报告并继续手动分工。", { status: 429 });
      ensureSubmittable(attempt);
      const now = this.now();
      const job: ScoringJob = { id: this.options.ids.next(), attemptId: attempt.id, projectId: attempt.projectId, userId: actor.userId, idempotencyKey: key, inputFingerprint: fingerprint, status: "queued", revision: 1, runNumber: attempt.scoringRuns + 1, correctionReason, createdAt: now, startedAt: null, finishedAt: null, durationMs: null, failureCode: null, resultScoreId: null };
      const next = { ...attempt, status: "submitted" as const, activeJobId: job.id, scoringRuns: job.runNumber, submittedAt: attempt.submittedAt ?? now, updatedAt: now, revision: attempt.revision + 1 };
      await tx.saveAttempt(next, attempt.revision); await tx.saveJob(job, null);
      await this.event(tx, "AssessmentSubmitted", attempt.id, attempt.projectId, next.revision, { jobId: job.id });
      return job;
    }, true);
  }
  async getJob(actor: Actor, jobId: string): Promise<ScoringJob> {
    const reference = await this.options.repository.transaction((tx) => tx.getJob(jobId));
    if (!reference || reference.userId !== actor.userId) throw new DomainError("NOT_FOUND", "未找到本人评分任务。", { status: 404 });
    return this.ownedTransaction(actor, reference.attemptId, async (tx) => {
      const current = await tx.getJob(jobId);
      if (!current || current.userId !== actor.userId) throw new DomainError("NOT_FOUND", "未找到本人评分任务。", { status: 404 });
      return current;
    });
  }
  private async bounded<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(() => work(controller.signal)), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new DomainError("MODEL_TIMEOUT", "模型未在限定时间内返回。", { status: 503 })); }, this.timeoutMs); })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  /** Trusted worker API. Do not expose this method as an unauthenticated HTTP route. */
  async processScoringJob(jobId: string): Promise<ScoringJob> {
    const reference = await this.options.repository.transaction((tx) => tx.getJob(jobId));
    if (!reference) throw new DomainError("NOT_FOUND", "评分任务不存在。", { status: 404 });
    const claim = await this.options.repository.transaction(async (tx) => {
      const context = await this.options.assignmentContext.getSnapshot(reference.projectId, tx.sql);
      if (context.projectId !== reference.projectId) invalid("评分上下文必须来自当前项目。");
      const attempt = await tx.getAttempt(reference.attemptId); const job = await tx.getJob(jobId);
      if (!attempt || !job) throw new DomainError("NOT_FOUND", "评分资料不存在。", { status: 404 });
      if (job.status !== "queued") return { claimed: false as const, job, attempt };
      if (attempt.activeJobId !== job.id || attempt.status !== "submitted") throw new DomainError("JOB_STALE", "评分任务已失效。", { status: 409 });
      this.ensureWritable(context);
      const now = this.now();
      const running = { ...job, status: "running" as const, revision: job.revision + 1, startedAt: now };
      await tx.saveAttempt({ ...attempt, status: "scoring", revision: attempt.revision + 1, updatedAt: now }, attempt.revision);
      await tx.saveJob(running, job.revision); return { claimed: true as const, job: running, attempt };
    }).catch(async (error: unknown) => {
      if (!(error instanceof DomainError) || error.code !== "PROJECT_READ_ONLY") throw error;
      const job = await this.failJob(jobId, reference.attemptId, reference.projectId, "PROJECT_READ_ONLY");
      return { claimed: false as const, job, attempt: null };
    });
    if (!claim.claimed) return claim.job;
    try {
      const currentMember = await this.member({ userId: claim.attempt.userId, platformRoles: [] }, claim.attempt.projectId);
      if (currentMember.membershipId !== claim.attempt.membershipId) throw new DomainError("FORBIDDEN", "本次测评的项目成员关系已失效。", { status: 403 });
      await this.options.repository.transaction(async (tx) => {
        const context = await this.options.assignmentContext.getSnapshot(claim.attempt.projectId, tx.sql);
        if (context.projectId !== claim.attempt.projectId || !context.members.some((member) => member.userId === claim.attempt.userId && member.membershipId === claim.attempt.membershipId && member.status === "active")) throw new DomainError("FORBIDDEN", "本次测评的项目成员关系已失效。", { status: 403 });
        this.ensureWritable(context);
      });
      const scorer = this.options.scorer;
      if (!scorer) throw new DomainError("MODEL_UNAVAILABLE", "评分模型尚未接入。", { status: 503 });
      if (scorer.provenance === "test_fixture" && !this.options.allowTestFixtureScorer) throw new DomainError("TEST_SCORER_DISABLED", "测试评分器不能用于实际试用。", { status: 503 });
      const output = await this.bounded((signal) => scorer.score({ attempt: structuredClone(claim.attempt), correctionReason: claim.job.correctionReason }, signal));
      const validated = validateScoringOutput(output, claim.attempt);
      return await this.options.repository.transaction(async (tx) => {
        const context = await this.options.assignmentContext.getSnapshot(claim.attempt.projectId, tx.sql);
        if (context.projectId !== claim.attempt.projectId || !context.members.some((member) => member.userId === claim.attempt.userId && member.membershipId === claim.attempt.membershipId && member.status === "active")) throw new DomainError("FORBIDDEN", "本次测评的项目成员关系已失效。", { status: 403 });
        this.ensureWritable(context);
        const current = await tx.getAttempt(claim.attempt.id); const job = await tx.getJob(jobId);
        if (!current || !job || current.activeJobId !== jobId || job.status !== "running") throw new DomainError("JOB_STALE", "评分任务状态已变化。", { status: 409 });
        const now = this.now();
        const score: AssessmentScore = { ...validated,
          limitations: [...new Set([...current.questionSetSnapshot.limitations, ...current.rubricSnapshot.limitations, ...validated.limitations, SCORE_MEANING])],
          id: this.options.ids.next(), attemptId: current.id, provenance: scorer.provenance, status: "published", supersedesScoreId: current.latestScoreId, correctionReason: job.correctionReason, validatedAt: now };
        const completed: ScoringJob = { ...job, status: "succeeded", revision: job.revision + 1, finishedAt: now, durationMs: Math.max(0, Date.parse(now) - Date.parse(job.startedAt!)), resultScoreId: score.id };
        await tx.insertScore(score);
        const next = { ...current, status: "completed" as const, latestScoreId: score.id, activeJobId: null, revision: current.revision + 1, updatedAt: now };
        await tx.saveAttempt(next, current.revision); await tx.saveJob(completed, job.revision);
        await this.event(tx, "AssessmentSummaryUpdated", current.id, current.projectId, next.revision);
        return completed;
      });
    } catch (error) {
      const safeCodes = ["MODEL_UNAVAILABLE", "TEST_SCORER_DISABLED", "MODEL_TIMEOUT", "INVALID_SCORING_OUTPUT", "INVALID_QUESTION_CATALOG", "FORBIDDEN", "JOB_STALE", "PROJECT_READ_ONLY", ...MODEL_TRANSPORT_FAILURE_CODES];
      return this.failJob(jobId, claim.attempt.id, claim.attempt.projectId, error instanceof DomainError && safeCodes.includes(error.code) ? error.code : "MODEL_FAILED");
    }
  }
  /** Terminal execution metadata may close an already queued/running job in a read-only
   * project; no answers, scores, sharing or assignment content is changed here.
   */
  private async failJob(jobId: string, attemptId: string, projectId: string, failureCode: string): Promise<ScoringJob> {
    return this.options.repository.transaction(async (tx) => {
      const context = await this.options.assignmentContext.getSnapshot(projectId, tx.sql);
      if (context.projectId !== projectId) invalid("评分上下文必须来自当前项目。");
      const attempt = await tx.getAttempt(attemptId); const job = await tx.getJob(jobId);
      if (!attempt || !job) throw new DomainError("NOT_FOUND", "评分任务不存在。", { status: 404 });
      const readOnly = context.readOnly === true || context.stage === "archived";
      const safeFailureCode = readOnly ? "PROJECT_READ_ONLY" : failureCode;
      if (job.status !== "running" && !(job.status === "queued" && safeFailureCode === "PROJECT_READ_ONLY")) return job;
      const now = this.now();
      const failed: ScoringJob = { ...job, status: "failed", revision: job.revision + 1, failureCode: safeFailureCode, finishedAt: now, durationMs: job.startedAt === null ? 0 : Math.max(0, Date.parse(now) - Date.parse(job.startedAt)) };
      await tx.saveJob(failed, job.revision);
      if (attempt.activeJobId === jobId) {
        const next = { ...attempt, status: "scoring_failed" as const, activeJobId: null, revision: attempt.revision + 1, updatedAt: now };
        await tx.saveAttempt(next, attempt.revision); await this.event(tx, "AssessmentScoringFailed", attempt.id, attempt.projectId, next.revision, { jobId, failureCode: safeFailureCode });
      }
      return failed;
    });
  }
  /** Worker recovery after a crash: expire the lease, never run the same model request again blindly. */
  async recoverExpiredScoringJob(jobId: string): Promise<ScoringJob> {
    const job = await this.options.repository.transaction((tx) => tx.getJob(jobId));
    if (!job) throw new DomainError("NOT_FOUND", "评分任务不存在。", { status: 404 });
    if (job.status !== "running" || this.options.clock.now().getTime() - Date.parse(job.startedAt!) <= this.timeoutMs + 30000) return job;
    return this.failJob(job.id, job.attemptId, job.projectId, "WORKER_INTERRUPTED");
  }
  private async summaries(tx: AssessmentTransaction, context: AssignmentContextSnapshot): Promise<readonly TeamAssessmentSummary[]> {
    const summaries: TeamAssessmentSummary[] = [];
    for (const attempt of await tx.listAttempts(context.projectId)) {
      if (!context.members.some((member) => member.status === "active" && member.membershipId === attempt.membershipId && member.userId === attempt.userId)) continue;
      if (attempt.sharing.confirmedTasks.length === 0 && attempt.sharing.criterionIds.length === 0) continue;
      const score = (await tx.getScores(attempt.id)).find((entry) => entry.id === attempt.latestScoreId);
      summaries.push({ attemptId: attempt.id, membershipId: attempt.membershipId, revision: attempt.revision, confirmedTasks: attempt.sharing.confirmedTasks,
        criterionScores: (score?.criterionScores ?? []).filter((entry) => attempt.sharing.criterionIds.includes(entry.criterionId)).map(({ criterionId, state, score }) => {
          const criterion = attempt.rubricSnapshot.criteria.find((entry) => entry.id === criterionId)!;
          return { criterionId, state, score, dimension: criterion.dimension, label: criterion.label, maxScore: criterion.maxScore };
        }),
        rubricVersionId: attempt.rubricVersionId, questionSetId: attempt.questionSetId,
        provenance: score?.provenance ?? null,
        scoreMeaning: SCORE_MEANING,
        limitations: [...new Set([...attempt.questionSetSnapshot.limitations, ...attempt.rubricSnapshot.limitations, "摘要仅含本人明确共享的任务与评分项，原始回答和模型解释仍为私有。", "证据不足不等于能力为零；本次得分不表示真实能力百分比。"])],
      });
    }
    return summaries;
  }
  async getTeamSummaries(actor: Actor, projectId: string): Promise<readonly TeamAssessmentSummary[]> {
    await this.member(actor, projectId);
    return this.options.repository.transaction(async (tx) => {
      const context = await this.options.assignmentContext.getSnapshot(projectId, tx.sql);
      if (context.projectId !== projectId) invalid("摘要上下文必须来自当前项目。");
      this.contextMember(actor, context, false);
      return this.summaries(tx, context);
    });
  }
  private contextMember(actor: Actor, context: AssignmentContextSnapshot, manager = true): void {
    if (!context.members.some((member) => member.userId === actor.userId && member.status === "active" && (!manager || member.role === "manager"))) throw new DomainError("FORBIDDEN", "当前项目成员权限已变化。", { status: 403 });
  }
  private async assignmentInputs(tx: AssessmentTransaction, actor: Actor, projectId: string) {
    const head = await tx.getHead(projectId);
    const context = await this.options.assignmentContext.getSnapshot(projectId, tx.sql);
    if (context.projectId !== projectId) invalid("分工上下文必须来自当前项目。");
    this.contextMember(actor, context);
    this.ensureWritable(context);
    const summaries = await this.summaries(tx, context);
    return { head, context, summaries };
  }
  async createAssignment(actor: Actor, projectId: string, baseVersionId: string | null, draft: unknown): Promise<AssignmentVersion> {
    await this.member(actor, projectId, true);
    return this.options.repository.transaction(async (tx) => {
      const { head, context, summaries } = await this.assignmentInputs(tx, actor, projectId);
      if (head.versionId !== baseVersionId) throw new DomainError("ASSIGNMENT_BASE_CHANGED", "当前生效分工已变化，请以最新分工建立草案。", { status: 409, latestRevision: head.revision });
      const base = baseVersionId === null ? null : await tx.getAssignment(baseVersionId);
      if (base && base.projectId !== projectId) invalid("分工基线必须属于当前项目。");
      const data = validateAssignmentDraft(draft, context, summaries); const now = this.now();
      const version: AssignmentVersion = { ...data, id: this.options.ids.next(), projectId, baseVersionId, inputSnapshot: inputSnapshot(context, summaries),
        changes: assignmentChanges(base?.assignments ?? [], data.assignments), status: data.validationIssues.length ? "needs_changes" : "draft", revision: 1, createdBy: actor.userId, createdAt: now, updatedAt: now, appliedBy: null, appliedAt: null };
      await tx.saveAssignment(version, null); return version;
    });
  }
  async editAssignment(actor: Actor, assignmentId: string, expectedRevision: number, draft: unknown): Promise<AssignmentVersion> {
    const ref = await this.options.repository.transaction((tx) => tx.getAssignment(assignmentId));
    if (!ref) throw new DomainError("NOT_FOUND", "分工版本不存在。", { status: 404 });
    await this.member(actor, ref.projectId, true);
    return this.options.repository.transaction(async (tx) => {
      const { head, context, summaries } = await this.assignmentInputs(tx, actor, ref.projectId);
      const version = await tx.getAssignment(assignmentId);
      if (!version) throw new DomainError("NOT_FOUND", "分工版本不存在。", { status: 404 });
      this.expected(version.revision, expectedRevision);
      if (["applied", "superseded"].includes(version.status)) throw new DomainError("ASSIGNMENT_IMMUTABLE", "已应用分工不能覆盖，请创建新草案。");
      if (head.versionId !== version.baseVersionId) throw new DomainError("ASSIGNMENT_BASE_CHANGED", "生效分工已变化，请创建新草案。", { status: 409 });
      const base = version.baseVersionId === null ? null : await tx.getAssignment(version.baseVersionId);
      const data = validateAssignmentDraft(draft, context, summaries);
      const next: AssignmentVersion = { ...version, ...data, inputSnapshot: inputSnapshot(context, summaries), changes: assignmentChanges(base?.assignments ?? [], data.assignments), status: data.validationIssues.length ? "needs_changes" : "draft", revision: version.revision + 1, updatedAt: this.now() };
      await tx.saveAssignment(next, version.revision); return next;
    });
  }
  private async sharedSummaryRefs(tx: AssessmentTransaction, context: AssignmentContextSnapshot): Promise<readonly Pick<TeamAssessmentSummary, "attemptId" | "revision">[]> {
    return (await tx.listSharedSummaryRefs(context.projectId)).filter(ref => context.members.some(member => member.status === "active" && member.membershipId === ref.membershipId && member.userId === ref.userId)).map(ref => ({ attemptId: ref.attemptId, revision: ref.revision }));
  }
  private assignmentView(version: AssignmentVersion, context: AssignmentContextSnapshot, summaries: readonly Pick<TeamAssessmentSummary, "attemptId" | "revision">[]): AssignmentVersionView {
    const current = isSnapshotCurrent(version.inputSnapshot, context, summaries);
    return { ...version, inputFreshness: current ? "current" : "changed", staleReason: current ? null : "比赛赛道、项目状态、成员意愿、项目要求、可用时间或共享摘要已变化，请重新检查依据。" };
  }
  async getAssignment(actor: Actor, assignmentId: string): Promise<AssignmentVersionView> {
    const reference = await this.options.repository.transaction((tx) => tx.getAssignment(assignmentId));
    if (!reference) throw new DomainError("NOT_FOUND", "分工版本不存在。", { status: 404 });
    await this.member(actor, reference.projectId);
    return this.options.repository.transaction(async (tx) => {
      const context = await this.options.assignmentContext.getSnapshot(reference.projectId, tx.sql);
      if (context.projectId !== reference.projectId) invalid("分工上下文必须来自当前项目。");
      this.contextMember(actor, context, false);
      const summaries = await this.sharedSummaryRefs(tx, context);
      const version = await tx.getAssignment(assignmentId);
      if (!version) throw new DomainError("NOT_FOUND", "分工版本不存在。", { status: 404 });
      return this.assignmentView(version, context, summaries);
    });
  }
  async getAppliedAssignment(actor: Actor, projectId: string): Promise<{ head: AssignmentHead; version: AssignmentVersionView | null }> {
    await this.member(actor, projectId);
    return this.options.repository.transaction(async (tx) => {
      const head = await tx.getHead(projectId, false);
      const context = await this.options.assignmentContext.getSnapshot(projectId, tx.sql);
      if (context.projectId !== projectId) invalid("分工上下文必须来自当前项目。");
      this.contextMember(actor, context, false);
      const summaries = await this.sharedSummaryRefs(tx, context);
      const version = head.versionId === null ? null : await tx.getAssignment(head.versionId);
      return { head, version: version === null ? null : this.assignmentView(version, context, summaries) };
    });
  }
  async validateAssignment(actor: Actor, assignmentId: string, expectedRevision: number): Promise<AssignmentVersion> {
    return this.changeAssignmentState(actor, assignmentId, expectedRevision, false);
  }
  async applyAssignment(actor: Actor, assignmentId: string, expectedRevision: number): Promise<AssignmentVersion> {
    return this.changeAssignmentState(actor, assignmentId, expectedRevision, true);
  }
  private async changeAssignmentState(actor: Actor, assignmentId: string, expectedRevision: number, apply: boolean): Promise<AssignmentVersion> {
    const reference = await this.options.repository.transaction((tx) => tx.getAssignment(assignmentId));
    if (!reference) throw new DomainError("NOT_FOUND", "分工版本不存在。", { status: 404 });
    await this.member(actor, reference.projectId, true);
    return this.options.repository.transaction(async (tx) => {
      const { head, context, summaries } = await this.assignmentInputs(tx, actor, reference.projectId);
      const version = await tx.getAssignment(assignmentId);
      if (!version) throw new DomainError("NOT_FOUND", "分工版本不存在。", { status: 404 });
      this.expected(version.revision, expectedRevision);
      if (["applied", "superseded"].includes(version.status)) throw new DomainError("ASSIGNMENT_IMMUTABLE", "这份分工已确认，请查看生效记录或创建新草案。");
      if (apply && version.status !== "ready") throw new DomainError("ASSIGNMENT_NOT_READY", "请先校验草案并查看差异，再确认应用。");
      if (head.versionId !== version.baseVersionId) throw new DomainError("ASSIGNMENT_BASE_CHANGED", "其他管理员已应用新分工，请重新对照草案。", { status: 409, latestRevision: head.revision });
      ensureSnapshotCurrent(version.inputSnapshot, context, summaries);
      const validated = validateAssignmentDraft({ assignments: version.assignments, gaps: version.gaps, assumptions: version.assumptions }, context, summaries);
      if (validated.validationIssues.length) throw new DomainError("ASSIGNMENT_NEEDS_CHANGES", validated.validationIssues.join(" "));
      const now = this.now();
      const next: AssignmentVersion = { ...version, status: apply ? "applied" : "ready", revision: version.revision + 1, updatedAt: now, appliedBy: apply ? actor.userId : null, appliedAt: apply ? now : null };
      if (apply) {
        if (head.versionId !== null) {
          const previous = await tx.getAssignment(head.versionId);
          if (!previous) throw new DomainError("ASSIGNMENT_BASE_MISSING", "分工基线记录缺失。", { status: 409 });
          await tx.saveAssignment({ ...previous, status: "superseded", revision: previous.revision + 1, updatedAt: now }, previous.revision);
        }
        await tx.saveHead({ projectId: version.projectId, versionId: version.id, revision: head.revision + 1 }, head.revision);
      }
      await tx.saveAssignment(next, version.revision);
      if (apply) await this.event(tx, "AssignmentApplied", version.id, version.projectId, next.revision, { assignmentVersionId: version.id, previousAssignmentVersionId: head.versionId, headRevision: head.revision + 1, appliedBy: actor.userId });
      return next;
    });
  }
  /** Optional bounded generation returns a reviewable draft; only shared summaries enter the model. */
  async withAssignmentSuggestionInputs<T>(actor: Actor, projectId: string, targetDeliverables: readonly string[], work: (inputs: { readonly baseVersionId: string | null; readonly inputSnapshot: AssignmentInputSnapshot; readonly targetDeliverables: readonly string[]; readonly membershipId: string }, sql: SqlExecutor | undefined) => Promise<T>): Promise<T> {
    await this.member(actor, projectId, true);
    const targets = strings(targetDeliverables, "目标交付物", 30, 2000);
    if (targets.length === 0) invalid("请至少填写一个目标交付物。");
    return this.options.repository.transaction(async (tx) => {
      const inputs = await this.assignmentInputs(tx, actor, projectId);
      const membershipId = inputs.context.members.find((member) => member.userId === actor.userId && member.status === "active" && member.role === "manager")!.membershipId;
      return work({ baseVersionId: inputs.head.versionId, inputSnapshot: inputSnapshot(inputs.context, inputs.summaries), targetDeliverables: targets, membershipId }, tx.sql);
    });
  }
  async suggestAssignment(actor: Actor, projectId: string, targetDeliverables: readonly string[], expectedInputs?: { readonly baseVersionId: string | null; readonly inputSnapshot: AssignmentInputSnapshot; readonly onDraftSaved?: (assignment: AssignmentVersion, sql: SqlExecutor | undefined) => Promise<void> }): Promise<AssignmentVersion> {
    await this.member(actor, projectId, true);
    const targets = strings(targetDeliverables, "目标交付物", 30, 2000);
    const inputs = await this.options.repository.transaction((tx) => this.assignmentInputs(tx, actor, projectId));
    if (expectedInputs) {
      if (expectedInputs.baseVersionId !== inputs.head.versionId) throw new DomainError("ASSIGNMENT_BASE_CHANGED", "排队期间生效分工已变化，请建立新的生成任务。", { status: 409 });
      ensureSnapshotCurrent(expectedInputs.inputSnapshot, inputs.context, inputs.summaries);
    }
    if (!this.options.suggestions) throw new DomainError("MODEL_UNAVAILABLE", "分工建议模型尚未接入，仍可手动建立草案。", { status: 503 });
    const output = await this.bounded((signal) => this.options.suggestions!.suggest({ context: inputs.context, summaries: inputs.summaries, targetDeliverables: targets }, signal));
    return this.options.repository.transaction(async (tx) => {
      const fresh = await this.assignmentInputs(tx, actor, projectId);
      if (fresh.head.versionId !== inputs.head.versionId) throw new DomainError("ASSIGNMENT_BASE_CHANGED", "生成期间生效分工已变化。", { status: 409 });
      ensureSnapshotCurrent(inputSnapshot(inputs.context, inputs.summaries), fresh.context, fresh.summaries);
      const data = validateAssignmentDraft(output, fresh.context, fresh.summaries);
      const base = fresh.head.versionId === null ? null : await tx.getAssignment(fresh.head.versionId); const now = this.now();
      const version: AssignmentVersion = { ...data, id: this.options.ids.next(), projectId, baseVersionId: fresh.head.versionId, inputSnapshot: inputSnapshot(fresh.context, fresh.summaries), changes: assignmentChanges(base?.assignments ?? [], data.assignments), status: data.validationIssues.length ? "needs_changes" : "draft", revision: 1, createdBy: actor.userId, createdAt: now, updatedAt: now, appliedBy: null, appliedAt: null };
      await tx.saveAssignment(version, null);
      await expectedInputs?.onDraftSaved?.(version, tx.sql);
      return version;
    });
  }
}
