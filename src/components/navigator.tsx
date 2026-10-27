"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, dateText, useApi } from "./client-api.ts";
import { Feedback, Field, type Me } from "./site-shell.tsx";
import { useAction } from "./workflow.tsx";
import styles from "./navigator.module.css";
import { NavigatorShare } from "./navigator-share.tsx";
import type { Project } from "../modules/projects/model.ts";

type Message = { id?: string; role: "user" | "assistant"; content: string };
interface SearchResult { items: readonly { id: string; title: string; href: string; sourceType: string; scope: "public" | "current_project"; excerpt: string; updatedAt?: string }[]; notices: readonly string[] }
interface Reply { reply: string; links: { title: string; href: string }[]; provider: "dsh"; requestId: string; sourceId?: string | null; siteSearch?: SearchResult }
interface Intro { version: string; title: string; sections: string[]; steps: string[]; links: { title: string; href: string }[]; chat: { provider: "dsh"; configured: boolean } }
interface Conversation { session: { id: string; provider: "dsh"; busy: boolean }; messages: Message[]; messageIds?: string[] }
const intro = [
  ["从适合你的入口开始", "新人先看参赛指引；选手从我的参赛继续当前比赛与团队任务；主办方从顶部入驻入口进入办赛流程。"],
  ["先确认比赛与报名", "本站正式赛事可在网站报名、查看审核和通知；DSH发现卡片是未核验线索，需打开主办方来源核对并报名。保存线索不等于报名成功。"],
  ["在团队空间做当前任务", "保存作品目标、邀请队友、确认分工与计划，再按工作台的下一步协作。个人资料与AI记忆默认私密，明确分享后队友才能看到。"],
  ["需要时再用工具", "教程、灵感、AI技能、GitHub、路演和PPT在对应任务时使用。保存代码、验证运行和向主办方正式提交分别记录；赛后保留经验。"],
  ["有问题时叫导航员", "随时打开导航员重放介绍或提问。登录后的聊天统一由 DeepSeek Harness 回复，可以讨论备赛、协作和技术问题；关键事实以来源和团队确认记录为准。"],
];
function internalHref(value: string) { return value.startsWith("/") && !value.startsWith("//") && !/[\\\x00-\x20]/.test(value) ? value : null; }
export function Navigator() {
  const [activated, setActivated] = useState(false);
  const pathname = usePathname(); const identity = useApi<Me>(activated ? "/me" : null); const metadata = useApi<Intro>(activated ? "/navigator/intro" : null); const dialog = useRef<HTMLDialogElement>(null); const trigger = useRef<HTMLButtonElement>(null); const [open, setOpen] = useState(false); const [tab, setTab] = useState<"intro" | "ask">("intro"); const [message, setMessage] = useState(""); const [pendingQuestion, setPendingQuestion] = useState(""); const [history, setHistory] = useState<Message[]>([]); const [links, setLinks] = useState<Reply["links"]>([]); const action = useAction();
  const projectId = /^\/app\/projects\/([^/]+)/.exec(pathname)?.[1];
  const conversationPath = `/navigator/conversation${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`;
  const contextKey = `${identity.data?.profile.id ?? "guest"}:${conversationPath}`;
  const context = useRef(contextKey); context.current = contextKey;
  const [siteSearch, setSiteSearch] = useState<SearchResult | null>(null);
  const conversation = useApi<Conversation>(identity.data ? conversationPath : null);
  const spaces = useApi<Project[]>(identity.data ? "/projects" : null);
  useEffect(() => { if (open && !dialog.current?.open) dialog.current?.showModal(); if (!open && dialog.current?.open) dialog.current?.close(); }, [open]);
  useEffect(() => { setHistory([]); setLinks([]); setSiteSearch(null); setPendingQuestion(""); }, [contextKey]);
  useEffect(() => { setHistory(conversation.data?.messages.map((item, index) => ({ ...item, id: conversation.data?.messageIds?.[index] })) ?? []); }, [conversation.data, conversationPath]);
  function close() { setOpen(false); trigger.current?.focus(); }
  return <><button ref={trigger} type="button" className={styles.launcher} onClick={() => { setActivated(true); setOpen(true); }} aria-haspopup="dialog" aria-label="问问导航员">问问导航员</button><dialog ref={dialog} className={styles.dialog} aria-labelledby="navigator-title" onCancel={event => { event.preventDefault(); close(); }} onClose={() => setOpen(false)}><div className={styles.header}><h2 id="navigator-title">你的参赛导航员</h2><button type="button" onClick={close} aria-label="关闭导航员">关闭</button></div><nav className={styles.tabs} aria-label="导航员内容"><button type="button" aria-pressed={tab === "intro"} onClick={() => setTab("intro")}>网站详细介绍</button><button type="button" aria-pressed={tab === "ask"} onClick={() => setTab("ask")}>向 AI 提问</button></nav>
    {tab === "intro" ? <><div className={styles.intro}>{metadata.data ? <><h3>{metadata.data.title}</h3>{metadata.data.sections.map((text, i) => <p key={i}>{text}</p>)}<ol>{metadata.data.steps.map((step, i) => <li key={i}>{step}</li>)}</ol><ul>{metadata.data.links.map(link => internalHref(link.href) && <li key={link.href}><Link href={link.href} onClick={close}>{link.title}</Link></li>)}</ul></> : intro.map(([title, text], i) => <section key={title}><h3>{i + 1}. {title}</h3><p>{text}</p></section>)}</div><div className={styles.actions}><Link href="/library" onClick={close}>打开新手教程</Link><button type="button" onClick={close}>已了解，开始使用</button><button type="button" onClick={close}>稍后再看</button></div></> : <>
      <p className={styles.provider}>{metadata.data?.chat?.configured === false ? "DeepSeek Harness 尚未配置，发送后会返回服务错误。" : "当前账号有独立的 DSH 对话记录，刷新或换设备后可继续。"}</p>
      <p><Link href="/ai" onClick={close}>打开 AI 工作台（整页）</Link>——左侧网站入口、右侧对话，适合边看边问。</p>
      <p>可以用相关词找站内资料，例如“链接邀请队友”“Git 冲突”“PPT 模板”，也可以描述当前困难。发送后会查找教程、功能说明和已公开信息，再交给 DSH 回复；当前空间只提供你有权限的摘要，不会读取队友私人资料。</p>
      {!identity.data && <p><Link href={`/login?returnTo=${encodeURIComponent(pathname)}`} onClick={close}>登录后使用 DeepSeek Harness 提问</Link>，网站介绍和资料馆可直接查看。</p>}
      <div className={styles.messages} aria-live="polite">{history.map((item, i) => <div key={item.id ?? i} className={item.role === "user" ? styles.user : styles.assistant}><strong>{item.role === "user" ? "你" : "DeepSeek Harness"}</strong><p>{item.content}</p>{item.role === "assistant" && item.id && <NavigatorShare sourceId={item.id} content={item.content} projects={spaces.data ?? []} currentProjectId={projectId}/>}</div>)}{pendingQuestion && <div className={styles.user}><strong>你</strong><p>{pendingQuestion}</p></div>}{action.busy && <p role="status">正在查找站内资料，并由 DeepSeek Harness 回复…</p>}</div>
      {siteSearch && <section className={styles.sources} aria-label="本次找到的站内资料">
        {siteSearch.items.length ? <details><summary>本次找到的站内资料（{siteSearch.items.length}）</summary><ul>{siteSearch.items.map(item => internalHref(item.href) && <li key={item.id}><Link href={internalHref(item.href)!} onClick={close}>{item.title}</Link><small>{item.sourceType} · {item.scope === "current_project" ? "仅当前有权限空间" : "公开资料"}</small>{item.updatedAt && Number.isFinite(Date.parse(item.updatedAt)) && <small>来源更新：<time dateTime={item.updatedAt}>{item.updatedAt.includes("T") ? dateText(item.updatedAt) : item.updatedAt}</time></small>}<p>{item.excerpt}</p></li>)}</ul></details> : <p>本次没有找到对应的站内资料，DSH 会说明缺少的信息。</p>}
        {siteSearch.notices.map((notice, index) => <p className={styles.searchNotice} key={index}>{notice}</p>)}
      </section>}
      <ul>{links.map(link => internalHref(link.href) && <li key={link.href}><Link href={internalHref(link.href)!} onClick={close}>{link.title}</Link></li>)}</ul>
      <Feedback error={action.error ?? conversation.error} notice={action.notice}/>
      <form onSubmit={event => { event.preventDefault(); void action.run(async () => {
        const requestedContext = context.current;
        setPendingQuestion(message); setSiteSearch(null); setLinks([]);
        try {
          const result = await api<Reply>("/navigator/messages", { method: "POST", body: { message, pagePath: pathname, ...(projectId ? { projectId } : {}) } });
          if (result.provider !== "dsh") throw new Error("聊天回复来源不匹配，未展示结果。");
          if (requestedContext !== context.current) return;
          setHistory([...history, { role: "user", content: message }, { role: "assistant", content: result.reply, id: result.sourceId ?? undefined }]);
          setLinks(result.links); setSiteSearch(result.siteSearch ?? null); setMessage(""); await conversation.reload();
        } finally { if (requestedContext === context.current) setPendingQuestion(""); }
      }, "已收到 DeepSeek Harness 回复，请核对关键建议。"); }}>
        <Field label="你现在需要什么帮助"><textarea required maxLength={2000} value={message} disabled={action.busy || !identity.data} onChange={event => setMessage(event.target.value)}/></Field>
        <div className={styles.actions}><button disabled={action.busy || !identity.data || !message.trim()}>{action.busy ? "等待服务回复…" : "发送问题"}</button><button type="button" disabled={action.busy || !identity.data} onClick={() => void action.run(async () => { await api(conversationPath, { method: "DELETE" }); setHistory([]); setLinks([]); setSiteSearch(null); await conversation.reload(); }, "当前对话已清空，生成的计划和讲稿仍保留。")}>清空保存的对话</button></div>
      </form>
    </>}
  </dialog></>;
}

