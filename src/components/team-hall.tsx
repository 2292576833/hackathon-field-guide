"use client";

import { useCallback, useEffect, useState } from "react";
import { api, message as errorMessage } from "./client-api.ts";
import styles from "./team-hall.module.css";

/**
 * 智能组队大厅（参赛者侧）。
 *
 * 三条门槛由后端判定：本人报名已通过 + 主办方开了参赛名录 + 对方主动开启愿意被组队。
 * 页面只做两件事：本人开关、看愿意组队的人。**没有分数、没有排名、不撮合**。
 */
interface Candidate { readonly userId: string; readonly displayName: string; readonly headline: string; readonly skills: readonly string[]; readonly city: string }
interface Hall { readonly candidates: readonly Candidate[]; readonly notice: string; readonly limitations: readonly string[] }

export function TeamHall({ eventId }: { readonly eventId: string }) {
  const base = "/competitions/" + encodeURIComponent(eventId) + "/team-match";
  const [open, setOpen] = useState(false);
  const [hall, setHall] = useState<Hall | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const mine = await api<{ open: boolean }>(base + "/opt-in");
      setOpen(mine.open);
      setHall(await api<Hall>(base));
    } catch (problem) { setError(errorMessage(problem)); }
    finally { setLoading(false); }
  }, [base]);
  useEffect(() => { void load(); }, [load]);

  async function toggle(next: boolean) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await api(base + "/opt-in", { method: "POST", body: { open: next } });
      setOpen(next);
      setHall(await api<Hall>(base));
    } catch (problem) { setError(errorMessage(problem)); }
    finally { setBusy(false); }
  }

  if (loading) return <p>正在读取组队大厅…</p>;
  if (hall === null) {
    return (
      <section className={styles.panel}>
        <h2>组队大厅暂不可用</h2>
        <p className={styles.muted}>{error === "" ? "本场还没有开启参赛名录，或你的报名还没通过。" : error}</p>
        <p className={styles.muted}>如果你还没报名，先完成报名；主办方开启「参赛名录」后才能使用。</p>
      </section>);
  }

  return (
    <section className={styles.panel}>
      <header className={styles.head}>
        <h2>智能组队大厅</h2>
        <label className={styles.switch}>
          <input type="checkbox" checked={open} disabled={busy} onChange={event => void toggle(event.target.checked)} />
          愿意被组队
        </label>
      </header>
      <p className={styles.muted}>{open ? "你现在会出现在别人的组队大厅里（只显示名片公开字段）。" : "开启后，其他已通过报名的参赛者能在组队大厅看到你的名片；随时可以关。"}</p>
      {error === "" ? null : <p role="alert" className={styles.error}>{error}</p>}

      <h3 className={styles.subhead}>愿意组队的人（{hall.candidates.length}）</h3>
      {hall.candidates.length === 0 ? <p className={styles.muted}>还没有其他人开启。你可以先把名片补完整，开启后别人就能看到你。</p> : (
        <ul className={styles.list}>
          {hall.candidates.map(candidate => (
            <li key={candidate.userId} className={styles.card}>
              <strong>{candidate.displayName}</strong>
              {candidate.headline === "" ? null : <p className={styles.headline}>{candidate.headline}</p>}
              <p className={styles.meta}>
                {candidate.skills.length === 0 ? "还没填技能" : candidate.skills.join(" · ")}
                {candidate.city === "" ? "" : " · " + candidate.city}
              </p>
            </li>))}
        </ul>)}
      <p className={styles.notice}>{hall.notice}</p>
      <ul className={styles.limits}>{hall.limitations.map(item => <li key={item}>{item}</li>)}</ul>
    </section>);
}
