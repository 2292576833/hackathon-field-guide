import type { Actor, Clock, IdGenerator, ProjectAccessPort } from "../../shared/contracts.ts";

export interface RepositoryTarget { repositoryId: number; owner: string; name: string; installationId: number; appId: number; defaultBranch: string }
export interface RepositoryBinding extends RepositoryTarget { id: string; projectId: string; boundBy: string; lastChangedBy?: string; status: "bound" | "revoked"; revision: number; checkedAt: string }
/** Only a server credential provider may implement this. Never return credentials through handlers. */
export interface UserCredential { token: string; tokenKind: "github_app_user"; websiteUserId: string; githubUserId: number }
export interface GitHubCredentialPort { getUserCredential(actor: Actor, target: RepositoryTarget): Promise<UserCredential> }
export interface AuthorizationSnapshot { githubUserId: number; contentsWrite: boolean; pullRequestsWrite: boolean; userCanPush: boolean }
export interface FileChange { path: string; action: "upsert" | "delete"; content?: string; mode?: "100644" | "100755" }
export interface ManifestEntry { path: string; action: "upsert" | "delete"; bytes: number; contentHash: string; mode: "100644" | "100755" }
export interface FileIssue { path: string; code: string; message: string; severity: "blocked" | "warning" }
export interface Manifest { entries: ManifestEntry[]; totalBytes: number; inputHash: string; issues: FileIssue[] }
export interface GitTreeEntry { path: string; sha: string; mode: string; type: "blob" | "tree" | "commit"; size?: number }
export interface GitHead { commitSha: string; treeSha: string }
export interface CommitData { sha: string; treeSha: string; parents: string[]; message: string }
export interface GitHubPort {
  authorize(credential: UserCredential, target: RepositoryTarget): Promise<AuthorizationSnapshot>;
  getHead(credential: UserCredential, target: RepositoryTarget, branch: string): Promise<GitHead | null>;
  getTree(credential: UserCredential, target: RepositoryTarget, treeSha: string): Promise<GitTreeEntry[]>;
  getBlobText(credential: UserCredential, target: RepositoryTarget, sha: string): Promise<string>;
  createTree(credential: UserCredential, target: RepositoryTarget, baseTreeSha: string, changes: FileChange[]): Promise<string>;
  createCommit(credential: UserCredential, target: RepositoryTarget, input: { treeSha: string; parentSha: string; message: string }): Promise<string>;
  getCommit(credential: UserCredential, target: RepositoryTarget, sha: string): Promise<CommitData>;
  createBranch(credential: UserCredential, target: RepositoryTarget, branch: string, sha: string): Promise<void>;
  findPullRequest(credential: UserCredential, target: RepositoryTarget, head: string, base: string): Promise<string | null>;
  createPullRequest(credential: UserCredential, target: RepositoryTarget, input: { head: string; base: string; title: string; body: string }): Promise<string>;
}
export interface FilePreview { path: string; action: "add" | "modify" | "delete" | "unchanged"; before: string | null; after: string | null; beforeMode: "100644" | "100755" | null; afterMode: "100644" | "100755" | null }
export interface GitPreview { inputHash: string; baseHeadSha: string; baseTreeSha: string; files: FilePreview[]; issues: FileIssue[]; previewHash: string; createdAt: string }
export type GitOperationStatus = "draft" | "ready_for_preview" | "saving" | "saved" | "blocked" | "failed" | "unknown";
export type GitOperationStep = "draft" | "preview" | "tree" | "commit" | "branch" | "verify" | "pull_request" | "done";
export interface GitOperation {
  id: string; projectId: string; actorId: string; bindingId: string; bindingRevision: number; target: RepositoryTarget;
  idempotencyKey: string; inputHash: string; manifest: Manifest; draftRef: string; expiresAt: string; message: string; wantsPullRequest: boolean;
  branch: string; status: GitOperationStatus; step: GitOperationStep; revision: number; createdAt: string; updatedAt: string;
  preview: GitPreview | null; treeSha: string | null; commitSha: string | null; commitMessage: string | null;
  pullRequestUrl: string | null; pullRequestStatus: "not_requested" | "pending" | "created" | "failed" | "unknown";
  errorCode: string | null; leaseUntil: string | null;
}
export interface DraftStorePort {
  put(input: { projectId: string; actorId: string; changes: FileChange[]; expiresAt: string }): Promise<string>;
  get(ref: string, projectId: string, actorId: string): Promise<FileChange[] | null>;
  remove(ref: string): Promise<void>;
  purgeExpired(now: string): Promise<number>;
}
export interface GitRepositoryStore {
  getBinding(projectId: string): Promise<RepositoryBinding | null>;
  saveBinding(binding: RepositoryBinding, expectedRevision: number | null): Promise<void>;
  createOperation(operation: GitOperation): Promise<GitOperation>;
  findOperationByKey(projectId: string, actorId: string, idempotencyKey: string): Promise<GitOperation | null>;
  getOperation(projectId: string, operationId: string): Promise<GitOperation | null>;
  listOperations(projectId: string): Promise<GitOperation[]>;
  updateOperation(operation: GitOperation, expectedRevision: number): Promise<void>;
}
/** A membership role never substitutes for explicit M06 capabilities or GitHub permissions. */
export interface DeliveryCapabilityPort {
  getCapabilities(projectId: string, userId: string): Promise<{ saveRepository: boolean; verifyDelivery: boolean; recordSubmission: boolean }>;
}
export interface GitServiceDependencies {
  access: ProjectAccessPort; capabilities: DeliveryCapabilityPort; credentials: GitHubCredentialPort;
  github: GitHubPort; store: GitRepositoryStore; drafts: DraftStorePort; clock: Clock; ids: IdGenerator;
}
export interface DeliveryVerification {
  id: string; projectId: string; repositoryCommitSha: string | null; verifierId: string; verifiedAt: string;
  environmentSummary: string; steps: string[]; outcome: "passed" | "failed" | "inconclusive";
  blockers: string[]; evidenceRefs: string[]; verificationSource: "user_reported"; version: number;
}
export interface SubmissionRecord {
  id: string; projectId: string; eventId: string; stageId: string; requirementsVersion: string; platformUrl: string;
  submittedAt: string | null; verificationSource: "user_reported" | "platform_verified"; repositoryCommitSha: string | null;
  status: "not_submitted" | "reported" | "verified" | "rejected_or_withdrawn"; evidenceRefs: string[];
  recordedBy: string; recordedAt: string; version: number;
}
export interface DeliveryStorePort {
  insertVerification(record: DeliveryVerification): Promise<void>;
  listVerifications(projectId: string): Promise<DeliveryVerification[]>;
  insertSubmission(record: SubmissionRecord): Promise<void>;
  getSubmission(projectId: string, id: string): Promise<SubmissionRecord | null>;
  updateSubmission(record: SubmissionRecord, expectedVersion: number): Promise<void>;
  listSubmissions(projectId: string): Promise<SubmissionRecord[]>;
}
export interface ConfirmedRequirementsPort {
  assertConfirmed(input: { projectId: string; eventId: string; stageId: string; requirementsVersion: string; platformUrl: string }): Promise<void>;
}
