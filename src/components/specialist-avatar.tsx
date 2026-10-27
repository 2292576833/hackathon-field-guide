"use client";

/**
 * 专员卡通头像：内联 SVG，一个专员一张脸。
 *
 * 不引外部图片、不加依赖、不发请求；颜色与「辨识物」都由 key 决定，
 * 所以新增专员时只在本文件的表里补一行即可。
 */
interface Look {
  readonly hue: string;
  /** 辨识物：画在右下的一个小徽记，让两张脸不只是颜色不同。 */
  readonly mark: "pen" | "people" | "box" | "cup" | "loop" | "compass" | "clipboard" | "team" | "bubble" | "clock" | "bell" | "glass";
}

const LOOKS: Readonly<Record<string, Look>> = {
  enroll: { hue: "#e8a33d", mark: "pen" },
  teamup: { hue: "#2f9e8f", mark: "people" },
  submit: { hue: "#5b6ee1", mark: "box" },
  results: { hue: "#8a5bd6", mark: "cup" },
  retro: { hue: "#7a8b3a", mark: "loop" },
  overview: { hue: "#4176e6", mark: "compass" },
  registration: { hue: "#3f9e63", mark: "clipboard" },
  teams: { hue: "#e07a3f", mark: "team" },
  communication: { hue: "#3f9ec4", mark: "bubble" },
  schedule: { hue: "#8a5bd6", mark: "clock" },
  services: { hue: "#d6608f", mark: "bell" },
  judging: { hue: "#c2554f", mark: "glass" },
};

const FALLBACK: Look = { hue: "#7f8287", mark: "compass" };

function Mark({ mark, color }: { readonly mark: Look["mark"]; readonly color: string }) {
  const stroke = { stroke: "#fff", strokeWidth: 1.6, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (mark) {
    case "pen": return <path d="M3 9l3-3 3 3-3 3z" {...stroke} />;
    case "people": return <><circle cx="4" cy="6" r="1.6" {...stroke} /><circle cx="8" cy="6" r="1.6" {...stroke} /><path d="M2 9c0-1.2 1-2 2-2M10 9c0-1.2-1-2-2-2" {...stroke} /></>;
    case "box": return <><path d="M2.5 5.5h7v5h-7z" {...stroke} /><path d="M2.5 5.5l3.5-2 3.5 2" {...stroke} /></>;
    case "cup": return <><path d="M3 4h6v3a3 3 0 0 1-6 0z" {...stroke} /><path d="M9 5h1.2a1.2 1.2 0 0 1 0 2.4H9" {...stroke} /></>;
    case "loop": return <path d="M3 7a4 4 0 1 1 1.2 2.8M3 4v3h3" {...stroke} />;
    case "compass": return <><circle cx="6" cy="7" r="3.2" {...stroke} /><path d="M7.4 5.6L5.2 7.8 6.6 6.4" {...stroke} /></>;
    case "clipboard": return <><path d="M3.5 4.5h5v6h-5z" {...stroke} /><path d="M5 4.5V3.2h2v1.3" {...stroke} /></>;
    case "team": return <><circle cx="4" cy="5.5" r="1.5" {...stroke} /><circle cx="8" cy="5.5" r="1.5" {...stroke} /><path d="M2.5 9.5c0-1.3 1-2.2 2.2-2.2s2.2.9 2.2 2.2" {...stroke} /></>;
    case "bubble": return <path d="M3 4.5h6v4H6l-2 2v-2H3z" {...stroke} />;
    case "clock": return <><circle cx="6" cy="7" r="3.3" {...stroke} /><path d="M6 5v2l1.6 1" {...stroke} /></>;
    case "bell": return <><path d="M4 8.5V6a2 2 0 0 1 4 0v2.5z" {...stroke} /><path d="M5 9.5h2" {...stroke} /></>;
    case "glass": return <><circle cx="4.6" cy="6.6" r="1.7" {...stroke} /><circle cx="7.6" cy="6.6" r="1.7" {...stroke} /><path d="M6.2 6.6h-.4" {...stroke} /><path d="M3 9.6l1.6-1M9 9.6l-1.6-1" {...stroke} /></>;
    default: return <circle cx="6" cy="8" r="1.6" fill={color} />;
  }
}

export function SpecialistAvatar({ specialistKey, size = 20 }: { readonly specialistKey: string; readonly size?: number }) {
  const look = LOOKS[specialistKey] ?? FALLBACK;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={{ flex: "0 0 auto" }}>
      <circle cx="12" cy="12" r="11" fill={look.hue} />
      <circle cx="12" cy="12.6" r="6.4" fill="#ffe9d6" />
      <circle cx="9.9" cy="11.4" r="0.95" fill="#2b2320" />
      <circle cx="14.1" cy="11.4" r="0.95" fill="#2b2320" />
      <path d="M10.2 14.1c.6.7 1.3 1 1.8 1s1.2-.3 1.8-1" stroke="#2b2320" strokeWidth="1" fill="none" strokeLinecap="round" />
      <g transform="translate(13.5 13.5)">
        <circle cx="3" cy="3" r="3.4" fill={look.hue} stroke="#fff" strokeWidth="1" />
        <g transform="translate(-2.6 -0.2) scale(0.78)"><Mark mark={look.mark} color="#fff" /></g>
      </g>
    </svg>);
}
