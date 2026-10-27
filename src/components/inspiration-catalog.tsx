"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { InspirationCandidate, InspirationCatalogStatus, InspirationCategory, InspirationItem } from "../server/inspiration-catalog.ts";
import { safeLink, dateText as formatInstant } from "./client-api.ts";
import { Empty, Field, PageTitle } from "./site-shell.tsx";
import styles from "./site.module.css";
import catalogStyles from "./inspiration-catalog.module.css";

const categories: { value: InspirationCategory; label: string; symbol: string; hint: string }[] = [
  { value: "visual", label: "视觉参考", symbol: "◫", hint: "先确定颜色、字体与界面方向" },
  { value: "websites", label: "网页案例", symbol: "▤", hint: "参考整站布局与内容组织" },
  { value: "components", label: "组件代码", symbol: "〈〉", hint: "挑能接入项目的界面组件" },
  { value: "motion", label: "动效", symbol: "↝", hint: "为交互与展示补上必要动效" },
];
const contentLabels = { reference: "设计与案例参考", code: "提供实现代码", asset: "动画素材与工具" };
const dateText = (value: string) => value.includes("T") ? formatInstant(value) : value;

export interface InspirationCatalogProps { items: readonly InspirationItem[]; pendingItems?: readonly InspirationCandidate[]; status: InspirationCatalogStatus }
export function InspirationCatalog({ items, pendingItems = [], status }: InspirationCatalogProps) {
  const router = useRouter(), pathname = usePathname(), params = useSearchParams();
  const query = params.get("q") ?? "";
  const category = categories.some(value => value.value === params.get("category")) ? params.get("category")! : "";
  const [search, setSearch] = useState(query);
  useEffect(() => { setSearch(query); }, [query]);
  const visibleItems = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    const analyzedIds = new Set(items.map(item => item.id));
    const combined: { item: InspirationCandidate; analysis: InspirationItem | null }[] = [
      ...items.map(item => ({ item, analysis: item })), ...pendingItems.filter(item => !analyzedIds.has(item.id)).map(item => ({ item, analysis: null })),
    ];
    return combined.filter(({ item, analysis }) => (!category || item.category === category) && (!term || [item.name, analysis?.description ?? "", analysis?.useWhen ?? "", ...item.tags].join(" ").toLocaleLowerCase().includes(term)));
  }, [items, pendingItems, category, query]);
  function setFilters(next: { q?: string; category?: string }) {
    const updated = new URLSearchParams(params.toString());
    const nextQuery = (next.q ?? query).trim(), nextCategory = next.category ?? category;
    if (nextQuery) updated.set("q", nextQuery); else updated.delete("q");
    if (nextCategory) updated.set("category", nextCategory); else updated.delete("category");
    router.replace(`${pathname}${updated.size ? `?${updated}` : ""}`, { scroll: false });
  }
  function clearFilters() { setSearch(""); setFilters({ q: "", category: "" }); }
  return <>
    <PageTitle eyebrow="INSPIRATION DESK" title="灵感库">先找到想要的感觉，再挑适合项目的组件。这里集中视觉参考、网页案例、组件代码和动效的官网入口。</PageTitle>
    <section className={catalogStyles.orientation} aria-label="选择灵感方向">
      {categories.map(value => <button type="button" key={value.value} className={`${catalogStyles.direction} ${category === value.value ? catalogStyles.selected : ""}`} aria-pressed={category === value.value} onClick={() => setFilters({ category: value.value })}>
        <span className={catalogStyles.symbol} aria-hidden="true">{value.symbol}</span><strong>{value.label}</strong><span>{value.hint}</span>
      </button>)}
    </section>
    <section className={styles.panel} aria-label="灵感目录">
      <div className={catalogStyles.catalogHeading}><h2>从这里开始找</h2><p className={styles.muted} role="status">{status.message}{status.updatedAt ? ` · ${status.kind === "curated" ? "核查于" : "更新于"} ${dateText(status.updatedAt)}` : ""}</p></div>
      <form className={catalogStyles.filters} onSubmit={event => { event.preventDefault(); setFilters({ q: search }); }}>
        <Field label="搜索灵感网站" hint="搜索名称或用途，例如：React、配色、落地页。"><input type="search" value={search} maxLength={100} onChange={event => setSearch(event.target.value)} placeholder="你现在想做什么？"/></Field>
        <Field label="灵感分类"><select value={category} onChange={event => setFilters({ category: event.target.value })}><option value="">全部分类</option>{categories.map(value => <option key={value.value} value={value.value}>{value.label}</option>)}</select></Field>
        <div className={catalogStyles.filterActions}><button className={styles.button} type="submit">搜索</button>{(query || category) && <button className={styles.secondary} type="button" onClick={clearFilters}>清除筛选</button>}</div>
      </form>
      <p className={catalogStyles.resultCount} role="status">找到 {visibleItems.length} 个官网入口 · {visibleItems.filter(item => item.analysis).length} 个已有分析{query ? ` · 关键词「${query}」` : ""}</p>
      {visibleItems.length === 0 && <Empty>没有找到匹配的灵感网站。换个关键词，或清除筛选查看全部目录。<div className={styles.actions}><button className={styles.secondary} onClick={clearFilters}>查看全部灵感</button></div></Empty>}
      <div className={catalogStyles.grid}>{visibleItems.map(({ item, analysis }) => {
        const kind = categories.find(value => value.value === item.category)!;
        const officialUrl = safeLink(item.url);
        return <article key={item.id} className={catalogStyles.card}>
          <div className={catalogStyles.cardTop}><span className={catalogStyles.cardSymbol} aria-hidden="true">{kind.symbol}</span><span className={styles.tag}>{kind.label}</span></div>
          <h3>{item.name}</h3>{analysis ? <><span className={catalogStyles.contentType}>{contentLabels[item.contentType]}</span>
            <p className={catalogStyles.analysisBadge}>{status.kind === "dsh" ? "DSH 分析 · 未人工核验" : "编辑说明"}</p>
            <p>{analysis.description}</p><p><strong>什么时候用：</strong>{analysis.useWhen}</p>
            <div className={catalogStyles.tags} aria-label={`${item.name} 标签`}>{item.tags.map(tag => <span key={tag}>{tag}</span>)}</div>
            <p className={catalogStyles.usageNote}>{analysis.usageNote}</p>
            <details className={catalogStyles.evidence}><summary className={styles.summary}>查看分析依据</summary><p>{status.kind === "dsh" ? "DSH 分析于" : "官网核查于"} {dateText(analysis.checkedAt)}</p>{analysis.evidenceUrls.map(url => safeLink(url) && <a key={url} className={styles.link} href={safeLink(url)!} target="_blank" rel="noopener noreferrer">{new URL(url).hostname}（官网依据，新窗口）</a>)}</details>
          </> : <p className={catalogStyles.pending}>等待 DSH 分析</p>}
          {officialUrl && <a className={`${styles.button} ${catalogStyles.outbound}`} href={officialUrl} target="_blank" rel="noopener noreferrer" aria-label={`打开 ${item.name} 官网（新窗口）`}>打开官网 <span aria-hidden="true">↗</span><span className={catalogStyles.newWindow}>新窗口</span></a>}
        </article>;
      })}</div>
    </section>
  </>;
}
