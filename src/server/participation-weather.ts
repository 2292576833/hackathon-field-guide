import type { Clock } from "../shared/contracts.ts";
import type { WeatherPort, WeatherSnapshot } from "../modules/participation/index.ts";

/** Weather facts are independent of generated advice. Never fill missing readings with AI. */
export interface ParticipationWeatherRequest {
  readonly city: string;
  /** Destination-local calendar date, not a UTC instant. */
  readonly date: string;
  readonly signal?: AbortSignal;
  /** Internal adapter uses the destination's timezone to resolve this instant. */
  readonly eventStartAt?: string;
}
export interface ParticipationWeatherPlace {
  readonly name: string;
  readonly label: string;
  readonly countryCode: string;
  readonly country: string;
  readonly admin1: string | null;
  readonly timezone: string;
  readonly latitude: number;
  readonly longitude: number;
}
export interface ParticipationWeatherReading {
  readonly date: string;
  readonly condition: string | null;
  readonly weatherCode: number | null;
  readonly temperatureMinC: number | null;
  readonly temperatureMaxC: number | null;
  readonly precipitationProbabilityPercent: number | null;
  readonly windSpeedMaxKmh: number | null;
}
export interface ParticipationWeatherResult {
  readonly status: "available" | "out_of_range" | "unavailable" | "needs_confirmation";
  readonly provider: "open-meteo";
  readonly city: string;
  readonly date: string;
  readonly checkedAt: string;
  readonly sourceUrl: string;
  readonly summary: string;
  readonly place?: ParticipationWeatherPlace;
  readonly reading?: ParticipationWeatherReading;
  readonly candidates?: readonly string[];
}
export interface ParticipationWeatherPort {
  describe(input: ParticipationWeatherRequest): Promise<ParticipationWeatherResult>;
}
export interface ParticipationWeatherOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: Clock;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const SOURCE_URL = "https://open-meteo.com/en/docs";
const DAY_MS = 86_400_000;
const DAILY_VARIABLES = ["weather_code", "temperature_2m_min", "temperature_2m_max", "precipitation_probability_max", "wind_speed_10m_max"];
// WMO labels from https://open-meteo.com/en/docs#weathervariables .
const CONDITIONS: Readonly<Record<number, string>> = {
  0: "晴", 1: "大部晴朗", 2: "局部多云", 3: "阴", 45: "雾", 48: "冻雾",
  51: "小毛毛雨", 53: "中等毛毛雨", 55: "较强毛毛雨", 56: "小冻毛毛雨", 57: "较强冻毛毛雨",
  61: "小雨", 63: "中雨", 65: "大雨", 66: "小冻雨", 67: "较强冻雨",
  71: "小雪", 73: "中雪", 75: "大雪", 77: "雪粒", 80: "小阵雨", 81: "中等阵雨", 82: "强阵雨",
  85: "小阵雪", 86: "强阵雪", 95: "雷暴", 96: "雷暴伴少量冰雹", 97: "强雷暴", 99: "雷暴伴较强冰雹",
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function finite(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}
function safeText(value: unknown, max = 120): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value) ? value.trim() : null;
}
function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function validInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-](\d{2}):(\d{2}))$/u.exec(value);
  return !!match && validDate(match[1]!) && Number(match[2]) <= 23 && Number(match[3]) <= 59 && (match[4] === undefined || Number(match[4]) <= 59) && (match[6] === undefined || Number(match[6]) <= 14) && (match[7] === undefined || Number(match[7]) <= 59) && Number.isFinite(Date.parse(value));
}
function localDate(value: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  return ["year", "month", "day"].map(key => parts.find(part => part.type === key)!.value).join("-");
}
function validTimezone(value: unknown): value is string {
  if (!safeText(value, 80)) return false;
  try { localDate(new Date(0), value as string); return true; } catch { return false; }
}
function cityIdentity(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en").trim().replace(/市$/u, "");
}
function parsePlaces(value: unknown): ParticipationWeatherPlace[] {
  const data = record(value);
  if (!data || data.error === true || (data.results !== undefined && !Array.isArray(data.results))) throw new Error("Invalid geocoding response");
  const places = new Map<string, ParticipationWeatherPlace>();
  for (const row of (data.results as unknown[] | undefined) ?? []) {
    const item = record(row);
    if (!item) continue;
    const name = safeText(item.name);
    if (!name || !finite(item.latitude, -90, 90) || !finite(item.longitude, -180, 180) || !validTimezone(item.timezone) || typeof item.country_code !== "string" || !/^[A-Z]{2}$/u.test(item.country_code)) continue;
    if (item.feature_code !== undefined && (typeof item.feature_code !== "string" || !item.feature_code.startsWith("PPL"))) continue;
    const admin = safeText(item.admin1);
    const country = safeText(item.country) ?? item.country_code;
    const label = `${name}, ${admin ?? country}`;
    const key = `${name}:${item.latitude}:${item.longitude}`;
    places.set(key, { name, label, countryCode: item.country_code, country, admin1: admin, timezone: item.timezone, latitude: item.latitude, longitude: item.longitude });
  }
  return [...places.values()].slice(0, 5);
}
function nullableReading(value: unknown, min: number, max: number): number | null {
  if (value === null || value === undefined) return null;
  if (!finite(value, min, max)) throw new Error("Invalid daily value");
  return value;
}
function parseReading(value: unknown, date: string, place: ParticipationWeatherPlace): ParticipationWeatherReading | null {
  const data = record(value);
  if (!data || data.error === true || !finite(data.latitude, -90, 90) || !finite(data.longitude, -180, 180) || !validTimezone(data.timezone) || data.timezone !== place.timezone) throw new Error("Invalid forecast response");
  // A grid-cell may differ by kilometres, but not by an unrelated city or hemisphere.
  if (Math.abs(data.latitude - place.latitude) > 1 || Math.abs(data.longitude - place.longitude) > 1) throw new Error("Forecast coordinates do not match destination");
  const daily = record(data.daily), units = record(data.daily_units);
  if (!daily || !units || !Array.isArray(daily.time) || daily.time.length > 16 || daily.time.some(item => typeof item !== "string" || !validDate(item)) || new Set(daily.time).size !== daily.time.length) throw new Error("Invalid forecast dates");
  for (const variable of DAILY_VARIABLES) {
    if (!Array.isArray(daily[variable]) || (daily[variable] as unknown[]).length !== daily.time.length) throw new Error("Invalid forecast columns");
  }
  if (units.temperature_2m_min !== "°C" || units.temperature_2m_max !== "°C" || units.precipitation_probability_max !== "%" || units.wind_speed_10m_max !== "km/h") throw new Error("Unexpected weather units");
  const index = daily.time.indexOf(date);
  if (index < 0) return null;
  const at = (name: string) => (daily[name] as unknown[])[index];
  const code = at("weather_code");
  if (code !== null && code !== undefined && (!Number.isInteger(code) || typeof code !== "number" || CONDITIONS[code] === undefined)) throw new Error("Unknown weather code");
  const min = nullableReading(at("temperature_2m_min"), -100, 70), max = nullableReading(at("temperature_2m_max"), -100, 70);
  if (min !== null && max !== null && min > max) throw new Error("Invalid temperature range");
  const precipitation = nullableReading(at("precipitation_probability_max"), 0, 100);
  const wind = nullableReading(at("wind_speed_10m_max"), 0, 500);
  if (code == null && min === null && max === null && precipitation === null && wind === null) return null;
  return { date, condition: code == null ? null : CONDITIONS[code as number]!, weatherCode: code == null ? null : code as number, temperatureMinC: min, temperatureMaxC: max, precipitationProbabilityPercent: precipitation, windSpeedMaxKmh: wind };
}

async function readJson(fetcher: typeof globalThis.fetch, url: URL, options: { signal: AbortSignal; maxBytes: number }): Promise<unknown> {
  if (url.protocol !== "https:" || ![GEOCODING_URL, FORECAST_URL].some(endpoint => url.origin + url.pathname === endpoint)) throw new Error("Weather endpoint is not allowed");
  const response = await fetcher(url, { signal: options.signal, redirect: "error", headers: { accept: "application/json" } });
  if (!response.ok || (response.url && response.url !== url.href) || !/application\/json/iu.test(response.headers.get("content-type") ?? "")) throw new Error("Weather provider unavailable");
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > options.maxBytes) throw new Error("Weather response too large");
  if (!response.body) throw new Error("Empty weather response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > options.maxBytes) throw new Error("Weather response too large");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(combined));
}

/** Fixed official endpoints; no credentials, arbitrary URL, browser location, or paid requests. */
export function createParticipationWeatherPort(options: ParticipationWeatherOptions = {}): ParticipationWeatherPort & WeatherPort {
  const fetcher = options.fetch ?? globalThis.fetch;
  const clock = options.clock ?? { now: () => new Date() };
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 8_000, 20_000));
  const maxBytes = Math.max(1, Math.min(options.maxResponseBytes ?? 65_536, 131_072));
  const port: ParticipationWeatherPort & WeatherPort = {
    async getForecast(input: { city: string; eventStartAt: string; now: string }): Promise<WeatherSnapshot> {
      const empty: WeatherSnapshot = { status: "unavailable", provider: "open-meteo", requestedCity: typeof input.city === "string" ? input.city.trim() || null : null, location: null, days: [], fetchedAt: null, sourceUrl: SOURCE_URL, note: "暂时无法获取经过校验的天气预报。请出发前再查看当地天气。" };
      if (!safeText(input.city) || input.city.trim().length < 2) return { ...empty, status: "city_unknown", note: "请先确认比赛城市，才能查询当天预报。" };
      if (!validInstant(input.eventStartAt)) return { ...empty, status: "date_unknown", note: "请先确认含时区的开赛时间，才能查询比赛当天预报。" };
      const requestNow = new Date(input.now);
      if (!Number.isFinite(requestNow.getTime())) return empty;
      // Reuse the bounded implementation, but use the service-provided current time.
      const result: ParticipationWeatherResult = await createParticipationWeatherPort({ ...options, clock: { now: () => requestNow } }).describe({ city: input.city, date: new Date(input.eventStartAt).toISOString().slice(0, 10), eventStartAt: input.eventStartAt });
      const status = { available: "available", out_of_range: "outside_forecast_window", unavailable: "unavailable", needs_confirmation: "ambiguous_city" } as const;
      const snapshot: WeatherSnapshot = { ...empty, status: status[result.status], note: result.summary + (result.candidates?.length ? ` 候选：${result.candidates.join("；")}。` : ""), fetchedAt: result.status === "available" ? result.checkedAt : null,
        location: result.place ? { name: result.place.name, country: result.place.country, admin1: result.place.admin1, latitude: result.place.latitude, longitude: result.place.longitude, timeZone: result.place.timezone } : null };
      const reading = result.reading;
      if (result.status === "available" && reading && reading.weatherCode !== null && reading.temperatureMinC !== null && reading.temperatureMaxC !== null) snapshot.days = [{ date: reading.date, weatherCode: reading.weatherCode, temperatureMinC: reading.temperatureMinC, temperatureMaxC: reading.temperatureMaxC, precipitationProbabilityMax: reading.precipitationProbabilityPercent, windSpeedMaxKmh: reading.windSpeedMaxKmh }];
      else if (result.status === "available") { snapshot.status = "unavailable"; snapshot.fetchedAt = null; snapshot.note = "天气服务返回的比赛当天预报不完整。请出发前再查看当地天气。"; }
      return snapshot;
    },
    async describe(input: ParticipationWeatherRequest): Promise<ParticipationWeatherResult> {
      const now = clock.now();
      let date = input.date;
      let base = { provider: "open-meteo" as const, city: typeof input.city === "string" ? input.city.trim() : "", date, checkedAt: now.toISOString(), sourceUrl: SOURCE_URL };
      const unavailable = (summary: string): ParticipationWeatherResult => ({ ...base, status: "unavailable", summary });
      const city = safeText(input.city);
      if (!city || city.length < 2 || typeof input.date !== "string" || !validDate(input.date)) return unavailable("请先确认比赛城市和开赛日期，才能查询当天预报。");
      // Every destination's local date is within one day of UTC. Avoid needless requests for remote dates.
      const utcDiff = (Date.parse(`${input.date}T00:00:00Z`) - Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`)) / DAY_MS;
      if (utcDiff > 16 || utcDiff < -1) return { ...base, status: "out_of_range", summary: utcDiff < 0 ? "该比赛日期已过去，本功能不提供历史天气。" : "比赛尚未进入最长 16 天的预报范围。请在临近比赛时重新检查天气，并预留交通调整余量。" };
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (input.signal?.aborted) controller.abort();
      input.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, timeoutMs);
      try {
        const locationUrl = new URL(GEOCODING_URL);
        locationUrl.search = new URLSearchParams({ name: city, count: "5", language: "zh", format: "json" }).toString();
        const candidates = parsePlaces(await readJson(fetcher, locationUrl, { signal: controller.signal, maxBytes }));
        if (!candidates.length) return unavailable("未找到这个城市。请填写城市全名，并可附国家或省份，例如“上海, 中国”。");
        const queryName = cityIdentity(city.split(",")[0]!);
        const exact = candidates.filter(candidate => cityIdentity(candidate.name) === queryName);
        const matches = exact.length ? exact : candidates;
        if (matches.length > 1) return { ...base, status: "needs_confirmation", candidates: matches.map(candidate => candidate.label), summary: "找到多个同名或相近城市。请补充省份或国家后重新查询，避免使用错误地点的预报。" };
        const place = matches[0]!;
        if (input.eventStartAt) { date = localDate(new Date(input.eventStartAt), place.timezone); base = { ...base, date }; }
        const today = localDate(now, place.timezone);
        const daysUntil = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS;
        if (daysUntil < 0 || daysUntil > 15) return { ...base, place, status: "out_of_range", summary: daysUntil < 0 ? "按比赛城市当地日期，该比赛日期已过去，本功能不提供历史天气。" : "比赛尚未进入最长 16 天的预报范围。请在临近比赛时重新检查天气，并预留交通调整余量。" };
        const forecastUrl = new URL(FORECAST_URL);
        forecastUrl.search = new URLSearchParams({ latitude: String(place.latitude), longitude: String(place.longitude), daily: DAILY_VARIABLES.join(","), forecast_days: "16", timezone: place.timezone, temperature_unit: "celsius", wind_speed_unit: "kmh", precipitation_unit: "mm" }).toString();
        const reading = parseReading(await readJson(fetcher, forecastUrl, { signal: controller.signal, maxBytes }), date, place);
        if (!reading) return { ...base, place, status: "unavailable", summary: "天气服务未返回比赛当天的有效预报。请在出发前查看当地天气和交通通知。" };
        const observations = [reading.condition];
        if (reading.temperatureMinC !== null && reading.temperatureMaxC !== null) observations.push(`${reading.temperatureMinC}～${reading.temperatureMaxC}°C`);
        if (reading.precipitationProbabilityPercent !== null) observations.push(`降水概率 ${reading.precipitationProbabilityPercent}%`);
        if (reading.windSpeedMaxKmh !== null) observations.push(`最高风速 ${reading.windSpeedMaxKmh} km/h`);
        return { ...base, place, reading, status: "available", summary: `${place.name} ${date}：${observations.filter(Boolean).join("，")}。这是查询时的预报，请出发前再次确认。` };
      } catch {
        return unavailable(controller.signal.aborted ? "天气查询超时或已取消。计划可先生成，出发前再查看当地天气。" : "暂时无法获取经过校验的天气预报。计划可先生成，出发前再查看当地天气。" );
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", abort);
      }
    },
  };
  return port;
}
