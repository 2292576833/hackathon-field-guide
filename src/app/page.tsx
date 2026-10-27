import Link from "next/link";
import { SiteShell } from "../components/site-shell.tsx";
import styles from "../styles/home.module.css";

export default function HomePage() {
  return <SiteShell>
    <section className={styles.hero} aria-labelledby="hero-title">
      <div><p className={styles.eyebrow}>HACKATHON FIELD GUIDE / 试用版</p>
        <h1 id="hero-title">第一次参加黑客松，<br />跟着<span>下一步</span>来。</h1>
        <p className={styles.lead}>从找比赛、组队到交作品，<br />每一步都告诉你现在该做什么。</p>
        <div className={styles.actions}><Link prefetch={false} className={styles.primary} href="/journey">开始参赛指引 <span aria-hidden="true">→</span></Link><Link prefetch={false} className={styles.secondary} href="/app">已有团队空间？继续参赛 <span aria-hidden="true">↗</span></Link></div>
        <p className={styles.caption}>先看当前一步，需要时再展开教程和工具。</p>
        <div className={styles.organizerCallout} aria-label="主办方办赛入口"><div><strong>想办一场黑客松？</strong><p>发布报名链接、审核选手，管理赛程和评审。</p></div><Link prefetch={false} className={styles.organizerButton} href="/organizers">主办方入驻 <span aria-hidden="true">↗</span></Link></div>
      </div>
      <aside className={styles.brief} aria-label="参赛行动清单">
        <div className={styles.briefHeader}><span>第一次参赛，走这条路</span><span className={styles.stamp}>FIELD NOTES</span></div>
        <p className={styles.briefTitle}>先知道要做什么，<br />再一步步完成。</p>
        <ol className={styles.checklist}><li><span>01</span><div><strong>找比赛，确认报名</strong><p>看时间、资格和要求，进入对应报名页。</p></div></li><li><span>02</span><div><strong>组队分工，开始做任务</strong><p>确定最小作品，知道自己现在负责什么。</p></div></li><li><span>03</span><div><strong>演示提交，留下经验</strong><p>检查作品、准备展示，查看正式提交记录。</p></div></li></ol>
        <div className={styles.note}>一个人也能开始；工具和 AI 在需要时帮助你。</div>
      </aside>
    </section>
    <section className={styles.features} aria-label="参赛工具入口">
      <Link prefetch={false} href="/events"><span className={styles.eyebrow}>01 / 找比赛</span><h2>了解比赛，再决定参加 <span aria-hidden="true">↗</span></h2><p>看 AI 整理的分析、报名入口和注意事项，关键条件以主办方说明为准。</p></Link>
      <Link prefetch={false} href="/app"><span className={styles.eyebrow}>02 / 我的参赛</span><h2>开始准备，和队友一起做 <span aria-hidden="true">↗</span></h2><p>安排个人准备和出行，创建项目、邀请队友，再确定分工与任务时间。</p></Link>
      <Link prefetch={false} href="/resources"><span className={styles.eyebrow}>03 / 工具与资料</span><h2>找工具、灵感和入门教程 <span aria-hidden="true">↗</span></h2><p>从开发工具、设计案例到 AI 技能，按当前需要找资料，收藏后继续使用。</p></Link>
      <Link prefetch={false} href="/journey"><span className={styles.eyebrow}>第一次参赛</span><h2>整场比赛，一张路线图 <span aria-hidden="true">↗</span></h2><p>沿着赛前、赛中、赛后的树枝，找到要做的事、注意事项和对应工具资料。</p></Link>
    </section>
    <section className={styles.closing}><p className={styles.eyebrow}>一起把比赛办好</p><h2>主办方与选手，<br />进入同一场比赛。</h2><p>主办方发布比赛、管理报名和评审。选手从对应赛事进入，查看通知、组队并提交作品。</p><div className={styles.actions}><Link prefetch={false} className={styles.secondary} href="/competitions">查看本站正式赛事</Link><Link prefetch={false} className={styles.secondary} href="/organizers">主办方入驻</Link></div></section>
    <section className={styles.closing}><p className={styles.eyebrow}>从这次，到下一次</p><h2>作品留下来，<br />经验也留下来。</h2><p>保存代码，检查作品能否演示，再记录向主办方的提交结果。赛后总结做得好和需要改进的地方。</p><Link prefetch={false} className={styles.secondary} href="/app">打开我的参赛 <span aria-hidden="true">→</span></Link></section>
  </SiteShell>;
}
