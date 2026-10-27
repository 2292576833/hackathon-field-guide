import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../../shared/errors.ts";
import { AVATAR_MAX_BYTES, emptyProfile, revision, validateAvatar, validateCardDraft, validateFilter, validatePostData, validateProfileData } from "./validation.ts";
import { cardDraft, jpegAvatar, pngAvatar, postData, profileData, webpAvatar } from "./test-fixture.ts";

const invalid = (error: unknown) => error instanceof DomainError && error.code === "INVALID_RECRUITING_INPUT" && error.status === 400;

test("private profile accepts blank optional fields and normalizes editable values without a completion gate", () => {
  assert.deepEqual(validateProfileData(emptyProfile()), emptyProfile());
  const result = validateProfileData(profileData({ mbti: "intp", resume: " 经历\n第二行 ", workLinks: [{ title: " 作品 ", url: "https://example.test" }] }));
  assert.equal(result.mbti, "INTP"); assert.equal(result.resume, "经历\n第二行");
  assert.deepEqual(result.workLinks, [{ title: "作品", url: "https://example.test/" }]);
});

test("private profile rejects ownership injection, unknown roles, duplicate choices, malformed optional values and unsafe work URLs", () => {
  const values: unknown[] = [null, [], {}, { ...profileData(), userId: "other" }, { ...profileData(), revision: 7 },
    { ...profileData(), primaryRoles: ["frontend", "frontend"] }, { ...profileData(), supportingRoles: ["captain"] }, { ...profileData(), purposes: ["rank"] },
    ...[0, 121, 20.5, "20", NaN].map(age => ({ ...profileData(), age })),
    ...["ABCD", "INTPA", 42].map(mbti => ({ ...profileData(), mbti })),
    { ...profileData(), resume: "a".repeat(4001) }, { ...profileData(), resume: "\u0000" }, { ...profileData(), workLinks: Array.from({ length: 9 }, () => ({ title: "作品", url: "https://example.test" })) },
    ...["javascript:alert(1)", "data:text/html,test", "file:///etc/passwd", "https://user:pass@example.test", "example.test"].map(url => ({ ...profileData(), workLinks: [{ title: "作品", url }] })),
  ];
  for (const value of values) assert.throws(() => validateProfileData(value), invalid);
});

test("public card and recruiting post validation rejects hidden ownership fields and impossible limits", () => {
  assert.equal(validateCardDraft(cardDraft()).introduction, cardDraft().introduction);
  for (const value of [{ ...cardDraft(), email: "private@example.test" }, { ...cardDraft(), introduction: "联系 private@example.test" }, { ...cardDraft(), headline: "" }, { ...cardDraft(), introduction: "" }, { ...cardDraft(), showAge: "true" }, { ...cardDraft(), availableHoursPerDay: 25 }, { ...cardDraft(), availableHoursPerDay: Infinity }, { ...cardDraft(), skills: [""] }]) assert.throws(() => validateCardDraft(value), invalid);
  assert.equal(validatePostData(postData()).seats, 2);
  for (const value of [{ ...postData(), projectId: "other" }, { ...postData(), description: "联系 private@example.test" }, { ...postData(), seats: 0 }, { ...postData(), seats: 51 }, { ...postData(), seats: 1.5 }, { ...postData(), status: "published" }, { ...postData(), description: "" }]) assert.throws(() => validatePostData(value), invalid);
});

test("public card accepts every skill allowed by the existing participant profile while keeping bounded input", () => {
  const skills = Array.from({ length: 30 }, (_, index) => `${index}`.padEnd(80, "x"));
  assert.deepEqual(validateCardDraft(cardDraft({ skills })).skills, skills);
  assert.throws(() => validateCardDraft(cardDraft({ skills: [...skills, "31"] })), invalid);
  assert.throws(() => validateCardDraft(cardDraft({ skills: ["x".repeat(81)] })), invalid);
  assert.throws(() => validateCardDraft(cardDraft({ introduction: "请邮件联系private@example.test" })), invalid);
});

test("public list filters and revisions have bounded values and no arbitrary SQL fields", () => {
  assert.deepEqual(validateFilter(), { keyword: "", limit: 24 });
  assert.equal(validateFilter({ role: "ai", purpose: "learn", keyword: " 前端 ", limit: 60 }).keyword, "前端");
  for (const value of [{ limit: 0 }, { limit: 61 }, { cursor: "cursor' OR 1=1" }, { role: "manager" }, { purpose: "hire" }, { keyword: "a".repeat(121) }, { sql: "SELECT 1" }]) assert.throws(() => validateFilter(value as never), invalid);
  for (const value of [-1, 1.5, Infinity, NaN, "1", 2_147_483_647]) assert.throws(() => revision(value), invalid);
});

test("avatar accepts bounded raster bytes and rejects SVG, remote URLs, MIME spoofing, damaged content and trailing payloads", () => {
  const result = validateAvatar(pngAvatar);
  assert.equal(result.mimeType, "image/png"); assert.deepEqual(Buffer.from(result.bytes), Buffer.from(pngAvatar.base64, "base64"));
  const png = Buffer.from(pngAvatar.base64, "base64");
  const oversizedDimensions = Buffer.from(png); oversizedDimensions.writeUInt32BE(2049, 16);
  const zeroDimensions = Buffer.from(png); zeroDimensions.writeUInt32BE(0, 20);
  const invalidValues: unknown[] = [
    { mimeType: "image/svg+xml", base64: Buffer.from("<svg onload='alert(1)'/>").toString("base64") },
    { mimeType: "image/png", url: "https://example.test/avatar.png" }, { mimeType: "image/png", base64: "https://example.test/avatar.png" },
    { mimeType: "image/jpeg", base64: pngAvatar.base64 }, { mimeType: "image/webp", base64: pngAvatar.base64 },
    { mimeType: "image/png", base64: Buffer.from("<script>bad()</script>").toString("base64") },
    { mimeType: "image/png", base64: "" }, { mimeType: "image/png", base64: "!!!!" }, { mimeType: "image/png", base64: pngAvatar.base64 + "\n" },
    { mimeType: "image/png", base64: png.subarray(0, 33).toString("base64") },
    { mimeType: "image/png", base64: Buffer.concat([png, Buffer.from("<script>bad()</script>")]).toString("base64") },
    { mimeType: "image/png", base64: oversizedDimensions.toString("base64") }, { mimeType: "image/png", base64: zeroDimensions.toString("base64") },
    { mimeType: "image/png", base64: Buffer.alloc(AVATAR_MAX_BYTES + 1).toString("base64") },
  ];
  for (const value of invalidValues) assert.throws(() => validateAvatar(value), invalid);
});

test("avatar rejects animated and truncated WebP containers and incomplete JPEG scan structures", () => {
  const animated = Buffer.alloc(32); animated.write("RIFF", 0); animated.writeUInt32LE(24, 4); animated.write("WEBP", 8); animated.write("VP8X", 12); animated.writeUInt32LE(10, 16); animated[20] = 2;
  assert.throws(() => validateAvatar({ mimeType: "image/webp", base64: animated.toString("base64") }), invalid);
  assert.throws(() => validateAvatar({ mimeType: "image/webp", base64: animated.subarray(0, 20).toString("base64") }), invalid);
  assert.throws(() => validateAvatar({ mimeType: "image/jpeg", base64: Buffer.from([255,216,255,192,0,8,8,0,1,0,1,0,255,217]).toString("base64") }), invalid);
});

test("all three allowed raster formats have a valid small-avatar path", () => {
  for (const avatar of [pngAvatar, jpegAvatar, webpAvatar]) {
    const validated = validateAvatar(avatar);
    assert.equal(validated.mimeType, avatar.mimeType);
    assert.deepEqual(Buffer.from(validated.bytes), Buffer.from(avatar.base64, "base64"));
  }
});

test("WebP extension headers without actual raster data cannot masquerade as an avatar", () => {
  const headerOnly = Buffer.alloc(32); headerOnly.write("RIFF", 0); headerOnly.writeUInt32LE(24, 4); headerOnly.write("WEBP", 8); headerOnly.write("VP8X", 12); headerOnly.writeUInt32LE(10, 16);
  assert.throws(() => validateAvatar({ mimeType: "image/webp", base64: headerOnly.toString("base64") }), invalid);
});
