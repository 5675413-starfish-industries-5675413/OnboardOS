import type { Db } from "./deps.js";
import {
  parseConfigRevision,
  parseDecision,
  parseSubmission,
  parseTestRun,
  type SessionHistory,
} from "./records.js";
import { queryConfigRevisions, queryDecisions, querySubmissions, queryTestRuns } from "./repo.js";

/**
 * Load a session's bounded revision and run history (two consistent Queries on
 * the session partition). A stored item that fails validation is skipped and
 * logged: it is never displayed and never counted as evidence of anything.
 */
export async function loadHistory(db: Db, sessionId: string, assignmentId: string): Promise<SessionHistory> {
  const [revItems, runItems, subItems, decItems] = await Promise.all([
    queryConfigRevisions(db, sessionId),
    queryTestRuns(db, sessionId),
    querySubmissions(db, assignmentId),
    queryDecisions(db, assignmentId),
  ]);

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
  // Submissions and decisions are keyed by assignment (all attempts); re-check the assignment id.
  const submissions = [];
  for (const item of subItems) {
    const rec = parseSubmission(item);
    if (rec && rec.assignmentId === assignmentId) submissions.push(rec);
    else console.error({ message: "skipping malformed submission", sessionId });
  }
  const decisions = [];
  for (const item of decItems) {
    const rec = parseDecision(item);
    if (rec && rec.assignmentId === assignmentId) decisions.push(rec);
    else console.error({ message: "skipping malformed decision", sessionId });
  }
  return { revisions, runs, submissions, decisions };
}
