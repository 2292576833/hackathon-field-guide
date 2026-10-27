"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import type { LifecycleInput } from "../modules/space-workflow/model.ts";
import { buildSpaceGuideTree, type SpaceGuideStepId, type SpaceGuideNode } from "../modules/space-workflow/guide-tree.ts";
import styles from "./space-guide-tree.module.css";

/**
 * 详细指南树：保留为"完整教程"，位于空间内的深层折叠中。
 *
 * 首屏的"流程主线"已由 `SpacePathCanvas` 承担（可拖动方框、点方框弹出组件），
 * 因此这里**不再**承担首屏主线职责，也不重复提供就地展开入口，避免同一屏出现两套六步。
 * 本组件只做只读浏览：节点里的入口仍是跳转到对应完整页面。
 */
export interface SpaceGuideTreeProps { readonly input: LifecycleInput }
export function SpaceGuideTree({ input }: SpaceGuideTreeProps) {
  const view = buildSpaceGuideTree(input);
  const context = `${input.detail.project.id}:${input.detail.membership.userId}`;
  const [expanded, setExpanded] = useState<SpaceGuideStepId | null>(view.currentStepId);
  const manuallyBrowsed = useRef(false);
  const prefix = useId();
  useEffect(() => { manuallyBrowsed.current = false; setExpanded(view.currentStepId); }, [context]);
  useEffect(() => { if (!manuallyBrowsed.current) setExpanded(view.currentStepId); }, [view.currentStepId]);

  return <section className={styles.guide} aria-label="团队空间指引树">
    <header className={styles.header}>
      <p className={styles.eyebrow}>第一次进入空间，从这里看懂整套流程</p>
      <h2>团队空间指引树</h2>
      <p className={styles.description}>按顺序了解六段行动，点击标题展开。每段都告诉你：何时做、怎么做、怎样核对、下一步去哪。实际任务可以按依赖并行。</p>
    </header>
    <div className={styles.next}>
      <strong>建议先做</strong>
      <p>{view.next.purpose}</p>
      <Link className={styles.primary} href={view.next.href}>{view.next.title} →</Link>
      {view.solo && <p className={styles.solo}>一个人也能继续：邀请队友可选，你可以自己选职责、确认时间、完成任务与自检。</p>}
    </div>
    <p className={styles.notice}>{view.notice}</p>
    <ol className={styles.tree}>
      {view.steps.map((step, index) => <li className={styles.branch} key={step.id}>
        <details className={styles.step} open={expanded === step.id}>
          <summary className={styles.summary} onClick={event => {
            event.preventDefault(); manuallyBrowsed.current = true;
            setExpanded(value => value === step.id ? null : step.id);
          }}>
            <span className={styles.number} aria-hidden="true">{index + 1}</span>
            <span className={styles.summaryText}><span className={styles.title}>{step.title.replace(/^\d+\.\s*/, "")}</span><span className={styles.summaryDescription}>{step.summary}</span></span>
            <span className={styles.disclosure} aria-hidden="true">{expanded === step.id ? "−" : "+"}</span>
          </summary>
          {step.id === view.currentStepId && <p className={styles.recommended}>依据已读取记录，建议从这一段继续；这不是必走步骤或完成结论。</p>}
          <ol className={styles.nodes}>{step.nodes.map(node => <GuideNode key={node.id} node={node} headingId={`${prefix}-${step.id}-${node.id}`}/>)}</ol>
          <p className={styles.branchNext}><strong>接下来：</strong>{step.next}</p>
        </details>
      </li>)}
    </ol>
  </section>;
}

function GuideNode({ node, headingId }: { node: SpaceGuideNode; headingId: string }) {
  return <li className={styles.node}><article aria-labelledby={headingId}>
    <header className={styles.nodeHeading}><h3 id={headingId}>{node.title}</h3>{node.optional && <span className={styles.optional}>可选</span>}</header>
    <p className={styles.when}><strong>何时做：</strong>{node.when}</p>
    <div className={styles.fact} data-state={node.fact.status}><span className={styles.factLabel}>{node.fact.label}</span><p>{node.fact.explanation}</p></div>
    <div className={styles.instructions}><h4>具体怎么做</h4><ul>{node.actions.map(action => <li key={action}>{action}</li>)}</ul></div>
    <p className={styles.condition}><strong>完成或核对条件：</strong>{node.condition}</p>
    <ul className={styles.actionLinks}>{node.links.map((item, index) => <li key={`${item.href}-${index}`}><Link className={styles.link} href={item.href}>{item.title} →</Link><p>{item.purpose}</p></li>)}</ul>
    {node.tools.length > 0 && <details className={styles.tools}><summary>需要时用这些工具</summary><ul>{node.tools.map(item => <li key={`${item.href}-${item.title}`}><Link className={styles.link} href={item.href}>{item.title} →</Link><p>{item.purpose}</p></li>)}</ul></details>}
    <p className={styles.nodeNext}><strong>下一步：</strong>{node.next}</p>
  </article></li>;
}
