import { DomainError } from "../../../shared/errors.ts";
import type { Actor, ProjectMembershipAccess } from "../../../shared/contracts.ts";
import type { AuditEvent, Dependencies, Document, DocumentTransaction, EvidenceRef, EvidenceState, RetrospectiveRepository } from "../domain.ts";
import { RetrospectiveService } from "../service.ts";

/** Test fixture only. The application must inject PostgreSQL persistence. */
export class TestRepository implements RetrospectiveRepository {
  documents = new Map<string, Document>();
  versions = new Map<string, Document>();
  events: AuditEvent[] = [];
  private transactionTail: Promise<void> = Promise.resolve();
  async get(id: string) { return structuredClone(this.documents.get(id) ?? null); }
  async getVersion(id: string, revision: number) { return structuredClone(this.versions.get(`${id}:${revision}`) ?? null); }
  async insert(document: Document, event: AuditEvent) {
    if (this.documents.has(document.id)) throw new DomainError("VERSION_CONFLICT", "重复记录。", { status: 409 });
    this.documents.set(document.id, structuredClone(document));
    this.versions.set(`${document.id}:${document.revision}`, structuredClone(document));
    this.events.push(structuredClone(event));
  }
  async replace(document: Document, expected: number, event: AuditEvent) {
    const current = this.documents.get(document.id);
    if (!current || current.revision !== expected) throw new DomainError("VERSION_CONFLICT", "版本冲突。", { status: 409, latestRevision: current?.revision });
    this.documents.set(document.id, structuredClone(document));
    this.versions.set(`${document.id}:${document.revision}`, structuredClone(document));
    this.events.push(structuredClone(event));
  }
  async deletePersonal(id: string, ownerId: string, expected: number, event: AuditEvent) {
    const current = this.documents.get(id);
    if (!current || current.ownerId !== ownerId || current.scope !== "personal" || current.revision !== expected) throw new DomainError("VERSION_CONFLICT", "版本冲突。", { status: 409 });
    this.documents.delete(id);
    for (const key of this.versions.keys()) if (key.startsWith(`${id}:`)) this.versions.delete(key);
    this.events.push(structuredClone(event));
  }
  async list(input: { ownerId: string; projectId?: string; kind: Document["kind"]; limit: number; afterId?: string; personalOnly?: boolean }) {
    return [...this.documents.values()].filter(doc => doc.kind === input.kind && (!input.projectId || doc.projectId === input.projectId) && ((doc.scope === "personal" && doc.ownerId === input.ownerId) || (!input.personalOnly && doc.scope === "project" && Boolean(input.projectId))) && (!input.afterId || doc.id > input.afterId)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, input.limit).map(doc => structuredClone(doc));
  }
  async transaction<T>(work: (transaction: DocumentTransaction) => Promise<T>): Promise<T> {
    const previous = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    const savedDocuments = structuredClone(this.documents), savedVersions = structuredClone(this.versions), savedEvents = structuredClone(this.events);
    try { return await work(this); }
    catch (error) { this.documents = savedDocuments; this.versions = savedVersions; this.events = savedEvents; throw error; }
    finally { release(); }
  }
}
export const alice: Actor = { userId: "alice", platformRoles: ["user"] };
export const bob: Actor = { userId: "bob", platformRoles: ["admin"] };
export const charlie: Actor = { userId: "charlie", platformRoles: ["user"] };
export const manualAnswers = { goalAndOutcome: "做出了最小演示", blockerAndResponse: "无法确认", helpfulPractice: "提前准备视频", scopeReduction: "删掉排行榜", nextChange: "提前试上传" };
export const ref: EvidenceRef = { kind: "task", id: "task-1", revision: 1 };
export const content = { answers: manualAnswers, evidenceRefs: [ref], tools: [] };
export const cardContent = { title: "提前准备素材", scenario: "新人短时赛事", advice: ["提前明确负责人", "尽早试上传"], conditions: "要求演示视频", limitations: "没有上传记录时无法确认", evidenceRefs: [ref], tools: [] };
export function fixture(overrides: Partial<Dependencies> = {}) {
  const repository = new TestRepository();
  let counter = 0;
  const memberships = new Map<string, ProjectMembershipAccess>();
  for (const projectId of ["p1", "p2"]) for (const userId of ["alice", "bob", "charlie"]) memberships.set(`${projectId}:${userId}`, { membershipId: `${projectId}-${userId}`, projectId, userId, role: userId === "bob" ? "manager" : "member", status: "active" });
  const evidence = new Map<string, EvidenceState>([["task-1", { ref, projectId: "p1", state: "available", projectShareable: true, title: "上传视频" }]]);
  const reviewed = new Set(["resource-1"]), archived = new Set<string>();
  const dependencies: Dependencies = {
    repository,
    access: { async getMembership(projectId, userId) { return memberships.get(`${projectId}:${userId}`) ?? null; } },
    projects: { async isArchived(projectId) { return archived.has(projectId); } },
    evidence: { async resolve(_actor, _projectId, refs) { return refs.flatMap(item => evidence.has(item.id) ? [evidence.get(item.id)!] : []); } },
    resources: { async isReviewed(id) { return reviewed.has(id); } },
    generationBudget: { async reserve() { /* Test fixture; production supplies an atomic persisted budget. */ } },
    clock: { now() { return new Date("2026-10-08T10:00:00Z"); } }, ids: { next() { return `id-${String(++counter).padStart(5, "0")}`; } },
    ...overrides,
  };
  return { service: new RetrospectiveService(dependencies), dependencies, repository, memberships, evidence, reviewed, archived };
}
export function hasCode(code: string) { return (error: unknown) => error instanceof DomainError && error.code === code; }
