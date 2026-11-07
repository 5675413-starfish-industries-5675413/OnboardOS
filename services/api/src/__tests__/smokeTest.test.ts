import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "aws-lambda";

// ---------------------------------------------------------------------------
// Mock AWS SDK modules BEFORE importing the handler.
//
// Vitest 5 requires class-constructor mocks to use actual class syntax or
// a function constructor, not vi.fn(() => ({})) arrow factories.
//
// The mock strategy:
//  - DynamoDBClient is mocked as a class whose instances have no methods
//    (DynamoDBDocumentClient.from() is what we actually control).
//  - DynamoDBDocumentClient.from() returns an object whose `send` is the
//    shared `mockSend` function, allowing per-test control.
//  - Command constructors (DescribeTableCommand, PutCommand, etc.) tag the
//    command object with a `_type` discriminator so tests can inspect which
//    command was sent.
// ---------------------------------------------------------------------------

const mockSend = vi.fn();

vi.mock("@aws-sdk/client-dynamodb", () => {
  class DynamoDBClient {}
  const DescribeTableCommand = vi.fn(
    function (this: unknown, input: unknown) {
      (this as Record<string, unknown>)._type = "Describe";
      (this as Record<string, unknown>).input = input;
    },
  );
  return { DynamoDBClient, DescribeTableCommand };
});

vi.mock("@aws-sdk/lib-dynamodb", () => {
  const PutCommand = vi.fn(
    function (this: unknown, input: unknown) {
      (this as Record<string, unknown>)._type = "Put";
      (this as Record<string, unknown>).input = input;
    },
  );
  const GetCommand = vi.fn(
    function (this: unknown, input: unknown) {
      (this as Record<string, unknown>)._type = "Get";
      (this as Record<string, unknown>).input = input;
    },
  );
  const DeleteCommand = vi.fn(
    function (this: unknown, input: unknown) {
      (this as Record<string, unknown>)._type = "Delete";
      (this as Record<string, unknown>).input = input;
    },
  );
  const DynamoDBDocumentClient = {
    from: vi.fn(() => ({ send: mockSend })),
  };
  return { DynamoDBDocumentClient, PutCommand, GetCommand, DeleteCommand };
});

// Import the handler AFTER the mocks are declared (vi.mock is hoisted anyway)
import { smokeTestHandler } from "../smokeTest.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeContext(id = "test-req-id"): Context {
  return {
    awsRequestId: id,
    functionName: "smoke-fn",
    functionVersion: "$LATEST",
    invokedFunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:smoke-fn",
    memoryLimitInMB: "512",
    logGroupName: "/aws/lambda/smoke-fn",
    logStreamName: "stream",
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

describe("smokeTestHandler", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("ONBOARDOS_CORE_TABLE", "test-core-table");
    mockSend.mockReset();
  });

  it("returns ok=true and cleanupOk=true on a successful round-trip", async () => {
    const ctx = makeContext("req-success");
    mockSend.mockImplementation((cmd: { _type?: string }) => {
      switch (cmd._type) {
        case "Describe": return Promise.resolve({ Table: { TableStatus: "ACTIVE" } });
        case "Put":      return Promise.resolve({});
        case "Get":      return Promise.resolve({
          Item: { PK: `SMOKE#${ctx.awsRequestId}`, SK: "TEST", _smoke: true, _requestId: ctx.awsRequestId },
        });
        case "Delete":   return Promise.resolve({});
        default:         return Promise.resolve({});
      }
    });

    const result = await smokeTestHandler({}, ctx);

    expect(result.ok).toBe(true);
    expect(result.cleanupOk).toBe(true);
    expect(result.tableStatus).toBe("ACTIVE");
    expect(result.requestId).toBe(ctx.awsRequestId);
    expect(result.message).toContain("round-trip OK");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    // Four commands: Describe, Put, Get, Delete
    expect(mockSend).toHaveBeenCalledTimes(4);
  });

  it("returns ok=false with sanitized message when PutItem throws", async () => {
    const ctx = makeContext("req-put-fail");
    mockSend.mockImplementation((cmd: { _type?: string }) => {
      switch (cmd._type) {
        case "Describe": return Promise.resolve({ Table: { TableStatus: "ACTIVE" } });
        case "Put":      return Promise.reject(
          new Error("ConditionalCheckFailedException for arn:aws:dynamodb:us-east-1:123456789012:table/test"),
        );
        case "Delete":   return Promise.resolve({});
        default:         return Promise.resolve({});
      }
    });

    const result = await smokeTestHandler({}, ctx);

    expect(result.ok).toBe(false);
    expect(result.requestId).toBe(ctx.awsRequestId);
    // AWS account ID and ARN must be redacted
    expect(result.message).not.toContain("123456789012");
    expect(result.message).not.toContain("arn:aws");
    // Cleanup DeleteItem must have been attempted
    const callTypes = mockSend.mock.calls.map((c) => (c[0] as { _type?: string })._type);
    expect(callTypes).toContain("Delete");
  });

  it("returns ok=false when GetItem returns no item (data-corruption path)", async () => {
    const ctx = makeContext("req-get-miss");
    mockSend.mockImplementation((cmd: { _type?: string }) => {
      switch (cmd._type) {
        case "Describe": return Promise.resolve({ Table: { TableStatus: "ACTIVE" } });
        case "Put":      return Promise.resolve({});
        case "Get":      return Promise.resolve({ Item: undefined });
        case "Delete":   return Promise.resolve({});
        default:         return Promise.resolve({});
      }
    });

    const result = await smokeTestHandler({}, ctx);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("GetItem returned no item");
  });

  it("returns ok=false when GetItem returns item with wrong _smoke value", async () => {
    const ctx = makeContext("req-bad-smoke");
    mockSend.mockImplementation((cmd: { _type?: string }) => {
      switch (cmd._type) {
        case "Describe": return Promise.resolve({ Table: { TableStatus: "ACTIVE" } });
        case "Put":      return Promise.resolve({});
        case "Get":      return Promise.resolve({
          Item: { PK: `SMOKE#${ctx.awsRequestId}`, SK: "TEST", _smoke: false },
        });
        case "Delete":   return Promise.resolve({});
        default:         return Promise.resolve({});
      }
    });

    const result = await smokeTestHandler({}, ctx);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Validation failed");
    expect(result.message).toContain("_smoke");
  });

  it("marks ok=false and cleanupOk=false with warning when DeleteItem fails", async () => {
    const ctx = makeContext("req-cleanup-fail");
    mockSend.mockImplementation((cmd: { _type?: string }) => {
      switch (cmd._type) {
        case "Describe": return Promise.resolve({ Table: { TableStatus: "ACTIVE" } });
        case "Put":      return Promise.resolve({});
        case "Get":      return Promise.resolve({
          Item: { PK: `SMOKE#${ctx.awsRequestId}`, SK: "TEST", _smoke: true, _requestId: ctx.awsRequestId },
        });
        case "Delete":   return Promise.reject(new Error("ResourceNotFoundException"));
        default:         return Promise.resolve({});
      }
    });

    const result = await smokeTestHandler({}, ctx);

    // Round-trip succeeded but cleanup failed → ok must be false
    expect(result.ok).toBe(false);
    expect(result.cleanupOk).toBe(false);
    expect(result.message).toContain("cleanup DeleteItem failed");
    expect(result.requestId).toBe(ctx.awsRequestId);
  });

  it("returns ok=false immediately when ONBOARDOS_CORE_TABLE is not set", async () => {
    vi.unstubAllEnvs(); // removes the table name stubbed in beforeEach

    const ctx = makeContext("req-no-table");
    const result = await smokeTestHandler({}, ctx);

    expect(result.ok).toBe(false);
    expect(result.cleanupOk).toBe(false);
    expect(result.message).toContain("ONBOARDOS_CORE_TABLE");
    // No SDK calls should have been made
    expect(mockSend).not.toHaveBeenCalled();
  });
});
