import assert from "node:assert/strict";
import { test } from "node:test";
import { versionsEqual } from "./service.ts";
import type { InputVersions } from "./types.ts";

const baseline: InputVersions = {
  projectRevision: 3, requirementVersionId: "rule-v1", assignmentVersionId: null,
  availabilityVersions: { "member-a": 1, "member-b": 2 }, trackSelectionRevision: 1,
  memberIntentionRefs: [{ membershipId: "member-a", revision: 2 }, { membershipId: "member-b", revision: 1 }],
};

test("persisted JSONB key and row order cannot manufacture a planning version conflict", () => {
  const persisted: InputVersions = { ...baseline,
    availabilityVersions: { "member-b": 2, "member-a": 1 },
    memberIntentionRefs: [{ revision: 1, membershipId: "member-b" }, { revision: 2, membershipId: "member-a" }],
  };
  assert.equal(versionsEqual(baseline, persisted), true);
  assert.equal(versionsEqual(persisted, baseline), true);
});

test("changed or removed shared intentions still invalidate the stored planning basis", () => {
  for (const refs of [
    [{ revision: 3, membershipId: "member-a" }, { revision: 1, membershipId: "member-b" }],
    [{ revision: 2, membershipId: "member-a" }],
    [{ revision: 2, membershipId: "member-c" }, { revision: 1, membershipId: "member-b" }],
  ]) assert.equal(versionsEqual(baseline, { ...baseline, memberIntentionRefs: refs }), false);
});

test("canonical intention comparison retains project, rules, assignment, track, availability and readonly checks", () => {
  for (const changes of [
    { projectRevision: 4 }, { requirementVersionId: "rule-v2" }, { assignmentVersionId: "assignment-2" },
    { trackSelectionRevision: 2 }, { availabilityVersions: { "member-a": 2, "member-b": 2 } },
    { projectArchived: true }, { projectReadOnly: true },
  ]) assert.equal(versionsEqual(baseline, { ...baseline, ...changes }), false);
});

test("a server planning-facts version permits stage-only revisions while retaining all other constraints", () => {
  const version = "a".repeat(64), original = { ...baseline, projectFactsVersion: version };
  assert.equal(versionsEqual(original, { ...original, projectRevision: 4 }), true);
  assert.equal(versionsEqual(original, { ...original, projectFactsVersion: "b".repeat(64) }), false);
  for (const changes of [{ requirementVersionId: "rules-v2" }, { assignmentVersionId: "new-assignment" }, { trackSelectionRevision: 2 },
    { availabilityVersions: {} }, { memberIntentionRefs: [] }, { projectArchived: true }, { projectReadOnly: true }]) {
    assert.equal(versionsEqual(original, { ...original, ...changes }), false);
  }
});

test("legacy plans remain conservative and invalid planning-facts versions cannot bypass comparisons", () => {
  assert.equal(versionsEqual(baseline, { ...baseline, projectFactsVersion: "a".repeat(64) }), true);
  assert.equal(versionsEqual(baseline, { ...baseline, projectRevision: 4, projectFactsVersion: "a".repeat(64) }), false);
  assert.equal(versionsEqual({ ...baseline, projectFactsVersion: "invalid" }, { ...baseline, projectFactsVersion: "invalid" }), false);
});
