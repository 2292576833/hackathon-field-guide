import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../shared/errors.ts";
import { resourceInstant, resourceUrl } from "./domain.ts";
import { RESOURCE_CANDIDATES } from "./candidates.ts";

test("核验时间拒绝不存在的日期及无时区值，带时区的真实时刻统一存储", () => {
  const now = new Date("2026-10-08T12:00:00Z");
  for (const value of ["2026-02-30T10:00:00Z", "2025-02-29T10:00:00Z", "2026-10-08T24:00:00Z", "2026-10-08T10:00:00", "2026-10-09T10:00:00Z"]) {
    assert.throws(() => resourceInstant(value, "核验时间", now), (error: unknown) => error instanceof DomainError && error.code === "INVALID_RESOURCE_TIME");
  }
  assert.equal(resourceInstant("2024-02-29T18:30:00+08:00", "核验时间", now), "2024-02-29T10:30:00.000Z");
});

test("候选清单全部未核验，不携带已发布、免费或可商用事实", () => {
  assert.ok(RESOURCE_CANDIDATES.length > 0);
  for (const candidate of RESOURCE_CANDIDATES) {
    assert.equal(candidate.status, "unverified_candidate");
    assert.equal(candidate.input.linkStatus, "unknown");
    assert.equal(candidate.input.verifiedAt, null);
    assert.equal(candidate.input.costType, "unknown");
    assert.equal(candidate.input.licenseStatus, "unknown");
    assert.ok(candidate.checkBeforePublishing.length > 0);
    assert.ok(resourceUrl(candidate.input.officialUrl));
  }
});
