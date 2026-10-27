import test from "node:test";
import assert from "node:assert/strict";
import { createBraveSearchProvider, BRAVE_WEB_SEARCH_ENDPOINT } from "./public-search.ts";

test("Brave adapter uses the verified fixed endpoint, header auth and accepts only public HTTPS results", async () => {
  let called: URL | undefined; let options: RequestInit | undefined;
  const provider = createBraveSearchProvider({ apiKey: "fixture-only-key", fetch: async (url, input) => {
    called = new URL(String(url)); options = input;
    return Response.json({ web: { results: [ { url: "https://events.hackathon.dev/event", title: "Event", description: "Details" },
      { url: "https://127.0.0.1/", title: "Private" }, { url: "http://events.hackathon.dev/", title: "HTTP" } ] } });
  } });
  const results = await provider.search({ query: "AI hackathon & prizes", count: 5, signal: new AbortController().signal });
  assert.equal(called?.origin + called!.pathname, BRAVE_WEB_SEARCH_ENDPOINT); assert.equal(called?.searchParams.get("q"), "AI hackathon & prizes");
  assert.equal(options?.redirect, "error"); assert.equal(options?.credentials, "omit");
  assert.equal(new Headers(options?.headers).get("x-subscription-token"), "fixture-only-key"); assert.equal(called?.href.includes("fixture-only-key"), false);
  assert.equal(results.length, 1); assert.equal(results[0]?.title, "Event");
});
test("search errors are real configuration/rate/format failures with no provider body disclosure", async () => {
  assert.throws(() => createBraveSearchProvider({ apiKey: "" }), { code: "SEARCH_UNCONFIGURED" });
  for (const status of [401, 429, 500]) {
    const provider = createBraveSearchProvider({ apiKey: "fixture", fetch: async () => new Response("secret provider diagnostic", { status }) });
    await assert.rejects(provider.search({ query: "hackathon", count: 1, signal: new AbortController().signal }), error => error instanceof Error && !error.message.includes("secret") && "code" in error);
  }
  const large = createBraveSearchProvider({ apiKey: "fixture", maxResponseBytes: 100, fetch: async () => Response.json({ web: { results: [{ title: "x".repeat(101) }] } }) });
  await assert.rejects(large.search({ query: "hackathon", count: 1, signal: new AbortController().signal }), { code: "SEARCH_RESPONSE_TOO_LARGE" });
});
