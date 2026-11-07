/**
 * routes/me.ts — GET /v1/me
 *
 * Returns the authenticated user's identity and all ACTIVE organization
 * memberships. Identity is derived exclusively from API Gateway JWT authorizer
 * claims; the client cannot supply or override any field here.
 *
 * Authorization contract:
 *  1. extractAuthContext() enforces token_use=access and extracts userSub.
 *  2. getMembershipsForUser() loads membership records from DynamoDB Core.
 *  3. Only ACTIVE memberships are returned; SUSPENDED/INVITED are silently
 *     excluded. This means a suspended user receives an empty memberships
 *     array — they are authenticated but have no organization access.
 *  4. Each returned membership is parsed through MembershipViewSchema to
 *     guarantee the shape and reject any unexpected or malformed DynamoDB
 *     values before they reach the client.
 *  5. No DynamoDB record field is returned unvalidated.
 */

import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { MembershipViewSchema, MeResponseSchema } from "@onboardos/contracts";
import { extractAuthContext, AuthError } from "../auth.js";
import { getMembershipsForUser } from "../db.js";

interface HttpResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function json(statusCode: number, body: unknown): HttpResult {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export async function handleGetMe(
  event: APIGatewayProxyEventV2,
  context: Context,
): Promise<HttpResult> {
  const requestId = context.awsRequestId;

  // Step 1: Extract and validate auth context from authorizer claims.
  let authCtx: ReturnType<typeof extractAuthContext>;
  try {
    authCtx = extractAuthContext(event);
  } catch (err) {
    if (err instanceof AuthError) {
      // Return 401 for auth issues; do not leak internal error codes.
      return json(401, {
        code: "UNAUTHORIZED",
        message: "Authentication required",
        requestId,
      });
    }
    console.error({ requestId, event: "AUTH_EXTRACT_FAILED", error: String(err) });
    return json(500, { code: "INTERNAL_ERROR", message: "An unexpected error occurred", requestId });
  }

  // Step 2: Load membership records from DynamoDB.
  let rawMemberships: Awaited<ReturnType<typeof getMembershipsForUser>>;
  try {
    rawMemberships = await getMembershipsForUser(authCtx.userSub);
  } catch (err) {
    // Fail closed: any DynamoDB error denies access.
    console.error({ requestId, event: "MEMBERSHIP_LOOKUP_FAILED", userSub: authCtx.userSub, error: String(err) });
    return json(500, { code: "INTERNAL_ERROR", message: "An unexpected error occurred", requestId });
  }

  // Step 3: Filter to ACTIVE memberships only.
  const activeMemberships = rawMemberships.filter((m) => m.status === "ACTIVE");

  // Step 4: Parse each membership through the shared Zod schema.
  // Invalid records are logged and excluded — we never return malformed data.
  const validatedMemberships = [];
  for (const raw of activeMemberships) {
    const parsed = MembershipViewSchema.safeParse(raw);
    if (!parsed.success) {
      console.error({
        requestId,
        event: "INVALID_MEMBERSHIP_RECORD",
        organizationId: raw.organizationId,
        error: parsed.error.message,
      });
      continue; // Exclude invalid record, do not fail the whole request.
    }
    validatedMemberships.push(parsed.data);
  }

  // Step 5: Build and validate the full response.
  const responseBody = MeResponseSchema.parse({
    userSub: authCtx.userSub,
    username: authCtx.username,
    memberships: validatedMemberships,
  });

  return json(200, responseBody);
}
