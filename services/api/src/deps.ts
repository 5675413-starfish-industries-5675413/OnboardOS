/**
 * Injectable dependencies for the Phase 2B routes.
 *
 * Routes take an ApiDeps instead of importing a global client, so tests can run
 * the real handler code against an in-memory DynamoDB and a fixed clock.
 */

import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { docClient } from "./db.js";
import { lambdaRunnerFromEnv, type RunnerClient } from "./runner.js";

export interface Db {
  client: Pick<DynamoDBDocumentClient, "send">;
  coreTable: string;
  eventsTable: string;
}

export interface ApiDeps {
  db: Db;
  /** Server clock, ISO-8601. Injected so the engine and tests stay deterministic. */
  now: () => string;
  /**
   * The scenario-runner client. LAZY: it throws when the runner is not configured,
   * so callers obtain it BEFORE persisting a PENDING run (a misconfigured runner
   * then fails fast and leaves nothing stranded).
   */
  runner: () => RunnerClient;
}

/** Production dependencies. Throws (=> 500, fail closed) if the tables are not configured. */
export function defaultDeps(): ApiDeps {
  const coreTable = process.env["ONBOARDOS_CORE_TABLE"];
  const eventsTable = process.env["ONBOARDOS_EVENTS_TABLE"];
  if (!coreTable || !eventsTable) {
    throw new Error("ONBOARDOS_CORE_TABLE and ONBOARDOS_EVENTS_TABLE must be set");
  }
  return {
    db: { client: docClient, coreTable, eventsTable },
    now: () => new Date().toISOString(),
    runner: lambdaRunnerFromEnv,
  };
}
