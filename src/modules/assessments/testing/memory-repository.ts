import { DomainError } from "../../../shared/errors.ts";
import type { AssessmentRepository, AssessmentTransaction } from "../ports.ts";
import type { AssessmentAttempt, AssessmentEvent, AssessmentScore, AssignmentHead, AssignmentVersion, ScoringJob } from "../types.ts";

interface FixtureState {
  attempts: Map<string, AssessmentAttempt>;
  scores: Map<string, AssessmentScore>;
  jobs: Map<string, ScoringJob>;
  assignments: Map<string, AssignmentVersion>;
  heads: Map<string, AssignmentHead>;
  events: Map<string, AssessmentEvent>;
}

function conflict(latestRevision?: number): never {
  throw new DomainError("VERSION_CONFLICT", "测试仓库的预期修订号已过期。", { status: 409, latestRevision });
}

function save<T extends { readonly id: string; readonly revision: number }>(rows: Map<string, T>, row: T, expected: number | null): void {
  if (!Number.isSafeInteger(row.revision) || row.revision !== (expected === null ? 1 : expected + 1) ||
    (expected !== null && (!Number.isSafeInteger(expected) || expected < 1))) {
    throw new DomainError("INVALID_REVISION", "测试仓库修订号必须逐次增加。");
  }
  const current = rows.get(row.id);
  if (expected === null ? current !== undefined : current === undefined || current.revision !== expected) conflict(current?.revision);
  rows.set(row.id, structuredClone(row));
}

/**
 * TEST FIXTURE ONLY. Serialized transactions copy all state, commit only on success,
 * enforce CAS, and return detached values. This is deliberately absent from index.ts
 * and must never be used as the persistence adapter for a real team trial.
 */
export class MemoryAssessmentRepository implements AssessmentRepository {
  private state: FixtureState = {
    attempts: new Map(), scores: new Map(), jobs: new Map(), assignments: new Map(), heads: new Map(), events: new Map(),
  };
  private tail: Promise<void> = Promise.resolve();

  transaction<T>(work: (transaction: AssessmentTransaction) => Promise<T>): Promise<T> {
    const operation = this.tail.then(async () => {
      const state = structuredClone(this.state);
      let open = true;
      const check = (): void => { if (!open) throw new Error("Test fixture transaction is closed"); };
      const detached = <V>(value: V): V => { check(); return structuredClone(value); };
      const transaction: AssessmentTransaction = {
        getAttempt: async (id) => detached(state.attempts.get(id) ?? null),
        listAttempts: async (projectId) => detached([...state.attempts.values()].filter((entry) => entry.projectId === projectId).sort((a, b) => a.id.localeCompare(b.id))),
        listSharedSummaryRefs: async (projectId) => detached([...state.attempts.values()].filter(entry => entry.projectId === projectId && (entry.sharing.confirmedTasks.length > 0 || entry.sharing.criterionIds.length > 0)).sort((a, b) => a.id.localeCompare(b.id)).map(entry => ({ attemptId: entry.id, userId: entry.userId, membershipId: entry.membershipId, revision: entry.revision }))),
        listOwnAttempts: async (projectId, userId, membershipId) => detached([...state.attempts.values()].filter((entry) => entry.projectId === projectId && entry.userId === userId && entry.membershipId === membershipId).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))),
        saveAttempt: async (attempt, expected) => {
          check();
          const old = state.attempts.get(attempt.id);
          if (old && ["projectId", "membershipId", "userId", "questionSetId", "rubricVersionId", "createdAt"].some((key) => old[key as keyof AssessmentAttempt] !== attempt[key as keyof AssessmentAttempt])) conflict(old.revision);
          save(state.attempts, attempt, expected);
        },
        getScores: async (attemptId) => detached([...state.scores.values()].filter((entry) => entry.attemptId === attemptId).sort((a, b) => a.validatedAt.localeCompare(b.validatedAt) || a.id.localeCompare(b.id))),
        insertScore: async (score) => {
          check();
          if (state.scores.has(score.id)) throw new DomainError("SCORE_ALREADY_EXISTS", "评分历史不可覆盖。", { status: 409 });
          state.scores.set(score.id, structuredClone(score));
        },
        getJob: async (id) => detached(state.jobs.get(id) ?? null),
        findJob: async (attemptId, userId, key) => detached([...state.jobs.values()].find((entry) => entry.attemptId === attemptId && entry.userId === userId && entry.idempotencyKey === key) ?? null),
        saveJob: async (job, expected) => {
          check();
          const duplicate = [...state.jobs.values()].find((entry) => entry.id !== job.id && entry.attemptId === job.attemptId && entry.userId === job.userId && entry.idempotencyKey === job.idempotencyKey);
          if (duplicate) conflict(duplicate.revision);
          const old = state.jobs.get(job.id);
          if (old && ["attemptId", "projectId", "userId", "idempotencyKey", "inputFingerprint", "runNumber", "createdAt"].some((key) => old[key as keyof ScoringJob] !== job[key as keyof ScoringJob])) conflict(old.revision);
          save(state.jobs, job, expected);
        },
        getAssignment: async (id) => detached(state.assignments.get(id) ?? null),
        saveAssignment: async (assignment, expected) => {
          check();
          const old = state.assignments.get(assignment.id);
          if (old && ["projectId", "baseVersionId", "createdBy", "createdAt"].some((key) => old[key as keyof AssignmentVersion] !== assignment[key as keyof AssignmentVersion])) conflict(old.revision);
          save(state.assignments, assignment, expected);
        },
        getHead: async (projectId, initialize = true) => {
          check();
          if (!initialize && !state.heads.has(projectId)) return detached({ projectId, versionId: null, revision: 0 });
          if (!state.heads.has(projectId)) state.heads.set(projectId, { projectId, versionId: null, revision: 0 });
          return detached(state.heads.get(projectId)!);
        },
        saveHead: async (head, expected) => {
          check();
          if (!Number.isSafeInteger(expected) || expected < 0 || head.revision !== expected + 1) throw new DomainError("INVALID_REVISION", "分工头部修订号必须逐次增加。");
          const current = state.heads.get(head.projectId);
          if (!current || current.revision !== expected) conflict(current?.revision);
          state.heads.set(head.projectId, structuredClone(head));
        },
        appendEvent: async (event) => {
          check();
          if (state.events.has(event.eventId)) throw new DomainError("OUTBOX_EVENT_CONFLICT", "测试 outbox 事件 ID 重复。", { status: 409 });
          state.events.set(event.eventId, structuredClone(event));
        },
      };
      try {
        const result = await work(transaction);
        const returned = structuredClone(result);
        this.state = state;
        return returned;
      } finally { open = false; }
    });
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  /** Detached diagnostic snapshot for assertions; this is not a production read API. */
  inspect() {
    return structuredClone({
      attempts: [...this.state.attempts.values()], scores: [...this.state.scores.values()], jobs: [...this.state.jobs.values()],
      assignments: [...this.state.assignments.values()], heads: [...this.state.heads.values()], events: [...this.state.events.values()],
    });
  }
}
