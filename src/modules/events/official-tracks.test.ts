import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../shared/errors.ts";
import { diffRuleVersions, validateRuleVersion } from "./domain.ts";
import type { EventRuleVersion } from "./domain.ts";
import { getOfficialTrackCatalog } from "./official-tracks.ts";

function rules(): EventRuleVersion {
  return {
    eventId: "event", version: 1, createdAt: "2026-10-09T00:00:00Z",
    metadata: { name: "官方测试比赛", organizer: "主办方", format: "online", region: "", officialUrl: "https://example.com/rules" },
    sources: [{ id: "source", eventId: "event", version: 1, sourceConfigId: null, url: "https://example.com/rules", kind: "official", contentHash: "hash", fetchedAt: "2026-10-09T00:00:00Z", trustScope: "official_rules", status: "available" }],
    evidence: [{ id: "proof", eventId: "event", version: 1, sourceId: "source", fieldKey: "official_tracks", excerpt: "主办方设原型赛道，需提供可运行原型。", locator: "#tracks", rawDateText: null, verifiedBy: "reviewer", verifiedAt: "2026-10-09T00:00:00Z", conflictsWith: [] }],
    facts: ["eligibility", "fees", "team_size", "ai_policy"].map(key => ({ key, statement: "待核对", status: "unknown", evidenceIds: [] })),
    stages: [], requirements: [{ id: "demo", label: "可运行原型", necessity: "required", stageId: null, evidenceIds: ["proof"] }], qualityFlags: ["missing_information"],
    officialTracks: { status: "confirmed", evidenceIds: ["proof"], tracks: [{ id: "prototype", name: "原型赛道", evidenceIds: ["proof"], eligibility: null, scoringFocus: { text: "原型可演示", evidenceIds: ["proof"] }, deliverables: [{ requirementId: "demo", evidenceIds: ["proof"] }] }] },
  };
}
function rejects(value: EventRuleVersion) {
  assert.throws(() => validateRuleVersion(value), error => error instanceof DomainError && error.code === "INVALID_RULE_VERSION");
}
test("old rules remain unknown and none requires an explicit verified official statement", () => {
  const value = rules(); delete value.officialTracks;
  const snapshot = validateRuleVersion(value);
  assert.equal(snapshot.officialTracks, undefined);
  assert.deepEqual(getOfficialTrackCatalog(snapshot), { status: "unknown", evidenceIds: [], tracks: [] });
  value.officialTracks = { status: "none", evidenceIds: ["proof"], tracks: [] };
  assert.equal(validateRuleVersion(value).officialTracks?.status, "none");
  value.evidence[0]!.verifiedBy = null; value.evidence[0]!.verifiedAt = null;
  rejects(value);
});
test("confirmed official tracks reject resource labels without matching official proof", () => {
  for (const change of [
    (value: EventRuleVersion) => { value.evidence[0]!.fieldKey = "resource_package"; },
    (value: EventRuleVersion) => { value.sources[0]!.kind = "secondary"; value.sources[0]!.trustScope = "secondary_report"; value.evidence[0]!.verifiedBy = null; value.evidence[0]!.verifiedAt = null; },
    (value: EventRuleVersion) => { value.officialTracks!.tracks[0]!.deliverables[0]!.requirementId = "invented"; },
    (value: EventRuleVersion) => { value.officialTracks!.tracks.push(structuredClone(value.officialTracks!.tracks[0]!)); },
    (value: EventRuleVersion) => { value.officialTracks!.tracks[0]!.evidenceIds = []; },
  ]) { const value = rules(); change(value); rejects(value); }
});
test("unknown and conflict cannot be mistaken for verified no-track state", () => {
  const value = rules(); value.officialTracks!.status = "unknown"; rejects(value);
  value.officialTracks!.status = "conflict"; rejects(value);
  const proof2 = { ...value.evidence[0]!, id: "proof2", conflictsWith: ["proof"] };
  value.evidence[0]!.conflictsWith = ["proof2"]; value.evidence.push(proof2);
  value.officialTracks!.evidenceIds.push("proof2");
  assert.equal(validateRuleVersion(value).officialTracks?.status, "conflict");
  value.officialTracks!.status = "confirmed"; rejects(value);
});
test("track identity survives rule changes and diff reports the official change", () => {
  const before = rules(); const after = rules();
  after.version = 2; after.sources[0]!.version = 2; after.evidence[0]!.version = 2;
  after.officialTracks!.tracks[0]!.name = "可演示原型赛道";
  const validated = validateRuleVersion(after);
  assert.equal(validated.officialTracks!.tracks[0]!.id, "prototype");
  assert.ok(diffRuleVersions(before, after).some(change => change.path.startsWith("/officialTracks")));
  assert.equal(before.officialTracks!.tracks[0]!.name, "原型赛道");
});
