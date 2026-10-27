/** Test fixture only. Production wiring must use a persistent repository. */
import type { PageResult } from "../../../shared/contracts.ts";
import { DomainError } from "../../../shared/errors.ts";
import { deriveEventPhase } from "../domain.ts";
import type { EventRuleVersion } from "../domain.ts";
import type {
  AnalysisRun, EventAnalysis, EventCorrection, EventFilter, EventRecord, EventsAudit,
  EventsRepository, EventsUnitOfWork, ProjectRuleConfirmation, PublicEvent,
} from "../model.ts";

interface Store {
  events: Map<string, EventRecord>;
  rules: Map<string, EventRuleVersion>;
  confirmations: Map<string, ProjectRuleConfirmation>;
  analyses: Map<string, EventAnalysis>;
  runs: Map<string, AnalysisRun>;
  corrections: Map<string, EventCorrection>;
  audits: Map<string, EventsAudit>;
}
function emptyStore(): Store {
  return { events: new Map(), rules: new Map(), confirmations: new Map(), analyses: new Map(), runs: new Map(), corrections: new Map(), audits: new Map() };
}
function clone<T>(value: T): T { return structuredClone(value); }
function ruleKey(eventId: string, version: number): string { return JSON.stringify([eventId, version]); }
function conflict(latestRevision?: number): never {
  throw new DomainError("VERSION_CONFLICT", "内容已被更新，请查看最新版本后重试。", { status: 409, recoveryAction: "review_latest_version", latestRevision });
}
function read<T>(map: Map<string, T>, key: string): T | null {
  const value = map.get(key);
  return value === undefined ? null : clone(value);
}
function insert<T>(map: Map<string, T>, key: string, value: T): void {
  if (map.has(key)) conflict();
  map.set(key, clone(value));
}
function compareAndSave<T extends { revision: number }>(map: Map<string, T>, key: string, value: T, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected < 0 || value.revision !== expected + 1) {
    throw new DomainError("INVALID_REVISION", "写入版本必须递增一次。");
  }
  const current = map.get(key);
  if ((current?.revision ?? 0) !== expected || (expected === 0 && current !== undefined)) conflict(current?.revision ?? 0);
  map.set(key, clone(value));
}

class MemoryEventsUnitOfWork implements EventsUnitOfWork {
  protected store: Store;
  constructor(store: Store) { this.store = store; }
  async getEvent(id: string): Promise<EventRecord | null> { return read(this.store.events, id); }
  async saveEvent(value: EventRecord, expected: number): Promise<void> { compareAndSave(this.store.events, value.id, value, expected); }
  async getRules(eventId: string, version: number): Promise<EventRuleVersion | null> { return read(this.store.rules, ruleKey(eventId, version)); }
  async insertRules(value: EventRuleVersion): Promise<void> { insert(this.store.rules, ruleKey(value.eventId, value.version), value); }
  async getConfirmation(projectId: string): Promise<ProjectRuleConfirmation | null> { return read(this.store.confirmations, projectId); }
  async saveConfirmation(value: ProjectRuleConfirmation, expected: number): Promise<void> { compareAndSave(this.store.confirmations, value.projectId, value, expected); }
  async getAnalysis(id: string): Promise<EventAnalysis | null> { return read(this.store.analyses, id); }
  async saveAnalysis(value: EventAnalysis, expected: number): Promise<void> { compareAndSave(this.store.analyses, value.id, value, expected); }
  async getRun(id: string): Promise<AnalysisRun | null> { return read(this.store.runs, id); }
  async findRun(projectId: string, actorId: string, key: string): Promise<AnalysisRun | null> {
    const value = Array.from(this.store.runs.values()).find(run => run.projectId === projectId && run.actorId === actorId && run.idempotencyKey === key);
    return value ? clone(value) : null;
  }
  async saveRun(value: AnalysisRun, expected: number): Promise<void> {
    const duplicate = Array.from(this.store.runs.values()).find(run => run.id !== value.id && run.projectId === value.projectId && run.actorId === value.actorId && run.idempotencyKey === value.idempotencyKey);
    if (duplicate) conflict();
    compareAndSave(this.store.runs, value.id, value, expected);
  }
  async insertCorrection(value: EventCorrection): Promise<void> { insert(this.store.corrections, value.id, value); }
  async appendAudit(value: EventsAudit): Promise<void> { insert(this.store.audits, value.id, value); }
}

export class MemoryEventsRepository extends MemoryEventsUnitOfWork implements EventsRepository {
  private transactionTail: Promise<void> = Promise.resolve();
  constructor() { super(emptyStore()); }

  async transaction<T>(work: (transaction: EventsUnitOfWork) => Promise<T>): Promise<T> {
    const predecessor = this.transactionTail;
    let unlock!: () => void;
    this.transactionTail = new Promise<void>(resolve => { unlock = resolve; });
    await predecessor;
    // Each transaction gets isolated Maps. Failure discards every partial write,
    // including immutable rules and audits, before the next transaction proceeds.
    const pending = clone(this.store);
    try {
      const result = await work(new MemoryEventsUnitOfWork(pending));
      this.store = pending;
      return clone(result);
    } finally { unlock(); }
  }

  async listPublished(filter: EventFilter, now: Date): Promise<PageResult<PublicEvent>> {
    const limit = filter.limit ?? 20;
    const matches: PublicEvent[] = [];
    const events = Array.from(this.store.events.values()).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    for (const event of events) {
      if (event.publicationStatus === "archived" || event.publishedVersion === null || (filter.cursor && event.id <= filter.cursor)) continue;
      const rules = this.store.rules.get(ruleKey(event.id, event.publishedVersion));
      if (!rules) continue;
      if (filter.query && !rules.metadata.name.toLocaleLowerCase().includes(filter.query.toLocaleLowerCase())) continue;
      if (filter.region && rules.metadata.region !== filter.region) continue;
      if (filter.format && rules.metadata.format !== filter.format) continue;
      const verifiedBeginner = rules.facts.some(fact => fact.key === "beginner_eligibility" && fact.status === "verified");
      if (filter.beginnerEligibility === "verified" && !verifiedBeginner) continue;
      if (filter.beginnerEligibility === "unknown" && verifiedBeginner) continue;
      if (filter.phase && deriveEventPhase(rules, now) !== filter.phase) continue;
      matches.push(clone({ event, rules }));
      if (matches.length > limit) break;
    }
    return { items: matches.slice(0, limit), nextCursor: matches.length > limit ? matches[limit - 1]!.event.id : null };
  }

  inspect() {
    return clone({
      events: Array.from(this.store.events.values()), rules: Array.from(this.store.rules.values()),
      confirmations: Array.from(this.store.confirmations.values()), analyses: Array.from(this.store.analyses.values()),
      runs: Array.from(this.store.runs.values()), corrections: Array.from(this.store.corrections.values()),
      audits: Array.from(this.store.audits.values()),
    });
  }
}
