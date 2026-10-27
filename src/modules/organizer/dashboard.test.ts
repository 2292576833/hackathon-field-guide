import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../shared/errors.ts";
import type { EventRegistrationStatus, EventStaffCapability, OrganizerPrincipal } from "../../shared/organizer-contracts.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { eventCommunicationHttpRoute } from "../event-communication/index.ts";
import {
  DASHBOARD_PANELS, MAX_DASHBOARD_LIMIT, buildDashboard, intakePanel, judgingPanel, logisticsPanel,
  parseDashboardFilter, registrationPanel, teamPanel,
} from "./dashboard.ts";
import type {
  DashboardAccommodationRow, DashboardInput, DashboardJudgingProgress, DashboardJudgingWorkspace,
  DashboardPanel, DashboardRegistrationCounts, DashboardRegistrationRow, DashboardScheduleDraft,
  DashboardTeamRow, DashboardView, DashboardVoucherRow,
} from "./dashboard.ts";
import { createOrganizerHttpHandlers, organizerHttpRoute } from "./handlers.ts";
import type { HostedEvent, Organization, StaffGrant } from "./model.ts";
import { OrganizerService } from "./service.ts";
import type { OrganizerDashboardPort } from "./service.ts";
import type { PostgresOrganizerRepository } from "./postgres.ts";

const READ_AT = "2026-10-16T00:00:00.000Z";
const FORBIDDEN = ["预测", "成功率", "影响力", "ROI", "最佳", "排名"];

function registrationRow(id: string, userId: string, status: EventRegistrationStatus, submittedAt: string | null): DashboardRegistrationRow {
  return { id, userId, status, submittedAt, createdAt: submittedAt ?? "2026-10-01T00:00:00.000Z" };
}
function teamRow(id: string, track: string, memberUserIds: readonly string[], status: DashboardTeamRow["status"] = "forming", projectId: string | null = null): DashboardTeamRow {
  return { id, name: "队伍" + id, track, status, memberUserIds, eligible: memberUserIds.length > 0, projectId, createdAt: "2026-10-01T00:00:00.000Z" };
}
function baseInput(overrides: Partial<DashboardInput> = {}): DashboardInput {
  return {
    eventId: "e1", eventTitle: "测试赛", scope: "本场", readAt: READ_AT,
    modules: { registration: true, teams: true, icebreaking: false, judging: true, schedule: true, accommodation: true, mealVouchers: true },
    ...overrides,
  };
}
function metricValue(panel: DashboardPanel, key: string): number | undefined {
  return panel.metrics.find(item => item.key === key)?.value;
}
function brokenQuery(query: Record<string, string>): boolean {
  try { parseDashboardFilter(query); return false; }
  catch (error) { return error instanceof DomainError && error.code === "DASHBOARD_FILTER_INVALID" && error.status === 422; }
}
function jsonWithout(value: unknown): string { return JSON.stringify(value); }

// ---- 纯函数：筛选条件解析 ----

test("parseDashboardFilter 解析并校验查询串，非法值抛 422", () => {
  const parsed = parseDashboardFilter({ panel: "registration", status: "approved", track: "AI 赛道", from: "2026-10-01T00:00:00+08:00", to: "2026-10-31T00:00:00+08:00", roundId: "round-1", cursor: "c1", limit: "10" });
  assert.equal(parsed.panel, "registration");
  assert.equal(parsed.status, "approved");
  assert.equal(parsed.track, "AI 赛道");
  assert.equal(parsed.from, "2026-09-30T16:00:00.000Z");
  assert.equal(parsed.to, "2026-10-30T16:00:00.000Z");
  assert.equal(parsed.roundId, "round-1");
  assert.equal(parsed.cursor, "c1");
  assert.equal(parsed.limit, 10);
  assert.equal(parseDashboardFilter({}).limit, 50);
  assert.equal(parseDashboardFilter({ limit: "999" }).limit, MAX_DASHBOARD_LIMIT);
  assert.equal(parseDashboardFilter({ panel: "   " }).panel, undefined);
  const badQueries: Record<string, string>[] = [{ panel: "nope" }, { status: "nope" }, { from: "not-a-date" }, { from: "2026-10-02T00:00:00Z", to: "2026-10-01T00:00:00Z" }, { limit: "0" }, { limit: "1.5" }, { track: "x".repeat(101) }];
  for (const query of badQueries) {
    assert.equal(brokenQuery(query), true, "应拒绝：" + jsonWithout(query));
  }
});

// ---- 纯函数：报名 ----

const REG_COUNTS: DashboardRegistrationCounts = { counts: { draft: 0, pending: 2, approved: 3, rejected: 1, withdrawn: 0 }, pending: 2, reserved: 5 };
const REG_ROWS: readonly DashboardRegistrationRow[] = [
  registrationRow("r1", "u1", "pending", "2026-10-10T01:00:00.000Z"),
  registrationRow("r2", "u2", "approved", "2026-10-10T02:00:00.000Z"),
  registrationRow("r3", "u3", "approved", "2026-10-10T03:00:00.000Z"),
  registrationRow("r4", "u4", "approved", "2026-10-10T04:00:00.000Z"),
  registrationRow("r5", "u5", "rejected", "2026-10-10T05:00:00.000Z"),
];

test("报名面板：状态计数与既有 registrationCounts 逐一相等，真实 0 保留为 0", () => {
  const panel = registrationPanel(baseInput({ registrationCounts: REG_COUNTS, registrations: { items: REG_ROWS, nextCursor: "next" } }));
  assert.equal(metricValue(panel, "pending"), REG_COUNTS.pending);
  assert.equal(metricValue(panel, "approved"), REG_COUNTS.counts.approved);
  assert.equal(metricValue(panel, "rejected"), REG_COUNTS.counts.rejected);
  assert.equal(metricValue(panel, "withdrawn"), 0);
  assert.equal(metricValue(panel, "reserved"), REG_COUNTS.reserved);
  assert.equal(metricValue(panel, "read"), REG_ROWS.length);
  assert.equal(metricValue(panel, "matched"), REG_ROWS.length);
  assert.equal(panel.sections[0]!.nextCursor, "next");
  assert.equal(panel.available, true);
  assert.ok(panel.definitions.some(line => line.includes("数据时间：" + READ_AT)));
});

test("报名面板：按状态与时间筛选只数本页匹配行", () => {
  const input = baseInput({ registrationCounts: REG_COUNTS, registrations: { items: REG_ROWS, nextCursor: null } });
  const approved = registrationPanel(input, { status: "approved" });
  assert.equal(metricValue(approved, "matched"), 3);
  const window = registrationPanel(input, { from: "2026-10-10T03:00:00.000Z" });
  assert.equal(metricValue(window, "matched"), 3);
  const none = registrationPanel(input, { status: "withdrawn" });
  assert.equal(metricValue(none, "matched"), 0);
  assert.equal(metricValue(none, "matched") === 0, true);
});

test("报名面板：未读取的指标是 undefined，不是 0", () => {
  const panel = registrationPanel(baseInput(), { status: "approved" });
  assert.equal(metricValue(panel, "pending"), undefined);
  assert.notEqual(metricValue(panel, "pending"), 0);
  assert.equal(metricValue(panel, "matched"), undefined);
  assert.equal(metricValue(panel, "read"), undefined);
  assert.equal(panel.available, false);
  const payload = JSON.parse(jsonWithout(panel.metrics[0])) as { value?: unknown };
  assert.equal(payload.value, undefined);
  assert.equal("value" in payload, false);
});

test("报名赛道下钻来自既有队伍；未读取队伍时显式不可用", () => {
  const rows = [registrationRow("r1", "t1-u0", "approved", "2026-10-10T01:00:00.000Z"), registrationRow("r2", "t2-u0", "approved", "2026-10-10T02:00:00.000Z")];
  const teams = { items: [teamRow("t1", "AI 赛道", ["t1-u0"]), teamRow("t2", "硬件赛道", ["t2-u0"])], nextCursor: null };
  const input = baseInput({ registrationCounts: REG_COUNTS, registrations: { items: rows, nextCursor: null }, teams });
  const panel = registrationPanel(input, { track: "AI 赛道" });
  assert.equal(metricValue(panel, "matched"), 1);
  assert.equal(panel.sections[0]!.rows.length, 1);
  assert.equal(panel.sections[0]!.rows[0]!.cells.find(cell => cell.label === "赛道（队伍）")?.value, "AI 赛道");
  const blocked = registrationPanel(baseInput({ registrationCounts: REG_COUNTS, registrations: { items: rows, nextCursor: null } }), { track: "AI 赛道" });
  assert.equal(blocked.available, false);
  assert.equal(metricValue(blocked, "matched"), undefined);
  assert.ok(blocked.notAvailableReasons.some(reason => reason.includes("未读取队伍")));
});

// ---- 纯函数：队伍 ----

test("队伍面板：人数分布、成员齐备与已收件既有一致", () => {
  const teams = { items: [
    teamRow("t1", "AI 赛道", ["a", "b", "c"], "locked", "project-1"),
    teamRow("t2", "AI 赛道", ["d", "e"]),
    teamRow("t3", "硬件赛道", ["f"]),
  ], nextCursor: null };
  const workspace: DashboardJudgingWorkspace = { rounds: [], submissions: [{ id: "s1", teamId: "t1", version: 1, submittedAt: "2026-10-11T01:00:00.000Z", materials: { title: "作品", links: [], files: [] } }] };
  const panel = teamPanel(baseInput({ teams, judgingWorkspace: workspace }));
  assert.equal(metricValue(panel, "teams"), 3);
  assert.equal(metricValue(panel, "locked"), 1);
  assert.equal(metricValue(panel, "members"), 6);
  assert.equal(metricValue(panel, "withIntake"), 1);
  assert.equal(metricValue(panel, "withProject"), 1);
  const size = panel.breakdowns.find(item => item.key === "teamSize")!;
  assert.deepEqual(size.groups.map(group => [group.label, group.value]), [["1 人", 1], ["2 人", 1], ["3 人", 1]]);
  const tracks = panel.breakdowns.find(item => item.key === "teamTrack")!;
  assert.deepEqual(tracks.groups.map(group => [group.label, group.value]), [["AI 赛道", 2], ["硬件赛道", 1]]);
  const filtered = teamPanel(baseInput({ teams, judgingWorkspace: workspace }), { track: "硬件赛道" });
  assert.equal(metricValue(filtered, "matched"), 1);
});

test("队伍面板：未读取收件时是否已收件为 null 而不是未收件", () => {
  const teams = { items: [teamRow("t1", "AI 赛道", ["a"])], nextCursor: null };
  const panel = teamPanel(baseInput({ teams }));
  assert.equal(metricValue(panel, "withIntake"), undefined);
  assert.equal(panel.sections[0]!.rows[0]!.cells.find(cell => cell.label === "是否已收件")?.value, null);
  assert.ok(panel.notAvailableReasons.some(reason => reason.includes("是否已收件")));
});

// ---- 纯函数：收件 ----

test("收件面板：每队取最新一版，未交件与过薄为显式事实", () => {
  const workspace: DashboardJudgingWorkspace = {
    rounds: [],
    submissions: [
      { id: "s1", teamId: "t1", version: 1, submittedAt: "2026-10-11T01:00:00.000Z", materials: { title: "旧版", links: [], files: [] } },
      { id: "s2", teamId: "t1", version: 2, submittedAt: "2026-10-11T02:00:00.000Z", materials: { title: "新版", links: [{ label: "仓库", url: "https://example.test" }], files: [] } },
      { id: "s3", teamId: "t2", version: 1, submittedAt: "2026-10-11T03:00:00.000Z", materials: { title: "只有名称", links: [], files: [] } },
    ],
  };
  const teams = { items: [teamRow("t1", "AI 赛道", ["a"]), teamRow("t2", "AI 赛道", ["b"]), teamRow("t3", "AI 赛道", ["c"])], nextCursor: null };
  const panel = intakePanel(baseInput({ judgingWorkspace: workspace, teams }));
  assert.equal(metricValue(panel, "submittedTeams"), 2);
  assert.equal(metricValue(panel, "receipts"), 3);
  assert.equal(metricValue(panel, "notSubmitted"), 1);
  assert.equal(metricValue(panel, "thin"), 1);
  assert.equal(metricValue(panel, "matched"), 2);
  assert.equal(panel.sections[0]!.rows.length, 2);
  assert.equal(panel.sections[0]!.rows[0]!.id, "s3");
  assert.equal(panel.sections[1]!.rows[0]!.id, "t3");
  const failed = intakePanel(baseInput({ judgingWorkspace: workspace }));
  assert.equal(metricValue(failed, "submittedTeams"), 2);
  assert.equal(metricValue(failed, "notSubmitted"), undefined);
});

// ---- 纯函数：评审 ----

function progressStub(roundId: string): DashboardJudgingProgress {
  return {
    roundId, status: "in_progress", snapshotCount: 2, requiredJudges: 2, incompleteSnapshots: 1,
    submittedTotal: 5, assignedTotal: 6,
    rows: [
      { snapshotId: "s1", title: "作品一", submittedCount: 2, requiredJudges: 2, stillNeeds: 0, complete: true },
      { snapshotId: "s2", title: "作品二", submittedCount: 1, requiredJudges: 2, stillNeeds: 1, complete: false },
    ],
    judges: [{ judgeUserId: "j1", submittedCount: 1, assignedCount: 2, outstanding: 1, excludedCount: 1 }],
  };
}
const WORKSPACE: DashboardJudgingWorkspace = {
  rounds: [
    { id: "round-1", status: "published", snapshotIds: ["s0"], publishedResultId: "pub-1", config: { minJudges: 1 } },
    { id: "round-2", status: "open", snapshotIds: ["s1", "s2"], publishedResultId: null, config: { minJudges: 2 } },
  ],
  submissions: [{ id: "s1", teamId: "t1", version: 1, submittedAt: "2026-10-11T01:00:00.000Z", materials: { title: "作品一", links: [], files: [] } }],
};

test("评审面板：本轮数字直接用既有 progress 的输出，默认取最新一轮", () => {
  const input = baseInput({ judgingWorkspace: WORKSPACE, judgingProgress: progressStub("round-2") });
  const panel = judgingPanel(input);
  assert.equal(metricValue(panel, "rounds"), 2);
  assert.equal(metricValue(panel, "publishedRounds"), 1);
  assert.equal(metricValue(panel, "snapshots"), 2);
  assert.equal(metricValue(panel, "incomplete"), 1);
  assert.equal(metricValue(panel, "submitted"), 5);
  assert.equal(metricValue(panel, "assigned"), 6);
  assert.equal(metricValue(panel, "required"), 2);
  assert.equal(panel.sections[0]!.rows.length, 2);
  assert.deepEqual(panel.sections[0]!.rows[0]!.cells.map(cell => cell.value), ["作品一", "2 / 2", 0]);
  assert.equal(panel.sections[1]!.rows[0]!.cells.find(cell => cell.label === "还差")?.value, 1);
  const first = judgingPanel(input, { roundId: "round-1" });
  assert.equal(metricValue(first, "snapshots"), undefined);
  assert.ok(first.notAvailableReasons.some(reason => reason.includes("本轮评审进度未读取")));
});

test("评审面板：未知轮次与空轮次都显式说明，不编造数字", () => {
  const empty = judgingPanel(baseInput({ judgingWorkspace: { rounds: [], submissions: [] } }));
  assert.equal(metricValue(empty, "rounds"), 0);
  assert.equal(metricValue(empty, "snapshots"), undefined);
  assert.ok(empty.notAvailableReasons.some(reason => reason.includes("还没有评审轮次")));
  const unknown = judgingPanel(baseInput({ judgingWorkspace: WORKSPACE }), { roundId: "missing" });
  assert.ok(unknown.notAvailableReasons.some(reason => reason.includes("不存在")));
});

// ---- 纯函数：后勤 ----

test("后勤面板：住宿未分配、餐券核销与行程覆盖都是既有事实", () => {
  const accommodation: readonly DashboardAccommodationRow[] = [{ userId: "u2", location: "酒店", room: "101", checkIn: "2026-10-20T00:00:00.000Z", checkOut: "2026-10-22T00:00:00.000Z" }];
  const vouchers: readonly DashboardVoucherRow[] = [
    { id: "v1", userId: "u2", name: "午餐", totalUses: 3, remainingUses: 1, state: "available", revokedAt: null },
    { id: "v2", userId: "u3", name: "午餐", totalUses: 2, remainingUses: 0, state: "exhausted", revokedAt: null },
    { id: "v3", userId: "u4", name: "午餐", totalUses: 2, remainingUses: 2, state: "revoked", revokedAt: "2026-10-12T00:00:00.000Z" },
  ];
  const scheduleDraft: DashboardScheduleDraft = { revision: 2, publishedRevision: 1, items: [{ title: "开幕式", startsAt: "2026-10-20T01:00:00.000Z", endsAt: "2026-10-20T02:00:00.000Z", location: "线上", audience: "participants", userIds: [] }] };
  const panel = logisticsPanel(baseInput({ registrations: { items: REG_ROWS, nextCursor: null }, accommodation, vouchers, scheduleDraft }));
  assert.equal(metricValue(panel, "accommodationAssigned"), 1);
  assert.equal(metricValue(panel, "accommodationUnassigned"), 2);
  assert.equal(metricValue(panel, "vouchersIssued"), 2);
  assert.equal(metricValue(panel, "voucherRedemptions"), 4);
  assert.equal(metricValue(panel, "vouchersExhausted"), 1);
  assert.equal(metricValue(panel, "vouchersRevoked"), 1);
  assert.equal(metricValue(panel, "scheduleItems"), 1);
  assert.equal(metricValue(panel, "scheduleCovered"), 3);
  assert.deepEqual(panel.breakdowns[0]!.groups.map(group => [group.label, group.value]), [["可使用", 1], ["已用完", 1], ["已过期", 0], ["已撤销", 1]]);
  const explicit = logisticsPanel(baseInput({ registrations: { items: REG_ROWS, nextCursor: null }, scheduleDraft: { revision: 1, publishedRevision: null, items: [{ title: "复核", startsAt: "2026-10-20T01:00:00.000Z", endsAt: "2026-10-20T02:00:00.000Z", location: "线上", audience: "users", userIds: ["u2", "u9"] }] } }));
  assert.equal(metricValue(explicit, "scheduleCovered"), 1);
});

test("后勤面板：未读取的住宿/餐券/行程都是 undefined", () => {
  const panel = logisticsPanel(baseInput());
  assert.equal(metricValue(panel, "accommodationAssigned"), undefined);
  assert.equal(metricValue(panel, "vouchersIssued"), undefined);
  assert.equal(metricValue(panel, "scheduleItems"), undefined);
  assert.equal(panel.available, false);
  assert.equal(panel.notAvailableReasons.length >= 3, true);
});

// ---- 纯函数：组装与禁用语 ----

function fullInput(): DashboardInput {
  return baseInput({
    registrationCounts: REG_COUNTS,
    registrations: { items: REG_ROWS, nextCursor: null },
    teams: { items: [teamRow("t1", "AI 赛道", ["u2", "u3"])], nextCursor: null },
    judgingWorkspace: WORKSPACE,
    judgingProgress: progressStub("round-2"),
    accommodation: [{ userId: "u2", location: "酒店", room: "101", checkIn: "2026-10-20T00:00:00.000Z", checkOut: "2026-10-22T00:00:00.000Z" }],
    vouchers: [{ id: "v1", userId: "u2", name: "午餐", totalUses: 3, remainingUses: 1, state: "available", revokedAt: null }],
    scheduleDraft: { revision: 1, publishedRevision: null, items: [{ title: "开幕式", startsAt: "2026-10-20T01:00:00.000Z", endsAt: "2026-10-20T02:00:00.000Z", location: "线上", audience: "all", userIds: [] }] },
  });
}

test("buildDashboard 组装五块面板；指定 panel 只返回该面板", () => {
  const view = buildDashboard(fullInput());
  assert.deepEqual(view.panels.map(panel => panel.panel), [...DASHBOARD_PANELS]);
  assert.equal(view.eventId, "e1");
  assert.equal(view.readAt, READ_AT);
  assert.equal(view.filter.limit, 50);
  const one = buildDashboard(fullInput(), { panel: "judging" });
  assert.deepEqual(one.panels.map(panel => panel.panel), ["judging"]);
});

test("看板文案不含预测/成功率/影响力/ROI/最佳/排名", () => {
  const text = jsonWithout(buildDashboard(fullInput()));
  for (const word of FORBIDDEN) assert.equal(text.includes(word), false, "看板文案不应出现：" + word);
});

test("看板不按分数排序：评审行只按还差数与标识", () => {
  const panel = judgingPanel(baseInput({ judgingWorkspace: WORKSPACE, judgingProgress: progressStub("round-2") }));
  assert.equal(panel.sections[0]!.rows[0]!.id, "s1");
  assert.equal(panel.sections[0]!.rows[1]!.id, "s2");
});

// ---- 服务：只读组合、权限与未接入 ----

function fakeOrganization(): Organization {
  return { id: "org-1", name: "测试机构", kind: "community", description: "", ownerUserId: "owner", status: "approved", revision: 1, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" };
}
function fakeEvent(overrides: Partial<HostedEvent> = {}): HostedEvent {
  return {
    organizationId: "org-1", organizationName: "测试机构", eventId: "e1", title: "测试赛", status: "published", revision: 3, publishedRevision: 1,
    timezone: "Asia/Shanghai", startsAt: "2026-10-20T02:00:00.000Z", endsAt: "2026-10-22T10:00:00.000Z",
    registrationOpensAt: "2026-10-12T02:00:00.000Z", registrationClosesAt: "2026-10-19T10:00:00.000Z", submissionClosesAt: "2026-10-22T09:00:00.000Z",
    modules: { registration: true, teams: true, icebreaking: false, judging: true, schedule: true, accommodation: true, mealVouchers: true },
    registration: { reviewRequired: false, capacity: 30 }, teams: { mode: "free", minSize: 1, maxSize: 5, locksAt: null }, linkedEventId: null,
    templateKey: "online", templateVersion: 1, format: "online", summary: "简介", rules: "规则", location: "在线",
    responsibleUserId: "staff", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}
function fakeGrant(capabilities: readonly EventStaffCapability[]): StaffGrant {
  return { id: "g1", organizationId: "org-1", eventId: "e1", userId: "staff", role: "staff", capabilities, status: "active", revision: 1, createdAt: "2026-10-01T00:00:00.000Z", revokedAt: null };
}
function stubPort(): OrganizerDashboardPort {
  return {
    registrationCounts: async () => REG_COUNTS,
    registrations: async () => ({ items: REG_ROWS, nextCursor: null }),
    teams: async () => ({ items: [teamRow("t1", "AI 赛道", ["u2", "u3"])], nextCursor: null }),
    judgingWorkspace: async () => WORKSPACE,
    judgingProgress: async (_principal, _eventId, roundId) => progressStub(roundId),
    accommodation: async () => [{ userId: "u2", location: "酒店", room: "101", checkIn: "2026-10-20T00:00:00.000Z", checkOut: "2026-10-22T00:00:00.000Z" }],
    vouchers: async () => [{ id: "v1", userId: "u2", name: "午餐", totalUses: 3, remainingUses: 1, state: "available", revokedAt: null }],
    scheduleDraft: async () => ({ revision: 1, publishedRevision: null, items: [{ title: "开幕式", startsAt: "2026-10-20T01:00:00.000Z", endsAt: "2026-10-20T02:00:00.000Z", location: "线上", audience: "all", userIds: [] }] }),
  };
}
function dashboardHarness(options: { capabilities: readonly EventStaffCapability[]; port?: OrganizerDashboardPort; event?: HostedEvent }) {
  const event = options.event ?? fakeEvent();
  const organization = fakeOrganization();
  const grants = [fakeGrant(options.capabilities)];
  const sql = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as SqlExecutor;
  const database = {
    query: async () => ({ rows: [], rowCount: 0 }),
    transaction: async <T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> => work(sql),
  } as unknown as DatabasePort;
  let seq = 0;
  const repository = {
    getEvent: async () => event,
    getOrganization: async () => organization,
    listGrants: async (_sql: SqlExecutor, orgId: string, userId?: string) => grants.filter(grant => grant.organizationId === orgId && (userId === undefined || grant.userId === userId)),
    insertEvent: async () => { throw new Error("dashboard must not write"); },
    saveEvent: async () => { throw new Error("dashboard must not write"); },
    insertGrant: async () => { throw new Error("dashboard must not write"); },
    audit: async () => { throw new Error("dashboard must not write"); },
  } as unknown as PostgresOrganizerRepository;
  const service = new OrganizerService({
    database, clock: { now: () => new Date("2026-10-16T08:00:00.000Z") }, ids: { next: () => "id-" + (++seq) }, repository,
    ...(options.port ? { dashboard: options.port } : {}),
  });
  const principal: OrganizerPrincipal = { actor: { userId: "staff", platformRoles: ["user"] }, guard: async () => {} };
  return { service, principal, event };
}

test("服务 dashboard 只读组合既有读取，数字与 Port 逐一相等", async () => {
  const harness = dashboardHarness({ capabilities: ["registration_manage", "teams_manage", "judging_manage", "schedule_manage", "logistics_manage"], port: stubPort() });
  const view = await harness.service.dashboard(harness.principal, "e1", {});
  assert.deepEqual(view.panels.map(panel => panel.panel), [...DASHBOARD_PANELS]);
  assert.equal(view.readAt, "2026-10-16T08:00:00.000Z");
  const registration = view.panels.find(panel => panel.panel === "registration")!;
  assert.equal(metricValue(registration, "pending"), REG_COUNTS.pending);
  assert.equal(metricValue(registration, "approved"), REG_COUNTS.counts.approved);
  const judging = view.panels.find(panel => panel.panel === "judging")!;
  assert.equal(metricValue(judging, "submitted"), progressStub("round-2").submittedTotal);
  assert.equal(metricValue(judging, "assigned"), progressStub("round-2").assignedTotal);
  const logistics = view.panels.find(panel => panel.panel === "logistics")!;
  assert.equal(metricValue(logistics, "accommodationAssigned"), 1);
});

test("服务 dashboard 未接入 Port 时返回未提供而不是 0", async () => {
  const harness = dashboardHarness({ capabilities: ["registration_manage"] });
  const view = await harness.service.dashboard(harness.principal, "e1", { panel: "registration" });
  const panel = view.panels[0]!;
  assert.equal(metricValue(panel, "pending"), undefined);
  assert.notEqual(metricValue(panel, "pending"), 0);
  assert.ok(panel.notAvailableReasons.some(reason => reason.includes("NEEDS_INTERFACE")));
});

test("服务 dashboard 按 capability 过滤面板；越权面板 403", async () => {
  const harness = dashboardHarness({ capabilities: ["teams_manage"], port: stubPort() });
  const view = await harness.service.dashboard(harness.principal, "e1", {});
  assert.deepEqual(view.panels.map(panel => panel.panel), ["teams"]);
  await assert.rejects(harness.service.dashboard(harness.principal, "e1", { panel: "registration" }), (error: unknown) => error instanceof DomainError && error.code === "ORGANIZER_FORBIDDEN");
  await assert.rejects(harness.service.dashboard(harness.principal, "e1", { panel: "judging" }), (error: unknown) => error instanceof DomainError && error.code === "ORGANIZER_FORBIDDEN");
});

test("服务 dashboard 只读：不写任何事实，归档赛事拒绝", async () => {
  const harness = dashboardHarness({ capabilities: ["registration_manage"], port: stubPort() });
  const view = await harness.service.dashboard(harness.principal, "e1", {});
  assert.equal(view.panels.length, 1);
  const archived = dashboardHarness({ capabilities: ["registration_manage"], event: fakeEvent({ status: "archived" }) });
  await assert.rejects(archived.service.dashboard(archived.principal, "e1", {}), (error: unknown) => error instanceof DomainError && error.code === "ORGANIZER_FORBIDDEN");
});

// ---- HTTP：单一入口与 GET-only ----

test("GET organizer/events/:id/dashboard 是唯一入口，与既有模块路由不冲突", async () => {
  assert.deepEqual(organizerHttpRoute(["organizer", "events", "e", "dashboard"]), { kind: "dashboard", eventId: "e" });
  assert.equal(eventCommunicationHttpRoute(["organizer", "events", "e", "dashboard"]), null);
  assert.equal(organizerHttpRoute(["organizer", "events", "e", "unknown"]), null);
  const harness = dashboardHarness({ capabilities: ["registration_manage"], port: stubPort() });
  let authenticateCalls = 0, mutationCalls = 0;
  const handlers = createOrganizerHttpHandlers({
    service: harness.service, authenticate: async () => { authenticateCalls += 1; return harness.principal; },
    authorizeMutation: async () => { mutationCalls += 1; }, requestId: () => "req-dashboard",
  });
  const response = await handlers.handle(new Request("https://organizer.local/api/v1/organizer/events/e1/dashboard?panel=registration&status=approved"), { kind: "dashboard", eventId: "e1" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const envelope = await response.json() as { data: DashboardView; requestId: string };
  assert.equal(envelope.requestId, "req-dashboard");
  assert.deepEqual(envelope.data.panels.map(panel => panel.panel), ["registration"]);
  assert.equal(metricValue(envelope.data.panels[0]!, "matched"), 3);
  assert.equal(envelope.data.filter.status, "approved");
  assert.equal(authenticateCalls, 1);
  assert.equal(mutationCalls, 0);
  const post = await handlers.handle(new Request("https://organizer.local/api/v1/organizer/events/e1/dashboard", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), { kind: "dashboard", eventId: "e1" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");
  assert.equal(authenticateCalls, 1);
  assert.equal(mutationCalls, 0);
});

test("HTTP 查询串非法时由 parseDashboardFilter 返回 422", async () => {
  const harness = dashboardHarness({ capabilities: ["registration_manage"], port: stubPort() });
  const handlers = createOrganizerHttpHandlers({ service: harness.service, authenticate: async () => harness.principal, authorizeMutation: async () => {}, requestId: () => "req-invalid" });
  const response = await handlers.handle(new Request("https://organizer.local/api/v1/organizer/events/e1/dashboard?panel=nope"), { kind: "dashboard", eventId: "e1" });
  assert.equal(response.status, 422);
  const envelope = await response.json() as { error: { code: string } };
  assert.equal(envelope.error.code, "DASHBOARD_FILTER_INVALID");
});
