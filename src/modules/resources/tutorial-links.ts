export interface TutorialLink { href: string; external: boolean }
export interface TutorialFilters { category: string; query: string }

const internalLearningPath = /^\/(?:events|app|resources|skills|library|inspiration|participation|roadshow|ppt|github)(?:\/[A-Za-z0-9_-]+)*\/?$/;
const unsafeRawCharacters = /[\\\u0000-\u0020\u007f-\u009f]/u;
const unsafeDecodedCharacters = /[\\\u0000-\u001f\u007f-\u009f]/u;

/** Keep rooted next steps separate from absolute public reference links. */
export function tutorialLink(value: string | null | undefined): TutorialLink | null {
  if (!value || unsafeRawCharacters.test(value)) return null;
  try { if (unsafeDecodedCharacters.test(decodeURIComponent(value))) return null; } catch { return null; }
  if (value.startsWith("/")) {
    if (value.startsWith("//") || !internalLearningPath.test(value.split(/[?#]/, 1)[0]!)) return null;
    return { href: value, external: false };
  }
  if (!/^https?:\/\/(?!\/)/i.test(value)) return null;
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) return null;
    return { href: parsed.href, external: true };
  } catch { return null; }
}

function filterText(value: string | null | undefined, limit: number): string {
  return (value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").trim().slice(0, limit);
}

export function readTutorialFilters(params: { get: (key: string) => string | null }): TutorialFilters {
  return { category: filterText(params.get("category"), 60), query: filterText(params.get("query"), 100) };
}

export function tutorialFilterQuery(filters: TutorialFilters): string {
  const query = new URLSearchParams();
  const category = filterText(filters.category, 60), keyword = filterText(filters.query, 100);
  if (category) query.set("category", category);
  if (keyword) query.set("query", keyword);
  return query.toString();
}

export function tutorialDirectoryHref(filters: TutorialFilters): string {
  const query = tutorialFilterQuery(filters);
  return `/library${query ? `?${query}` : ""}`;
}
