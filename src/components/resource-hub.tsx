import Link from "next/link";
import styles from "./site.module.css";

const entries = [
  { href: "#resource-tools-title", title: "找工具，把作品做出来", description: "按用途查找开发、协作与演示工具。下面的资料由运营人工审核。" },
  { href: "/inspiration", title: "找灵感，确定视觉方向", description: "参考网页、配色、组件和动效。官网说明由 DSH 更新，未完成会标记等待。" },
  { href: "/skills", title: "让正在用的 AI 帮我做事", description: "先选 AI 工具和任务，再看技能的用法、版本与兼容条件。" },
  { href: "/library", title: "第一次参赛，先学会操作", description: "本站原创入门说明，带你理解比赛、组队和提交；按步骤继续到实际页面。" },
] as const;

export function ResourceHub() {
  return <section className={styles.panel} aria-labelledby="resource-hub-title">
    <h2 id="resource-hub-title">为当前任务找工具</h2>
    <p className={styles.muted}>下面可按用途筛选已审核的工具与资料。不知道现在该做什么？<Link className={styles.link} href="/journey">先看参赛指引 →</Link></p>
    <details><summary className={styles.summary}>还需要灵感、AI 技能或入门教程？</summary>
    <div className={styles.grid}>{entries.map(entry => <Link className={styles.card} href={entry.href} key={entry.href}>
      <h3>{entry.title} <span aria-hidden="true">→</span></h3>
      <p>{entry.description}</p>
    </Link>)}</div>
    <p className={styles.muted}>准备保存代码或和队友协作？<Link className={styles.link} href="/github">直接看 GitHub 教程 →</Link></p>
    </details>
  </section>;
}
