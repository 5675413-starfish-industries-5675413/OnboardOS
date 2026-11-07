import { describe, it, expect, vi } from "vitest";
import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { httpHandler } from "../handler.js";

// The handler always returns the structured object form, never a plain string.
interface HttpResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

// ---------------------------------------------------------------------------
// Minimal test doubles
// ---------------------------------------------------------------------------

function makeEvent(routeKey: string): APIGatewayProxyEventV2 {
  return {
    routeKey,
    version: "2.0",
    rawPath: "/",
    rawQueryString: "",
    headers: {},
    requestContext: {
      http: { method: "GET", path: "/", protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "test" },
      accountId: "123456789012",
      apiId: "test",
      domainName: "test.execute-api.us-east-1.amazonaws.com",
      domainPrefix: "test",
      requestId: "test-request-id",
      routeKey,
      stage: "$default",
      time: "01/Jan/2026:00:00:00 +0000",
      timeEpoch: 1735689600000,
    },
    isBase64Encoded: false,
  } as APIGatewayProxyEventV2;
}

function makeContext(id = "test-request-id"): Context {
  return {
    awsRequestId: id,
    functionName: "test-fn",
    functionVersion: "$LATEST",
    invokedFunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:test-fn",
    memoryLimitInMB: "512",
    logGroupName: "/aws/lambda/test-fn",
    logStreamName: "test-stream",
    callbackWaitsForEmptyEventLoop: false,
    getRemainingTimeInMillis: () => 30000,
    done: () => {},
    fail: () => {},
    succeed: () => {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("httpHandler", () => {
  it("GET /health returns 200 with status ok", async () => {
    const result = await httpHandler(makeEvent("GET /health"), makeContext()) as HttpResult;
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.status).toBe("ok");
    expect(body.service).toBe("onboardos-api");
    expect(body.timestamp).toBeDefined();
  });

  it("unknown route returns 404 with NOT_FOUND code", async () => {
    const result = await httpHandler(makeEvent("GET /unknown"), makeContext()) as HttpResult;
    expect(result.statusCode).toBe(404);
    const body = JSON.parse(result.body);
    expect(body.code).toBe("NOT_FOUND");
    expect(body.requestId).toBe("test-request-id");
  });

  it("unhandled exception in route returns 500 with INTERNAL_ERROR code", async () => {
    // Craft an event whose routeKey will trigger the default branch, then monkey-patch
    // JSON.stringify to throw on the second call (body serialisation) to simulate an
    // unexpected runtime error inside the handler.
    const event = makeEvent("GET /health");
    const ctx = makeContext("req-500");

    const original = JSON.stringify.bind(JSON);
    let calls = 0;
    vi.spyOn(JSON, "stringify").mockImplementation((...args) => {
      calls++;
      if (calls === 1) throw new Error("simulated serialisation failure");
      return original(...(args as [unknown]));
    });

    const result = await httpHandler(event, ctx) as HttpResult;
    expect(result.statusCode).toBe(500);
    const body = JSON.parse(result.body);
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.requestId).toBe("req-500");

    vi.restoreAllMocks();
  });
});
