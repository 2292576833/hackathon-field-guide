import type { UserProfile } from "./types.ts";

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export interface OwnDataRecord { readonly id: string; readonly userId: string; readonly data: JsonValue }
export interface ExportProjectSummary { readonly projectId: string; readonly name: string; readonly summary: string }
export interface OwnDataBundle {
  readonly records: {
    readonly personal: readonly OwnDataRecord[];
    readonly conversations: readonly OwnDataRecord[];
    readonly generations: readonly OwnDataRecord[];
    readonly assessments: readonly OwnDataRecord[];
    readonly retrospectives: readonly OwnDataRecord[];
    readonly bookmarks: readonly OwnDataRecord[];
  };
  readonly projects: readonly ExportProjectSummary[];
}
export interface OwnDataDocument extends OwnDataBundle {
  readonly schemaVersion: 1; readonly userId: string; readonly generatedAt: string; readonly profile: UserProfile;
}
export interface DataExportRequest {
  readonly id: string; readonly userId: string; readonly status: "queued" | "ready" | "failed" | "expired";
  readonly createdAt: string; readonly updatedAt: string; readonly expiresAt: string;
  readonly revision: number; readonly attempts: number; readonly errorCode: string | null; readonly byteLength: number | null;
}
export type DataExportSummary = Omit<DataExportRequest, "userId">;
/** Stored privately; never serialize this record from an HTTP status handler. */
export interface StoredDataExport extends DataExportRequest { readonly document: OwnDataDocument | null }
export interface DeletionBlockingProject { readonly projectId: string; readonly name: string; readonly remediationUrl: string }
export interface DeletionImpact {
  readonly lastManagerProjects: readonly DeletionBlockingProject[];
  readonly notices: readonly string[];
}
export interface AccountDeletionRequest {
  readonly id: string; readonly userId: string; readonly status: "pending" | "blocked" | "processing" | "cancelled";
  readonly createdAt: string; readonly updatedAt: string; readonly revision: number; readonly impact: DeletionImpact;
}
export type AccountDeletionSummary = Omit<AccountDeletionRequest, "userId">;
export interface AccountDataOverview {
  readonly exports: readonly DataExportSummary[]; readonly deletionRequest: AccountDeletionSummary | null;
  readonly impact: DeletionImpact;
}
export interface EmailChangeChallenge {
  readonly id: string; readonly userId: string; readonly oldEmail: string; readonly newEmail: string;
  readonly expectedRevision: number; readonly currentCodeHash: string; readonly newCodeHash: string;
  readonly createdAt: string; readonly expiresAt: string;
  readonly delivery: "pending" | "ready" | "unknown";
  readonly failedAttempts: number; readonly consumedAt: string | null; readonly revokedAt: string | null;
}
export interface EmailChangeReceipt {
  readonly challengeId: string; readonly expiresAt: string; readonly resendAfterSeconds: number; readonly message: string;
}
export interface EmailChangeResult { readonly changed: true; readonly requiresLogin: true; readonly profile: UserProfile }
export interface AccountCompletionPolicy {
  readonly exportLifetimeMs: number; readonly exportWindowMs: number; readonly maxExportsPerWindow: number;
  readonly maxExportRecords: number; readonly maxExportBytes: number; readonly maxExportAttempts: number;
  readonly challengeLifetimeMs: number; readonly recentAuthenticationMs: number;
  readonly rateWindowMs: number; readonly sendCooldownMs: number;
  readonly maxSendsPerUser: number; readonly maxSendsPerEmail: number; readonly maxSendsPerClient: number;
  readonly maxVerificationsPerUser: number; readonly maxVerificationsPerClient: number; readonly maxCodeFailures: number;
}
export const DEFAULT_ACCOUNT_COMPLETION_POLICY: AccountCompletionPolicy = Object.freeze({
  exportLifetimeMs: 24 * 60 * 60_000, exportWindowMs: 24 * 60 * 60_000, maxExportsPerWindow: 3,
  maxExportRecords: 5000, maxExportBytes: 5 * 1024 * 1024, maxExportAttempts: 3,
  challengeLifetimeMs: 10 * 60_000, recentAuthenticationMs: 5 * 60_000,
  rateWindowMs: 15 * 60_000, sendCooldownMs: 60_000,
  maxSendsPerUser: 3, maxSendsPerEmail: 3, maxSendsPerClient: 20,
  maxVerificationsPerUser: 10, maxVerificationsPerClient: 50, maxCodeFailures: 5,
});
