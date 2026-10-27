export interface FeedRefreshState {
  cursor: string;
  loading: boolean;
  failed: boolean;
  snapshotVersion: string | null;
  observedVersion: string | null;
  observedRevision: number;
  handledRevision: number;
}

/** Revisions count live observations locally; the server's version is an opaque hash. */
export function shouldRefreshEventFeed(state: FeedRefreshState): boolean {
  if (state.cursor || state.loading || state.observedVersion === null) return false;
  if (state.failed) return true;
  return state.snapshotVersion !== state.observedVersion && state.observedRevision > state.handledRevision;
}

/** A response covers observations made before its request, and any matching snapshot
 * observed while it was in flight. An unmatched later observation needs one catch-up.
 * Consuming the starting revision also bounds retries when live returns a cached hash. */
export function coveredFeedRevision(startedRevision: number, observedRevision: number, snapshotVersion: string | null, observedVersion: string | null): number {
  return snapshotVersion !== null && snapshotVersion === observedVersion ? observedRevision : startedRevision;
}
