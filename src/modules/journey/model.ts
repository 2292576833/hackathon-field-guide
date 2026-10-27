/** Public preparation content only. Team facts remain in their existing modules. */
export type JourneyHref =
  | "/events"
  | "/competitions"
  | "/app"
  | "/participation"
  | "/app/account"
  | "/resources"
  | "/inspiration"
  | "/skills"
  | "/github"
  | "/roadshow"
  | "/ppt"
  | "/library"
  | "/library/start-here"
  | "/library/hackathon-introduction"
  | "/library/github-first-repository"
  | "/library/github-team-workflow"
  | "/library/delivery-checklist"
  | "/library/skill-pack-guide";

export type JourneyPhaseId = "before" | "during" | "after";

export interface JourneyAction {
  readonly label: string;
  readonly href: JourneyHref;
}

export interface JourneyRoot {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly actions: readonly JourneyAction[];
}

export interface JourneyResource {
  readonly title: string;
  /** Explain when to use this optional aid and what it helps produce. */
  readonly description: string;
  readonly href: JourneyHref;
}

export interface JourneyNode {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly actionLabel: string;
  readonly href: JourneyHref;
  /** A visible explanation of work that can start in parallel, or null. */
  readonly parallel: string | null;
  readonly resources: readonly JourneyResource[];
}

export interface JourneyPhase {
  readonly id: JourneyPhaseId;
  readonly title: string;
  readonly description: string;
  readonly cautions: readonly string[];
  readonly nodes: readonly JourneyNode[];
}

export interface JourneyGuide {
  readonly root: JourneyRoot;
  readonly phases: readonly JourneyPhase[];
}
