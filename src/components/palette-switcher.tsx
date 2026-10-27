"use client";

import { useEffect, useState } from "react";

/**
 * 配色方案切换（预览用）。
 *
 * 只做一件事：把 `<html class="palette-N">` 换掉，并记住选择。
 * 皮肤本身全部定义在 `src/styles/globals.css`，**只覆盖颜色变量**，不碰布局与组件样式，
 * 因此切换不会改变任何结构或行为。
 *
 * 位置固定在右下角、默认收起，**不需要登录也能看到**（不放进只有登录后才出现的账号菜单）。
 * 定稿后如需固定为默认，改 `globals.css` 的 `:root` 即可，本组件可以随时删除。
 */

export const PALETTES = [
  { id: "palette-1", label: "暖白橙红", note: "现用" },
  { id: "palette-2", label: "暖白 · 深青绿", note: "" },
  { id: "palette-3", label: "冷白 · 靛蓝", note: "" },
  { id: "palette-4", label: "暖白 · 紫罗兰", note: "" },
  { id: "palette-5", label: "象牙 · 墨黑朱砂", note: "" },
] as const;

const STORAGE_KEY = "hackathon.palette";
const CLASSES = PALETTES.map(palette => palette.id);

function apply(id: string) {
  const root = document.documentElement;
  root.classList.remove(...CLASSES);
  if (id !== "palette-1") root.classList.add(id);
}

export function PaletteSwitcher() {
  const [current, setCurrent] = useState<string>("palette-1");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let saved = "palette-1";
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored && CLASSES.includes(stored as (typeof CLASSES)[number])) saved = stored;
    } catch { /* 偏好读取失败就用默认 */ }
    setCurrent(saved);
    apply(saved);
  }, []);

  const choose = (id: string) => {
    setCurrent(id);
    apply(id);
    try { window.localStorage.setItem(STORAGE_KEY, id); } catch { /* 记不住只影响下次 */ }
  };

  const label = PALETTES.find(palette => palette.id === current)?.label ?? "暖白橙红";

  if (!open) {
    return <button type="button" className="paletteFab" onClick={() => setOpen(true)} title="切换配色方案（仅预览用）">
      <span className="paletteFabDot" data-palette={current} aria-hidden="true"/>配色
    </button>;
  }

  return <div className="paletteFabPanel" role="group" aria-label="配色方案">
    <div className="paletteFabHead">
      <strong>配色方案</strong>
      <button type="button" className="paletteFabClose" onClick={() => setOpen(false)} aria-label="收起配色切换">收起</button>
    </div>
    {PALETTES.map(palette => <button key={palette.id} type="button" className="paletteFabItem"
      aria-pressed={current === palette.id} onClick={() => choose(palette.id)}>
      <span className="paletteFabDot" data-palette={palette.id} aria-hidden="true"/>
      {palette.label}{palette.note && <em className="paletteFabNote">{palette.note}</em>}
    </button>)}
  </div>;
}
