export interface DraftPublication {
  readonly attemptId: string;
  readonly documentId: string | null;
  readonly targetDocumentId: string | null;
  readonly sourceDraftRevision: number;
  readonly status: "pending" | "unknown" | "succeeded" | "failed";
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
  readonly body: string;
  readonly baseDocumentRevision: number | null;
  readonly contentRevision: number;
  readonly result: { readonly documentId: string; readonly documentRevision: number } | null;
  readonly cleared: boolean | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

/** A null body is a revisioned tombstone; an empty string is an intentional draft. */
export interface DocumentDraft {
  readonly ownerId: string;
  readonly projectId: string;
  readonly documentId: string | null;
  readonly revision: number;
  readonly contentRevision: number;
  readonly body: string | null;
  readonly baseDocumentRevision: number | null;
  /** A newly published document becomes the target of any newer retained input. */
  readonly publishedDocumentId: string | null;
  readonly publication: DraftPublication | null;
  readonly deletedAt: string | null;
  readonly updatedAt: string | null;
}

export interface DocumentDraftCollection {
  readonly ownerId: string;
  readonly projectId: string;
  readonly items: readonly DocumentDraft[];
}

export interface SaveDocumentDraft {
  readonly expectedOwnerId?: string;
  readonly expectedRevision: number;
  readonly body: string;
  readonly baseDocumentRevision: number | null;
  /** Only for recovering newer input after this exact new-document receipt. */
  readonly continuePublicationAttemptId?: string;
}
export interface StartDraftPublication {
  readonly expectedOwnerId?: string;
  readonly expectedRevision: number;
  readonly attemptId: string;
  readonly retryFailed?: boolean;
}
export interface DraftPublicationOutcome {
  readonly receipt: DraftPublication;
  readonly draft: DocumentDraft;
}

export const documentDraftKey = (documentId: string | null): string => documentId === null ? "new" : `document:${documentId}`;
export const emptyDocumentDraft = (ownerId: string, projectId: string, documentId: string | null): DocumentDraft => ({
  ownerId, projectId, documentId, revision: 0, contentRevision: 0, body: null, baseDocumentRevision: null,
  publishedDocumentId: null, publication: null, deletedAt: null, updatedAt: null,
});
