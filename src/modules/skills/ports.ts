import type { Actor, Clock, IdGenerator } from "../../shared/contracts.ts";
import type { InstallationPlan, InstallationReceipt, Skill, TrackBundle } from "./domain.ts";
export interface PlanRecord { plan: InstallationPlan; bridgeTokenHash: string | null }
export interface SkillsTransaction {
  getSkill(id: string, lock?: boolean): Promise<Skill | null>;
  putSkill(skill: Skill, onlyIfAbsent?: boolean): Promise<void>;
  getBundle(id: string, lock?: boolean): Promise<TrackBundle | null>;
  putBundle(bundle: TrackBundle, onlyIfAbsent?: boolean): Promise<void>;
  getPlan(id: string, lock?: boolean): Promise<PlanRecord | null>;
  insertPlan(record: PlanRecord): Promise<void>;
  savePlan(record: PlanRecord, expectedRevision: number): Promise<void>;
  getReceipt(id: string): Promise<InstallationReceipt | null>;
  putReceipt(receipt: InstallationReceipt, userId: string): Promise<void>;
  appendAudit(input: { id: string; actorId: string; action: string; targetId: string; at: string; reason: string }): Promise<void>;
}
export interface SkillsRepository {
  transaction<T>(work: (tx: SkillsTransaction) => Promise<T>): Promise<T>;
  listSkills(): Promise<readonly Skill[]>;
  listBundles(): Promise<readonly TrackBundle[]>;
  listPlans(userId: string): Promise<readonly InstallationPlan[]>;
  listReceipts(userId: string): Promise<readonly InstallationReceipt[]>;
}
export interface SkillsDependencies { repository: SkillsRepository; clock: Clock; ids: IdGenerator; randomToken?: () => string }
export interface SkillsHttpDependencies { service: import("./service.ts").SkillsService; resolveActor(request: Request): Promise<Actor | null>; assertMutationAllowed(request: Request, actor: Actor): Promise<void>; requestId(): string }
