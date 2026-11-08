/**
 * Small HTTP helpers shared by the Phase 2B routes.
 *
 * Error contract (architecture freeze G): { code, message, requestId }.
 * Internal errors are never echoed to the client.
 */

import type { APIGatewayProxyEventV2 } from "aws-lambda";
import type { z } from "zod";

export interface HttpResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/** A failure that maps to a specific, safe HTTP response. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

/** JSON response. `no-store`: authoritative per-user state must never be cached. */
export function json(statusCode: number, body: unknown): HttpResult {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  };
}

export function errorResult(err: HttpError, requestId: string): HttpResult {
  return json(err.status, { code: err.code, message: err.message, requestId });
}

/** Request bodies are tiny JSON documents; anything bigger is rejected before parsing. */
export const MAX_BODY_BYTES = 4096;

/**
 * Parse and validate a JSON body against a Zod schema. Schemas used for
 * requests are STRICT, so unexpected fields (a forged role, status, etc.)
 * produce a 400 rather than being ignored.
 */
export function parseBody<T>(event: APIGatewayProxyEventV2, schema: z.ZodType<T>, maxBytes: number = MAX_BODY_BYTES): T {
  const raw = event.body;
  if (raw === undefined || raw === null || raw === "") {
    throw new HttpError(400, "INVALID_REQUEST", "A JSON request body is required");
  }
  const text = event.isBase64Encoded ? Buffer.from(raw, "base64").toString("utf8") : raw;
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "INVALID_REQUEST", "Request body is not valid JSON");
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new HttpError(400, "INVALID_REQUEST", "Request body failed validation");
  }
  return result.data;
}

export function pathParam(event: APIGatewayProxyEventV2, name: string): string | undefined {
  return event.pathParameters?.[name];
}
