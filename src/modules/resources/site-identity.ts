/** Same-site navigation metadata. It never changes a reviewed resource snapshot or DSH analysis. */
const sites = {
  "ui.shadcn.com": { id: "shadcn-ui", name: "shadcn/ui", url: "https://ui.shadcn.com/" },
  "radix-ui.com": { id: "radix-ui", name: "Radix UI", url: "https://www.radix-ui.com/" },
  "ant.design": { id: "ant-design", name: "Ant Design", url: "https://ant.design/" },
  "awwwards.com": { id: "awwwards", name: "Awwwards", url: "https://www.awwwards.com/" },
} as const;

export function resourceSiteIdentity(officialUrl: string): { id: string; name: string; url: string; inspirationHref: string } | null {
  try {
    const parsed = new URL(officialUrl);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || /[\\\u0000-\u0020\u007f]/.test(officialUrl)) return null;
    const host = parsed.hostname.replace(/^www\./, "");
    if (!Object.hasOwn(sites, host)) return null;
    const identity = sites[host as keyof typeof sites];
    if (!identity) return null;
    return { ...identity, inspirationHref: `/inspiration?${new URLSearchParams({ q: identity.name })}` };
  } catch { return null; }
}
