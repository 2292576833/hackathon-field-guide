import type { Clock } from "../../shared/contracts.ts";
import type { RegistrationWindow } from "../../shared/registration-window.ts";
import type { EventWindow } from "../../shared/event-window.ts";
import type { PublicDnsPort, PinnedFetchPort, NetworkPolicy } from "./network-policy.ts";

export const DISCOVERY_MODEL_REQUIRES_REVIEW = "DISCOVERY_MODEL_REQUIRES_REVIEW";
export const DISCOVERY_SEARCH_REQUIRES_REVIEW = "DISCOVERY_SEARCH_REQUIRES_REVIEW";

export interface PublicSearchResult {
  readonly url: string; readonly title: string; readonly description: string; readonly detailPolicy?: NetworkPolicy;
  /** Only verbatim cited_text from the official native tool's structured source result; never generated search prose. */
  readonly indexedExcerpt?: string;
}
export interface PublicSearchUsage {
  readonly inputTokens: number; readonly outputTokens: number; readonly estimatedCostMicros: number; readonly currency: "USD" | "CNY";
}
export type PublicSearchResponse = readonly PublicSearchResult[] | { readonly results: readonly PublicSearchResult[]; readonly usage: PublicSearchUsage | null };
export interface PublicSearchPort<Response extends PublicSearchResponse = PublicSearchResponse> {
  /** Bounded providers can interleave independent source/query batches. */
  readonly resultOrdering?: "interleave";
  /** Native search also consumes one paid model call, covered by the search cost reservation. */
  readonly modelCallsPerSearch?: 1;
  /** Stable model/prompt/maxTokens/maxUses identity; excludes dates and generated output. */
  readonly requestIdentity?: string;
  search(input: { readonly query: string; readonly count: number; readonly signal: AbortSignal }): Promise<Response>;
}
export interface DiscoveryAnalysis {
  readonly fit: readonly string[]; readonly risks: readonly string[];
  readonly preparation: readonly string[]; readonly unknowns: readonly string[];
}
export interface DiscoveryRegistration {
  readonly url: string; readonly sourceUrl: string; readonly evidence: string;
}
export interface DiscoveryParticipation {
  readonly recommendation: "consider" | "caution" | "insufficient_info";
  readonly reason: string; readonly suitableFor: readonly string[]; readonly cautionFor: readonly string[];
}
export interface DiscoveryCandidateInput {
  readonly canonicalUrl: string; readonly title: string; readonly summary: string;
  readonly analysis: DiscoveryAnalysis;
  readonly sources: readonly { readonly url: string; readonly title: string; readonly excerpt: string; readonly fetchedAt: string; readonly sourceKind?: "page" | "indexed_excerpt" }[];
  readonly discoveredAt: string; readonly lastAnalyzedAt: string; readonly provider: "dsh";
  readonly registration?: DiscoveryRegistration | null;
  readonly participation?: DiscoveryParticipation;
  readonly registrationWindow?: RegistrationWindow;
  readonly eventWindow?: EventWindow;
}
/** Main composition owns durable cards; every saved card remains unverified. No publication method. */
export interface DiscoveryRegistrationClosureInput {
  readonly canonicalUrl: string; readonly registrationWindow: RegistrationWindow;
  readonly sources: DiscoveryCandidateInput["sources"];
  readonly lastAnalyzedAt: string; readonly provider: "dsh";
}
export type DiscoveryCandidateCommit = (save: () => Promise<{ readonly id: string; readonly revision: number }>) => Promise<{ readonly id: string; readonly revision: number }>;
export interface DiscoveryCandidatePort {
  save(input: DiscoveryCandidateInput): Promise<{ readonly id: string; readonly revision: number }>;
  /** Trusted closed-source evidence only; no new closed card. A missing card
   * returns null before commit. Existing-card mutation must call commit(save)
   * and reuse the ledger's scoped transaction, retaining historical snapshots. */
  closeRegistration?(input: DiscoveryRegistrationClosureInput, commit: DiscoveryCandidateCommit): Promise<{ readonly id: string; readonly revision: number } | null>;
}
export interface DiscoveryModelPort {
  request(input: { readonly task: "discovery" | "navigator"; readonly prompt: string; readonly input: unknown; readonly signal: AbortSignal }): Promise<{
    readonly data: unknown;
    readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly estimatedCostMicros: number; readonly currency: "USD" | "CNY" };
  }>;
}
export interface DiscoveryLimits {
  readonly maxSearchCallsPerDay: number; readonly maxModelCallsPerDay: number;
  readonly maxEstimatedCostMicrosPerDay: number; readonly currency: "USD" | "CNY";
}
export interface DiscoveryCycleReservation {
  readonly searchCalls: number; readonly modelCalls: number; readonly estimatedCostMicros: number;
}
export interface DiscoveryCycleLease { readonly token: string; readonly expiresAt: string }
export type DiscoverySkipReason = "paused" | "not_due" | "busy" | "daily_limit";
export interface DiscoveryState {
  readonly revision: number; readonly paused: boolean; readonly nextEligibleAt: string | null;
  readonly leaseExpiresAt: string | null; readonly quotaDay: string;
  readonly searchCalls: number; readonly modelCalls: number; readonly estimatedCostMicros: number;
  readonly lastCompletedAt: string | null; readonly lastErrorCode: string | null;
}
/** Atomic durable reservations survive process restarts; no production in-memory fallback. */
export interface DiscoveryLedgerPort {
  beginCycle(input: { readonly workerId: string; readonly now: string; readonly minimumIntervalMs: number; readonly leaseMs: number;
    readonly limits: DiscoveryLimits; readonly reservation: DiscoveryCycleReservation }): Promise<{ readonly lease: DiscoveryCycleLease } | { readonly skipped: DiscoverySkipReason }>;
  /** Claim and persist a paid-search marker before send. A prior unknown outcome remains held across cycles/days/restarts. */
  claimSearch(input: { readonly token: string; readonly requestHash: string; readonly now: string }): Promise<boolean>;
  /** Lease + cycle-token fenced. null clears the marker only after a valid result or a known not_sent failure. */
  recordSearch(input: { readonly token: string; readonly requestHash: string; readonly now: string; readonly errorCode: string | null }): Promise<void>;
  /** contentHash is the last attempted/completed model input, not proof of successful analysis.
   * Any prior model-review error holds the whole URL for manual recovery; a changed
   * page cannot overwrite an unresolved hash and later replay its previous content. */
  claimUrl(input: { readonly token: string; readonly canonicalUrl: string; readonly now: string; readonly recrawlAfterMs: number }): Promise<{ readonly previousContentHash: string | null; readonly previousErrorCode: string | null; readonly fetchDue: boolean } | null>;
  assertCycle(input: { readonly token: string }): Promise<void>;
  /** save must reuse this ledger's DatabasePort transaction (main composition's scoped executor).
   * Ownership/expiry/abort and URL accounting fence the card write in one transaction. */
  commitCandidate(input: { readonly token: string; readonly canonicalUrl: string; readonly contentHash: string; readonly signal: AbortSignal },
    save: () => Promise<{ readonly id: string; readonly revision: number }>): Promise<{ readonly id: string; readonly revision: number }>;
  /** Persist a model-attempt hash before send; only errorCode=null records successful completion.
   * null contentHash retains prior model input across a temporary fetch failure. */
  recordUrl(input: { readonly token: string; readonly canonicalUrl: string; readonly now: string; readonly contentHash: string | null; readonly candidateId: string | null; readonly errorCode: string | null }): Promise<void>;
  finishCycle(input: { readonly token: string; readonly now: string; readonly consumed: DiscoveryCycleReservation; readonly errorCode: string | null }): Promise<void>;
  readState(): Promise<DiscoveryState>;
  setPaused(input: { readonly actorId: string; readonly expectedRevision: number; readonly paused: boolean; readonly now: string }): Promise<DiscoveryState>;
}
export interface ContinuousDiscoveryConfig {
  readonly workerId: string; readonly userAgent: string; readonly queries: readonly string[];
  /** Number of query groups cycled by composition. Candidate order rotates on
   * each revisit to the same group; fixed/custom query lists default to one. */
  readonly queryRotationGroups?: number;
  readonly minimumIntervalMs: number; readonly recrawlAfterMs: number;
  readonly maxResultsPerQuery: number; readonly maxPagesPerCycle: number;
  readonly maxCycleDurationMs: number; readonly fetchTimeoutMs: number; readonly maxPageBytes: number;
  readonly searchCostMicrosPerCall: number; readonly modelCostReservationMicrosPerCall: number;
  readonly limits: DiscoveryLimits;
}
export interface ContinuousDiscoveryDependencies {
  readonly search: PublicSearchPort; readonly model: DiscoveryModelPort; readonly candidates: DiscoveryCandidatePort;
  readonly ledger: DiscoveryLedgerPort; readonly clock: Clock; readonly config: ContinuousDiscoveryConfig;
  /** Bounded URL hints for revisiting at most one active stored card and actual
   * catalog links, within the existing allowance after a successful paid search.
   * Metadata is a hint, never evidence or permission to bypass network checks. */
  readonly existingCandidates?: (input?: { readonly signal: AbortSignal }) => Promise<readonly PublicSearchResult[]>;
  readonly dns?: PublicDnsPort; readonly transport?: PinnedFetchPort;
}
export interface DiscoveryCycleReport {
  readonly status: "completed" | "failed" | "cancelled" | "skipped";
  readonly reason?: string; readonly searched: number; readonly fetched: number; readonly saved: number;
  readonly unchanged: number; readonly rejected: number;
  readonly errors: readonly { readonly url?: string; readonly code: string }[];
}
