import type { Clock, IdGenerator, Instant } from "../../shared/contracts.ts";
import type { HostedEventScope, OrganizerPrincipal } from "../../shared/organizer-contracts.ts";
import type { DatabasePort, SqlExecutor } from "../../shared/persistence.ts";

export interface PublishedOfficialRules {
  readonly eventId: string;
  readonly title: string;
  readonly publishedVersion: number;
  readonly status: "published";
  readonly sourceUrl?: string;
}
export interface OfficialRulesPort {
  /** Root reads the current M03 human-reviewed publication through this executor. */
  getPublished(sql: SqlExecutor, eventId: string, options?: { readonly forUpdate?: boolean }): Promise<PublishedOfficialRules | null>;
  listPublished?(sql: SqlExecutor, input: { readonly query: string; readonly limit: number }): Promise<readonly PublishedOfficialRules[]>;
}
export interface OfficialRuleLink {
  readonly hostedEventId: string;
  readonly organizationId: string;
  readonly hostedPublishedRevision: number;
  readonly linkedEventId: string;
  readonly rulesVersion: number;
  readonly rulesTitle: string;
  readonly rulesSourceUrl: string | null;
  readonly revision: number;
  readonly status: "active" | "withdrawn";
  readonly auditNote: string;
  readonly updatedBy: string;
  readonly updatedAt: Instant;
}
export type OfficialLinkStaleReason = "hosted_unavailable" | "hosted_not_published" | "organization_changed" | "hosted_version_changed" | "rules_unavailable" | "rules_version_changed";
export interface OfficialRuleLinkView {
  readonly hostedEvent: Pick<HostedEventScope, "eventId" | "organizationId" | "organizationName" | "title" | "status" | "publishedRevision"> | null;
  readonly link: OfficialRuleLink | null;
  readonly state: "unlinked" | "active" | "withdrawn" | "stale";
  readonly staleReason: OfficialLinkStaleReason | null;
  readonly staleMessage: string | null;
  readonly currentRules: PublishedOfficialRules | null;
}
export interface SetOfficialRuleLinkInput {
  readonly expectedRevision: number;
  readonly expectedHostedPublishedRevision: number;
  readonly linkedEventId: string;
  readonly rulesVersion: number;
  readonly auditNote: string;
}
export interface WithdrawOfficialRuleLinkInput { readonly expectedRevision: number; readonly auditNote: string }
export interface EventOfficialLinksOptions {
  readonly database: DatabasePort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Must be undecorated O01 access; returns null for unavailable/unapproved organizations. */
  getHostedEvent(sql: SqlExecutor, id: string, options?: { readonly forUpdate?: boolean }): Promise<HostedEventScope | null>;
  readonly rulesPort: OfficialRulesPort;
}
export interface EventOfficialLinksService {
  get(principal: OrganizerPrincipal, hostedEventId: string): Promise<OfficialRuleLinkView>;
  listCandidates(principal: OrganizerPrincipal, hostedEventId: string, query?: string): Promise<readonly PublishedOfficialRules[]>;
  set(principal: OrganizerPrincipal, hostedEventId: string, input: unknown): Promise<OfficialRuleLinkView>;
  withdraw(principal: OrganizerPrincipal, hostedEventId: string, input: unknown): Promise<OfficialRuleLinkView>;
  history(principal: OrganizerPrincipal, hostedEventId: string): Promise<readonly OfficialRuleLink[]>;
  /** Default is a read-only projection. Trusted writes must opt into locking after acquiring any private project/confirmation locks. */
  getLinkedEventId(sql: SqlExecutor, scope: HostedEventScope, options?: { readonly forUpdate?: boolean }): Promise<string | null>;
}
