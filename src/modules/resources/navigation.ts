import {
  RESOURCE_COST_TYPES, RESOURCE_PREREQUISITES, RESOURCE_STACKS, RESOURCE_STAGES, RESOURCE_TYPES, RESOURCE_USES,
} from "./domain.ts";
import type { ResourceQuery } from "./domain.ts";

/** Only resource filters travel between the catalog and a detail page. */
export function readResourceLocation(params: URLSearchParams): { query: ResourceQuery; cursor: string } {
  const query: ResourceQuery = {};
  const search = params.get("search");
  if (search && search.length <= 200 && !/[\u0000-\u001f\u007f]/.test(search)) query.search = search;
  const fields = {
    type: RESOURCE_TYPES, stage: RESOURCE_STAGES, stack: RESOURCE_STACKS,
    prerequisite: RESOURCE_PREREQUISITES, use: RESOURCE_USES, costType: RESOURCE_COST_TYPES,
    sort: ["editorial", "name", "verified"],
  } as const;
  for (const [key, options] of Object.entries(fields)) {
    const value = params.get(key);
    if (value && (options as readonly string[]).includes(value)) Object.assign(query, { [key]: value });
  }
  const limit = params.get("limit");
  if (limit && /^\d{1,2}$/.test(limit) && Number(limit) >= 1 && Number(limit) <= 50) query.limit = Number(limit);
  const value = params.get("cursor");
  const cursor = value && /^\d{1,7}$/.test(value) && Number(value) <= 1000000 ? value : "";
  return { query, cursor };
}

export function resourceLocationParams(query: ResourceQuery = {}, cursor = ""): URLSearchParams {
  const input = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") input.set(key, String(value));
  if (cursor) input.set("cursor", cursor);
  const clean = readResourceLocation(input);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(clean.query)) params.set(key, String(value));
  if (clean.cursor) params.set("cursor", clean.cursor);
  return params;
}

export function resourceCatalogHref(query: ResourceQuery = {}, cursor = ""): string {
  const suffix = resourceLocationParams(query, cursor).toString();
  return `/resources${suffix ? `?${suffix}` : ""}`;
}

export function resourceDetailHref(resourceId: string, query: ResourceQuery = {}, cursor = ""): string {
  const suffix = resourceLocationParams(query, cursor).toString();
  return `/resources/${encodeURIComponent(resourceId)}${suffix ? `?${suffix}` : ""}`;
}
