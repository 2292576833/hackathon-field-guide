import assert from "node:assert/strict";
import test from "node:test";
import * as teamMatch from "./index.ts";
import {
  explainCandidate,
  explanationFacts,
  templateExplanation,
} from "./index.ts";
import type {
  TeamMatchCandidate,
  TeamMatchExplainModel,
  TeamMatchExplanationFacts,
  TeamMatchInvitePort,
} from "./index.ts";

const facts = (overrides: Partial<TeamMatchExplanationFacts> = {}): TeamMatchExplanationFacts => ({
  displayName: "小林",
  roles: ["backend"],
  skills: ["TypeScript", "React"],
  city: "杭州",
  sameCity: true,
  ...overrides,
});

const model = (reply: string | (() => Promise<string>)): TeamMatchExplainModel => ({
  explain: typeof reply === "string" ? async () => reply : reply,
});

const person = (overrides: Partial<TeamMatchCandidate> = {}): TeamMatchCandidate => ({
  userId: "candidate-1",
  displayName: "小林",
  cardId: "card-1",
  headline: "做过后端和前端",
  primaryRoles: ["backend"],
  supportingRoles: ["design"],
  coveringRoles: ["backend"],
  skills: ["TypeScript"],
  city: "杭州",
  sameCity: true,
  publishedAt: "2026-10-18T00:00:00.000Z",
  updatedAt: "2026-10-18T00:00:00.000Z",
  ...overrides,
});

const sentences = (text: string): string[] => text.split(/[。！？!?]+/).map(item => item.trim()).filter(Boolean);

test("没有注入模型时返回固定模板句，并标记 degraded", async () => {
  const result = await explainCandidate({ facts: facts() });
  assert.equal(result.degraded, true);
  assert.equal(result.source, "template");
  assert.equal(result.degradedReason, "model_not_injected");
  assert.equal(result.text, templateExplanation(facts()));
  assert.match(result.text, /后端开发/);
  assert.match(result.text, /TypeScript、React/);
  assert.match(result.text, /城市和你相同（杭州）/);
  assert.equal(sentences(result.text).length, 2, "模板句最多 2 句");
});

test("模型调用失败时退回模板句，不把异常透传给界面", async () => {
  const result = await explainCandidate({
    model: model(async () => { throw new Error("model offline"); }),
    facts: facts(),
  });
  assert.equal(result.degraded, true);
  assert.equal(result.source, "template");
  assert.equal(result.degradedReason, "model_failed");
  assert.equal(result.text, templateExplanation(facts()));
});

test("模型编造 facts 之外的技能时整段拒绝，绝不透传", async () => {
  const result = await explainCandidate({
    model: model("小林还会 Rust 和 Kubernetes。"),
    facts: facts({ skills: ["TypeScript", "React"] }),
  });
  assert.equal(result.degraded, true);
  assert.equal(result.degradedReason, "model_output_rejected");
  assert.doesNotMatch(result.text, /Rust|Kubernetes/);
  assert.match(result.text, /TypeScript、React/);
});

test("模型用中文编造经历或技能时同样拒绝", async () => {
  const result = await explainCandidate({
    model: model("小林会写小说，还有三次创业经验。"),
    facts: facts(),
  });
  assert.equal(result.degraded, true);
  assert.equal(result.degradedReason, "model_output_rejected");
  assert.doesNotMatch(result.text, /小说|创业/);
});

test("模型输出评分、百分比、排名或最佳匹配时拒绝", async () => {
  for (const reply of [
    "小林是最佳匹配，匹配度 95%。",
    "这位候选人的推荐指数很高，排名第一。",
    "他的年龄和 MBTI 都很合适。",
  ]) {
    const result = await explainCandidate({ model: model(reply), facts: facts() });
    assert.equal(result.degraded, true, reply);
    assert.equal(result.degradedReason, "model_output_rejected", reply);
    assert.equal(result.text, templateExplanation(facts()), reply);
  }
});

test("只重复姓名的模型输出不算给出理由，退回模板", async () => {
  const result = await explainCandidate({ model: model("小林。"), facts: facts() });
  assert.equal(result.degraded, true);
  assert.equal(result.degradedReason, "model_output_rejected");
  assert.equal(result.text, templateExplanation(facts()));
});

test("模型输出超过 2 句或带 Markdown 时拒绝", async () => {
  const three = await explainCandidate({
    model: model("小林的名片写了后端开发。技能是 TypeScript。城市和你相同。"),
    facts: facts(),
  });
  assert.equal(three.degraded, true);
  assert.equal(three.degradedReason, "model_output_rejected");

  const markdown = await explainCandidate({
    model: model("**小林**的名片写了后端开发。"),
    facts: facts(),
  });
  assert.equal(markdown.degraded, true);
  assert.equal(markdown.degradedReason, "model_output_rejected");
});

test("只引用 facts 的模型输出被接受，并补上句号", async () => {
  const result = await explainCandidate({
    model: model("小林的名片把后端开发列为可补职责，名片里写的技能是 TypeScript 和 React，城市和你相同"),
    facts: facts(),
  });
  assert.equal(result.degraded, false);
  assert.equal(result.source, "model");
  assert.equal(result.degradedReason, null);
  assert.match(result.text, /后端开发/);
  assert.ok(result.text.endsWith("。"));
  assert.doesNotMatch(result.text, /最佳|匹配度|排名|%/);
});

test("explanationFacts 只挑允许引用的字段，不带入简历、年龄、MBTI 或联系方式", () => {
  const projected = explanationFacts({ candidate: person(), postTitle: "找一位后端" });
  assert.deepEqual(Object.keys(projected).sort(), ["city", "displayName", "postTitle", "roles", "sameCity", "skills"]);
  assert.deepEqual(projected.roles, ["backend"], "优先用能补缺口的职责");
  assert.equal("resume" in projected, false);
  assert.equal("age" in projected, false);
  assert.equal("mbti" in projected, false);
  assert.equal("email" in projected, false);
});

test("组队大厅没有任何写入口：邀请端口即使准备好也不会被读路径调用", async () => {
  let writes = 0;
  const invite: TeamMatchInvitePort = {
    createApplication: async () => {
      writes += 1;
      return { applicationId: "application-1" };
    },
  };
  void invite;

  await explainCandidate({ facts: facts() });
  const exported = Object.keys(teamMatch);
  assert.deepEqual(exported.filter(key => /invite|apply|createApplication|join|write/i.test(key)), [], "模块不导出任何写入口");
  assert.equal(writes, 0, "没有显式的本人动作就不会创建招募申请");
});
