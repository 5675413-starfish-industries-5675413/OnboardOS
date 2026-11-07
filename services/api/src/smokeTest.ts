/**
 * OnboardOS Smoke-Test Lambda — internal DynamoDB connectivity test.
 *
 * INTERNAL ONLY — this handler must NEVER be added as an API Gateway event
 * source. It is invocable only via `aws lambda invoke` with IAM authorization.
 *
 * The handler performs a real DynamoDB round-trip:
 *   1. DescribeTable  — confirms connectivity and captures table status
 *   2. PutItem        — writes a uniquely keyed disposable item
 *   3. GetItem        — reads the item back with ConsistentRead: true
 *   4. Validates      — asserts returned data matches what was written
 *   5. DeleteItem     — cleans up in a finally block; result includes cleanupOk
 *
 * Returns a structured, non-sensitive result. A test is only considered clean
 * when both ok=true AND cleanupOk=true. The item key is scoped to the Lambda
 * request ID so concurrent invocations never collide.
 *
 * Note: the `ttlMarker` attribute written to the item is a convenience marker
 * only. DynamoDB TTL automatic deletion is NOT enabled on this table in Phase 1.
 * The handler always cleans up via explicit DeleteItem.
 */

import { DynamoDBClient, DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Context } from "aws-lambda";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface SmokeTestResult {
  ok: boolean;
  tableStatus?: string;
  /** Always present: true if cleanup DeleteItem succeeded, false if it threw. */
  cleanupOk: boolean;
  message: string;
  requestId: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Redact AWS ARNs and account IDs from error messages before returning. */
function sanitizeErrorMessage(msg: string): string {
  return msg
    .replace(/arn:[a-z0-9\-*]*:[a-z0-9\-]*:[a-z0-9\-]*:[0-9]{12}:[^\s,)"']*/gi, "<ARN>")
    .replace(/\b[0-9]{12}\b/g, "<ACCOUNT>");
}

// ---------------------------------------------------------------------------
// Exported Lambda handler (wrapper that owns the DynamoDB client lifecycle
// and correctly captures cleanupOk in the final returned value)
// ---------------------------------------------------------------------------

export const smokeTestHandler = async (
  _event: unknown,
  context: Context,
): Promise<SmokeTestResult> => {
  const start = Date.now();
  const requestId = context.awsRequestId;

  const tableName = process.env["ONBOARDOS_CORE_TABLE"];
  if (!tableName) {
    return {
      ok: false,
      cleanupOk: false,
      message: "ONBOARDOS_CORE_TABLE environment variable is not set",
      requestId,
      durationMs: Date.now() - start,
    };
  }

  const PK = `SMOKE#${requestId}`;
  const SK = "TEST";

  const rawClient = new DynamoDBClient({});
  const client = DynamoDBDocumentClient.from(rawClient);

  let tableStatus: string | undefined;
  let testOk = false;
  let testMessage = "";
  let cleanupOk = false;

  try {
    // DescribeTable
    const describeResult = await client.send(
      new DescribeTableCommand({ TableName: tableName }),
    );
    tableStatus = describeResult.Table?.TableStatus;

    // PutItem
    const ttlMarker = Math.floor(Date.now() / 1000) + 60;
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          PK,
          SK,
          _smoke: true,
          _requestId: requestId,
          ttlMarker,
        },
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );

    // GetItem (ConsistentRead: true)
    const getResult = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK, SK },
        ConsistentRead: true,
      }),
    );

    const item = getResult.Item;
    if (!item) {
      testOk = false;
      testMessage =
        "GetItem returned no item immediately after PutItem (ConsistentRead: true)";
    } else if (item["_smoke"] !== true) {
      testOk = false;
      testMessage = `Validation failed: expected _smoke=true, got _smoke=${String(item["_smoke"])}`;
    } else if (item["PK"] !== PK || item["SK"] !== SK) {
      testOk = false;
      testMessage = `Validation failed: key mismatch — expected PK=${PK} SK=${SK}`;
    } else {
      testOk = true;
      testMessage =
        "DynamoDB round-trip OK (DescribeTable → PutItem → GetItem → DeleteItem)";
    }
  } catch (err: unknown) {
    const raw = err instanceof Error ? err.message : String(err);
    testOk = false;
    testMessage = sanitizeErrorMessage(raw);
  } finally {
    // Always attempt cleanup. Record whether it succeeded.
    // A cleanup failure means the smoke item may be orphaned in the table.
    // We never claim a fully clean result if cleanup failed.
    try {
      await client.send(
        new DeleteCommand({
          TableName: tableName,
          Key: { PK, SK },
        }),
      );
      cleanupOk = true;
    } catch {
      cleanupOk = false;
      console.error(
        JSON.stringify({
          requestId,
          event: "SMOKE_CLEANUP_FAILED",
          PK,
        }),
      );
    }
  }

  return {
    ok: testOk && cleanupOk,
    tableStatus,
    cleanupOk,
    message: cleanupOk
      ? testMessage
      : `${testMessage} [WARNING: cleanup DeleteItem failed — smoke item may be orphaned]`,
    requestId,
    durationMs: Date.now() - start,
  };
};
