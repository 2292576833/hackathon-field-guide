import test from "node:test";
import assert from "node:assert/strict";
import { inspirationCandidates, inspirationSeed } from "./inspiration-catalog.ts";

const verifiedOfficialHosts = new Set([
  "dribbble.com", "www.behance.net", "help.behance.net", "mobbin.com", "www.siteinspire.com", "www.awwwards.com",
  "httpster.net", "www.lapa.ninja", "land-book.com", "ui.shadcn.com", "www.radix-ui.com", "mui.com", "ant.design",
  "daisyui.com", "ui.aceternity.com", "magicui.design", "www.hyperui.dev", "21st.dev", "reactbits.dev", "www.reactbits.dev",
  "pro.reactbits.dev", "motion.dev", "gsap.com", "lottiefiles.com",
]);

test("the editorial seed contains distinct verified official HTTPS entries and evidence, without affiliate or search URLs", () => {
  assert.ok(inspirationSeed.length >= 18 && inspirationSeed.length <= 24);
  const ids = new Set<string>(), destinations = new Set<string>();
  for (const entry of inspirationSeed) {
    assert.ok(!ids.has(entry.id), `duplicate identity: ${entry.id}`); ids.add(entry.id);
    assert.ok(!destinations.has(entry.url), `duplicate official destination: ${entry.url}`); destinations.add(entry.url);
    assert.ok(entry.evidenceUrls.length > 0, `${entry.name} has official evidence`);
    for (const value of [entry.url, ...entry.evidenceUrls]) {
      const url = new URL(value);
      assert.equal(url.protocol, "https:"); assert.equal(url.username, ""); assert.equal(url.password, "");
      assert.equal(url.port, ""); assert.equal(url.search, ""); assert.equal(url.hash, "");
      assert.ok(verifiedOfficialHosts.has(url.hostname), `not a verified official source: ${value}`);
    }
    assert.match(entry.checkedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Number.isFinite(Date.parse(entry.checkedAt)));
  }
});

test("all four discovery directions distinguish reference images, usable code and animation assets", () => {
  const categories = new Set(inspirationSeed.map(item => item.category));
  assert.deepEqual([...categories].sort(), ["components", "motion", "visual", "websites"]);
  for (const item of inspirationSeed) {
    assert.ok(item.description.length > 10 && item.useWhen.length > 10 && item.usageNote.length > 10);
    assert.ok(item.tags.length >= 1 && new Set(item.tags).size === item.tags.length);
    assert.match(item.usageNote, /授权|许可|使用权限|使用条件/);
    if (["visual", "websites"].includes(item.category)) assert.equal(item.contentType, "reference", `${item.name} must not claim usable code`);
    if (item.category === "components") assert.equal(item.contentType, "code");
  }
  assert.equal(inspirationSeed.find(item => item.id === "lottiefiles")?.contentType, "asset");
});

test("pending production identities exclude editorial recommendations so waiting cards cannot masquerade as DSH results", () => {
  assert.equal(inspirationCandidates.length, inspirationSeed.length);
  for (const candidate of inspirationCandidates) {
    const source = inspirationSeed.find(item => item.id === candidate.id)!;
    assert.equal(candidate.url, source.url); assert.equal(candidate.name, source.name);
    assert.equal(candidate.category, source.category); assert.equal(candidate.contentType, source.contentType);
    for (const field of ["description", "useWhen", "usageNote", "checkedAt", "evidenceUrls"]) assert.equal(field in candidate, false);
  }
});
