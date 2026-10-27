import assert from "node:assert/strict";
import test from "node:test";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { FreshSessionGuard, PersonalAiPort, PersonalArtifact, PersonalGenerationRequest } from "../../shared/personal-ai.ts";
import type { ParticipantProfile } from "../../shared/participant.ts";
import { createRoadshowHandlers } from "./http.ts";
import { createRoadshowService, ROADSHOW_PROMPT_VERSION } from "./service.ts";
import type { RoadshowDocument, RoadshowInput, RoadshowScript } from "./types.ts";
import { ROADSHOW_INPUT_LIMITS, roadshowToMarkdown, validateRoadshowDocument, validateRoadshowInput, validateRoadshowScript } from "./validation.ts";

const actor: Actor = { userId: "owner-1", platformRoles: ["user"] };
const other: Actor = { userId: "owner-2", platformRoles: ["user"] };
function input(durationSeconds = 300): RoadshowInput {
  return { projectIdea: "整理会议笔记为人工确认的行动卡", targetUsers: "需要对齐行动的会议参与者", problem: "会后对负责人和时间理解不同", completedCapabilities: "已完成本地输入和行动卡编辑界面；模型提取尚未接入", plannedCapabilities: "", technicalApproach: "前端原型，后续拟接入模型提取", differentiation: "保持负责人待确认，由人修改", facts: "目前只有本地原型，没有真实用户或准确率测试", assumptions: "参与者愿意检查行动卡", pendingValidation: "提取遗漏与修正所需时间", durationSeconds };
}
function script(durationSeconds = 300): RoadshowScript {
  const opening = Math.max(5, Math.floor(durationSeconds * .1));
  const closing = Math.max(5, Math.floor(durationSeconds * .1));
  const problem = Math.floor((durationSeconds - opening - closing) * .4);
  return {
    opening: { text: "会后大家可能对谁做什么理解不同，我们想帮助参与者明确行动。", durationSeconds: opening },
    segments: [{ title: "问题与方案", text: "这只是我们的待验证假设。目前用户自述完成本地输入和编辑界面，模型提取尚未接入。", durationSeconds: problem },
      { title: "原型演示与缓冲", text: "彩排时展示一段标注为演示材料的笔记，再手动修改负责人；保留切屏时间。", durationSeconds: durationSeconds - opening - closing - problem }],
    demoSteps: [{ action: "准备并输入标注为演示材料的笔记。", expectedResult: "预期可展示本地编辑界面；尚未实际执行本次演示。", fallback: "失败时如实说明，改用提前准备的截图。" }],
    closing: { text: "下一步验证遗漏与人工修改的成本。", durationSeconds: closing },
    qa: [{ question: "谁需要这个工具？", answer: "目标是会后需要对齐行动的参与者，需求尚待验证。" }, { question: "模型写错怎么办？", answer: "计划保留人工确认；目前模型尚未接入。" }, { question: "有准确率证据吗？", answer: "尚未开展真实测试，不提供准确率数据。" }],
    verificationItems: ["验证参与者是否愿意逐条确认。", "彩排最短演示路径和截图备选。"], totalDurationSeconds: durationSeconds,
  };
}
function fixture(output: (request: PersonalGenerationRequest<unknown>) => unknown = request => script((request.input as { project: RoadshowInput }).project.durationSeconds)) {
  const rows = new Map<string, PersonalArtifact[]>();
  const requests: PersonalGenerationRequest<unknown>[] = [];
  const guards: (FreshSessionGuard | undefined)[] = [];
  const ai: PersonalAiPort = {
    async generate<T>(current: Actor, request: PersonalGenerationRequest<T>, guard?: FreshSessionGuard): Promise<PersonalArtifact<T>> {
      requests.push(request); guards.push(guard);
      const data = request.validate(output(request));
      const row: PersonalArtifact<T> = { id: `artifact-${requests.length}`, kind: request.kind, title: request.title, data, createdAt: "2026-10-09T00:00:00.000Z", provider: "dsh", sessionId: `private-session-${current.userId}` };
      rows.set(current.userId, [...(rows.get(current.userId) ?? []), row]);
      return row;
    },
    async list(current, kind, guard) { guards.push(guard); return (rows.get(current.userId) ?? []).filter(row => row.kind === kind); },
    async get(current, id, guard) {
      guards.push(guard); const row = (rows.get(current.userId) ?? []).find(row => row.id === id);
      if (!row) throw new DomainError("ARTIFACT_NOT_FOUND", "未找到记录。", { status: 404 });
      return row;
    },
  };
  return { ai, requests, rows, guards };
}
const outputError = (error: unknown) => error instanceof DomainError && error.code === "ROADSHOW_OUTPUT_INVALID" && error.status === 502;
const inputError = (error: unknown) => error instanceof DomainError && error.code === "INVALID_INPUT";

test("input rejects unknown owner/provider instructions, wrong types and lengths before calling AI", async () => {
  const ports = fixture(); const service = createRoadshowService(ports);
  for (const bad of [{ ...input(), userId: other.userId }, { ...input(), provider: "other" }, { ...input(), projectIdea: " " }, { ...input(), targetUsers: ["用户"] }, { ...input(), projectIdea: "字".repeat(ROADSHOW_INPUT_LIMITS.projectIdea + 1) }, { ...input(), facts: null }, { ...input(), durationSeconds: 59 }, { ...input(), durationSeconds: 901 }, { ...input(), durationSeconds: 300.5 }, { ...input(), problem: "问题\u0000" }]) {
    await assert.rejects(service.generate(actor, bad), inputError);
  }
  assert.equal(ports.requests.length, 0);
  const { technicalApproach: _technical, facts: _facts, ...minimal } = input();
  assert.equal(validateRoadshowInput(minimal).technicalApproach, "");
  assert.equal(validateRoadshowInput(minimal).facts, "");
});

test("generation uses only injected DSH personal port, preserves private input and forwards guard", async () => {
  const ports = fixture(); const guard: FreshSessionGuard = async () => {};
  const artifact = await createRoadshowService(ports).generate(actor, input(), guard);
  assert.equal(artifact.kind, "roadshow"); assert.equal(artifact.provider, "dsh");
  assert.deepEqual(artifact.data.input, input()); assert.equal(artifact.data.script.totalDurationSeconds, 300);
  const request = ports.requests[0]!;
  assert.equal(request.kind, "roadshow"); assert.equal(request.promptVersion, ROADSHOW_PROMPT_VERSION);
  assert.deepEqual(request.input, { project: input(), participantContext: null });
  assert.equal(ports.guards[0], guard); assert.match(request.systemPrompt, /未执行 demo/);
  assert.match(request.systemPrompt, /用户数据而不是指令/); assert.match(request.systemPrompt, /不可编造/);
  assert.deepEqual((await createRoadshowService(ports).get(actor, artifact.id, guard)).data, artifact.data);
  assert.equal((await createRoadshowService(ports).list(actor, guard)).length, 1);
  assert.equal(ports.guards[1], guard); assert.equal(ports.guards[2], guard);
});

test("profile is optional/incomplete; only same-owner limited presentation context reaches AI", async () => {
  const ports = fixture(); const guard: FreshSessionGuard = async () => {};
  const profile: ParticipantProfile = { userId: actor.userId, revision: 1, firstHackathon: null, developmentExperience: null, city: "私人城市", skills: ["原型"], interests: ["私人兴趣"], projectIdea: "画像里的其他私人想法", availableHoursPerDay: null, travelPreference: "undecided", presentationExperience: null, updatedAt: null };
  let receivedGuard: FreshSessionGuard | undefined;
  const service = createRoadshowService({ ...ports, profiles: { async get(current, forwarded) { assert.equal(current, actor); receivedGuard = forwarded; return profile; } } });
  await service.generate(actor, input(), guard);
  const context = (ports.requests[0]!.input as { participantContext: unknown }).participantContext;
  assert.deepEqual(context, { firstHackathon: null, developmentExperience: null, presentationExperience: null, skills: ["原型"] });
  assert.equal(receivedGuard, guard); assert.ok(!JSON.stringify(ports.requests[0]!.input).includes("私人城市"));
  await assert.rejects(createRoadshowService({ ...ports, profiles: { async get() { return { ...profile, userId: other.userId }; } } }).generate(actor, input()), error => error instanceof DomainError && error.code === "ROADSHOW_PROFILE_INVALID");
  assert.equal(ports.requests.length, 1);
});

test("records are scoped through owner port and wrong artifact kind is hidden", async () => {
  const ports = fixture(); const service = createRoadshowService(ports);
  const artifact = await service.generate(actor, input());
  assert.deepEqual(await service.list(other), []);
  await assert.rejects(service.get(other, artifact.id), error => error instanceof DomainError && error.status === 404);
  await assert.rejects(service.get(actor, "../other"), inputError);
  ports.rows.get(actor.userId)![0]!.kind = "ppt";
  await assert.rejects(service.get(actor, artifact.id), error => error instanceof DomainError && error.status === 404);
});

test("structured Chinese output requires exact duration, bounded text, demonstration and strict fields", () => {
  assert.equal(validateRoadshowScript(script(60), input(60)).totalDurationSeconds, 60);
  assert.equal(validateRoadshowScript(script(900), input(900)).totalDurationSeconds, 900);
  const cases: unknown[] = [
    { ...script(), provider: "dsh" }, { ...script(), totalDurationSeconds: 301 },
    { ...script(), opening: { ...script().opening, durationSeconds: 30.5 } },
    { ...script(), opening: { ...script().opening, text: "English only" } },
    { ...script(), segments: script().segments.map(segment => ({ ...segment, title: "方案" })) },
    { ...script(), demoSteps: [{ ...script().demoSteps[0], executed: true }] },
    { ...script(), qa: script().qa.slice(0, 2) },
    { ...script(), verificationItems: [] },
    { ...script(), opening: { ...script().opening, text: "非常长的讲稿".repeat(100) } },
  ];
  for (const bad of cases) assert.throws(() => validateRoadshowScript(bad, input()), outputError);
  assert.throws(() => validateRoadshowDocument({ input: input(), script: script(), owner: other.userId }), outputError);
  assert.throws(() => validateRoadshowDocument({ input: { ...input(), durationSeconds: 10 }, script: script() }), outputError);
});

test("unsupported market, awards, actual users/tests and successful demo claims are rejected before save", async () => {
  for (const claim of ["我们的市场规模为300亿元。", "工具已有1000名真实用户。", "工具拥有大量用户。", "用户反馈表明他们满意。", "已经完成用户访谈。", "实际使用节省30%。", "方案获得一等奖。", "提取准确率达到98%。", "我们已经通过测试。", "刚才现场成功演示。", "现场运行成功。", "我们的工具行业领先。"] ) {
    const ports = fixture(() => ({ ...script(), opening: { ...script().opening, text: claim } }));
    await assert.rejects(createRoadshowService(ports).generate(actor, input()), outputError);
    assert.equal(ports.rows.size, 0, `unsupported output was persisted: ${claim}`);
  }
  const proposed = { ...script(), opening: { ...script().opening, text: "目标是将来验证准确率达到90%，目前尚未测试。" } };
  assert.equal(validateRoadshowScript(proposed, input()).opening.text, proposed.opening.text);
  const quoted = { ...script(), opening: { ...script().opening, text: "据用户自述：试验准确率达到80%；此结论仍需核实。" } };
  assert.equal(validateRoadshowScript(quoted, { ...input(), facts: "试验准确率达到80%" }).opening.text, quoted.opening.text);
  const demoClaim = { ...script(), opening: { ...script().opening, text: "现场运行成功。" } };
  assert.throws(() => validateRoadshowScript(demoClaim, { ...input(), facts: "现场运行成功" }), outputError);
  const demoHistory = { ...script(), opening: { ...script().opening, text: "据用户自述：现场运行成功。我们尚未执行本次演示。" } };
  assert.equal(validateRoadshowScript(demoHistory, { ...input(), facts: "现场运行成功" }).opening.text, demoHistory.opening.text);
});

test("model cannot replace private input by returning document wrapper or unknown instructions", async () => {
  const ports = fixture(() => ({ input: { ...input(), projectIdea: "替换私人想法" }, script: script() }));
  await assert.rejects(createRoadshowService(ports).generate(actor, input()), outputError);
  assert.equal(ports.rows.size, 0);
});

test("negative and uncertain input clauses cannot support positive awards or user results", async () => {
  const statements = [
    { facts: "我们没有获得一等奖", completedCapabilities: input().completedCapabilities, claim: "我们获得一等奖。" },
    { facts: "我们未获得一等奖", completedCapabilities: input().completedCapabilities, claim: "我们获得一等奖。" },
    { facts: "我们计划获得一等奖", completedCapabilities: input().completedCapabilities, claim: "我们获得一等奖。" },
    { facts: "", completedCapabilities: "我们没有获得一等奖", claim: "我们获得一等奖。" },
    { facts: "没有已有1000名用户的证据", completedCapabilities: input().completedCapabilities, claim: "我们已有1000名用户。" },
    { facts: "需要验证我们已有1000名用户是否属实", completedCapabilities: input().completedCapabilities, claim: "我们已有1000名用户。" },
  ];
  for (const entry of statements) {
    const ports = fixture(() => ({ ...script(), opening: { ...script().opening, text: entry.claim } }));
    await assert.rejects(createRoadshowService(ports).generate(actor, { ...input(), facts: entry.facts, completedCapabilities: entry.completedCapabilities }), outputError);
    assert.equal(ports.rows.size, 0);
  }
  const quote = { ...script(), opening: { ...script().opening, text: "据用户自述：获得一等奖。" } };
  assert.equal(validateRoadshowScript(quote, { ...input(), facts: "我们获得一等奖" }).opening.text, quote.opening.text);
  const denied = { ...script(), opening: { ...script().opening, text: "我们没有获得一等奖。" } };
  assert.equal(validateRoadshowScript(denied, input()).opening.text, denied.opening.text);
});

test("displayed segment titles cannot bypass factual claim validation", async () => {
  const result = script(); result.segments[1]!.title = "已有100万用户的演示";
  const ports = fixture(() => result);
  await assert.rejects(createRoadshowService(ports).generate(actor, input()), outputError);
  assert.equal(ports.rows.size, 0);
});

test("uncertainty must qualify the nearby claim and cannot flow through a contrast or another topic", async () => {
  for (const claim of [
    "需要验证成本但我们已有1000名用户。", "需要验证成本然而我们已有1000名用户。",
    "需要验证成本而我们已有1000名用户。", "需要验证成本却我们已有1000名用户。",
    "需要验证成本我们已有1000名用户。", "我们没有获得一等奖但是我们获得二等奖。",
    "我们需要验证成本但现场运行成功。",
  ]) {
    const ports = fixture(() => ({ ...script(), opening: { ...script().opening, text: claim } }));
    await assert.rejects(createRoadshowService(ports).generate(actor, input()), outputError);
    assert.equal(ports.rows.size, 0);
  }
  for (const qualified of ["需要验证：我们已有1000名用户是否属实。", "目标是将来验证准确率达到90%。", "我们计划访谈十位用户。", "我们尚未获得一等奖。", "我们不宣称现场运行成功。"] ) {
    const result = { ...script(), opening: { ...script().opening, text: qualified } };
    assert.equal(validateRoadshowScript(result, input()).opening.text, qualified);
  }
});

test("Chinese interview and willingness counts require affirmative user supplied evidence", async () => {
  for (const claim of ["我们访谈了十位用户，九位愿意付费。", "九位愿意付费。", "十位用户表示愿意订阅。", "90%用户愿意付费。", "我们访谈过目标用户。", "已完成十次用户访谈。", "真实用户表示愿意购买。"] ) {
    const ports = fixture(() => ({ ...script(), opening: { ...script().opening, text: claim } }));
    await assert.rejects(createRoadshowService(ports).generate(actor, input()), outputError);
    assert.equal(ports.rows.size, 0);
  }
  const actual = "据用户自述：我们访谈了十位用户，九位愿意付费。";
  const result = { ...script(), opening: { ...script().opening, text: actual } };
  assert.equal(validateRoadshowScript(result, { ...input(), facts: "我们访谈了十位用户，九位愿意付费" }).opening.text, actual);
  const targetUsers = "据用户自述：我们访谈了十位目标用户。";
  const targetResult = { ...script(), opening: { ...script().opening, text: targetUsers } };
  assert.equal(validateRoadshowScript(targetResult, { ...input(), facts: "我们访谈了十位目标用户" }).opening.text, targetUsers);
  assert.throws(() => validateRoadshowScript(result, { ...input(), facts: "计划访谈十位用户，假设九位愿意付费" }), outputError);
  assert.throws(() => validateRoadshowScript(result, { ...input(), facts: "", assumptions: "我们访谈了十位用户，九位愿意付费" }), outputError);
});

test("Markdown export is a complete readable private draft and escapes HTML/instructions", () => {
  const doc: RoadshowDocument = { input: { ...input(), projectIdea: "<script>私人想法</script> [外链](https://invalid.example)" }, script: script() };
  const markdown = roadshowToMarkdown(doc);
  assert.match(markdown, /由 DSH/); assert.match(markdown, /300 秒/); assert.match(markdown, /预期/);
  assert.match(markdown, /失败备选/); assert.match(markdown, /问答/); assert.match(markdown, /待核实事项/);
  assert.ok(!markdown.includes("<script>")); assert.ok(!markdown.includes("[外链](")); assert.match(markdown, /&lt;script&gt;/);
});

test("HTTP authenticates and mutation-checks before private generation and forwards fresh session", async () => {
  const ports = fixture(); const guard: FreshSessionGuard = async () => {};
  let mutationCalls = 0;
  const handlers = createRoadshowHandlers({ service: createRoadshowService(ports), resolveActor: async () => actor,
    authorizeMutation: async (_request, current) => { assert.equal(current, actor); mutationCalls++; },
    freshSessionGuard: (_request, current) => { assert.equal(current, actor); return guard; }, requestIds: { next: () => "request-1" } });
  const response = await handlers.generate(new Request("https://local.example/me/roadshow/scripts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input()) }));
  assert.equal(response.status, 201); assert.equal(mutationCalls, 1); assert.equal(ports.guards[0], guard);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  const generated = await response.json() as { data: { id: string; data: RoadshowDocument } };
  assert.deepEqual(generated.data.data.input, input());
  const listed = await handlers.list(new Request("https://local.example/me/artifacts?kind=roadshow"));
  assert.equal(((await listed.json()) as { data: unknown[] }).data.length, 1);
  const detail = await handlers.get(new Request(`https://local.example/me/artifacts/${generated.data.id}`), { id: generated.data.id });
  assert.equal(detail.status, 200);
});

test("HTTP rejects login, CSRF, wrong method/JSON/streamed size without leaking provider errors", async () => {
  const ports = fixture(); const guard: FreshSessionGuard = async () => {};
  const base = { service: createRoadshowService(ports), resolveActor: async () => actor, authorizeMutation: async () => {}, freshSessionGuard: () => guard, requestIds: { next: () => "request-2" } };
  const request = (body = JSON.stringify(input()), contentType = "application/json") => new Request("https://local.example/me/roadshow/scripts", { method: "POST", headers: { "Content-Type": contentType }, body });
  assert.equal((await createRoadshowHandlers({ ...base, resolveActor: async () => null }).generate(request())).status, 401);
  assert.equal((await createRoadshowHandlers({ ...base, authorizeMutation: async () => { throw new DomainError("CSRF_REJECTED", "请求来源无效。", { status: 403 }); } }).generate(request())).status, 403);
  assert.equal((await createRoadshowHandlers(base).generate(new Request("https://local.example/me/roadshow/scripts"))).status, 405);
  assert.equal((await createRoadshowHandlers(base).generate(request("{}", "text/plain"))).status, 415);
  assert.equal((await createRoadshowHandlers(base).generate(request("{"))).status, 400);
  assert.equal((await createRoadshowHandlers(base).generate(request(JSON.stringify({ ...input(), owner: other.userId })))).status, 422);
  assert.equal((await createRoadshowHandlers(base).generate(request("字".repeat(40_000)))).status, 413);
  assert.equal(ports.requests.length, 0);
  const failing = createRoadshowHandlers({ ...base, service: { ...base.service, async generate() { throw new Error("PRIVATE PROVIDER SECRET"); } } });
  const result = await failing.generate(request());
  assert.equal(result.status, 500); assert.ok(!(await result.text()).includes("PRIVATE PROVIDER SECRET"));
});
