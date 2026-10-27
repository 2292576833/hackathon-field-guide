import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Actor } from "../../shared/contracts.ts";
import { DomainError } from "../../shared/errors.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";
import { createParticipantService, validateParticipantProfileUpdate } from "./service.ts";
import type { ParticipantProfileUpdate } from "./service.ts";

const at = "2026-10-09T08:00:00.000Z";
const alice: Actor = { userId: "participant-alice", platformRoles: ["user"] };
const bob: Actor = { userId: "participant-bob", platformRoles: ["admin"] };
const clock = { now: () => new Date(at) };
const input = (expectedRevision = 0): ParticipantProfileUpdate => ({
  expectedRevision, firstHackathon: true, developmentExperience: "beginner", city: " 上海 ",
  skills: [" TypeScript ", "原型设计"], interests: [" AI Agent "], projectIdea: " 帮助新人拆解比赛规则。 ",
  availableHoursPerDay: 2.5, travelPreference: "rail", presentationExperience: "none",
});
const code = (expected: string) => (error: unknown): boolean => error instanceof DomainError && error.code === expected;

test("persistent participant service checks personal ownership, revisions and fresh guards in disposable PGlite", async t => {
  // No dataDir: an independent memory database; never opens .runtime/postgres-data.
  const engine = new PGlite(); await engine.waitReady;
  const executor = (query: (sql: string, values: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>): SqlExecutor => ({
    async query<Row>(sql: string, parameters: readonly unknown[] = []) {
      const result = await query(sql, [...parameters]);
      return { rows: result.rows as Row[], rowCount: result.rows.length || result.affectedRows || 0 };
    },
  });
  const direct = executor((sql, values) => engine.query(sql, values));
  const database: DatabasePort = {
    query: direct.query,
    transaction: work => engine.transaction(tx => work(executor((sql, values) => tx.query(sql, values)))),
  };
  const service = createParticipantService({ database, clock });
  try {
    await engine.exec(await readFile(new URL("../auth/migrations/001_auth.sql", import.meta.url), "utf8"));
    await engine.exec(await readFile(new URL("./migrations/001_participant_profiles.sql", import.meta.url), "utf8"));
    for (const actor of [alice, bob]) {
      await engine.query("INSERT INTO auth_users(id,email,display_name,timezone,email_verified_at,created_at) VALUES($1,$2,$3,'Asia/Shanghai',$4,$4)",
        [actor.userId, `${actor.userId}@example.test`, actor.userId, at]);
    }
    t.beforeEach(async () => {
      await engine.exec("DELETE FROM participant_profiles; UPDATE auth_users SET status='active'; DELETE FROM auth_sessions");
    });

    await t.test("empty account returns an editable revision 0 profile without any write", async () => {
      const profile = await service.get(alice);
      assert.deepEqual(profile, {
        userId: alice.userId, revision: 0, firstHackathon: null, developmentExperience: null, city: "",
        skills: [], interests: [], projectIdea: "", availableHoursPerDay: null, travelPreference: "undecided",
        presentationExperience: null, updatedAt: null,
      });
      assert.equal((await engine.query("SELECT * FROM participant_profiles")).rows.length, 0);
    });

    await t.test("first save and subsequent full replacement survive service recreation and use normalized values", async () => {
      const value = input();
      const saved = await service.update(alice, value);
      assert.equal(saved.userId, alice.userId); assert.equal(saved.revision, 1); assert.equal(saved.updatedAt, at);
      assert.equal(saved.city, "上海"); assert.deepEqual(saved.skills, ["TypeScript", "原型设计"]);
      assert.deepEqual(saved.interests, ["AI Agent"]); assert.equal(saved.availableHoursPerDay, 2.5);
      value.skills.push("changed after save"); saved.skills.push("changed response");
      const freshService = createParticipantService({ database, clock });
      assert.deepEqual((await freshService.get(alice)).skills, ["TypeScript", "原型设计"]);
      const replaced = await freshService.update(alice, { ...input(1), city: "北京", skills: [] });
      assert.equal(replaced.revision, 2); assert.equal(replaced.city, "北京"); assert.deepEqual(replaced.skills, []);
    });

    await t.test("admin and other accounts only read and update their own profile", async () => {
      await service.update(alice, input());
      assert.equal((await service.get(bob)).revision, 0);
      await service.update(bob, { ...input(), city: "杭州" });
      assert.equal((await service.get(alice)).city, "上海"); assert.equal((await service.get(bob)).city, "杭州");
      await assert.rejects(service.update(bob, { ...input(1), userId: alice.userId } as ParticipantProfileUpdate), code("PARTICIPANT_PROFILE_INVALID"));
      assert.equal((await service.get(alice)).revision, 1);
    });

    await t.test("stale and absent revision checks disclose only the caller's latest revision", async () => {
      await assert.rejects(service.update(alice, input(1)), error => error instanceof DomainError && error.status === 409 && error.latestRevision === 0);
      await service.update(alice, input()); await service.update(alice, input(1));
      await assert.rejects(service.update(alice, { ...input(1), city: "被旧表单覆盖" }), error => error instanceof DomainError && error.code === "PARTICIPANT_PROFILE_CHANGED" && error.latestRevision === 2);
      await assert.rejects(service.update(alice, input()), error => error instanceof DomainError && error.latestRevision === 2);
      assert.equal((await service.get(alice)).city, "上海");
    });

    await t.test("competing initial saves and same-revision edits have one winner", async () => {
      const first = await Promise.allSettled([service.update(alice, input()), service.update(alice, { ...input(), city: "广州" })]);
      assert.equal(first.filter(result => result.status === "fulfilled").length, 1);
      const rejected = first.find(result => result.status === "rejected");
      assert.ok(rejected?.status === "rejected" && code("PARTICIPANT_PROFILE_CHANGED")(rejected.reason));
      const edits = await Promise.allSettled([service.update(alice, { ...input(1), city: "北京" }), service.update(alice, { ...input(1), city: "深圳" })]);
      assert.equal(edits.filter(result => result.status === "fulfilled").length, 1);
      assert.equal((await service.get(alice)).revision, 2);
    });

    await t.test("clearing optional fields is allowed and no profile completion gate is imposed", async () => {
      const blank = await service.get(alice);
      const { userId: _userId, revision: _revision, updatedAt: _updatedAt, ...editable } = blank;
      const saved = await service.update(alice, { ...editable, expectedRevision: 0 });
      assert.equal(saved.revision, 1); assert.equal(saved.firstHackathon, null); assert.equal(saved.availableHoursPerDay, null);
      assert.deepEqual(saved.interests, []);
    });

    await t.test("missing, suspended, deleted and deletion-pending accounts cannot read or save", async () => {
      const missing = { userId: "participant-missing", platformRoles: ["admin"] } as const;
      await assert.rejects(service.get(missing), code("UNAUTHENTICATED"));
      await assert.rejects(service.update(missing, input()), code("UNAUTHENTICATED"));
      for (const status of ["suspended", "deleted", "deletion_pending"]) {
        await engine.query("UPDATE auth_users SET status=$1 WHERE id=$2", [status, alice.userId]);
        await assert.rejects(service.get(alice), code("UNAUTHENTICATED"));
        await assert.rejects(service.update(alice, input()), code("UNAUTHENTICATED"));
      }
      assert.equal((await engine.query("SELECT * FROM participant_profiles")).rows.length, 0);
    });

    await t.test("a revoked request session is rejected inside the profile transaction", async () => {
      await engine.query("INSERT INTO auth_sessions(id,user_id,token_hash,created_at,authenticated_at,expires_at,revoked_at) VALUES('participant-session',$1,$2,$3,$3,'2026-10-10T08:00:00Z',$3)", [alice.userId, "0".repeat(64), at]);
      const guard = async (sql: SqlExecutor) => {
        const result = await sql.query("SELECT id FROM auth_sessions WHERE id='participant-session' AND user_id=$1 AND revoked_at IS NULL AND expires_at>$2::timestamptz FOR SHARE", [alice.userId, at]);
        if (!result.rowCount) throw new DomainError("UNAUTHENTICATED", "会话已退出。", { status: 401 });
      };
      await assert.rejects(service.get(alice, guard), code("UNAUTHENTICATED"));
      await assert.rejects(service.update(alice, input(), guard), code("UNAUTHENTICATED"));
      assert.equal((await engine.query("SELECT * FROM participant_profiles")).rows.length, 0);
    });

    await t.test("final session guard observes uncommitted profile and failure rolls it back", async () => {
      let calls = 0; let transaction: SqlExecutor | undefined;
      const guard = async (sql: SqlExecutor) => {
        assert.notEqual(sql, database); if (transaction) assert.equal(sql, transaction); else transaction = sql;
        calls += 1;
        if (calls === 2) {
          assert.equal((await sql.query("SELECT revision FROM participant_profiles WHERE user_id=$1", [alice.userId])).rows.length, 1);
          throw new DomainError("UNAUTHENTICATED", "会话在保存期间失效。", { status: 401 });
        }
      };
      await assert.rejects(service.update(alice, input(), guard), code("UNAUTHENTICATED"));
      assert.equal(calls, 2); assert.equal((await engine.query("SELECT * FROM participant_profiles")).rows.length, 0);
      await service.update(alice, input());
      let reads = 0;
      await assert.rejects(service.get(alice, async () => { if (++reads === 2) throw new DomainError("UNAUTHENTICATED", "会话已失效。", { status: 401 }); }), code("UNAUTHENTICATED"));
      assert.equal(reads, 2);
    });

    await t.test("failed revision comparison rechecks session before disclosing latest revision", async () => {
      await service.update(alice, input());
      for (const expectedRevision of [0, 2]) {
        let calls = 0;
        await assert.rejects(service.update(alice, input(expectedRevision), async () => {
          if (++calls === 2) throw new DomainError("UNAUTHENTICATED", "会话在版本比较期间失效。", { status: 401 });
        }), error => error instanceof DomainError && error.code === "UNAUTHENTICATED" && error.latestRevision === undefined);
        assert.equal(calls, 2);
      }
      assert.equal((await service.get(alice)).revision, 1);
    });
  } finally { await engine.close(); }
});

test("profile validation rejects privilege fields, incomplete input and malformed formats before persistence", () => {
  const invalid: unknown[] = [
    null, [], {}, { ...input(), userId: bob.userId }, { ...input(), revision: 4 }, { ...input(), updatedAt: at },
    { ...input(), expectedRevision: -1 }, { ...input(), expectedRevision: 1.1 }, { ...input(), expectedRevision: Number.MAX_SAFE_INTEGER },
    { ...input(), firstHackathon: "true" }, { ...input(), developmentExperience: "expert" },
    { ...input(), city: "a".repeat(81) }, { ...input(), city: "城市\n第二行" }, { ...input(), city: "a\u0000" },
    { ...input(), skills: "TypeScript" }, { ...input(), skills: new Array(1) }, { ...input(), skills: [""] }, { ...input(), skills: [" TypeScript", "TypeScript "] },
    { ...input(), skills: Array.from({ length: 31 }, (_, index) => `s${index}`) }, { ...input(), interests: ["a".repeat(81)] },
    { ...input(), interests: [4] }, { ...input(), projectIdea: "a".repeat(4001) }, { ...input(), projectIdea: "\ud800" },
    { ...input(), availableHoursPerDay: "2" }, { ...input(), availableHoursPerDay: -0.1 }, { ...input(), availableHoursPerDay: 24.01 },
    { ...input(), availableHoursPerDay: NaN }, { ...input(), availableHoursPerDay: Infinity },
    { ...input(), travelPreference: null }, { ...input(), travelPreference: "drive" }, { ...input(), presentationExperience: "advanced" },
  ];
  invalid.push(Object.defineProperty({ ...input() }, "userId", { value: bob.userId }));
  invalid.push({ ...input(), [Symbol("owner")]: bob.userId });
  const missing = { ...input() } as Partial<ParticipantProfileUpdate>; delete missing.city; invalid.push(missing);
  for (const value of invalid) assert.throws(() => validateParticipantProfileUpdate(value), code("PARTICIPANT_PROFILE_INVALID"));
  for (const hours of [0, 0.1, 24, null]) assert.equal(validateParticipantProfileUpdate({ ...input(), availableHoursPerDay: hours }).availableHoursPerDay, hours);
  assert.equal(validateParticipantProfileUpdate({ ...input(), projectIdea: "第一行\n第二行 😀" }).projectIdea, "第一行\n第二行 😀");
  assert.equal(validateParticipantProfileUpdate({ ...input(), city: "a".repeat(80), skills: Array.from({ length: 30 }, (_, index) => `skill ${index}`) }).skills.length, 30);
});
