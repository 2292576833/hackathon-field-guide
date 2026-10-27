import type { Actor, ProjectMembershipAccess } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { OwnPlanningNotification, PlanningNotification, PlanningNotificationCause, PlanningNotificationDependencies, PlanningNotificationFact, PlanningNotificationProject, PlanningNotificationReceipt, PlanningNotificationTransaction } from "./notification-types.ts";

const wording: Record<PlanningNotificationCause, { title: string; message: string; page: "plan" | "rules" }> = {
  deadline_risk: { title: "截止安排需要核对", message: "当前任务与可用时间出现截止风险。请查看具体缺口，和队友决定调整范围或安排。", page: "plan" },
  owner_changed: { title: "负责人安排需要重新核对", message: "当前成员或任务负责人发生变化。请核对谁负责、谁协助和谁检查成果。", page: "plan" },
  availability_changed: { title: "队友的可用时间有变化", message: "工作时间窗口与生效计划的依据不同，请重新检查任务能否排下。", page: "plan" },
  rules_changed: { title: "赛事要求需要重新核对", message: "当前确认要求与生效计划的依据不同。请查看规则变化，再决定如何调整任务。", page: "rules" },
  input_changed: { title: "计划依据需要重新核对", message: "目标、分工、赛道或引用资料等依据有变化，请核对影响后再准备新草案。", page: "plan" },
  deliverable_review: { title: "有成果等你们检查", message: "任务已进入待检查。请按任务中的检查条件核对成果，再确认是否通过。", page: "plan" },
  task_blocked: { title: "有任务需要协助", message: "任务记录了阻塞。请查看原因，和负责人确认下一步或可并行准备的工作。", page: "plan" },
  acceptance_correction_requested: { title: "已通过的成果收到更正请求", message: "队友请求重新核对检查结果。请由项目管理员查看理由与后续影响。", page: "plan" },
};
export function planningNotificationHref(projectId: string, cause: PlanningNotificationCause): string { return `/app/projects/${encodeURIComponent(projectId)}/${wording[cause].page}`; }
function validFact(fact: PlanningNotificationFact): void {
  if (!Object.hasOwn(wording, fact.cause) || typeof fact.sourceRevision !== "string" || !fact.sourceRevision.trim() || fact.sourceRevision.length > 1000 || (fact.label !== undefined && (typeof fact.label !== "string" || fact.label.length > 300)) || (fact.taskId !== undefined && (typeof fact.taskId !== "string" || !fact.taskId.trim())) || (fact.requiresAction !== undefined && typeof fact.requiresAction !== "boolean")) throw new DomainError("NOTIFICATION_SNAPSHOT_INVALID", "提醒依据无法读取，请重新核对计划。", { status: 500 });
}
function key(fact: Pick<PlanningNotificationFact, "cause" | "sourceRevision">): string { return JSON.stringify([fact.cause, fact.sourceRevision]); }
function currentMembers(project: PlanningNotificationProject): ProjectMembershipAccess[] { return project.members.filter(member => member.projectId === project.projectId && member.status === "active"); }
function identities(project: PlanningNotificationProject | null): string { return JSON.stringify(project ? [project.projectId, project.archived, currentMembers(project).map(member => [member.userId, member.membershipId, member.role]).sort()] : null); }
function owned(project: PlanningNotificationProject | null, actor: Actor): ProjectMembershipAccess | null { return project ? currentMembers(project).find(member => member.userId === actor.userId) ?? null : null; }
function limit(value = 50): number { if (!Number.isSafeInteger(value) || value < 1 || value > 200) throw new DomainError("INVALID_INPUT", "提醒条数需要是 1 到 200 的整数。"); return value; }
function notFound(): DomainError { return new DomainError("NOT_FOUND", "这条提醒当前不可查看。", { status: 404 }); }

/** Only persisted notifications. Model generation and plan application are absent from these ports. */
export class PlanningNotificationService {
  private dependencies: PlanningNotificationDependencies;
  constructor(dependencies: PlanningNotificationDependencies) { this.dependencies = dependencies; }
  private async project(projectId: string, tx: PlanningNotificationTransaction): Promise<PlanningNotificationProject | null> {
    const project = await this.dependencies.projects.lockProject(projectId, tx.sql);
    if (project && project.projectId !== projectId) throw new DomainError("NOTIFICATION_PROJECT_INVALID", "提醒项目依据不一致，请重新核对。", { status: 500 });
    return project;
  }
  private async stable(projectId: string, tx: PlanningNotificationTransaction, before: PlanningNotificationProject | null): Promise<void> {
    if (identities(before) !== identities(await this.project(projectId, tx))) throw new DomainError("NOTIFICATION_INPUT_CHANGED", "项目权限刚刚变化，请稍后重新检查提醒。", { status: 409 });
  }
  async pendingProjectIds(count = 50, afterProjectId?: string): Promise<string[]> { return this.dependencies.repository.pendingProjectIds(limit(count), afterProjectId); }
  async reconcileProject(projectId: string): Promise<{ events: number; created: number; recipients: number; resolved: number }> {
    return this.dependencies.repository.transaction(projectId, async tx => {
      const project = await this.project(projectId, tx);
      const now = this.dependencies.clock.now().toISOString();
      const events = await tx.claimEvents(200);
      const members = project ? currentMembers(project) : [];
      await tx.revokeRecipients(members, now);
      const snapshot = project && !project.archived && members.length ? await this.dependencies.snapshots.readSnapshot(projectId, tx.sql, now) : { facts: [] };
      const active = new Map<string, PlanningNotificationFact>();
      for (const fact of snapshot.facts) { validFact(fact); active.set(key(fact), fact); }
      const previous = await tx.list();
      let created = 0, recipients = 0, resolved = 0;
      if (project) {
        for (const record of previous) if (!record.resolvedAt && (project.archived || !active.has(key(record)))) { await tx.resolve(record.id, now); resolved++; }
      }
      if (project && !project.archived) {
        for (const fact of active.values()) {
          let record = previous.find(value => key(value) === key(fact));
          // A real resolved→active transition reuses its identity; unchanged snapshots never resend it.
          if (record?.resolvedAt) { await tx.reopen(record.id, now); record.resolvedAt = null; record.updatedAt = now; }
          if (!record) {
            const copy = wording[fact.cause];
            const informationalOwnerChange = fact.cause === "owner_changed" && fact.requiresAction === false;
            record = { id: this.dependencies.ids.next(), projectId, cause: fact.cause, sourceRevision: fact.sourceRevision, requiresAction: fact.requiresAction !== false, title: informationalOwnerChange ? "任务负责人安排有更新" : copy.title, message: `${fact.label ? `“${fact.label}”：` : ""}${informationalOwnerChange ? "生效计划采用了新的负责、协助或检查安排。请查看当前任务；收起只表示本人已知悉。" : copy.message}`, href: planningNotificationHref(projectId, fact.cause), taskId: fact.taskId ?? null, createdAt: now, updatedAt: now, resolvedAt: null };
            if (await tx.insert(record)) created++;
          }
          for (const member of members) if (await tx.ensureRecipient(record.id, member)) recipients++;
        }
      }
      await this.stable(projectId, tx, project);
      await tx.completeEvents(events, now);
      return { events: events.length, created, recipients, resolved };
    });
  }
  private async view(tx: PlanningNotificationTransaction, project: PlanningNotificationProject, actor: Actor, id: string): Promise<OwnPlanningNotification | null> {
    const member = owned(project, actor);
    if (!member) return null;
    const receipt = await tx.getReceipt(id, actor.userId);
    if (!receipt || receipt.revokedAt || receipt.dismissedAt || receipt.membershipId !== member.membershipId) return null;
    const record = (await tx.list()).find(value => value.id === id);
    return record ? this.toOwn(record, receipt, project.archived) : null;
  }
  private toOwn(record: PlanningNotification, receipt: PlanningNotificationReceipt, archived: boolean): OwnPlanningNotification {
    return { ...record, href: planningNotificationHref(record.projectId, record.cause), revision: receipt.revision, readAt: receipt.readAt, dismissedAt: receipt.dismissedAt, status: archived ? "archived" : record.resolvedAt ? "resolved" : "active" };
  }
  async listOwn(actor: Actor, options: { limit?: number; projectId?: string } = {}): Promise<OwnPlanningNotification[]> {
    const count = limit(options.limit);
    if (options.projectId !== undefined && (!options.projectId.trim() || options.projectId.length > 200)) throw new DomainError("INVALID_INPUT", "项目编号无效。");
    const result: OwnPlanningNotification[] = [];
    const seen = new Set<string>();
    let before: { updatedAt: string; id: string } | undefined;
    // Continue past inaccessible references; they must not consume the user's visible limit.
    while (result.length < count) {
      const refs = await this.dependencies.repository.ownReferences(actor.userId, { limit: 200, projectId: options.projectId, before });
      if (!refs.length) break;
      const page = new Map<string, OwnPlanningNotification>();
      for (const projectId of new Set(refs.map(ref => ref.projectId))) {
        await this.dependencies.repository.transaction(projectId, async tx => {
          const project = await this.project(projectId, tx);
          if (!project || !owned(project, actor)) return;
          const values: OwnPlanningNotification[] = [];
          for (const ref of refs.filter(value => value.projectId === projectId)) { const item = await this.view(tx, project, actor, ref.id); if (item) values.push(item); }
          await this.stable(projectId, tx, project);
          for (const item of values) page.set(item.id, item);
        });
      }
      for (const ref of refs) { const item = page.get(ref.id); if (item && !seen.has(item.id) && result.length < count) { seen.add(item.id); result.push(item); } }
      const last = refs.at(-1)!; before = { updatedAt: last.updatedAt, id: last.id };
      if (refs.length < 200) break;
    }
    return result;
  }
  async markRead(actor: Actor, id: string, command: { expectedRevision: number }): Promise<OwnPlanningNotification> { return this.mutate(actor, id, command, false); }
  async dismissResolved(actor: Actor, id: string, command: { expectedRevision: number }): Promise<OwnPlanningNotification> { return this.mutate(actor, id, command, true); }
  private async mutate(actor: Actor, id: string, command: { expectedRevision: number }, dismiss: boolean): Promise<OwnPlanningNotification> {
    if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1) throw new DomainError("INVALID_REVISION", "请提供当前提醒版本。");
    const ref = await this.dependencies.repository.locateOwn(id, actor.userId);
    if (!ref) throw notFound();
    return this.dependencies.repository.transaction(ref.projectId, async tx => {
      const project = await this.project(ref.projectId, tx);
      const item = project ? await this.view(tx, project, actor, id) : null;
      if (!project || !item) throw notFound();
      if (item.revision !== command.expectedRevision) throw new DomainError("VERSION_CONFLICT", "提醒已更新，请刷新后再处理。", { status: 409, latestRevision: item.revision });
      const receipt = (await tx.getReceipt(id, actor.userId))!;
      const now = this.dependencies.clock.now().toISOString();
      if (dismiss && !project.archived) {
        const snapshot = await this.dependencies.snapshots.readSnapshot(ref.projectId, tx.sql, now);
        for (const fact of snapshot.facts) validFact(fact);
        const active = snapshot.facts.find(fact => key(fact) === key(item));
        if (active && active.requiresAction !== false) throw new DomainError("RISK_STILL_ACTIVE", "这项提醒仍需要处理。请先核对任务或计划，再收起提醒。", { status: 409, recoveryAction: "review_plan" });
        if (!active) { await tx.resolve(id, now); item.resolvedAt ??= now; item.updatedAt = now; item.status = "resolved"; }
      }
      if (dismiss && project.archived) { await tx.resolve(id, now); item.resolvedAt ??= now; item.updatedAt = now; }
      // Marking read acknowledges only this user's receipt; it never resolves a cause or touches a plan.
      if (!receipt.readAt || dismiss) {
        receipt.readAt ??= now; if (dismiss) receipt.dismissedAt = now;
        receipt.revision++;
        await tx.saveReceipt(receipt, command.expectedRevision);
      }
      await this.stable(ref.projectId, tx, project);
      return { ...item, revision: receipt.revision, readAt: receipt.readAt, dismissedAt: receipt.dismissedAt };
    });
  }
}

export function createPlanningNotificationWorker(service: PlanningNotificationService) {
  let periodicOffset = 0;
  let preferPeriodic = true;
  let pendingCursor: string | undefined;
  let pendingBuffer: string[] = [];
  return {
    /** Root scheduler supplies project IDs for clock changes and M02/M03/M06 facts. Sequential bounded transactions. */
    async runOnce(options: { projectIds?: readonly string[]; limit?: number } = {}) {
      const count = limit(options.limit);
      if (!pendingBuffer.length) {
        pendingBuffer = await service.pendingProjectIds(count, pendingCursor);
        if (!pendingBuffer.length && pendingCursor !== undefined) { pendingCursor = undefined; pendingBuffer = await service.pendingProjectIds(count); }
        if (pendingBuffer.length) pendingCursor = pendingBuffer.at(-1);
      }
      const pending = pendingBuffer.slice(0, count);
      const periodic = [...new Set(options.projectIds ?? [])];
      const rotated = periodic.length ? [...periodic.slice(periodicOffset % periodic.length), ...periodic.slice(0, periodicOffset % periodic.length)] : [];
      const projects: string[] = [];
      for (let index = 0; projects.length < count && index < Math.max(pending.length, rotated.length); index++) {
        for (const id of preferPeriodic ? [rotated[index], pending[index]] : [pending[index], rotated[index]]) if (id && !projects.includes(id) && projects.length < count) projects.push(id);
      }
      periodicOffset += projects.filter(id => periodic.includes(id)).length;
      pendingBuffer = pendingBuffer.filter(id => !projects.includes(id));
      preferPeriodic = !preferPeriodic;
      const results: { projectId: string; events: number; created: number; recipients: number; resolved: number }[] = [];
      const errors: { projectId: string; code: string }[] = [];
      for (const projectId of projects) {
        try { results.push({ projectId, ...await service.reconcileProject(projectId) }); }
        catch (error) { errors.push({ projectId, code: error instanceof DomainError && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code) ? error.code : "NOTIFICATION_CHECK_FAILED" }); }
      }
      return { projects: results, errors, modelRequests: 0 as const };
    },
  };
}
