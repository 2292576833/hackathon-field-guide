import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "./database.ts";
import { createDiscoveryService, type DiscoveryInput } from "./discovery.ts";
import type { DiscoveryRegistrationClosureInput } from "../modules/operations/discovery-types.ts";
import { getLibraryArticle, listLibraryArticles } from "./library.ts";

const clock = { now: () => new Date("2026-10-08T10:00:00Z") };
function input(): DiscoveryInput { return {
  canonicalUrl: "https://hackathon.devpost.com/?utm_source=search", title: "来源夹具赛事", summary: "测试夹具，不用于真实网站内容。",
  analysis: { fit: ["需要核对赛道"], risks: [], preparation: ["阅读规则"], unknowns: ["截止待核实"] },
  sources: [{ url: "https://hackathon.devpost.com/", title: "测试来源", excerpt: "报名开放，报名截止时间为 2026-10-20T12:00:00+08:00。", fetchedAt: "2026-10-08T08:00:00Z" }],
  discoveredAt: "2026-10-08T08:00:00Z", lastAnalyzedAt: "2026-10-08T08:30:00Z", provider: "dsh",
  registrationWindow: { status: "open", closesAt: "2026-10-20T12:00:00+08:00", closesOn: null, evidence: ["报名开放，报名截止时间为 2026-10-20T12:00:00+08:00。"], checkedAt: "2026-10-08T08:30:00Z" },
}; }
test("discovery feed persists canonical cards, immutable changes and refuses stale overwrites", async () => {
  const database = await createDatabase({});
  try {
    await database.migrate();
    const service = createDiscoveryService(database, clock);
    const original = await service.save(input());
    const repeated = await service.save({ ...input(), canonicalUrl: "https://hackathon.devpost.com/", lastAnalyzedAt: "2026-10-08T09:00:00Z" });
    assert.deepEqual(repeated, original);
    assert.equal((await service.get(original.id)).verificationStatus, "unverified");
    assert.equal((await service.list({ query: "夹具" })).items.length, 1);
    const revised = await service.save({ ...input(), title: "修订夹具赛事", lastAnalyzedAt: "2026-10-08T09:30:00Z" });
    assert.equal(revised.revision, 2);
    await service.save(input());
    assert.equal((await service.get(original.id)).title, "修订夹具赛事");
    assert.equal((await database.query("SELECT * FROM event_discovery_versions")).rows.length, 2);
    assert.equal((await database.query("SELECT * FROM m03_events")).rows.length, 0);
    await assert.rejects(service.save({ ...input(), canonicalUrl: "https://127.0.0.1/" }), { code: "UNSAFE_SOURCE_URL" });
    await assert.rejects(service.save({ ...input(), sources: [] }), { code: "INVALID_DISCOVERY" });
    await assert.rejects(service.list({ cursor: "invalid" }), { code: "INVALID_CURSOR" });
  } finally { await database.close(); }
});
test("all saved event analyses remain visible with their registration status", async () => {
  const database = await createDatabase({});
  try {
    await database.migrate(); const service = createDiscoveryService(database, clock);
    const registrationEvidence = "Registration is open, but the application deadline is not specified.";
    const eventEvidence = "Hackathon starts 2027-01-30.";
    const value: DiscoveryInput = { ...input(), canonicalUrl: "https://example.com/future-event", sources: [{ ...input().sources[0]!, excerpt: `${registrationEvidence} ${eventEvidence}` }], registrationWindow: { status: "unknown", closesAt: null, closesOn: null, evidence: [registrationEvidence], checkedAt: input().lastAnalyzedAt }, eventWindow: { status: "future", startsAt: null, startsOn: "2027-01-30", evidence: [eventEvidence], checkedAt: input().lastAnalyzedAt } };
    const saved = await service.save(value);
    assert.equal((await service.list()).items.length, 1);
    assert.equal((await service.get(saved.id)).eventWindow?.startsOn, "2027-01-30");
    const closed = await service.save({ ...value, canonicalUrl: "https://example.com/closed-future", registrationWindow: { ...value.registrationWindow!, status: "closed", evidence: ["Registration is closed."] }, sources: [{ ...value.sources[0]!, excerpt: `${eventEvidence} Registration is closed.` }] });
    assert.equal((await service.get(closed.id)).registrationWindow?.status, "closed");
    assert.equal((await service.list()).items.length, 2);
  } finally { await database.close(); }
});
test("library has original website onboarding, hackathon and official GitHub reference cards", () => {
  assert.ok(listLibraryArticles().items.length >= 6);
  assert.equal(getLibraryArticle("start-here").category, "网站介绍");
  assert.ok(listLibraryArticles("", "GitHub 指南").items.every(item => item.links.some(link => link.url.startsWith("https://docs.github.com/"))));
  assert.throws(() => getLibraryArticle("missing"), { code: "NOT_FOUND" });
});
test("indexed search evidence preserves its provenance and cannot claim a full-page source", async () => {
  const database = await createDatabase({});
  try {
    await database.migrate(); const service = createDiscoveryService(database, clock);
    const candidate = input();
    candidate.sources = candidate.sources.map(source => ({ ...source, sourceKind: "indexed_excerpt" }));
    const saved = await service.save(candidate);
    assert.equal((await service.get(saved.id)).sources[0]?.sourceKind, "indexed_excerpt");
    await assert.rejects(service.save({ ...candidate, sources: [{ ...candidate.sources[0]!, sourceKind: "invented" as "page" }] }), { code: "INVALID_DISCOVERY" });
  } finally { await database.close(); }
});
test("registration and participation survive durable revisions while legacy cards remain unchanged", async () => {
  const database = await createDatabase({});
  try {
    await database.migrate(); const service = createDiscoveryService(database, clock);
    const oldInput = input(), old = await service.save(oldInput), oldCard = await service.get(old.id);
    assert.equal("registration" in oldCard, false); assert.equal("participation" in oldCard, false);
    const registration = { url: "https://forms.hackathon.dev/apply", sourceUrl: oldCard.sources[0]!.url, evidence: "立即报名参赛" };
    const participation = { recommendation: "insufficient_info" as const, reason: "规则没有清楚说明年龄和设备条件，需先核实。", suitableFor: ["可以先核实规则的新人"], cautionFor: ["无法确认参赛时间的队伍"] };
    const enriched = { ...oldInput, sources: [...oldInput.sources, { ...oldInput.sources[0]!, excerpt: registration.evidence }], registration, participation, lastAnalyzedAt: "2026-10-08T09:00:00Z" };
    const saved = await service.save(enriched); assert.equal(saved.revision, 2);
    const card = await service.get(saved.id); assert.deepEqual(card.registration, registration); assert.deepEqual(card.participation, participation);
    assert.deepEqual((await service.list()).items[0]?.registration, registration);
    const repeated = await service.save({ ...enriched, lastAnalyzedAt: "2026-10-08T09:30:00Z" }); assert.equal(repeated.revision, 2);
    const history = (await database.query<{ content: DiscoveryInput }>("SELECT content FROM event_discovery_versions WHERE card_id=$1 ORDER BY revision", [saved.id])).rows;
    assert.equal(history.length, 2); assert.equal("registration" in history[0]!.content, false);
    assert.deepEqual(history[1]!.content.registration, registration); assert.deepEqual(history[1]!.content.participation, participation);
    const snapshot = structuredClone(card);
    await service.save({ ...enriched, registration: null, participation: { ...participation, recommendation: "caution", reason: "发现新的参赛限制，须核实后决定。" }, lastAnalyzedAt: "2026-10-08T09:45:00Z" });
    assert.equal((await service.get(saved.id)).registration, null); assert.deepEqual(snapshot.registration, registration);
  } finally { await database.close(); }
});

test("durable discovery ingestion requires signup source evidence and bounded participation", async () => {
  const database = await createDatabase({});
  try {
    await database.migrate(); const service = createDiscoveryService(database, clock), candidate = input();
    const registration = { url: "https://forms.hackathon.dev/apply", sourceUrl: candidate.sources[0]!.url, evidence: candidate.sources[0]!.excerpt };
    const participation = { recommendation: "consider" as const, reason: "愿意核实报名条件并准备演示的队伍可以考虑。", suitableFor: ["能准备小型原型的队伍"], cautionFor: ["规则尚未确认"] };
    for (const invalid of [
      { registration: { ...registration, evidence: "没有出现在保存来源里的证据" } },
      { registration: { ...registration, sourceUrl: "https://other.hackathon.dev/news" } },
      { registration: { ...registration, url: "javascript:alert(1)" } },
      { registration: { ...registration, url: "https://forms.hackathon.dev/apply?token=private" } },
      { registration: { ...registration, url: "https://127.0.0.1/apply" } },
      { participation: { ...participation, recommendation: "certain" } },
      { participation: { ...participation, reason: "匹配度 100%" } },
      { participation: { ...participation, suitableFor: Array(9).fill("新人") } },
    ]) await assert.rejects(service.save({ ...candidate, ...invalid } as DiscoveryInput), { code: "INVALID_DISCOVERY" });
    assert.equal((await service.list()).items.length, 0);
    const saved = await service.save({ ...candidate, registration, participation });
    assert.deepEqual((await service.get(saved.id)).registration, registration);
  } finally { await database.close(); }
});

test("legacy cards remain in immutable storage and appear with their missing registration status", async () => {
  const database = await createDatabase({});
  try {
    await database.migrate(); const service = createDiscoveryService(database, clock);
    const legacy = input(); delete legacy.registrationWindow;
    const saved = await service.save(legacy);
    assert.equal((await service.list()).items.length, 1); assert.equal((await service.get(saved.id)).registrationWindow, undefined);
    const history = (await database.query<{ content: DiscoveryInput }>("SELECT content FROM event_discovery_versions WHERE card_id=$1", [saved.id])).rows;
    assert.equal(history.length, 1); assert.equal(history[0]!.content.registrationWindow, undefined);
    assert.equal((await database.query("SELECT id FROM event_discovery_cards WHERE id=$1 AND status='active'", [saved.id])).rowCount, 1);
    const upgraded = await service.save({ ...input(), lastAnalyzedAt: "2026-10-08T09:00:00Z" });
    assert.equal(upgraded.revision, 2); assert.equal((await service.get(saved.id)).registrationWindow?.status, "open");
    assert.equal((await service.list()).items.length, 1); assert.equal((await database.query("SELECT content FROM event_discovery_versions WHERE card_id=$1", [saved.id])).rowCount, 2);
  } finally { await database.close(); }
});

test("precise and date-only registration deadlines remain visible after their dates without writes", async () => {
  const database = await createDatabase({});
  try {
    await database.migrate(); let milliseconds = Date.parse("2026-10-08T09:59:59.999Z");
    const mutableClock = { now: () => new Date(milliseconds) }, service = createDiscoveryService(database, mutableClock);
    const exactEvidence = "报名开放，报名截止时间为 2026-10-08T18:00:00+08:00。";
    const dateEvidence = "报名开放，报名截止日期为 2026-10-09，未提供具体时间或时区。";
    const exact = await service.save({ ...input(), canonicalUrl: "https://example.com/exact", sources: [{ ...input().sources[0]!, excerpt: exactEvidence }],
      registrationWindow: { status: "open", closesAt: "2026-10-08T18:00:00+08:00", closesOn: null, evidence: [exactEvidence], checkedAt: input().lastAnalyzedAt } });
    const date = await service.save({ ...input(), canonicalUrl: "https://example.com/date", sources: [{ ...input().sources[0]!, excerpt: dateEvidence }],
      registrationWindow: { status: "open", closesAt: null, closesOn: "2026-10-09", evidence: [dateEvidence], checkedAt: input().lastAnalyzedAt } });
    assert.equal((await service.list({ limit: 1 })).items.length, 1); assert.ok((await service.list({ limit: 1 })).nextCursor);
    assert.equal((await service.get(exact.id)).registrationWindow?.closesAt, "2026-10-08T10:00:00.000Z");
    assert.equal((await service.get(date.id)).registrationWindow?.closesOn, "2026-10-09");
    milliseconds++;
    assert.equal((await service.list()).items.length, 2);
    assert.equal((await service.get(exact.id)).registrationWindow?.closesAt, "2026-10-08T10:00:00.000Z");
    assert.equal((await service.get(date.id)).registrationWindow?.closesOn, "2026-10-09");
    assert.equal((await database.query("SELECT id FROM event_discovery_cards")).rowCount, 2);
    assert.equal((await database.query("SELECT revision FROM event_discovery_versions")).rowCount, 2);
    assert.equal((await createDiscoveryService(database, mutableClock).list()).items.length, 2, "restart keeps saved analyses visible");
  } finally { await database.close(); }
});

test("registration window fields remain evidence-checked while unknown and closed states stay visible", async () => {
  const database = await createDatabase({});
  try {
    await database.migrate(); const service = createDiscoveryService(database, clock), value = input();
    for (const registrationWindow of [
      { ...value.registrationWindow!, evidence: ["Invented registration deadline"] },
      { ...value.registrationWindow!, checkedAt: "2026-10-08T10:00:00.001Z" },
      { ...value.registrationWindow!, closesAt: "2026-10-20T12:00:00" },
    ]) await assert.rejects(service.save({ ...value, registrationWindow }), { code: "INVALID_DISCOVERY" });
    const unknown = await service.save({ ...value, canonicalUrl: "https://example.com/unknown-window", registrationWindow: { ...value.registrationWindow!, status: "unknown" as const, closesAt: null, closesOn: null, evidence: ["报名开放，报名截止时间为 2026-10-20T12:00:00+08:00。"] } });
    assert.equal((await service.get(unknown.id)).registrationWindow?.status, "unknown");
    const closedEvidence = "报名已关闭，名额已满。报名截止时间为 2026-10-20T12:00:00+08:00。";
    const closed = await service.save({ ...value, canonicalUrl: "https://example.com/closed-window", sources: [{ ...value.sources[0]!, excerpt: closedEvidence }], registrationWindow: { ...value.registrationWindow!, status: "closed" as const, evidence: [closedEvidence] } });
    assert.equal((await service.get(closed.id)).registrationWindow?.status, "closed");
    const expiredEvidence = "报名开放，报名截止时间为 2026-10-08T10:00:00Z。";
    await assert.rejects(service.save({ ...value, sources: [{ ...value.sources[0]!, excerpt: expiredEvidence }],
      registrationWindow: { ...value.registrationWindow!, closesAt: "2026-10-08T10:00:00Z", evidence: [expiredEvidence] } }), { code: "INVALID_DISCOVERY" });
    assert.equal((await database.query("SELECT id FROM event_discovery_cards")).rowCount, 2);
  } finally { await database.close(); }
});

test("the durable source allowance preserves event, signup, window and two year-evidence excerpts", async () => {
  const database = await createDatabase({});
  try {
    await database.migrate(); const service = createDiscoveryService(database, clock), value = input();
    const original = Array.from({ length: 5 }, (_, index) => ({ ...value.sources[0]!, excerpt: `实际赛事原文片段${index}` }));
    const signup = { ...value.sources[0]!, excerpt: "立即报名参赛" };
    const windowSources = Array.from({ length: 5 }, (_, index) => ({ ...value.sources[0]!, excerpt: `报名开放，报名截止时间为 2026-10-20T12:00:00+08:00。报名说明${index}` }));
    const yearSources = ["2026 Hackathon registration rules", "2026报名年度说明"].map(excerpt => ({ ...value.sources[0]!, excerpt }));
    const expanded: DiscoveryInput = { ...value, sources: [...original, signup, ...windowSources, ...yearSources],
      registration: { url: "https://forms.hackathon.dev/apply", sourceUrl: value.sources[0]!.url, evidence: signup.excerpt },
      registrationWindow: { ...value.registrationWindow!, evidence: windowSources.map(source => source.excerpt) } };
    const saved = await service.save(expanded), card = await service.get(saved.id);
    assert.equal(card.sources.length, 13); assert.equal(card.registrationWindow?.evidence.length, 5); assert.equal(card.registration?.evidence, signup.excerpt);
    await assert.rejects(service.save({ ...expanded, sources: [...expanded.sources, signup] }), { code: "INVALID_DISCOVERY" });
  } finally { await database.close(); }
});

function closure(closesAt = "2026-10-20T12:00:00+08:00"): DiscoveryRegistrationClosureInput {
  const value = input(), evidence = `报名已关闭，名额已满。报名截止时间为 ${closesAt}。`;
  return { canonicalUrl: value.canonicalUrl, provider: "dsh", lastAnalyzedAt: "2026-10-08T09:00:00Z",
    sources: [{ ...value.sources[0]!, excerpt: evidence, fetchedAt: "2026-10-08T09:00:00Z" }],
    registrationWindow: { status: "closed", closesAt, closesOn: null, evidence: [evidence], checkedAt: "2026-10-08T09:00:00Z" } };
}

test("a trusted early registration closure updates the card while keeping it visible", async () => {
  const database = await createDatabase({});
  try {
    await database.migrate(); const service = createDiscoveryService(database, clock), saved = await service.save(input()), snapshot = structuredClone(await service.get(saved.id));
    let commits = 0;
    const closed = await service.closeRegistration(closure(), async save => { commits++; return database.transaction(() => save()); });
    assert.equal(commits, 1); assert.equal(closed?.id, saved.id); assert.equal(closed?.revision, 2);
    assert.equal((await service.get(saved.id)).registrationWindow?.status, "closed"); assert.equal((await service.list()).items.length, 1);
    const history = (await database.query<{ content: DiscoveryInput }>("SELECT content FROM event_discovery_versions WHERE card_id=$1 ORDER BY revision", [saved.id])).rows;
    assert.equal(history.length, 2); assert.equal(history[0]!.content.registrationWindow?.status, "open"); assert.equal(history[1]!.content.registrationWindow?.status, "closed");
    assert.ok(history[1]!.content.sources.some(source => source.excerpt.includes("报名已关闭")));
    assert.equal(snapshot.registrationWindow?.status, "open"); assert.deepEqual(snapshot.sources, history[0]!.content.sources);
    assert.equal((await database.query<{ status: string }>("SELECT status FROM event_discovery_cards WHERE id=$1", [saved.id])).rows[0]!.status, "active");
    const reopened = await service.save({ ...input(), lastAnalyzedAt: "2026-10-08T09:30:00Z", registrationWindow: { ...input().registrationWindow!, checkedAt: "2026-10-08T09:30:00Z" } });
    assert.equal(reopened.revision, 3); assert.equal((await service.get(saved.id)).registrationWindow?.status, "open", "a real later reopening updates the visible card");
  } finally { await database.close(); }
});

test("closure never inserts a first card or trusts unknown, fabricated or merely model-labelled closed information", async () => {
  const database = await createDatabase({});
  try {
    await database.migrate(); const service = createDiscoveryService(database, clock);
    let commits = 0; const commit = async (save: () => Promise<{ id: string; revision: number }>) => { commits++; return database.transaction(() => save()); };
    assert.equal(await service.closeRegistration(closure(), commit), null); assert.equal(commits, 0);
    assert.equal((await database.query("SELECT id FROM event_discovery_cards")).rowCount, 0);
    const saved = await service.save(input());
    const openSource = input();
    await assert.rejects(service.closeRegistration({ ...closure(), sources: openSource.sources, registrationWindow: { ...openSource.registrationWindow!, status: "closed" } }, commit), { code: "INVALID_DISCOVERY" });
    await assert.rejects(service.closeRegistration({ ...closure(), registrationWindow: { ...closure().registrationWindow, status: "unknown" } }, commit), { code: "INVALID_DISCOVERY" });
    await assert.rejects(service.closeRegistration({ ...closure(), registrationWindow: { ...closure().registrationWindow, evidence: ["报名已关闭，来源没有这段文字"] } }, commit), { code: "INVALID_DISCOVERY" });
    assert.equal(commits, 0); assert.equal((await service.get(saved.id)).registrationWindow?.status, "open");
    assert.equal((await database.query("SELECT revision FROM event_discovery_versions")).rowCount, 1);
  } finally { await database.close(); }
});

test("the ledger-provided closure commit fences rollback, stale updates and manually withdrawn cards", async () => {
  const database = await createDatabase({});
  try {
    await database.migrate(); const service = createDiscoveryService(database, clock), saved = await service.save(input());
    await assert.rejects(service.closeRegistration(closure(), async save => database.transaction(async () => { await save(); throw new Error("fixture lease stopped before commit"); })), /fixture lease stopped/);
    assert.equal((await service.get(saved.id)).registrationWindow?.status, "open"); assert.equal((await database.query("SELECT revision FROM event_discovery_versions")).rowCount, 1);
    await service.save({ ...input(), title: "已有更新的可信来源", lastAnalyzedAt: "2026-10-08T09:30:00Z" });
    const stale = await service.closeRegistration(closure(), save => database.transaction(() => save()));
    assert.equal(stale?.revision, 2); assert.equal((await service.get(saved.id)).registrationWindow?.status, "open");
    await database.query("UPDATE event_discovery_cards SET status='withdrawn' WHERE id=$1", [saved.id]);
    const later = { ...closure(), lastAnalyzedAt: "2026-10-08T09:45:00Z", registrationWindow: { ...closure().registrationWindow, checkedAt: "2026-10-08T09:45:00Z" } };
    assert.equal((await service.closeRegistration(later, save => database.transaction(() => save())))?.revision, 2);
    assert.equal((await database.query("SELECT revision FROM event_discovery_versions")).rowCount, 2);
    assert.equal((await database.query<{ status: string }>("SELECT status FROM event_discovery_cards WHERE id=$1", [saved.id])).rows[0]!.status, "withdrawn");
  } finally { await database.close(); }
});

test("partial registration dates are rechecked against retained current-event year evidence rather than the server year", async () => {
  const database = await createDatabase({});
  try {
    await database.migrate(); const service = createDiscoveryService(database, clock), value = input();
    const excerpt = "報名時間：09/04 (五) ~ 11/02 (一) 12:00截止", yearExcerpts = ["115年正式期程", "© 2026新竹市政府"];
    const registrationWindow = { status: "open" as const, closesAt: null, closesOn: "2026-11-02", evidence: [excerpt], checkedAt: value.lastAnalyzedAt };
    const sources = [excerpt, ...yearExcerpts].map(excerpt => ({ ...value.sources[0]!, excerpt }));
    await assert.rejects(service.save({ ...value, registrationWindow, sources: sources.slice(0, 1) }), { code: "INVALID_DISCOVERY" });
    await assert.rejects(service.save({ ...value, registrationWindow, sources: sources.slice(0, 2) }), { code: "INVALID_DISCOVERY" });
    const saved = await service.save({ ...value, registrationWindow, sources });
    const card = await service.get(saved.id); assert.equal(card.registrationWindow?.closesOn, "2026-11-02");
    assert.ok(yearExcerpts.every(excerpt => card.sources.some(source => source.excerpt === excerpt)));
    const evidence = "報名已關閉。報名截止日期：11/02。", at = "2026-10-08T09:00:00Z";
    await service.closeRegistration({ canonicalUrl: value.canonicalUrl, provider: "dsh", lastAnalyzedAt: at,
      registrationWindow: { ...registrationWindow, status: "closed", evidence: [evidence], checkedAt: at },
      sources: [evidence, ...yearExcerpts].map(excerpt => ({ ...value.sources[0]!, excerpt, fetchedAt: at })) }, save => database.transaction(() => save()));
    const closed = (await database.query<{ content: DiscoveryInput }>("SELECT content FROM event_discovery_cards WHERE id=$1", [saved.id])).rows[0]!.content;
    assert.equal(closed.registrationWindow?.status, "closed"); assert.ok(yearExcerpts.every(excerpt => closed.sources.some(source => source.excerpt === excerpt)));
    assert.equal((await service.get(saved.id)).registrationWindow?.status, "closed");
  } finally { await database.close(); }
});
