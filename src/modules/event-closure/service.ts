import type { Clock, IdGenerator } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import type { EventParticipationPort, HostedEventAccessPort, HostedEventScope, OrganizerPrincipal } from "../../shared/organizer-contracts.ts";
import type {
  ContactWillingness, ContactWillingnessInput, ContactWillingnessWithdrawInput, EventClosureSourcePort,
  MyContactWillingness, OrganizerContactWillingness, PostEventSummary,
} from "./model.ts";
import * as store from "./postgres.ts";
import {
  activeWillingness, contactWillingnessChoice, contactWillingnessId, contactWillingnessIdempotencyKey,
  contactWillingnessRevision, contactWillingnessTeamId, myContactWillingnessView, organizerContactWillingness,
  postEventSummary as buildPostEventSummary, text,
} from "./policy.ts";

/**
 * 赛后闭环服务（规划 33 P09 / 缺口 N6）。
 *
 * **写路径只有一条**：`submitContactWillingness` / `withdrawContactWillingness` 写
 * `ec_contact_willingness`（唯一新事实）。其余方法全部只读派生，复用既有记录：
 * - 主办方侧 `postEventSummary` 只通过 `EventClosureSourcePort` 读取既有事实；
 * - 队伍侧 `myContactWillingness` 只返回本队历史，并指回既有 `my-checklists` 与 M07 复盘入口。
 *
 * 复盘写路径**完全复用既有 M07**：本服务不创建、不更新任何复盘条目，也没有第二个复盘写入点。
 */
export interface EventClosureDependencies {
  database: DatabasePort;
  clock: Clock;
  ids: IdGenerator;
  events: HostedEventAccessPort;
  participation: EventParticipationPort;
  source: EventClosureSourcePort;
  /** 由 root 提供；默认 `judging_manage`（赛后成果与公布口径同评审管理权限）。 */
  staffCapability?: "judging_manage" | "event_manage";
}

export function createEventClosureService(deps: EventClosureDependencies) {
  const { database, clock, ids, events, participation, source } = deps;
  const capability = deps.staffCapability ?? "judging_manage";
  function fail(code: string, message: string, status = 409): never { throw new DomainError(code, message, { status }); }
  const now = () => clock.now().toISOString();

  async function transact<T>(principal: OrganizerPrincipal, eventId: string, mutate: boolean, work: (sql: SqlExecutor, scope: HostedEventScope) => Promise<T>): Promise<T> {
    return database.transaction(async sql => {
      await principal.guard(sql);
      const scope = await events.getEvent(sql, text(eventId, "赛事", 160), { forUpdate: mutate });
      if (!scope) fail("EVENT_NOT_FOUND", "没有找到这场比赛。", 404);
      if (mutate && scope.status === "archived") fail("CLOSURE_EVENT_READ_ONLY", "比赛已归档，赛后闭环只能查看既有记录。");
      const output = await work(sql, scope);
      await principal.guard(sql);
      return output;
    });
  }

  async function staff(sql: SqlExecutor, principal: OrganizerPrincipal, scope: HostedEventScope): Promise<void> {
    const current = await events.requireStaff(sql, principal.actor, scope.eventId, capability);
    if (current.organizationId !== scope.organizationId || current.eventId !== scope.eventId) fail("EVENT_SCOPE_MISMATCH", "当前赛事权限不匹配。", 403);
  }

  /**
   * 成员资格双重校验（沿用 event-judging 申诉口径）：
   * ① 当前队伍名单包含本人；② 该队**最新正式收件回执**的成员快照也包含本人。
   * 队长不能凭身份替其他成员决定，也不能为没有正式交件的队伍选择。
   */
  async function participantTeam(sql: SqlExecutor, principal: OrganizerPrincipal, scope: HostedEventScope, teamId: string) {
    const roster = await participation.getTeam(sql, scope.eventId, teamId);
    if (!roster || roster.organizationId !== scope.organizationId || roster.eventId !== scope.eventId || roster.status === "withdrawn")
      fail("CLOSURE_TEAM_ACCESS_DENIED", "当前账号无法访问这支队伍。", 403);
    if (!roster.memberUserIds.includes(principal.actor.userId))
      fail("CLOSURE_TEAM_ACCESS_DENIED", "只有本队当前成员可以查看或提交这项选择。", 403);
    const receipts = await source.intakeReceipts(sql, scope.eventId);
    const latest = receipts.filter(receipt => receipt.teamId === teamId).sort((left, right) => right.version - left.version)[0] ?? null;
    if (!latest) fail("CLOSURE_TEAM_NOT_PARTICIPATED", "本场没有找到这支队伍的正式收件记录；正式交件后才能选择是否愿意被联系。");
    if (!latest.memberUserIds.includes(principal.actor.userId))
      fail("CLOSURE_TEAM_ACCESS_DENIED", "你不在该作品正式收件时的队伍成员名单中，不能提交这项选择。", 403);
    return { roster, receipt: latest };
  }

  return {
    /**
     * 主办方侧赛后闭环：**只读派生**。
     * 只列已公布/已批准内容与既有记录（每项都带回既有路径），并投影唯一新增事实中
     * 主动选择「愿意被联系」的队伍。不预测成果、不排名、不新增状态。
     */
    postEventSummary(principal: OrganizerPrincipal, eventId: string): Promise<PostEventSummary> {
      return transact(principal, eventId, false, async (sql, scope) => {
        await staff(sql, principal, scope);
        const receipts = await source.intakeReceipts(sql, scope.eventId);
        const published = await source.publishedResults(sql, scope.eventId);
        const reuse = await source.reuseSources(sql, scope.eventId);
        const projectIds: string[] = [];
        for (const teamId of [...new Set(receipts.map(receipt => receipt.teamId))]) {
          const roster = await participation.getTeam(sql, scope.eventId, teamId);
          if (roster?.projectId && !projectIds.includes(roster.projectId)) projectIds.push(roster.projectId);
        }
        let retrospectives: PostEventSummary["outcomes"]["retrospectives"];
        if (source.confirmedRetrospectiveCounts) {
          const counts = projectIds.length ? await source.confirmedRetrospectiveCounts(sql, scope.eventId, projectIds) : [];
          const confirmedCount = counts.reduce((sum, item) => sum + (Number.isFinite(item.confirmedCount) ? item.confirmedCount : 0), 0);
          retrospectives = { confirmedCount, linkedProjectCount: projectIds.length, state: "read", notice: null };
        } else {
          retrospectives = { confirmedCount: null, linkedProjectCount: projectIds.length, state: "unread",
            notice: "尚未接入复盘读取，这里不显示 0；接入后只统计已确认的复盘条目，不读取未提交草稿。" };
        }
        const willingness = await store.listWillingness(sql, scope);
        const summary = buildPostEventSummary({
          event: { eventId: scope.eventId, organizationId: scope.organizationId, title: scope.title, status: scope.status,
            timezone: scope.timezone, startsAt: scope.startsAt, endsAt: scope.endsAt, submissionClosesAt: scope.submissionClosesAt,
            afterEvent: Date.parse(now()) >= Date.parse(scope.endsAt) },
          receipts, published, reuse, retrospectives, willingness,
        });
        await staff(sql, principal, scope);
        return summary;
      });
    },

    /** 主办方侧联系意愿：只显示主动愿意的队伍，不显示未选择/不愿意，也不报告数量。 */
    eventContactWillingness(principal: OrganizerPrincipal, eventId: string): Promise<{ items: readonly OrganizerContactWillingness[]; visibleCount: number; notice: string; limitations: readonly string[] }> {
      return transact(principal, eventId, false, async (sql, scope) => {
        await staff(sql, principal, scope);
        const items = organizerContactWillingness(await store.listWillingness(sql, scope));
        await staff(sql, principal, scope);
        return { items, visibleCount: items.length,
          notice: "只显示主动选择「愿意被联系」的队伍；未选择或选择不愿意的队伍不在这里出现，也不显示数量。",
          limitations: ["联系意愿只对本场主办方可见，不进入跨赛事检索或公开面。", "它只表示同意就本队成果被联系，不代表获奖、投资、录用或孵化机会。"] };
      });
    },

    /** 队伍侧：本队自己的选择与历史，并指回既有赛后清单与既有复盘入口（不另做一份）。 */
    myContactWillingness(principal: OrganizerPrincipal, eventId: string, teamId: string): Promise<MyContactWillingness> {
      return transact(principal, eventId, false, async (sql, scope) => {
        const { roster } = await participantTeam(sql, principal, scope, contactWillingnessTeamId(teamId));
        const records = (await store.listWillingness(sql, scope)).filter(record => record.teamId === roster.id);
        const view = myContactWillingnessView({ eventId: scope.eventId, teamId: roster.id, memberCount: roster.memberUserIds.length, projectId: roster.projectId, records });
        await participantTeam(sql, principal, scope, contactWillingnessTeamId(teamId));
        return view;
      });
    },

    /**
     * 提交/重新提交本队的选择。一队一条有效记录；撤回后可重提；
     * 同一重试标识幂等（重放返回原记录，同键不同输入拒绝）。
     */
    submitContactWillingness(principal: OrganizerPrincipal, eventId: string, input: ContactWillingnessInput): Promise<ContactWillingness> {
      return transact(principal, eventId, true, async (sql, scope) => {
        const teamId = contactWillingnessTeamId(input.teamId);
        const key = contactWillingnessIdempotencyKey(input.idempotencyKey);
        const willing = contactWillingnessChoice(input.willing);
        const replay = await store.findWillingnessReplay(sql, scope, principal.actor.userId, key);
        if (replay) {
          if (replay.teamId !== teamId || replay.willing !== willing)
            fail("CLOSURE_IDEMPOTENCY_KEY_REUSED", "同一重试标识已用于另一个选择，请刷新后重新提交。");
          await participantTeam(sql, principal, scope, replay.teamId);
          return replay;
        }
        await participantTeam(sql, principal, scope, teamId);
        if (await store.findActiveWillingness(sql, scope, teamId))
          fail("CLOSURE_ALREADY_SET", "你们队已经提交过一次选择；如需改变，请先撤回再重新提交。");
        const value: ContactWillingness = { id: ids.next(), organizationId: scope.organizationId, eventId: scope.eventId, teamId,
          authorUserId: principal.actor.userId, willing, status: "active", revision: 1, submittedAt: now(), withdrawnAt: null, idempotencyKey: key };
        try { await store.insertWillingness(sql, value); }
        catch (error) {
          // 并发下的第二笔写入由部分唯一索引拒绝；此时重读给出可理解的 409，而不是把原始错误暴露出去。
          if (await store.findActiveWillingness(sql, scope, teamId))
            fail("CLOSURE_ALREADY_SET", "你们队已经提交过一次选择；如需改变，请先撤回再重新提交。");
          throw error;
        }
        return value;
      });
    },

    /** 只有提交人本人可以撤回；撤回后主办方侧不再显示，且可以重新提交。 */
    withdrawContactWillingness(principal: OrganizerPrincipal, eventId: string, willingnessId: string, input: ContactWillingnessWithdrawInput): Promise<ContactWillingness> {
      return transact(principal, eventId, true, async (sql, scope) => {
        const record = await store.getWillingness(sql, scope, contactWillingnessId(willingnessId));
        if (!record) fail("CLOSURE_NOT_FOUND", "没有找到这条联系意愿记录。", 404);
        if (record.authorUserId !== principal.actor.userId)
          fail("CLOSURE_ACCESS_DENIED", "只有提交这条选择的本人可以撤回。", 403);
        if (record.status !== "active") fail("CLOSURE_STATE_INVALID", "这条选择已经撤回，无需再次撤回。");
        const expected = contactWillingnessRevision(input.expectedRevision);
        if (record.revision !== expected)
          throw new DomainError("CLOSURE_VERSION_CONFLICT", "记录已更新，请刷新后核对再继续。", { status: 409, latestRevision: record.revision, recoveryAction: "reload" });
        await participantTeam(sql, principal, scope, record.teamId);
        const value: ContactWillingness = { ...record, status: "withdrawn", revision: record.revision + 1, withdrawnAt: now() };
        if (!await store.updateWillingness(sql, scope, record.revision, value))
          throw new DomainError("CLOSURE_VERSION_CONFLICT", "记录已更新，请刷新后核对再继续。", { status: 409, latestRevision: record.revision, recoveryAction: "reload" });
        return value;
      });
    },

    /** 只读：本人当前队伍是否可以提交（供界面决定是否显示表单），不写任何事实。 */
    myWillingnessEligibility(principal: OrganizerPrincipal, eventId: string, teamId: string): Promise<{ teamId: string; eligible: boolean; active: OrganizerContactWillingness | null; reason: string | null }> {
      return transact(principal, eventId, false, async (sql, scope) => {
        const { roster } = await participantTeam(sql, principal, scope, contactWillingnessTeamId(teamId));
        const active = activeWillingness((await store.listWillingness(sql, scope)).filter(record => record.teamId === roster.id), roster.id);
        return { teamId: roster.id, eligible: true,
          active: active ? { teamId: active.teamId, chosenAt: active.submittedAt } : null,
          reason: active ? "你们队已经提交过一次选择；如需改变，请先由提交人撤回。" : null };
      });
    },
  };
}
export type EventClosureService = ReturnType<typeof createEventClosureService>;
