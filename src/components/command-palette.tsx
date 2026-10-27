"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./command-palette.module.css";

/**
 * 全局命令面板（⌘K / Ctrl+K）。
 *
 * 63 个页面靠导航找太慢，这里给一句话可达。目录是**静态内置**的，
 * 不做服务端搜索、不抓正文——只跳转，所以永远不会越权也不会有隐私面。
 */
interface Destination {
  readonly href: string;
  readonly label: string;
  readonly group: "参与" | "主办" | "平台";
  readonly keywords: string;
}

const DESTINATIONS: readonly Destination[] = [
  { href: "/competitions", label: "找比赛", group: "参与", keywords: "赛事 目录 hackathon 报名" },
  { href: "/me/competitions", label: "我的参赛", group: "参与", keywords: "我的 报名 队伍 提交" },
  { href: "/events", label: "公开赛事目录", group: "参与", keywords: "赛事 公开 目录" },
  { href: "/journey", label: "参赛路线图", group: "参与", keywords: "指引 怎么参加 新手" },
  { href: "/app", label: "我的工作台", group: "参与", keywords: "项目 团队 计划" },
  { href: "/app/teams", label: "我的团队", group: "参与", keywords: "队伍 邀请 成员" },
  { href: "/recruiting", label: "找队友", group: "参与", keywords: "招募 组队 名片" },
  { href: "/participation", label: "参赛计划", group: "参与", keywords: "计划 时间 任务" },
  { href: "/resources", label: "工具与资料", group: "参与", keywords: "资源 工具 资料" },
  { href: "/inspiration", label: "找灵感", group: "参与", keywords: "灵感 案例 站点" },
  { href: "/skills", label: "技能库", group: "参与", keywords: "技能 赛道 包" },
  { href: "/library", label: "新人指南", group: "参与", keywords: "教程 入门 怎么用" },
  { href: "/organizers", label: "主办方工作台", group: "主办", keywords: "办赛 机构 赛事" },
  { href: "/organizers/workspace", label: "我的比赛", group: "主办", keywords: "工作台 赛事列表" },
  { href: "/ai", label: "AI 工作台", group: "平台", keywords: "ai 助手 导航员 对话 工作台" },
  { href: "/app/account", label: "账号设置", group: "平台", keywords: "资料 邮箱 登录" },
  { href: "/dev/mailbox", label: "本机邮箱预览", group: "平台", keywords: "开发 验证码 调试" },
];

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "k") { event.preventDefault(); setOpen(value => !value); return; }
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) { setQuery(""); setActive(0); return; }
    const timer = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [open]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return DESTINATIONS;
    return DESTINATIONS.filter(item => (item.label + " " + item.keywords + " " + item.href).toLowerCase().includes(needle));
  }, [query]);

  function go(href: string) { setOpen(false); router.push(href); }

  if (!open) return null;
  return (
    <div className={styles.backdrop} role="presentation" onClick={() => setOpen(false)}>
      <div className={styles.panel} role="dialog" aria-modal="true" aria-label="快速跳转" onClick={event => event.stopPropagation()}>
        <input
          ref={input}
          className={styles.input}
          value={query}
          placeholder="跳到哪？输入页面名，例如「找比赛」「团队」「评审」"
          onChange={event => { setQuery(event.target.value); setActive(0); }}
          onKeyDown={event => {
            if (event.key === "ArrowDown") { event.preventDefault(); setActive(index => Math.min(matches.length - 1, index + 1)); }
            else if (event.key === "ArrowUp") { event.preventDefault(); setActive(index => Math.max(0, index - 1)); }
            else if (event.key === "Enter") { const target = matches[active]; if (target !== undefined) go(target.href); }
          }}
        />
        <ul className={styles.list} role="listbox" aria-label="结果">
          {matches.length === 0 ? <li className={styles.empty}>没有匹配的页面。</li> : matches.map((item, index) => (
            <li key={item.href}>
              <button
                type="button"
                role="option"
                aria-selected={index === active}
                className={index === active ? styles.itemActive : styles.item}
                onMouseEnter={() => setActive(index)}
                onClick={() => go(item.href)}>
                <span className={styles.group}>{item.group}</span>
                <span>{item.label}</span>
                <span className={styles.href}>{item.href}</span>
              </button>
            </li>))}
        </ul>
        <p className={styles.hint}>↑↓ 选择 · Enter 打开 · Esc 关闭 · ⌘K / Ctrl+K 随时呼出</p>
      </div>
    </div>);
}
