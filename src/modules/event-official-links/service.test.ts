import test from "node:test";
import assert from "node:assert/strict";
import type { PublishedOfficialRules } from "./model.ts";
import { officialLinkError, officialLinksFixture, setInput } from "./testing.ts";

test("same-name events remain unlinked until an explicit selection; two organizations retain separate mappings", async t => {
  const f = await officialLinksFixture(t);
  assert.equal((await f.service.get(f.users.administrator, "hosted-a")).state, "unlinked");
  assert.equal(await f.service.getLinkedEventId(f.database, await f.hosted()), null);
  await f.service.set(f.users.administrator, "hosted-a", setInput());
  await f.service.set(f.users.administrator, "hosted-b", setInput({ expectedHostedPublishedRevision: 5, linkedEventId: "rules-b", rulesVersion: 7 }));
  const a = await f.service.get(f.users.administrator, "hosted-a"), b = await f.service.get(f.users.administrator, "hosted-b");
  assert.equal(a.link?.organizationId, "org-a"); assert.equal(a.link?.linkedEventId, "rules-a");
  assert.equal(b.link?.organizationId, "org-b"); assert.equal(b.link?.linkedEventId, "rules-b");
  assert.equal(await f.service.getLinkedEventId(f.database, await f.hosted("hosted-b")), "rules-b");
  const currentB = await f.hosted("hosted-b");
  assert.equal(await f.database.transaction(sql => f.service.getLinkedEventId(sql, currentB, { forUpdate: true })), "rules-b");
  assert.equal(await f.service.getLinkedEventId(f.database, { ...await f.hosted(), organizationId: "org-b" }), null);
  assert.equal(await f.service.getLinkedEventId(f.database, { ...await f.hosted(), status: "draft" }), null);
  assert.equal(await f.service.getLinkedEventId(f.database, { ...await f.hosted(), publishedRevision: 999 }), null);
  assert.equal(await f.service.getLinkedEventId(f.database, { ...await f.hosted(), eventId: "hosted-b" }), null);
  await f.service.withdraw(f.users.administrator, "hosted-a", { expectedRevision: 1, auditNote: "甲赛事撤回关联" });
  assert.equal((await f.service.get(f.users.administrator, "hosted-b")).state, "active");
  assert.deepEqual(await f.counts(), { heads: 2, history: 3 });
});

test("organizers, reviewers and outsiders cannot use any administrator mapping operation", async t => {
  const f = await officialLinksFixture(t);
  for (const user of [f.users.organizer, f.users.reviewer, f.users.outsider]) {
    for (const action of [
      () => f.service.get(user, "hosted-a"), () => f.service.listCandidates(user, "hosted-a"),
      () => f.service.set(user, "hosted-a", setInput()), () => f.service.withdraw(user, "hosted-a", { expectedRevision: 1, auditNote: "撤回" }),
      () => f.service.history(user, "hosted-a"),
    ]) await assert.rejects(action, officialLinkError("OFFICIAL_LINK_FORBIDDEN"));
  }
  assert.deepEqual(await f.counts(), { heads: 0, history: 0 });
});

test("current database session, account and roles are checked instead of trusting a cached admin actor", async t => {
  const f = await officialLinksFixture(t);
  await f.direct.query("UPDATE official_link_test_sessions SET active=false WHERE user_id=$1", ["administrator"]);
  await assert.rejects(() => f.service.set(f.users.administrator, "hosted-a", setInput()), officialLinkError("AUTH_SESSION_INVALID"));
  await f.direct.query("UPDATE official_link_test_sessions SET active=true WHERE user_id=$1", ["administrator"]);
  await f.direct.query("UPDATE auth_users SET platform_roles=$1::text[] WHERE id=$2", [["user"], "administrator"]);
  await assert.rejects(() => f.service.get(f.users.administrator, "hosted-a"), officialLinkError("AUTH_SESSION_INVALID"));
  await f.direct.query("UPDATE auth_users SET platform_roles=$1::text[],active=false WHERE id=$2", [["user", "admin"], "administrator"]);
  await assert.rejects(() => f.service.listCandidates(f.users.administrator, "hosted-a"), officialLinkError("AUTH_SESSION_INVALID"));
  const forged = f.principal("organizer", { actor: { userId: "organizer", platformRoles: ["user", "admin"] } });
  await assert.rejects(() => f.service.set(forged, "hosted-a", setInput()), officialLinkError("AUTH_SESSION_INVALID"));
  assert.deepEqual(await f.counts(), { heads: 0, history: 0 });
});

test("revocation detected by the final guard rolls back both head and immutable history", async t => {
  const f = await officialLinksFixture(t);
  const revoked = f.principal("administrator", { beforeGuard: async (sql, call) => {
    if (call === 2) await sql.query("UPDATE official_link_test_sessions SET active=false WHERE user_id=$1", ["administrator"]);
  } });
  await assert.rejects(() => f.service.set(revoked, "hosted-a", setInput()), officialLinkError("AUTH_SESSION_INVALID"));
  assert.deepEqual(await f.counts(), { heads: 0, history: 0 });
  assert.equal((await f.direct.query<{ active: boolean }>("SELECT active FROM official_link_test_sessions WHERE user_id=$1", ["administrator"])).rows[0]?.active, true);
  await f.service.set(f.users.administrator, "hosted-a", setInput());
  await assert.rejects(() => f.service.withdraw(f.principal("administrator", { failAt: 2 }), "hosted-a", { expectedRevision: 1, auditNote: "末尾权限失效" }), officialLinkError("AUTH_SESSION_INVALID"));
  assert.equal((await f.service.get(f.users.administrator, "hosted-a")).link?.status, "active");
  assert.deepEqual(await f.counts(), { heads: 1, history: 1 });
});

test("CAS grants only one write for the same missing or existing mapping revision", async t => {
  const f = await officialLinksFixture(t);
  // PGlite serializes these transactions; this verifies real SQL CAS, not multi-connection PostgreSQL concurrency.
  let results = await Promise.allSettled([f.service.set(f.users.administrator, "hosted-a", setInput()), f.service.set(f.users.administrator, "hosted-a", setInput())]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected" && officialLinkError("OFFICIAL_LINK_REVISION_CONFLICT")(result.reason)).length, 1);
  results = await Promise.allSettled([
    f.service.set(f.users.administrator, "hosted-a", setInput({ expectedRevision: 1, auditNote: "重新核对甲" })),
    f.service.set(f.users.administrator, "hosted-a", setInput({ expectedRevision: 1, linkedEventId: "rules-b", rulesVersion: 7, auditNote: "人工更正身份" })),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected" && officialLinkError("OFFICIAL_LINK_REVISION_CONFLICT")(result.reason)).length, 1);
  assert.equal((await f.service.get(f.users.administrator, "hosted-a")).link?.revision, 2);
  assert.deepEqual(await f.counts(), { heads: 1, history: 2 });
});

test("set rejects stale Hosted and M03 versions, missing publication, draft and unavailable organizations", async t => {
  const f = await officialLinksFixture(t);
  for (const input of [setInput({ expectedHostedPublishedRevision: 1 }), setInput({ rulesVersion: 2 }), setInput({ linkedEventId: "rules-draft", rulesVersion: 1 }), setInput({ linkedEventId: "unknown-rules" })]) {
    await assert.rejects(() => f.service.set(f.users.administrator, "hosted-a", input), officialLinkError("OFFICIAL_LINK_STALE_VERSION"));
  }
  await f.changeHosted("hosted-a", { status: "draft", publishedRevision: null });
  await assert.rejects(() => f.service.set(f.users.administrator, "hosted-a", setInput()), officialLinkError("OFFICIAL_LINK_STALE_VERSION"));
  await f.changeHosted("hosted-a", { status: "published", publishedRevision: 2 });
  await f.direct.query("UPDATE organizer_organizations SET status='pending' WHERE id=$1", ["org-a"]);
  await assert.rejects(() => f.service.set(f.users.administrator, "hosted-a", setInput()), officialLinkError("OFFICIAL_LINK_NOT_FOUND"));
  await f.direct.query("UPDATE organizer_organizations SET status='approved',active=false WHERE id=$1", ["org-a"]);
  await assert.rejects(() => f.service.set(f.users.administrator, "hosted-a", setInput()), officialLinkError("OFFICIAL_LINK_NOT_FOUND"));
  assert.deepEqual(await f.counts(), { heads: 0, history: 0 });
});

test("mapping, candidates, history and trusted resolution are read-only and never refresh a stored version", async t => {
  const f = await officialLinksFixture(t);
  await f.service.set(f.users.administrator, "hosted-a", setInput());
  const saved = (await f.service.get(f.users.administrator, "hosted-a")).link;
  await f.changeHosted("hosted-a", { publishedRevision: 4 });
  f.statements.length = 0;
  const stale = await f.service.get(f.users.administrator, "hosted-a");
  assert.equal(stale.state, "stale"); assert.equal(stale.staleReason, "hosted_version_changed"); assert.ok(stale.staleMessage);
  assert.deepEqual(stale.link, saved);
  assert.equal(await f.service.getLinkedEventId(f.database, await f.hosted()), null);
  assert.equal(await f.service.getLinkedEventId(f.database, { ...await f.hosted(), publishedRevision: 2 }), null);
  await f.service.listCandidates(f.users.administrator, "hosted-a"); await f.service.history(f.users.administrator, "hosted-a");
  assert.equal(f.statements.some(statement => /\b(?:INSERT|UPDATE|DELETE)\b|FOR UPDATE/i.test(statement)), false);
  assert.deepEqual(await f.counts(), { heads: 1, history: 1 });
});

test("M03 new version or withdrawal disables trusted mapping with a specific stale reason", async t => {
  const f = await officialLinksFixture(t); await f.service.set(f.users.administrator, "hosted-a", setInput());
  await f.direct.query("UPDATE official_link_test_rules SET published_version=4 WHERE event_id=$1", ["rules-a"]);
  assert.equal((await f.service.get(f.users.administrator, "hosted-a")).staleReason, "rules_version_changed");
  assert.equal(await f.service.getLinkedEventId(f.database, await f.hosted()), null);
  await f.direct.query("UPDATE official_link_test_rules SET status='withdrawn' WHERE event_id=$1", ["rules-a"]);
  assert.equal((await f.service.get(f.users.administrator, "hosted-a")).staleReason, "rules_unavailable");
  assert.equal(await f.service.getLinkedEventId(f.database, await f.hosted()), null);
  await f.direct.query("UPDATE organizer_organizations SET active=false WHERE id=$1", ["org-a"]);
  const unavailable = await f.service.get(f.users.administrator, "hosted-a");
  assert.equal(unavailable.staleReason, "hosted_unavailable"); assert.equal(unavailable.hostedEvent, null);
  assert.equal(await f.service.getLinkedEventId(f.database, await f.hosted()), null);
  assert.deepEqual(await f.counts(), { heads: 1, history: 1 });
});

test("drafting or ending the hosted event makes the mapping stale even if the version number was kept", async t => {
  const f = await officialLinksFixture(t); await f.service.set(f.users.administrator, "hosted-a", setInput());
  for (const status of ["draft", "ended", "archived"] as const) {
    await f.changeHosted("hosted-a", { status });
    assert.equal((await f.service.get(f.users.administrator, "hosted-a")).staleReason, "hosted_not_published");
    assert.equal(await f.service.getLinkedEventId(f.database, await f.hosted()), null);
  }
  assert.deepEqual(await f.counts(), { heads: 1, history: 1 });
});

test("retry set does not duplicate history; withdrawal retains a CAS tombstone and immutable snapshots", async t => {
  const f = await officialLinksFixture(t);
  const original = await f.service.set(f.users.administrator, "hosted-a", setInput());
  await assert.rejects(() => f.service.set(f.users.administrator, "hosted-a", setInput()), officialLinkError("OFFICIAL_LINK_REVISION_CONFLICT"));
  const withdrawn = await f.service.withdraw(f.users.administrator, "hosted-a", { expectedRevision: 1, auditNote: "发现正式规则身份需重核" });
  assert.equal(withdrawn.state, "withdrawn"); assert.equal(withdrawn.link?.revision, 2); assert.equal(withdrawn.link?.linkedEventId, "rules-a");
  const retry = await f.service.withdraw(f.users.administrator, "hosted-a", { expectedRevision: 2, auditNote: "重复请求" });
  assert.deepEqual(retry.link, withdrawn.link);
  await assert.rejects(() => f.service.withdraw(f.users.administrator, "hosted-a", { expectedRevision: 1, auditNote: "旧请求" }), officialLinkError("OFFICIAL_LINK_REVISION_CONFLICT"));
  assert.equal(await f.service.getLinkedEventId(f.database, await f.hosted()), null);
  await assert.rejects(() => f.service.set(f.users.administrator, "hosted-a", setInput()), officialLinkError("OFFICIAL_LINK_REVISION_CONFLICT"));
  const rebound = await f.service.set(f.users.administrator, "hosted-a", setInput({ expectedRevision: 2, linkedEventId: "rules-b", rulesVersion: 7, auditNote: "明确重新核对并关联乙规则" }));
  assert.equal(rebound.link?.revision, 3);
  const history = await f.service.history(f.users.administrator, "hosted-a");
  assert.deepEqual(history.map(link => [link.revision, link.status]), [[3, "active"], [2, "withdrawn"], [1, "active"]]);
  assert.deepEqual(history[2], original.link);
  await assert.rejects(() => f.direct.query("UPDATE event_official_link_history SET document=$1 WHERE hosted_event_id=$2", [JSON.stringify(rebound.link), "hosted-a"]), /immutable/);
  await assert.rejects(() => f.direct.query("DELETE FROM event_official_link_history WHERE hosted_event_id=$1", ["hosted-a"]), /immutable/);
  assert.deepEqual(await f.service.history(f.users.administrator, "hosted-a"), history);
  assert.deepEqual(await f.counts(), { heads: 1, history: 3 });
});

test("post-write Hosted or rules changes roll back the mapping and history in the same SQL transaction", async t => {
  const f = await officialLinksFixture(t);
  let calls = 0;
  const changedHosted = f.serviceWith({ getHostedEvent: async (sql, id, options) => {
    calls += 1; if (calls === 2) await f.changeHosted(id, { publishedRevision: 9 }, sql);
    return f.options.getHostedEvent(sql, id, options);
  } });
  await assert.rejects(() => changedHosted.set(f.users.administrator, "hosted-a", setInput()), officialLinkError("OFFICIAL_LINK_STALE_VERSION"));
  assert.equal((await f.hosted()).publishedRevision, 2); assert.deepEqual(await f.counts(), { heads: 0, history: 0 });
  calls = 0;
  const changedRules = f.serviceWith({ rulesPort: { ...f.options.rulesPort, getPublished: async (sql, id) => {
    calls += 1; if (calls === 2) await sql.query("UPDATE official_link_test_rules SET published_version=8 WHERE event_id=$1", [id]);
    return f.options.rulesPort.getPublished(sql, id);
  } } });
  await assert.rejects(() => changedRules.set(f.users.administrator, "hosted-a", setInput()), officialLinkError("OFFICIAL_LINK_STALE_VERSION"));
  assert.equal((await f.options.rulesPort.getPublished(f.direct, "rules-a"))?.publishedVersion, 3);
  assert.deepEqual(await f.counts(), { heads: 0, history: 0 });
});

test("candidate projection is rechecked against the current published head and never trusts stale or duplicate entries", async t => {
  const f = await officialLinksFixture(t);
  const current = (await f.options.rulesPort.getPublished(f.direct, "rules-a"))!;
  const raw = [current, current, { ...current, eventId: "rules-b", publishedVersion: 6 }, { ...current, eventId: "rules-draft", publishedVersion: 1 }, { ...current, eventId: "bad/id" }] satisfies PublishedOfficialRules[];
  const directory = f.serviceWith({ rulesPort: { ...f.options.rulesPort, listPublished: async (_sql, input) => { assert.equal(input.limit, 100); assert.equal(input.query, "同名"); return raw; } } });
  assert.deepEqual(await directory.listCandidates(f.users.administrator, "hosted-a", " 同名 "), [current]);
  await assert.rejects(() => directory.listCandidates(f.users.administrator, "hosted-a", "x".repeat(201)), officialLinkError("OFFICIAL_LINK_INVALID_INPUT"));
  const unconfigured = f.serviceWith({ rulesPort: { getPublished: f.options.rulesPort.getPublished } });
  await assert.rejects(() => unconfigured.listCandidates(f.users.administrator, "hosted-a"), officialLinkError("OFFICIAL_RULE_CANDIDATES_UNCONFIGURED"));
  assert.deepEqual(await f.counts(), { heads: 0, history: 0 });
});

test("service rejects caller-owned organization, invalid IDs, version coercion and unsafe notes", async t => {
  const f = await officialLinksFixture(t);
  for (const input of [
    { ...setInput(), organizationId: "org-b" }, { ...setInput(), updatedBy: "outsider" }, { ...setInput(), sourceUrl: "https://fake.example" },
    { ...setInput(), linkedEventId: "rules-a' OR 1=1" }, { ...setInput(), expectedRevision: "0" }, { ...setInput(), rulesVersion: 0 },
    { ...setInput(), expectedHostedPublishedRevision: 1.5 }, { ...setInput(), rulesVersion: 2147483648 }, { ...setInput(), auditNote: "\u0000unsafe" }, { ...setInput(), auditNote: " " },
  ]) await assert.rejects(() => f.service.set(f.users.administrator, "hosted-a", input), officialLinkError("OFFICIAL_LINK_INVALID_INPUT"));
  await assert.rejects(() => f.service.get(f.users.administrator, "hosted-a/other"), officialLinkError("OFFICIAL_LINK_INVALID_INPUT"));
  await assert.rejects(() => f.service.withdraw(f.users.administrator, "hosted-a", { expectedRevision: 0, auditNote: "撤回" }), officialLinkError("OFFICIAL_LINK_INVALID_INPUT"));
  assert.deepEqual(await f.counts(), { heads: 0, history: 0 });
});

test("SQL scope foreign key prevents storing a Hosted mapping under another organization", async t => {
  const f = await officialLinksFixture(t); const view = await f.service.set(f.users.administrator, "hosted-a", setInput());
  const forged = { ...view.link!, hostedEventId: "hosted-b" };
  await assert.rejects(() => f.direct.query("INSERT INTO event_official_links(hosted_event_id,organization_id,hosted_published_revision,linked_event_id,rules_version,revision,status,document,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", ["hosted-b", "org-a", 2, "rules-a", 3, 1, "active", JSON.stringify(forged), "administrator", "2026-10-11T04:00:00.000Z"]), /foreign key/);
  assert.deepEqual(await f.counts(), { heads: 1, history: 1 });
});
