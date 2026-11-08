import type { Db } from "./deps.js";
import {
  parseConfigRevision,
  parseTestRun,
  type SessionHistory,
} from "./records.js";
import { queryConfigRevisions, queryTestRuns } from "./repo.js";

/**
 * Load a session's bounded revision and run history (two consistent Queries on
 * the session partition). A stored item that fails validation is skipped and
 * logged: it is never displayed and never counted as evidence of anything.
 */
export async function loadHistory(db: Db, sessionId: string): Promise<SessionHistory> {
  const [revItems, runItems] = await Promise.all([queryConfigRevisions(db, sessionId), queryTestRuns(db, sessionId)]);

  const revisions = [];
  for (const item of revItems) {
    const rec = parseConfigRevision(item);
    if (rec && rec.sessionId === sessionId) revisions.push(rec);
    else console.error({ message: "skipping malformed config revision", sessionId });
  }
  const runs = [];
  for (const item of runItems) {
    const rec = parseTestRun(item);
    if (rec && rec.sessionId === sessionId) runs.push(rec);
    else console.error({ message: "skipping malformed test run", sessionId });
  }
  return { revisions, runs };
}
