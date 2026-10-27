import type { JourneyGuide, JourneyNode, JourneyPhase } from "./model.ts";
import styles from "./journey.module.css";

const phaseLabels: Record<JourneyPhase["id"], string> = {
  before: "赛前",
  during: "赛中",
  after: "赛后",
};

function phaseAnchor(phase: JourneyPhase): string {
  return `journey-phase-${phase.id}`;
}

function JourneyAction({ node }: { node: JourneyNode }) {
  return (
    <li className={styles.actionBranch}>
      <div className={styles.actionNode}>
        <h4 className={styles.actionTitle}>{node.title}</h4>
        <p className={styles.actionDescription}>{node.description}</p>
        {node.parallel ? (
          <p className={styles.parallelNote}>
            {node.parallel}
          </p>
        ) : null}
        <a className={styles.actionLink} href={node.href}>
          <span>{node.actionLabel}</span>
          <span aria-hidden="true">→</span>
        </a>
      </div>
      {node.resources.length > 0 ? (
        <details className={styles.resourceBranch}>
          <summary className={styles.resourceLabel}>需要帮助？工具与资料（{node.resources.length} 项）</summary>
          <ul className={styles.resources} role="list" aria-label={`${node.title}的辅助资源`}>
            {node.resources.map((resource) => (
              <li className={styles.resourceNode} key={`${resource.href}-${resource.title}`}>
                <a className={styles.resourceLink} href={resource.href}>
                  <span className={styles.resourceTitle}>
                    {resource.title}<span className={styles.resourceArrow} aria-hidden="true"> →</span>
                  </span>
                  <span className={styles.resourceDescription}>{resource.description}</span>
                </a>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}

export function JourneyTree({ guide }: { guide: JourneyGuide }) {
  return (
    <section className={styles.tree} aria-labelledby="journey-root-title">
      <div className={styles.diagram}>
        <header className={styles.root}>
          <p className={styles.rootLabel}>第一次参赛 · 从这里开始</p>
          <h2 className={styles.rootTitle} id="journey-root-title">{guide.root.title}</h2>
          <p className={styles.rootDescription}>先选一场比赛，核对报名要求。已有参赛项目？打开团队空间继续。</p>
          <div className={styles.rootActions}>
            {guide.root.actions.map((action, index) => (
              <a
                className={index === 0 ? styles.primaryLink : styles.secondaryLink}
                href={action.href}
                key={`${action.href}-${action.label}`}
              >
                <span>{action.label}</span><span aria-hidden="true">→</span>
              </a>
            ))}
          </div>
          <p className={styles.spaceNote}>单人也能使用团队空间。工具和教程在对应行动下按需展开。</p>
          <div className={styles.guideNotes}>
            <p><strong>通用准备指南。</strong>主办方要求优先，点击入口不代表完成。</p>
            <details><summary>怎样理解流程、进度与共享？</summary><p>{guide.root.description}</p><p>行动顺序可以调整，具体依赖和真实进度在团队空间确认。成员报告完成后仍需检查成果；私人准备和材料不会自动共享。</p><p>开展团队协作时，先登录并创建或打开空间。</p></details>
          </div>
          <nav className={styles.phaseNavigation} aria-label="参赛阶段快速定位">
            <span className={styles.navigationLabel}>按需查看阶段</span>
            <ol className={styles.phaseShortcuts} role="list">
              {guide.phases.map((phase, index) => (
                <li key={phase.id}>
                  <a href={`#${phaseAnchor(phase)}`} aria-label={`查看${phase.title}`}>
                    <span className={styles.shortcutNumber} aria-hidden="true">0{index + 1}</span>
                    <span>{phaseLabels[phase.id]}</span>
                    <span aria-hidden="true">↓</span>
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        </header>

        <ol className={styles.phases} role="list" aria-label="参赛阶段">
          {guide.phases.map((phase, index) => (
            <li className={styles.phaseBranch} key={phase.id}>
              <section
                className={styles.phase}
                id={phaseAnchor(phase)}
                aria-labelledby={`${phaseAnchor(phase)}-title`}
                tabIndex={-1}
              >
                <header className={styles.phaseHead}>
                  <p className={styles.phaseNumber} aria-hidden="true">0{index + 1}</p>
                  <h3 className={styles.phaseTitle} id={`${phaseAnchor(phase)}-title`}>{phase.title}</h3>
                  <p className={styles.phaseDescription}>{phase.description}</p>
                </header>
                {phase.cautions.length > 0 ? (
                  <details className={styles.cautions}>
                    <summary>
                      <span>本阶段注意事项</span>
                      <span className={styles.cautionCount}>{phase.cautions.length} 条提醒</span>
                    </summary>
                    <ul>
                      {phase.cautions.map((caution) => <li key={caution}>{caution}</li>)}
                    </ul>
                  </details>
                ) : null}
                <ol className={styles.actions} role="list" aria-label={`${phase.title}的行动`}>
                  {phase.nodes.map((node) => <JourneyAction key={node.id} node={node}/>)}
                </ol>
              </section>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
