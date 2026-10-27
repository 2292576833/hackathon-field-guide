import { AsyncLocalStorage } from "node:async_hooks";
import type { ProjectMembershipAccess } from "../../../shared/contracts.ts";
import { DomainError } from "../../../shared/errors.ts";
import type { Invitation, Project, ProjectActivity, ProjectAggregate, ProjectChangeFact, Team, TeamAggregate } from "../model.ts";
import type { ProjectsRepository } from "../ports.ts";

interface TestTransaction {
  projects: Map<string, ProjectAggregate>;
  teams: Map<string, TeamAggregate>;
  releases: Map<string, () => void>;
}

/** Test fixture only. Production code must use the PostgreSQL repository. */
export class MemoryProjectsRepository implements ProjectsRepository {
  private readonly projects = new Map<string, ProjectAggregate>();
  private readonly teams = new Map<string, TeamAggregate>();
  private readonly activities: ProjectActivity[] = [];
  private readonly facts: ProjectChangeFact[] = [];
  private readonly acknowledgedFacts = new Set<string>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly context = new AsyncLocalStorage<TestTransaction>();
  private commitFailure: Error | null = null;

  /** Simulates a persistence failure after business work, before any commit. */
  failNextCommit(error = new Error("test persistence failure")): void { this.commitFailure = error; }

  inspectProject(projectId: string): ProjectAggregate {
    const aggregate = this.projects.get(projectId);
    if (!aggregate) throw new DomainError("PROJECT_UNAVAILABLE", "项目不存在。", { status: 404 });
    return structuredClone({ ...aggregate, activities: this.activities.filter((item) => item.projectId === projectId), facts: this.facts.filter((item) => item.projectId === projectId) });
  }

  inspectTeam(teamId: string): TeamAggregate {
    const aggregate = this.teams.get(teamId);
    if (!aggregate) throw new DomainError("TEAM_UNAVAILABLE", "队伍不存在。", { status: 404 });
    return structuredClone(aggregate);
  }

  private async acquire(transaction: TestTransaction, scope: string): Promise<void> {
    if (transaction.releases.has(scope)) return;
    const previous = this.tails.get(scope) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.tails.set(scope, tail);
    await previous;
    transaction.releases.set(scope, () => {
      release();
      if (this.tails.get(scope) === tail) this.tails.delete(scope);
    });
  }

  private async transaction<T>(work: (transaction: TestTransaction) => Promise<T>): Promise<T> {
    const current = this.context.getStore();
    if (current) return work(current);
    const transaction: TestTransaction = { projects: new Map(), teams: new Map(), releases: new Map() };
    return this.context.run(transaction, async () => {
      try {
        const result = await work(transaction);
        if (this.commitFailure) { const error = this.commitFailure; this.commitFailure = null; throw error; }
        this.commit(transaction);
        return result;
      } finally {
        for (const release of [...transaction.releases.values()].reverse()) release();
      }
    });
  }

  private commit(transaction: TestTransaction): void {
    // Prepare every clone first, so cloning failure also leaves the fixture unchanged.
    const projects = [...transaction.projects].map(([id, aggregate]) => [id, structuredClone(aggregate)] as const);
    const teams = [...transaction.teams].map(([id, aggregate]) => [id, structuredClone(aggregate)] as const);
    const newActivities = projects.flatMap(([, aggregate]) => aggregate.activities);
    const newFacts = projects.flatMap(([, aggregate]) => aggregate.facts);
    const activityIds = new Set(this.activities.map((item) => item.id));
    const factIds = new Set(this.facts.map((item) => item.eventId));
    for (const item of newActivities) {
      if (activityIds.has(item.id)) throw new Error("duplicate activity in test fixture");
      activityIds.add(item.id);
    }
    for (const item of newFacts) {
      if (factIds.has(item.eventId)) throw new Error("duplicate fact in test fixture");
      factIds.add(item.eventId);
    }
    for (const [id, aggregate] of projects) this.projects.set(id, { ...aggregate, activities: [], facts: [] });
    for (const [id, aggregate] of teams) this.teams.set(id, aggregate);
    this.activities.push(...newActivities);
    this.facts.push(...newFacts);
  }

  async createProject(aggregate: ProjectAggregate): Promise<void> {
    await this.transaction(async (transaction) => {
      if (aggregate.project.teamId) {
        await this.withTeam(aggregate.project.teamId, async (team) => {
          if (!team.members.some((item) => item.userId === aggregate.project.createdBy && item.status === "active")) throw new DomainError("TEAM_UNAVAILABLE", "你尚未加入该队伍。", { status: 404 });
          if (team.team.status !== "active") throw new DomainError("TEAM_DISSOLVED", "队伍已解散。", { status: 409 });
        });
      }
      await this.acquire(transaction, `project:${aggregate.project.id}`);
      if (this.projects.has(aggregate.project.id) || transaction.projects.has(aggregate.project.id)) throw new Error("duplicate project in test fixture");
      transaction.projects.set(aggregate.project.id, structuredClone(aggregate));
    });
  }

  async createTeam(aggregate: TeamAggregate): Promise<void> {
    await this.transaction(async (transaction) => {
      await this.acquire(transaction, `team:${aggregate.team.id}`);
      if (this.teams.has(aggregate.team.id) || transaction.teams.has(aggregate.team.id)) throw new Error("duplicate team in test fixture");
      transaction.teams.set(aggregate.team.id, structuredClone(aggregate));
    });
  }

  async withProject<T>(projectId: string, work: (aggregate: ProjectAggregate) => Promise<T>): Promise<T> {
    return this.transaction(async (transaction) => {
      await this.acquire(transaction, `project:${projectId}`);
      let aggregate = transaction.projects.get(projectId);
      if (!aggregate) {
        const stored = this.projects.get(projectId);
        if (!stored) throw new DomainError("PROJECT_UNAVAILABLE", "项目不存在。", { status: 404 });
        aggregate = structuredClone(stored);
        aggregate.activities = []; aggregate.facts = [];
        transaction.projects.set(projectId, aggregate);
      }
      return work(aggregate);
    });
  }

  async withTeam<T>(teamId: string, work: (aggregate: TeamAggregate) => Promise<T>): Promise<T> {
    return this.transaction(async (transaction) => {
      await this.acquire(transaction, `team:${teamId}`);
      let aggregate = transaction.teams.get(teamId);
      if (!aggregate) {
        const stored = this.teams.get(teamId);
        if (!stored) throw new DomainError("TEAM_UNAVAILABLE", "队伍不存在。", { status: 404 });
        aggregate = structuredClone(stored);
        transaction.teams.set(teamId, aggregate);
      }
      return work(aggregate);
    });
  }

  async getMembership(projectId: string, userId: string): Promise<ProjectMembershipAccess | null> {
    const aggregate = this.context.getStore()?.projects.get(projectId) ?? this.projects.get(projectId);
    const member = aggregate?.members.find((item) => item.userId === userId);
    if (!member) return null;
    const { membershipId, role, status } = member;
    return { membershipId, projectId, userId, role, status };
  }

  async findInvitationByHash(tokenHash: string): Promise<Pick<Invitation, "scopeType" | "scopeId"> | null> {
    const transaction = this.context.getStore();
    const projects = new Map([...this.projects, ...(transaction?.projects ?? [])]);
    const teams = new Map([...this.teams, ...(transaction?.teams ?? [])]);
    const invitation = [...projects.values(), ...teams.values()].flatMap((item) => item.invitations).find((item) => item.tokenHash === tokenHash);
    return invitation ? { scopeType: invitation.scopeType, scopeId: invitation.scopeId } : null;
  }

  async listProjects(userId: string): Promise<Project[]> {
    const transaction = this.context.getStore();
    return structuredClone([...new Map([...this.projects, ...(transaction?.projects ?? [])]).values()].filter((item) => item.members.some((member) => member.userId === userId && member.status === "active")).map((item) => item.project));
  }

  async listTeams(userId: string): Promise<Team[]> {
    const transaction = this.context.getStore();
    return structuredClone([...new Map([...this.teams, ...(transaction?.teams ?? [])]).values()].filter((item) => item.members.some((member) => member.userId === userId && member.status === "active")).map((item) => item.team));
  }

  async listActivities(projectId: string, limit: number): Promise<ProjectActivity[]> {
    const staged = this.context.getStore()?.projects.get(projectId)?.activities ?? [];
    return structuredClone([...this.activities.filter((item) => item.projectId === projectId), ...staged].reverse().slice(0, limit));
  }

  async listPendingFacts(limit: number): Promise<ProjectChangeFact[]> {
    return structuredClone(this.facts.filter((item) => !this.acknowledgedFacts.has(item.eventId)).slice(0, limit));
  }

  async acknowledgeFact(eventId: string): Promise<void> { this.acknowledgedFacts.add(eventId); }
}
