export type DshJsonOutputFormat =
  | "json"
  | "json_fence"
  | "empty"
  | "invalid_fence"
  | "invalid_json"
  | "invalid_json_fence"
  | "non_object";

export type DshJsonParseResult =
  | { readonly ok: true; readonly data: Record<string, unknown>; readonly outputFormat: "json" | "json_fence"; readonly outputBytes: number }
  | { readonly ok: false; readonly outputFormat: Exclude<DshJsonOutputFormat, "json" | "json_fence">; readonly outputBytes: number };

/** Parse one complete object, permitting only an enclosing JSON code fence.
 * Never extract braces, join multiple answers, repair JSON, or retain raw text
 * in diagnostics. Callers must establish a completed turn and byte limit first. */
export function parseDshJsonObject(text: string): DshJsonParseResult {
  const outputBytes = Buffer.byteLength(text, "utf8");
  let json = text.trim();
  if (!json) return { ok: false, outputFormat: "empty", outputBytes };
  let format: "json" | "json_fence" = "json";
  if (json.startsWith("```")) {
    const fenced = /^```json[ \t]*\r?\n([\s\S]*)\r?\n```$/iu.exec(json);
    if (!fenced) return { ok: false, outputFormat: "invalid_fence", outputBytes };
    json = fenced[1]!.trim();
    format = "json_fence";
  }
  let data: unknown;
  try { data = JSON.parse(json) as unknown; }
  catch {
    const outputFormat = format === "json_fence" ? "invalid_json_fence" : json.includes("```") ? "invalid_fence" : "invalid_json";
    return { ok: false, outputFormat, outputBytes };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return { ok: false, outputFormat: "non_object", outputBytes };
  return { ok: true, data: data as Record<string, unknown>, outputFormat: format, outputBytes };
}
