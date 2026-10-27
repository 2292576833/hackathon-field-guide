import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../shared/errors.ts";
import { moduleAssistantNamespace, moduleAssistantNamespaceLabel } from "./namespace.ts";
import { moduleAssistant } from "./registry.ts";

test("命名空间显式包含机构+赛事+模块+账号，四者任一变化都得到不同命名空间", () => {
  const a = moduleAssistantNamespace({ organizationId: "org-1", eventId: "evt-1", assistantKey: "registration", userId: "u1" });
  assert.equal(a, "org:org-1:event:evt-1:module:registration:user:u1");
  const variants = [
    moduleAssistantNamespace({ organizationId: "org-2", eventId: "evt-1", assistantKey: "registration", userId: "u1" }),
    moduleAssistantNamespace({ organizationId: "org-1", eventId: "evt-2", assistantKey: "registration", userId: "u1" }),
    moduleAssistantNamespace({ organizationId: "org-1", eventId: "evt-1", assistantKey: "judging", userId: "u1" }),
    moduleAssistantNamespace({ organizationId: "org-1", eventId: "evt-1", assistantKey: "registration", userId: "u2" }),
  ];
  for (const value of variants) assert.notEqual(value, a);
  assert.equal(new Set([a, ...variants]).size, 5);
  // 与选手备赛 AI / 全站聊天不存在共享前缀：本命名空间始终以 org:...:module: 标记模块边界。
  assert.match(a, /^org:[^:]+:event:[^:]+:module:[a-z_]+:user:[^:]+$/);
});

test("命名空间标签对主办方写明机构/赛事/模块/账号，且非法标识被显式拒绝", () => {
  const label = moduleAssistantNamespaceLabel({ organizationId: "org-1", eventId: "evt-1", assistantKey: "judging", userId: "u1" }, moduleAssistant("judging").label, "示例机构");
  assert.match(label, /示例机构/);
  assert.match(label, /evt-1/);
  assert.match(label, /u1/);
  assert.equal(moduleAssistantNamespaceLabel({ organizationId: "org-1", eventId: "evt-1", assistantKey: "judging", userId: "u1" }, "收件与评审"), "机构 org-1 · 赛事 evt-1 · 模块 收件与评审 · 账号 u1");
  assert.throws(() => moduleAssistantNamespace({ organizationId: "org 1", eventId: "evt-1", assistantKey: "judging", userId: "u1" }), (error: unknown) => error instanceof DomainError && error.code === "MODULE_ASSISTANT_SCOPE_INVALID");
  assert.throws(() => moduleAssistantNamespace({ organizationId: "org-1", eventId: "", assistantKey: "judging", userId: "u1" }), (error: unknown) => error instanceof DomainError && error.status === 503);
});
