import test from "node:test";
import assert from "node:assert/strict";
import { createParticipationWeatherPort } from "./participation-weather.ts";

const now = new Date("2026-10-09T00:30:00.000Z");
const place = { name: "上海", latitude: 31.22, longitude: 121.45, country_code: "CN", country: "中国", timezone: "Asia/Shanghai", feature_code: "PPLA", admin1: "上海" };
function json(value: unknown) { return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } }); }
function forecast(date = "2026-10-10") {
  return { latitude: 31.25, longitude: 121.5, timezone: "Asia/Shanghai", daily_units: { weather_code: "wmo code", temperature_2m_min: "°C", temperature_2m_max: "°C", precipitation_probability_max: "%", wind_speed_10m_max: "km/h" },
    daily: { time: [date], weather_code: [63], temperature_2m_min: [18], temperature_2m_max: [24], precipitation_probability_max: [80], wind_speed_10m_max: [30] } };
}
function setup(response: unknown = forecast(), options: { candidates?: unknown[]; clock?: Date } = {}) {
  const urls: URL[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); urls.push(url);
    assert.equal(init?.redirect, "error");
    assert.equal(init?.headers && (init.headers as Record<string, string>).accept, "application/json");
    return url.hostname === "geocoding-api.open-meteo.com" ? json({ results: options.candidates ?? [place] }) : json(response);
  };
  return { port: createParticipationWeatherPort({ fetch: fetcher, clock: { now: () => options.clock ?? now } }), urls };
}

test("confirmed city and destination-local date return real units and fixed official endpoints", async () => {
  const { port, urls } = setup();
  const result = await port.describe({ city: "上海", date: "2026-10-10" });
  assert.equal(result.status, "available");
  assert.equal(result.provider, "open-meteo");
  assert.equal(result.checkedAt, now.toISOString());
  assert.deepEqual(result.reading, { date: "2026-10-10", condition: "中雨", weatherCode: 63, temperatureMinC: 18, temperatureMaxC: 24, precipitationProbabilityPercent: 80, windSpeedMaxKmh: 30 });
  assert.match(result.summary, /预报.*出发前再次确认/u);
  assert.deepEqual(urls.map(url => url.origin + url.pathname), ["https://geocoding-api.open-meteo.com/v1/search", "https://api.open-meteo.com/v1/forecast"]);
  assert.equal(urls[0]?.searchParams.get("language"), "zh");
  assert.equal(urls[1]?.searchParams.get("forecast_days"), "16");
  assert.equal(urls[1]?.searchParams.get("timezone"), "Asia/Shanghai");
});

test("dates outside forecast range do not claim future or historical readings", async () => {
  const { port, urls } = setup();
  for (const date of ["2026-11-01", "2026-01-01"]) {
    const result = await port.describe({ city: "上海", date });
    assert.equal(result.status, "out_of_range");
    assert.equal(result.reading, undefined);
  }
  assert.equal(urls.length, 0);
});

test("16-day horizon counts today and uses destination timezone at date boundary", async () => {
  const { port, urls } = setup(forecast("2026-10-24"), { clock: new Date("2026-10-08T16:30:00Z") });
  assert.equal((await port.describe({ city: "上海", date: "2026-10-24" })).status, "available");
  urls.length = 0;
  const beyond = await port.describe({ city: "上海", date: "2026-10-25" });
  assert.equal(beyond.status, "out_of_range");
  assert.equal(urls.length, 0);
});

test("ambiguous city yields candidates and does not fetch a wrong-location forecast", async () => {
  const { port, urls } = setup(forecast(), { candidates: [place, { ...place, longitude: 110, admin1: "另一个省" }] });
  const result = await port.describe({ city: "上海", date: "2026-10-10" });
  assert.equal(result.status, "needs_confirmation");
  assert.equal(result.candidates?.length, 2);
  assert.equal(result.reading, undefined);
  assert.equal(urls.length, 1);
});

test("missing city and invalid calendar dates do not trigger network requests", async () => {
  const { port, urls } = setup();
  for (const input of [{ city: "", date: "2026-10-10" }, { city: "上海", date: "2026-02-30" }, { city: "上海", date: "2026-10-10T00:00:00Z" }]) {
    assert.equal((await port.describe(input)).status, "unavailable");
  }
  assert.equal(urls.length, 0);
});

test("city input is an encoded query and cannot replace fixed endpoint", async () => {
  const { port, urls } = setup(forecast(), { candidates: [] });
  const city = "https://127.0.0.1/private?api_key=bad";
  await port.describe({ city, date: "2026-10-10" });
  assert.equal(urls[0]?.hostname, "geocoding-api.open-meteo.com");
  assert.equal(urls[0]?.searchParams.get("name"), city);
  assert.equal(urls.length, 1);
});

test("unknown cities, malformed coordinates and invalid timezone do not leak invalid facts", async () => {
  for (const candidates of [[], [{ ...place, latitude: 91 }], [{ ...place, longitude: Infinity }], [{ ...place, timezone: "not-a-zone" }]]) {
    const { port, urls } = setup(forecast(), { candidates });
    const result = await port.describe({ city: "上海", date: "2026-10-10" });
    assert.equal(result.status, "unavailable");
    assert.equal(result.reading, undefined);
    assert.equal(urls.length, 1);
  }
});

test("missing requested date does not invent a forecast", async () => {
  const { port } = setup(forecast("2026-10-11"));
  const result = await port.describe({ city: "上海", date: "2026-10-10" });
  assert.equal(result.status, "unavailable");
  assert.equal(result.reading, undefined);
});

test("missing individual variables remain null rather than zero", async () => {
  const data = forecast(); data.daily.temperature_2m_min = [null as unknown as number];
  const { port } = setup(data);
  const result = await port.describe({ city: "上海", date: "2026-10-10" });
  assert.equal(result.status, "available");
  assert.equal(result.reading?.temperatureMinC, null);
  assert.ok(!result.summary.includes("0～24"));
});

test("invalid values, mismatched units and unrelated destination coordinates fail safely", async () => {
  const responses = [
    { ...forecast(), latitude: -31.2 },
    { ...forecast(), daily_units: { ...forecast().daily_units, temperature_2m_max: "°F" } },
    { ...forecast(), daily: { ...forecast().daily, precipitation_probability_max: [101] } },
    { ...forecast(), daily: { ...forecast().daily, weather_code: [1000] } },
    { ...forecast(), daily: { ...forecast().daily, temperature_2m_min: [26] } },
    { ...forecast(), daily: { ...forecast().daily, wind_speed_10m_max: [] } },
    { ...forecast(), daily: { ...forecast().daily, time: ["2026-02-30"] } },
  ];
  for (const response of responses) {
    const result = await setup(response).port.describe({ city: "上海", date: "2026-10-10" });
    assert.equal(result.status, "unavailable");
    assert.equal(result.reading, undefined);
  }
});

test("API error content and network exception remain a usable unavailable result", async () => {
  for (const fetcher of [async () => json({ error: true, reason: "provider internals" }), async () => { throw new Error("sensitive network details"); }]) {
    const port = createParticipationWeatherPort({ fetch: fetcher, clock: { now: () => now } });
    const result = await port.describe({ city: "上海", date: "2026-10-10" });
    assert.equal(result.status, "unavailable");
    assert.ok(!result.summary.includes("sensitive"));
    assert.ok(!result.summary.includes("internals"));
  }
});

test("redirects, non-JSON and oversized responses are rejected", async () => {
  for (const response of [new Response("redirect", { status: 302 }), new Response("html"), new Response("{}", { headers: { "content-type": "application/json", "content-length": "90000" } }), json({ results: [{ ...place, payload: "x".repeat(2000) }] })]) {
    const port = createParticipationWeatherPort({ fetch: async () => response, clock: { now: () => now }, maxResponseBytes: 1000 });
    const result = await port.describe({ city: "上海", date: "2026-10-10" });
    assert.equal(result.status, "unavailable");
  }
});

test("timeout and caller cancellation terminate network request without blocking plan", async () => {
  let aborted = 0;
  const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    const onAbort = () => { aborted++; reject(new Error("abort")); };
    if (init?.signal?.aborted) onAbort(); else init?.signal?.addEventListener("abort", onAbort, { once: true });
  });
  const port = createParticipationWeatherPort({ fetch: fetcher, clock: { now: () => now }, timeoutMs: 5 });
  const result = await port.describe({ city: "上海", date: "2026-10-10" });
  assert.equal(result.status, "unavailable");
  assert.match(result.summary, /超时或已取消/u);
  const controller = new AbortController(); controller.abort();
  assert.equal((await port.describe({ city: "上海", date: "2026-10-10", signal: controller.signal })).status, "unavailable");
  assert.equal(aborted, 2);
});

test("participation public WeatherPort returns the exact module snapshot and service clock", async () => {
  const { port } = setup(forecast("2026-10-10"), { clock: new Date("2020-01-01T00:00:00Z") });
  const snapshot = await port.getForecast({ city: "上海", eventStartAt: "2026-10-09T23:00:00Z", now: now.toISOString() });
  assert.equal(snapshot.status, "available");
  assert.equal(snapshot.requestedCity, "上海");
  assert.equal(snapshot.fetchedAt, now.toISOString());
  assert.deepEqual(snapshot.location, { name: "上海", country: "中国", admin1: "上海", latitude: 31.22, longitude: 121.45, timeZone: "Asia/Shanghai" });
  assert.deepEqual(snapshot.days, [{ date: "2026-10-10", weatherCode: 63, temperatureMinC: 18, temperatureMaxC: 24, precipitationProbabilityMax: 80, windSpeedMaxKmh: 30 }]);
});

test("public port returns precise status for missing facts, ambiguous cities and distant dates", async () => {
  const { port, urls } = setup();
  const base = { city: "上海", eventStartAt: "2026-10-10T08:00:00+08:00", now: now.toISOString() };
  assert.equal((await port.getForecast({ ...base, city: "" })).status, "city_unknown");
  for (const eventStartAt of ["", "2026-10-10", "2026-02-30T08:00:00Z", "2026-10-10T24:00:00Z", "2026-10-10T08:99:00Z", "2026-10-10T08:00:00"]) {
    assert.equal((await port.getForecast({ ...base, eventStartAt })).status, "date_unknown");
  }
  assert.equal((await port.getForecast({ ...base, eventStartAt: "2026-11-10T08:00:00Z" })).status, "outside_forecast_window");
  assert.equal(urls.length, 0);
  const ambiguous = await setup(forecast(), { candidates: [place, { ...place, longitude: 110 }] }).port.getForecast(base);
  assert.equal(ambiguous.status, "ambiguous_city");
  assert.equal(ambiguous.days.length, 0);
  assert.match(ambiguous.note, /候选/u);
});

test("public module requires complete temperature and weather code rather than synthesizing values", async () => {
  const data = forecast(); data.daily.temperature_2m_min = [null as unknown as number];
  const snapshot = await setup(data).port.getForecast({ city: "上海", eventStartAt: "2026-10-10T08:00:00+08:00", now: now.toISOString() });
  assert.equal(snapshot.status, "unavailable");
  assert.deepEqual(snapshot.days, []);
  assert.equal(snapshot.fetchedAt, null);
});
