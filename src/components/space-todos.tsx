"use client";

import { useEffect, useState, type FormEvent } from "react";
import { api, message, useApi } from "./client-api.ts";
import type { CurrentPlanningView } from "../modules/planning/types.ts";
import type { MemberAvailability, MyIntentionView, ProjectOfficialTracksView } from "../modules/projects/index.ts";
import type { ProjectDetail } from "./projects-client.tsx";
import { buildSpaceTodos, type SpaceManualTodo, type SpaceTodoKind, type SpaceTodoView } from "../modules/space-workflow/todos.ts";
import type { ReadState, SpaceRules } from "../modules/space-workflow/model.ts";
import styles from "./space-todos.module.css";

const KIND_LABEL: Record<SpaceTodoKind, string> = { confirm: "等我确认", assign: "没人接的任务", do: "要我做", fill: "要我填", manual: "我的备忘" };
function readState<T>(state: { data: T | null; loading: boolean; error: Error | null }): ReadState<T> {
  return state.error ? { status: "error", message: "读取失败" } : state.loading ? { status: "loading" } : state.data === null ? { status: "unread" } : { status: "ready", value: state.data };
}

export interface SpaceTodosPanelProps {
  readonly detail: ProjectDetail;
  readonly current: CurrentPlanningView | null;
  readonly planningLoading?: boolean;
  readonly planningError?: unknown;
  /** 就地展开某个节点（如"检查成果"跳到任务板）。 */
  readonly onOpenNode?: (nodeId: string) => void;
}

/**
 * 首屏待办清单（规划27 第1期）。
 * 四类派生 + 本人手动添加；红色只用于真阻塞；系统未知信息进 unread，不进待办。
 */
export function SpaceTodosPanel({ detail, current, planningLoading, planningError, onOpenNode }: SpaceTodosPanelProps) {
  const projectId = detail.project.id;
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const manual = useApi<SpaceManualTodo[]>(`${base}/space-todos`);
  const rules = useApi<SpaceRules>(`${base}/rules`, { timeoutMs: 15_000 });
  const tracks = useApi<ProjectOfficialTracksView>(`${base}/official-tracks`, { timeoutMs: 15_000 });
  const intention = useApi<MyIntentionView>(`${base}/my-intention`, { timeoutMs: 15_000 });
  const availability = useApi<{ availability: MemberAvailability | null; confirmationRequired: boolean }>(`${base}/my-availability`, { timeoutMs: 15_000 });
  const [title, setTitle] = useState(""), [note, setNote] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");

  const view: SpaceTodoView = buildSpaceTodos({
    detail: detail as never, current, planningLoading, planningError,
    rules: readState(rules), tracks: readState(tracks), intention: readState(intention), availability: readState(availability),
    manual: manual.data ?? [],
  });

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!title.trim()) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await api<SpaceManualTodo>(`${base}/space-todos`, { method: "POST", body: { title: title.trim(), note: note.trim() } });
      setTitle(""); setNote(""); setNotice("已加入我的待办。这是私人备忘，队友看不到。");
      await manual.reload();
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }

  async function markDone(item: SpaceManualTodo) {
    setBusy(true); setError("");
    try {
      await api<SpaceManualTodo>(`${base}/space-todos/${encodeURIComponent(item.id)}/edit`, { method: "POST", body: { status: "done", expectedRevision: item.revision } });
      await manual.reload();
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }

  async function remove(item: SpaceManualTodo) {
    setBusy(true); setError("");
    try {
      await api<{ id: string }>(`${base}/space-todos/${encodeURIComponent(item.id)}/remove`, { method: "POST" });
      await manual.reload();
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }

  const derived = view.todos.filter(todo => todo.kind !== "manual");
  useEffect(() => {
    const refresh = (event: Event) => { if ((event as CustomEvent<{ projectId?: string }>).detail?.projectId === projectId) void manual.reload(); };
    window.addEventListener("hackathon:space-todos-changed", refresh);
    return () => window.removeEventListener("hackathon:space-todos-changed", refresh);
  }, [projectId, manual.reload]);
  return <section className={styles.surface} aria-label="我的待办" id="space-todos">
      <div className={styles.head}><h2>我的待办</h2>
        <div className={styles.actions}>
          <span className={styles.count}>{view.urgentCount > 0 ? `有人等你处理 ${view.urgentCount} 件` : `共 ${view.todos.length} 件`}</span></div></div>
      {view.readonly && <p className={styles.notice}>已归档，待办只读。</p>}
      {Boolean(planningError) && <p role="alert" className={styles.error}>任务读取失败，暂时无法判断下一步。</p>}
      {[rules.error, tracks.error, intention.error, availability.error].some(Boolean) && <p role="alert" className={styles.error}>部分准备信息读取失败，请重新读取。</p>}
      {manual.error && <p role="alert" className={styles.error}>{manual.error.message}</p>}
      {manual.loading && <p role="status" className={styles.notice}>正在读取私人备忘…</p>}
      {notice && <p role="status" className={styles.noticeLine}>{notice}</p>}
      {error && <p role="alert" className={styles.error}>{error}</p>}

      {view.todos.length === 0 && !view.unread.length && !manual.loading && <p className={styles.empty}>{view.readonly ? "没有未完成的备忘。" : "暂无待办。从流程中选一步，或记一件事。"}</p>}

      {derived.length > 0 && <ul className={styles.list}>{derived.map(todo => <li className={styles.item} key={todo.id} data-kind={todo.kind}>
        <span className={`${styles.marker} ${todo.urgency === "urgent" ? styles.urgent : ""}`} aria-hidden="true"/>
        <div>
          <p className={styles.title}>{todo.title}</p>
          <p className={styles.kind}>{KIND_LABEL[todo.kind]}{todo.urgency === "urgent" ? " · 有人在等" : ""}</p>
          <div className={styles.actions}>
            {todo.nodeId && onOpenNode
              ? <button type="button" className={styles.link} onClick={() => onOpenNode(todo.nodeId!)}>在这里处理 →</button>
              : <a className={styles.link} href={todo.href.startsWith("/app") ? todo.href : `/app/projects/${encodeURIComponent(projectId)}${todo.href.replace(`/app/projects/${encodeURIComponent(projectId)}`, "")}`}>去处理 →</a>}
          </div>
          <details className={styles.details}><summary>完成标准</summary><p className={styles.done}>{todo.doneWhen}</p></details>
        </div>
      </li>)}</ul>}

      {view.unread.length > 0 && <details className={styles.details}>
        <summary>待核对信息（{view.unread.length} 项）</summary>
        <ul>{view.unread.map((line, index) => <li key={index}>{line}</li>)}</ul>
        <div className={styles.actions}><button type="button" className={styles.secondary} disabled={busy} onClick={() => { void rules.reload(); void tracks.reload(); void intention.reload(); void availability.reload(); void manual.reload(); }}>重新读取</button></div>
      </details>}

      {!view.readonly && <details className={styles.manualBox}>
        <summary>记一件事</summary>
        <form onSubmit={add}>
          <div className={styles.field}><label htmlFor="space-todo-title">要做什么</label>
            <input id="space-todo-title" value={title} onChange={event => setTitle(event.target.value)} maxLength={200} placeholder="例如：问队友要接口文档" required/></div>
          <div className={styles.field}><label htmlFor="space-todo-note">备注（可选）</label>
            <input id="space-todo-note" value={note} onChange={event => setNote(event.target.value)} maxLength={2000}/></div>
          <div className={styles.actions}><button type="submit" className={styles.secondary} disabled={busy || !title.trim()}>{busy ? "正在添加…" : "加入我的待办"}</button></div>
        </form>
      </details>}

    {(manual.data ?? []).some(item => item.status === "open") && <section className={styles.manualList} aria-label="我的备忘">
      <div className={styles.head}><h3>我的备忘</h3><span className={styles.count}>只有你可见</span></div>
      <ul className={styles.list}>{(manual.data ?? []).filter(item => item.status === "open").map(item => <li className={styles.item} key={item.id} data-kind="manual">
        <span className={styles.marker} aria-hidden="true"/>
        <div><p className={styles.title}>{item.title}</p>{item.note && <details className={styles.details}><summary>备注</summary><p className={styles.done}>{item.note}</p></details>}
          <div className={styles.actions}>
            {!view.readonly && <><button type="button" className={styles.secondary} disabled={busy} onClick={() => void markDone(item)}>标记完成</button>
            <button type="button" className={styles.textButton} disabled={busy} onClick={() => void remove(item)}>删除</button></>}
          </div></div>
      </li>)}</ul>
    </section>}
    <details className={styles.details}><summary>说明</summary><p className={styles.notice}>团队任务由实际检查记录判定完成。手动添加的是私人备忘，只有你可见；标记它完成不改变团队任务、交付或已读状态。</p></details>
  </section>;
}
