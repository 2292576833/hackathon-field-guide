import type { Actor } from "../../shared/contracts.ts";
import type { SqlExecutor } from "../../shared/persistence.ts";
import type { AuthUserRecord, SessionContext } from "./types.ts";
import type { AccountDeletionRequest, DeletionImpact, EmailChangeChallenge, OwnDataBundle, StoredDataExport } from "./account-types.ts";

export interface OwnDataExportPort {
  /** Use executor and current actor, bounded owner-only records and current authorized project summaries. */
  collectOwnData(actor: Actor, executor: SqlExecutor, limits: { readonly maxRecords: number; readonly maxBytes: number }): Promise<OwnDataBundle>;
  /** Lock/recheck project access at both collection completion and download; throw when any is no longer readable. */
  assertProjectAccess(actor: Actor, projectIds: readonly string[], executor: SqlExecutor): Promise<void>;
}
export interface AccountDeletionImpactPort {
  /** Root locks M02 facts in a consistent order, returns no teammates' raw private records. */
  inspectOwnDeletion(actor: Actor, executor: SqlExecutor): Promise<DeletionImpact>;
}
export interface AccountEmailPort {
  sendEmailChangeCode(input: { readonly email: string; readonly code: string; readonly expiresAt: string; readonly purpose: "current_email" | "new_email" }): Promise<void>;
}
export interface AccountTransaction {
  readonly executor: SqlExecutor;
  readonly context: SessionContext;
  now(): string;
  assertSession(): Promise<void>;
  takeRates(rules: readonly { readonly key: string; readonly windowMs: number; readonly maximum: number; readonly cooldownMs?: number }[]): Promise<boolean>;
  listExports(): Promise<readonly StoredDataExport[]>;
  getExport(id: string): Promise<StoredDataExport | null>;
  saveExport(record: StoredDataExport): Promise<void>;
  getDeletion(id?: string): Promise<AccountDeletionRequest | null>;
  saveDeletion(record: AccountDeletionRequest): Promise<void>;
  getEmailChallenge(id: string): Promise<EmailChangeChallenge | null>;
  saveEmailChallenge(record: EmailChangeChallenge): Promise<void>;
  revokeEmailChallenges(): Promise<void>;
  /** Locks both mailbox identities before user/session; CAS unique email and invalidate old login codes/sessions. */
  changeEmail(email: string, expectedRevision: number): Promise<AuthUserRecord | "email_conflict" | "version_conflict">;
  beginDeletionProcessing(): Promise<void>;
  audit(action: string, objectType: string, objectId: string, result: string): Promise<void>;
}
export interface AccountStorePort {
  withSession<T>(tokenHash: string, work: (transaction: AccountTransaction) => Promise<T>, mailboxLocks?: readonly string[]): Promise<T>;
  /** Server-only worker boundary; authenticated owner handlers never receive userId from JSON. */
  withUser<T>(userId: string, work: (transaction: AccountTransaction) => Promise<T>): Promise<T>;
}
