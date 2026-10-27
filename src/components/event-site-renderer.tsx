import { Fragment } from "react";
import type { ReactNode } from "react";
import type {
  EventSiteActionBlock, EventSiteActionTarget, EventSiteBlock, EventSiteBlockNode,
  EventSiteBindingField, EventSiteImageRef, EventSitePageLayout, EventSitePageSpec,
} from "../modules/event-site/index.ts";
import styles from "./event-site-renderer.module.css";

/** 事实绑定值的只读视图；缺失一律 null，界面**留空、不编造**（规划 35 §4/§13）。 */
export interface EventSiteFactsView {
  readonly registrationCloses: string | null;
  readonly submissionCloses: string | null;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly scheduleNodes: readonly { readonly id: string; readonly title: string; readonly startsAt: string | null }[];
  readonly faqEntries: readonly { readonly id: string; readonly question: string; readonly answer: string }[];
}

export interface EventSiteRendererViewProps {
  readonly spec: EventSitePageSpec;
  readonly layout: EventSitePageLayout;
  readonly facts: EventSiteFactsView;
  readonly actionHref: (target: EventSiteActionTarget) => string;
  readonly assetUrl?: (assetId: string) => string | null;
  readonly eventTitle: string;
  readonly organizerName: string;
  readonly canonicalHref: string;
  readonly publishedAt: string | null;
  /** 编辑器预览用：强制显示桌面或手机那一棵；公开页不传（按真实视口切换）。 */
  readonly mode?: "auto" | "desktop" | "mobile";
  /** 编辑器用：把每个区块交给调用方包一层（选中/悬浮工具/就地编辑）；公开页不传。 */
  readonly editable?: { readonly render: (blockId: string, node: EventSiteBlockNode, body: ReactNode) => ReactNode };
}

const actionLabels: Record<EventSiteActionTarget, string> = {
  register: "立即报名",
  submit: "提交作品",
  results: "查看结果",
  appeal: "提交申诉",
};

const aspectClass: Record<EventSiteImageRef["aspect"], string> = {
  "16:9": styles.aspect169,
  "4:3": styles.aspect43,
  "1:1": styles.aspect11,
  "3:4": styles.aspect34,
};

function isAction(node: EventSiteBlockNode): node is EventSiteActionBlock {
  return node.kind.startsWith("action");
}
function isContainer(node: EventSiteBlockNode): boolean {
  return node.kind === "aiBlock";
}
function factValue(facts: EventSiteFactsView, field: EventSiteBindingField): string | null {
  if (field === "registrationCloses") return facts.registrationCloses;
  if (field === "submissionCloses") return facts.submissionCloses;
  if (field === "startsAt") return facts.startsAt;
  if (field === "endsAt") return facts.endsAt;
  return null;
}

/**
 * 专属页渲染器（规划 35 §4/§7）。
 *
 * 只吃「语义层 + 派生的布局层 + 只读事实」：
 * - 文案是**纯文本节点**，永不使用 dangerouslySetInnerHTML；
 * - 事实类区块只能从 `binding.field` 取值，取不到就留空，绝不编造；
 * - 行动跳板只渲染平台固定目标的链接，不接受外部 href；
 * - 桌面用 12 列栅格、手机单列；折叠只有一层（`<details>`，无 JS）。
 */
export function EventSiteRenderer(props: EventSiteRendererViewProps) {
  const byId = new Map<string, EventSiteBlockNode>();
  for (const node of props.spec.blocks) byId.set(node.id, node);
  const mobileById = new Map(props.layout.mobile.entries.map(entry => [entry.blockId, entry]));
  const groupById = new Map(props.layout.mobile.collapseGroups.map(group => [group.id, group]));

  function renderBody(node: EventSiteBlockNode) {
    if (isContainer(node)) return null;
    if (isAction(node)) {
      const cls = node.variant === "banner" ? `${styles.action} ${styles.actionBanner}`
        : node.variant === "inline" ? `${styles.action} ${styles.actionInline}` : styles.action;
      return <p><a className={cls} href={props.actionHref(node.action)}>{actionLabels[node.action]}</a></p>;
    }
    const block = node as EventSiteBlock;
    const heading = block.heading ? <h2 className={styles.heading}>{block.heading}</h2> : null;
    const text = block.text ? <p className={styles.text}>{block.text}</p> : null;
    const items = block.items.length > 0 ? (
      <ul className={`${styles.items} ${block.variant === "grid" || block.variant === "logoGrid" || block.variant === "logoRow" ? styles.itemsGrid : ""}`}>
        {block.items.map((item, index) => (
          <li className={styles.item} key={`${block.id}-${index}`}>
            {item.image ? renderImage(item.image) : null}
            <h3 className={styles.itemHeading}>{item.heading}</h3>
            {item.text ? <p className={styles.text}>{item.text}</p> : null}
          </li>
        ))}
      </ul>) : null;
    const image = block.image ? renderImage(block.image) : null;
    const fact = renderFact(block);
    if (!heading && !text && !items && !image && !fact) return null;
    return <>{heading}{text}{image}{items}{fact}</>;
  }

  function renderImage(image: EventSiteImageRef) {
    const url = props.assetUrl?.(image.assetId) ?? null;
    // 资产地址解析不到时不渲染破图（不编造 URL）。
    if (!url) return null;
    return <img className={`${styles.media} ${aspectClass[image.aspect]}`} src={url} alt={image.alt} loading="lazy" decoding="async" />;
  }

  function renderFact(block: EventSiteBlock) {
    const binding = block.binding;
    if (!binding) return null;
    if (binding.field === "scheduleNodes") {
      if (props.facts.scheduleNodes.length === 0) return null;
      return <ul className={styles.items}>{props.facts.scheduleNodes.map(node => (
        <li className={styles.item} key={node.id}>
          <h3 className={styles.itemHeading}>{node.title}</h3>
          {node.startsAt ? <p className={styles.muted}><time dateTime={node.startsAt}>{node.startsAt}</time></p> : null}
        </li>
      ))}</ul>;
    }
    if (binding.field === "faqEntries") {
      if (props.facts.faqEntries.length === 0) return null;
      return <div className={styles.items}>{props.facts.faqEntries.map(entry => (
        <details className={styles.collapse} key={entry.id}>
          <summary>{entry.question}</summary>
          <p className={styles.text}>{entry.answer}</p>
        </details>
      ))}</div>;
    }
    const value = factValue(props.facts, binding.field);
    // 事实缺失：留空，不写「待定」之类的话（避免被当成平台结论）。
    if (!value) return null;
    return <p className={styles.text}><time dateTime={value}>{value}</time></p>;
  }

  function renderDesktop() {
    return (
      <div className={styles.desktop}>
        {props.layout.grid.rows.map(row => (
          <Fragment key={row.index}>{row.cells.map(cell => {
            const node = byId.get(cell.blockId);
            if (!node) return null;
            const span = `span${cell.span}` as keyof typeof styles;
            return <div className={styles[span]} key={cell.blockId}>
              {props.editable ? props.editable.render(cell.blockId, node, renderBody(node)) : <div data-block-id={cell.blockId}>{renderBody(node)}</div>}
            </div>;
          })}</Fragment>
        ))}
      </div>);
  }

  function renderMobile() {
    const rendered: ReactNode[] = [];
    const foldedDone = new Set<string>();
    for (const entry of props.layout.mobile.entries) {
      const node = byId.get(entry.blockId);
      if (!node) continue;
      if (entry.groupId) {
        if (foldedDone.has(entry.groupId)) continue;
        foldedDone.add(entry.groupId);
        const group = groupById.get(entry.groupId);
        if (!group) continue;
        rendered.push(
          <details className={styles.collapse} key={entry.groupId}>
            <summary>展开更多（{group.blockIds.length} 项）</summary>
            {group.blockIds.map(id => {
              const inner = byId.get(id);
              return inner ? (props.editable
                ? <div key={id}>{props.editable.render(id, inner, renderBody(inner))}</div>
                : <div key={id} data-block-id={id}>{renderBody(inner)}</div>) : null;
            })}
          </details>);
        continue;
      }
      rendered.push(props.editable
        ? <div key={entry.blockId}>{props.editable.render(entry.blockId, node, renderBody(node))}</div>
        : <div key={entry.blockId} data-block-id={entry.blockId}>{renderBody(node)}</div>);
    }
    return <div className={styles.mobile}>{rendered}</div>;
  }

  return (
    <div className={`${styles.wrap} skin-${props.spec.skin ?? "classic"} ${props.mode === "desktop" ? styles.forceDesktop : props.mode === "mobile" ? styles.forceMobile : ""}`}>
      <header className={styles.siteHeader}>
        <strong>{props.eventTitle}</strong>
        {props.organizerName ? <span> · {props.organizerName}</span> : null}
      </header>
      {renderDesktop()}
      {renderMobile()}
      <footer className={styles.footer}>
        <p>本页由主办方配置，正式信息以 <a className={styles.footerLink} href={props.canonicalHref}>平台赛事页</a> 为准。</p>
        <p>由 草根黑客松情报局 提供{props.publishedAt ? ` · 发布于 ${props.publishedAt}` : ""}</p>
      </footer>
    </div>);
}
