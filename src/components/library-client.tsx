"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { readTutorialFilters, tutorialDirectoryHref, tutorialFilterQuery, tutorialLink, type TutorialFilters } from "../modules/resources/tutorial-links.ts";
import { dateText, useApi } from "./client-api.ts";
import { Empty, Feedback, Field, Loading, PageTitle, SiteShell } from "./site-shell.tsx";
import styles from "./site.module.css";
interface LibraryArticle { slug: string; title: string; category: string; summary: string; body: string[]; steps: string[]; links: { title: string; url: string }[]; updatedAt: string }
const githubArticles = new Set(["github-first-repository", "github-team-workflow"]);
export function LibraryClient({ slug }: { slug?: string }) {
  return <SiteShell><Suspense fallback={<Loading/>}><LibraryContent slug={slug}/></Suspense></SiteShell>;
}
function LibraryContent({ slug }: { slug?: string }) {
  const params = useSearchParams(), router = useRouter();
  const applied = readTutorialFilters(params), query = tutorialFilterQuery(applied);
  const [category, setCategory] = useState(applied.category), [keyword, setKeyword] = useState(applied.query);
  const list = useApi<{ items: LibraryArticle[]; categories: string[] }>(slug ? null : `/library${query ? `?${query}` : ""}`);
  const detail = useApi<LibraryArticle>(slug ? `/library/${encodeURIComponent(slug)}` : null);
  useEffect(() => { const next = readTutorialFilters(new URLSearchParams(query)); setCategory(next.category); setKeyword(next.query); }, [query]);
  const directoryHref = tutorialDirectoryHref(applied);
  const articleHref = (articleSlug: string) => `/library/${encodeURIComponent(articleSlug)}${query ? `?${query}` : ""}`;
  const draftChanged = tutorialFilterQuery({ category, query: keyword }) !== query;
  function apply(filters: TutorialFilters) { router.push(tutorialDirectoryHref(filters), { scroll: false }); }
  function clear() { setCategory(""); setKeyword(""); apply({ category: "", query: "" }); }
  const isGithubArticle = Boolean(detail.data && githubArticles.has(detail.data.slug));
  return <><PageTitle title={detail.data?.title ?? (slug ? "读取教程" : "新手教程")}>看懂操作，再开始做。GitHub 的完整教程集中在 GitHub 教程页。</PageTitle>
    <p className={styles.muted}>内容来源：本站原创入门说明。外部参考打开原网站；工具与资料的人工审核、灵感的 DSH 官网分析各自保留状态。</p>
    {slug && <p><Link className={styles.link} href={directoryHref}>← 返回新手教程{query ? "，保留筛选" : ""}</Link></p>}
    <Feedback error={list.error ?? detail.error}/>
    {(list.loading || detail.loading) && <Loading/>}
    {!slug && <><form className={styles.row} onSubmit={event => { event.preventDefault(); apply({ category, query: keyword }); }}>
      <Field label="想了解哪一类"><select value={category} onChange={event => setCategory(event.target.value)}><option value="">全部教程</option>{category && !list.data?.categories.includes(category) && <option value={category}>{category}</option>}{list.data?.categories.map(value => <option key={value} value={value}>{value}</option>)}</select></Field>
      <Field label="搜索想完成的事"><input value={keyword} onChange={event => setKeyword(event.target.value)} maxLength={100} placeholder="第一次参赛、提交、技能等"/></Field>
      <button className={styles.secondary}>查找教程</button><button className={styles.secondary} type="button" onClick={clear} disabled={!query && !draftChanged}>清除筛选</button>
    </form>{draftChanged && <p className={styles.muted}>点击“查找教程”应用新条件；当前结果与详情保留上次筛选。</p>}
    <div className={styles.cards}>{list.data?.items.map(article => <article className={styles.card} key={article.slug}>
      <span className={styles.tag}>{article.category}</span><h2><Link className={styles.link} href={githubArticles.has(article.slug) ? "/github" : articleHref(article.slug)}>{article.title}</Link></h2><p>{article.summary}</p>
      {githubArticles.has(article.slug) ? <div className={styles.actions}><Link className={styles.link} href="/github">打开 GitHub 教程</Link><Link className={styles.link} href={articleHref(article.slug)}>查看入门摘要</Link></div> : <Link className={styles.link} href={articleHref(article.slug)}>阅读步骤</Link>}
    </article>)}</div>
    {!list.loading && !list.error && list.data?.items.length === 0 && <Empty><p>{query ? "没有符合条件的教程。可以换个关键词，或清除筛选浏览全部。" : "教程正在整理中。可以先找比赛，或打开工具与资料。"}</p><div className={styles.actions}>{query && <button type="button" className={styles.secondary} onClick={clear}>清除筛选，浏览全部教程</button>}<Link className={styles.link} href="/resources">工具与资料</Link><Link className={styles.link} href="/events">找比赛</Link></div></Empty>}</>}
    {detail.data && <article className={styles.panel}>
      <p className={styles.lead}>{detail.data.summary}</p>
      {isGithubArticle ? <><p>仓库、分支、保存和团队协作的主要步骤集中在 GitHub 教程；实际仓库操作在自己的项目内继续。</p><p><Link className={styles.button} href="/github">打开 GitHub 教程</Link></p><details><summary className={styles.summary}>补充阅读：本站原创入门说明</summary><ArticleBody article={detail.data}/></details></> : <ArticleBody article={detail.data}/>}
      <h2>接下来可以做</h2>
      <ul className={styles.list}>{detail.data.links.map(link => { const safe = tutorialLink(link.url); return safe ? <li key={link.url}>{safe.external ? <a className={styles.link} href={safe.href} target="_blank" rel="noopener noreferrer">{link.title}（新窗口）</a> : <Link className={styles.link} href={safe.href}>{link.title}</Link>}</li> : <li key={link.url}><span>{link.title}</span><small className={styles.muted}>此链接暂不可打开，请从教程目录选择下一步。</small></li>; })}</ul>
      <p className={styles.muted}>更新于 {dateText(detail.data.updatedAt)}</p>
      <Link className={styles.link} href={directoryHref}>← 返回新手教程{query ? "，保留筛选" : ""}</Link>
    </article>}
  </>;
}
function ArticleBody({ article }: { article: LibraryArticle }) {
  return <>{article.body.map((paragraph, index) => <p key={index}>{paragraph}</p>)}{article.steps.length > 0 && <><h2>按步骤开始</h2><ol>{article.steps.map((step, index) => <li key={index}>{step}</li>)}</ol></>}</>;
}
