"use client";

import Link from "next/link";
import { useApi } from "./client-api.ts";
import { Feedback, Loading, PageTitle, SiteShell } from "./site-shell.tsx";
import type { ProjectDetail } from "./projects-client.tsx";
import { presentationHref, usePresentationProjectId } from "./presentation-workflow.tsx";
import styles from "./site.module.css";

type GuideStep = {
  number: string;
  title: string;
  summary: string;
  details: string[];
};

const steps: GuideStep[] = [
  {
    number: "01",
    title: "注册 GitHub 账号",
    summary: "先在 GitHub 官方网站注册并完成邮箱验证。",
    details: [
      "打开 GitHub 官方注册页，使用自己的邮箱创建账号；用户名会成为公开主页和仓库地址的一部分。",
      "完成邮箱验证并开启双因素认证。不要把密码、验证码或 Personal Access Token 发给本站或队友。",
      "已有账号可以直接跳到下一步。本站登录与 GitHub 登录是两套身份，互不替代。",
    ],
  },
  {
    number: "02",
    title: "登录并连接本站",
    summary: "登录本站后，再单独授权 GitHub App，服务端只保存加密后的授权凭据。",
    details: [
      "在本站登录后进入‘我的参赛 → 当前团队空间 → 代码与提交’，点击‘前往 GitHub 完成本人授权’。",
      "授权页会显示本站 App 请求的权限；只同意你愿意授予的账号和范围。授权成功后回到本站刷新状态。",
      "授权失败、过期或撤销时，本站会要求重新连接，不会把失败显示成已绑定。",
    ],
  },
  {
    number: "03",
    title: "新建或选择仓库",
    summary: "可以在项目交付页预览并确认建仓，也可以从已授权范围选择已有仓库。",
    details: [
      "已有仓库：先安装或调整本站 GitHub App 的仓库范围，再从 GitHub 返回的真实列表中选择；本站会再次检查账号、安装和写权限。",
      "新仓库：填写名称、可见性和说明后先生成预览，确认名称与账号无误才会发起创建。创建结果未知时只核对结果，不重复创建。",
      "空仓库需要先有初始化分支。若当前权限或 App 未配置，页面会明确提示并提供 GitHub 官方操作路径。",
    ],
  },
  {
    number: "04",
    title: "读取基版本与准备代码",
    summary: "本站能读取远端基版本用于差异预览，也能取回本人保存的草稿。",
    details: [
      "绑定仓库后，点击‘读取 GitHub 基版本并预览’，本站会读取当前分支和文件树，作为本次保存的基线。",
      "网页端读取基版本是一次只读核对，取回草稿只恢复本人保存在本站的输入。需要完整本地工作区时，按 GitHub 官方 Clone 说明操作。",
      "队友更新了目标分支后，旧预览不能直接覆盖共享成果；请重新读取基版本或改用独立分支。",
    ],
  },
  {
    number: "05",
    title: "先预览，再保存代码版本",
    summary: "输入文件变更和提交说明，先预览差异，再确认一次性保存。",
    details: [
      "目前网页端首版支持普通 UTF-8 文本文件；会拒绝不安全路径，并提示疑似密钥或受限文件。",
      "预览会显示新增、修改、删除和基版本。确认后服务端创建一次 commit，并默认保存到独立分支；不会强推或静默覆盖主分支。",
      "保存结果会显示真实分支、commit SHA 和 GitHub 链接。网络超时显示‘结果未知’，先核对远端再决定下一步。",
    ],
  },
  {
    number: "06",
    title: "请队友审查，再检查运行与赛事提交",
    summary: "可继续或核对 PR；运行验收、赛事提交和代码保存分别记录。",
    details: [
      "保存成功后，可选择创建或核对 PR。PR 创建成功不等于已合并，仍需有权限的成员在 GitHub 审核和合并。",
      "在交付页填写真实运行验收步骤，并单独记录赛事官方提交链接和提交声明；本站不会把 commit 当成比赛提交成功。",
      "截止时间临近时优先打开赛事官方入口，确认目标分支、材料和最终提交状态。",
    ],
  },
];

const officialLinks = [
  ["注册 GitHub", "https://github.com/signup", "创建账号、验证邮箱并开启双因素认证。"],
  ["GitHub 入门文档", "https://docs.github.com/zh/get-started/start-your-journey", "官方账号、仓库、分支和协作入门。"],
  ["Clone 官方说明", "https://docs.github.com/zh/repositories/creating-and-managing-repositories/cloning-a-repository", "需要本地完整工作区时，按官方说明拉取仓库。"],
  ["Pull Request 说明", "https://docs.github.com/zh/pull-requests/collaborating-with-pull-requests", "了解 PR 审核、讨论和合并。"],
] as const;

export function GitHubGuide({ projectId: suppliedProjectId }: { projectId?: string } = {}) {
  const projectId = usePresentationProjectId(suppliedProjectId);
  const project = useApi<ProjectDetail>(projectId ? `/projects/${encodeURIComponent(projectId)}` : null);
  const currentProject = project.data?.project.id === projectId ? project.data : null;
  const deliveryHref = currentProject ? presentationHref("delivery", currentProject.project.id) : "/app";
  const guideHref = projectId ? `/github?projectId=${encodeURIComponent(projectId)}` : "/github";
  return <SiteShell>
    <PageTitle eyebrow="GITHUB WORKFLOW" title="从注册到交付，一页学会 GitHub">
      学会连接账号、选择仓库和保存版本，再分别核对作品运行与主办方提交。实际操作在当前团队空间的“代码与提交”中完成。
    </PageTitle>

    <section className={styles.panel} aria-labelledby="quick-start-title">
      <div className={styles.titleRow}><div><p className={styles.eyebrow}>ONE-STOP START</p><h2 id="quick-start-title">边看教程，边完成当前空间的交付</h2></div><span className={styles.tag}>本站登录 → 账号授权 → 仓库权限</span></div>
      <p className={styles.muted}>本站账号和 GitHub 账号分开管理。没有完成真实 GitHub App 配置时，页面会保留教程和历史记录，但不会伪造授权、建仓或提交成功。</p>
      {projectId && project.loading && <Loading/>}
      <Feedback error={project.error}/>
      {currentProject && <p><span className={styles.tag}>当前团队空间</span><strong>{currentProject.project.name}</strong>{currentProject.project.stage === "archived" && <span className={styles.tag}>已归档 · 记录只读</span>}</p>}
      {projectId && !project.loading && !currentProject && <p className={styles.notice}>暂时无法读取这个团队空间，请登录后重新打开空间。教程仍可阅读。</p>}
      <div className={styles.actions}>
        <Link className={styles.button} href={deliveryHref}>{currentProject ? "在当前空间查看代码与提交" : "选择我的团队空间"}</Link>
        <Link className={styles.secondary} href={currentProject ? `${deliveryHref}#github-authorization` : "/app/account"}>连接 GitHub 账号</Link>
        <Link className={styles.secondary} href={`/login?returnTo=${encodeURIComponent(guideHref)}`}>登录本站后回到本教程</Link>
      </div>
      {currentProject && <nav className={styles.actions} aria-label="当前团队空间交付操作"><Link className={styles.link} href={`/app/projects/${encodeURIComponent(currentProject.project.id)}`}>返回团队空间 →</Link><Link className={styles.link} href={`${deliveryHref}#repository-save`}>保存代码版本 →</Link><Link className={styles.link} href={`${deliveryHref}#delivery-verification`}>记录实际运行 →</Link><Link className={styles.link} href={`${deliveryHref}#official-submission`}>核对正式提交 →</Link></nav>}
    </section>

    <section className={styles.panel} aria-labelledby="flow-title">
      <p className={styles.eyebrow}>STEP BY STEP</p>
      <h2 id="flow-title">完整流程</h2>
      <div className={styles.cards}>
        {steps.map(step => <details className={styles.card} key={step.number}>
          <summary className={styles.summary}><span className={styles.tag}>{step.number}</span><strong>{step.title}</strong><span aria-hidden="true">＋</span></summary>
          <p>{step.summary}</p>
          <ol>{step.details.map(detail => <li key={detail}>{detail}</li>)}</ol>
        </details>)}
      </div>
    </section>

    <section className={styles.panel} aria-labelledby="branch-title">
      <p className={styles.eyebrow}>SEE THE GRAPH</p>
      <h2 id="branch-title">分支、拉取与提交，一张图看懂</h2>
      <p className={styles.muted}>这是团队协作示意图：从主分支开始，在独立分支保存改动，发起 PR 请队友审查。合并由 GitHub 上有权限的成员完成。</p>
      <figure className={styles.branchDiagram} aria-labelledby="branch-caption">
        <div className={styles.branchLane}>
          <span className={styles.branchLabel}>main · 稳定版本</span>
          <div className={styles.branchTrack}>
            <span className={`${styles.branchDot} ${styles.branchDotMain}`} aria-label="主分支起点">1</span>
            <span className={`${styles.branchDot} ${styles.branchDotMain}`} aria-label="主分支已合并版本">3</span>
            <span className={`${styles.branchDot} ${styles.branchDotMain}`} aria-label="主分支最新版本">5</span>
          </div>
        </div>
        <div className={styles.branchFork} aria-hidden="true"><span>读取基版本，创建工作分支 ↓</span><i /></div>
        <div className={styles.branchLane}>
          <span className={styles.branchLabel}>feature/你的任务 · 独立工作</span>
          <div className={styles.branchTrack}>
            <span className={`${styles.branchDot} ${styles.branchDotWork}`} aria-label="工作分支创建">2</span>
            <span className={`${styles.branchDot} ${styles.branchDotWork}`} aria-label="工作分支提交">4</span>
          </div>
        </div>
        <div className={styles.branchMerge} aria-hidden="true"><i /><span>预览差异 → PR → 审核后合并</span></div>
        <figcaption id="branch-caption" className={styles.branchCaption}>本站先读取基版本并预览差异，再把确认后的代码保存到独立分支；PR 和合并是后续步骤。</figcaption>
      </figure>
      <div className={styles.grid}>
        <article className={styles.branchCallout}>
          <strong>读取基版本有什么用？</strong>
          <p>先知道仓库里现在有哪些内容，再对比你准备新增、修改或删除的文件。本站这一步只读远端，不会改动文件。取回本人草稿与 Git 的 Pull 命令是不同动作。</p>
        </article>
        <article className={styles.branchCallout}>
          <strong>什么时候提交（Commit）？</strong>
          <p>完成一小块可说明的改动就提交一次，说明“改了什么、为什么改”。提交只是保存版本，PR 审核并合并后才会进入主分支。</p>
        </article>
      </div>
      <div className={styles.notice}><strong>遇到冲突：</strong>先保留当前草稿 → 重新读取基版本 → 对比冲突文件 → 在独立分支修复 → 再预览差异。需要在本地处理时，按官方 Clone 与分支协作说明操作。</div>
    </section>

    <section className={styles.grid} aria-label="本站可以做什么">
      <article className={styles.panel}>
        <p className={styles.eyebrow}>IN THIS SITE</p>
        <h2>本站可执行范围</h2>
        <ul className={styles.list}>
          <li><strong>授权与仓库范围</strong><br/><span className={styles.muted}>跳转官方授权、安装 App、读取真实仓库列表并绑定项目。</span></li>
          <li><strong>建仓与保存</strong><br/><span className={styles.muted}>建仓先预览再确认；文件差异先预览，随后创建独立分支和 commit。</span></li>
          <li><strong>恢复与核对</strong><br/><span className={styles.muted}>读取远端基版本、取回本人草稿、核对未知结果和 PR 状态。</span></li>
          <li><strong>交付记录</strong><br/><span className={styles.muted}>分开记录仓库保存、运行验收和赛事正式提交，不混淆状态。</span></li>
        </ul>
        <p className={styles.notice}>本站不会替你保管密码或验证码，不会强推、自动合并、绕过分支保护，也不会把“保存成功”包装成“比赛提交成功”。</p>
      </article>
      <article className={styles.panel}>
        <p className={styles.eyebrow}>WHEN SOMETHING GOES WRONG</p>
        <h2>遇到问题怎么办</h2>
        <ul className={styles.list}>
          <li><strong>授权失败</strong><br/><span className={styles.muted}>检查 GitHub App 是否已安装到目标仓库，回到项目页刷新；不要重复提交授权码。</span></li>
          <li><strong>权限不足</strong><br/><span className={styles.muted}>让仓库管理员调整 App 范围或换一个有写权限的仓库，本站不会自行申请更高权限。</span></li>
          <li><strong>保存结果未知</strong><br/><span className={styles.muted}>先点击“仅核对未知保存结果”，确认远端分支和 commit 后再继续。</span></li>
          <li><strong>冲突或分支保护</strong><br/><span className={styles.muted}>保留草稿，重新读取基版本，或让有权限的成员按 GitHub 官方流程处理。</span></li>
        </ul>
      </article>
    </section>

    <section className={styles.panel} aria-labelledby="official-title">
      <p className={styles.eyebrow}>OFFICIAL REFERENCES</p>
      <h2 id="official-title">官方资料</h2>
      <div className={styles.cards}>
        {officialLinks.map(([title, url, description]) => <a className={styles.card} key={url} href={url} target="_blank" rel="noopener noreferrer"><h3>{title} <span aria-hidden="true">↗</span></h3><p>{description}</p><span className={styles.link}>在新窗口打开</span></a>)}
      </div>
    </section>

    <p className={styles.muted}>建议顺序：先注册并登录 GitHub → 在本站连接账号 → 选择或创建仓库 → 在项目交付页预览并保存 → 运行验收 → 打开赛事官方提交入口。</p>
  </SiteShell>;
}
