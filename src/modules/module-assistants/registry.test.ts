import assert from "node:assert/strict";
import test from "node:test";
import { EVENT_STAFF_CAPABILITIES, type EventStaffCapability } from "../../shared/organizer-contracts.ts";
import { MODULE_ASSISTANT_KEYS, MODULE_ASSISTANT_OUTPUT_KINDS } from "./model.ts";
import { isModuleAssistantKey, moduleAssistant, moduleAssistantCatalog, MODULE_ASSISTANT_REGISTRY } from "./registry.ts";
import { ALL_MODULE_ASSISTANT_KEYS } from "./model.ts";
import { safeModuleAssistantSectionHref } from "./ui.ts";

const EXPECTED_CAPABILITIES: Record<string, EventStaffCapability> = {
  overview: "event_manage", registration: "registration_manage", teams: "teams_manage",
  communication: "communication_manage", schedule: "schedule_manage", services: "logistics_manage", judging: "judging_manage",
};

test("注册表覆盖 7 个主办方模块 + 5 个选手端环节，key 唯一且与自身枚举一致", () => {
  assert.equal(MODULE_ASSISTANT_REGISTRY.length, 14);
  assert.deepEqual(MODULE_ASSISTANT_REGISTRY.map(item => item.key), [...ALL_MODULE_ASSISTANT_KEYS]);
  assert.equal(new Set(MODULE_ASSISTANT_REGISTRY.map(item => item.key)).size, 14);
  for (const key of ALL_MODULE_ASSISTANT_KEYS) {
    assert.equal(isModuleAssistantKey(key), true);
    assert.equal(moduleAssistant(key).key, key);
  }
  assert.equal(isModuleAssistantKey("peer_review"), false);
  assert.equal(isModuleAssistantKey(null), false);
});

test("每个助手所需的 EventStaffCapability 是既有枚举，且与工作台 section 映射一致", () => {
  for (const entry of MODULE_ASSISTANT_REGISTRY) {
    if (entry.audience === "staff") assert.ok(entry.requiredCapability !== undefined && (EVENT_STAFF_CAPABILITIES as readonly string[]).includes(entry.requiredCapability), `${entry.key} 的能力必须来自既有枚举`);
    if (entry.audience === "staff") assert.equal(entry.requiredCapability, EXPECTED_CAPABILITIES[entry.key], `${entry.key} 的能力映射必须与既有 section 一致`);
    assert.ok(entry.label.trim().length > 0);
    assert.ok(entry.readsDescription.trim().length > 0);
  }
});

test("可读事实键与允许产出都非空、去重，且产出类型只有草稿/清单/摘要/去重提示", () => {
  for (const entry of MODULE_ASSISTANT_REGISTRY) {
    assert.ok(entry.readableFactKeys.length > 0, `${entry.key} 必须声明可读事实键`);
    assert.equal(new Set(entry.readableFactKeys).size, entry.readableFactKeys.length);
    assert.ok(entry.allowedOutputs.length > 0);
    assert.equal(new Set(entry.allowedOutputs).size, entry.allowedOutputs.length);
    for (const kind of entry.allowedOutputs) assert.ok((MODULE_ASSISTANT_OUTPUT_KINDS as readonly string[]).includes(kind));
  }
});

test("评审助手不声明任何选手私人点评/留言/互评键（评分期评审隔离）", () => {
  const judging = moduleAssistant("judging");
  for (const key of judging.readableFactKeys) {
    assert.doesNotMatch(key, /comment|message|peer|feedback|review(er)?/i, `评审助手不得读取私人点评键：${key}`);
  }
});

test("注册表只挂既有工作台 section，不新增任何导航入口；本模块不设平台强制次数上限", () => {
  for (const entry of MODULE_ASSISTANT_REGISTRY) {
    const needsProject = entry.sectionPath.includes("{projectId}");
    const href = safeModuleAssistantSectionHref("evt-1", entry.key, needsProject ? "proj-1" : undefined);
    assert.ok(href !== null, entry.key + " 的挂载页必须能拼出来");
    assert.ok(href!.startsWith("/organizers/workspace/") || href!.startsWith("/competitions/") || href!.startsWith("/app/projects/"), entry.key + " 只能挂既有页面");
    assert.equal(safeModuleAssistantSectionHref("../etc", entry.key), null);
  }
  for (const entry of MODULE_ASSISTANT_REGISTRY) {
    for (const key of Object.keys(entry)) assert.doesNotMatch(key, /limit|quota|maxcalls|ratelimit/i, `助手条目不得携带平台强制次数上限字段：${key}`);
  }
});

test("catalog 返回冻结的同一份注册表，只读", () => {
  assert.equal(moduleAssistantCatalog(), MODULE_ASSISTANT_REGISTRY);
  assert.equal(Object.isFrozen(MODULE_ASSISTANT_REGISTRY), true);
  for (const entry of MODULE_ASSISTANT_REGISTRY) {
    assert.equal(Object.isFrozen(entry), true);
    assert.equal(Object.isFrozen(entry.readableFactKeys), true);
    assert.equal(Object.isFrozen(entry.allowedOutputs), true);
  }
});

test("选手端 5 个环节都有职责明确的助手：受众、参赛状态、只读事实、允许产出、挂载页", () => {
  const participant = MODULE_ASSISTANT_REGISTRY.filter(entry => entry.audience === "participant");
  assert.deepEqual(participant.map(entry => entry.key).sort(), ["enroll", "plan", "resources", "results", "retro", "submit", "teamup"]);
  for (const entry of participant) {
    assert.equal(entry.requiredParticipant, "approved", entry.key + " 必须要求报名已通过");
    assert.equal(entry.requiredCapability, undefined, entry.key + " 不应要求工作人员权限");
    assert.ok(entry.readableFactKeys.length > 0, entry.key + " 必须声明只读事实");
    assert.ok(entry.allowedOutputs.length > 0, entry.key + " 必须声明允许产出");
    assert.ok(entry.sectionPath.startsWith("/competitions/") || entry.sectionPath.startsWith("/app/"), entry.key + " 必须挂在自己环节的页面上");
  }
});
