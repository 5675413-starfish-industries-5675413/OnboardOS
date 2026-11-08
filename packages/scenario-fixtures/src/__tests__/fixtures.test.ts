import { describe, it, expect } from "vitest";
import { ScenarioPublicSchema } from "@onboardos/contracts";
import {
  INC_104_V1,
  PUBLISHED_SCENARIOS,
  getLatestPublished,
  getPublishedScenario,
} from "../index.js";

describe("INC-104 published definition", () => {
  it("conforms to the shared public contract", () => {
    expect(ScenarioPublicSchema.safeParse(INC_104_V1.content).success).toBe(true);
  });

  it("starts with the specified config and nothing else", () => {
    expect(INC_104_V1.content.initialConfig).toEqual({ request_timeout_ms: 800 });
  });

  it("is version 1 of scenario inc-104 with the documented ids", () => {
    expect(INC_104_V1.content).toMatchObject({ scenarioId: "inc-104", version: 1 });
    expect(INC_104_V1.content.ticket.id).toBe("INC-104");
    expect(INC_104_V1.content.runbook.id).toBe("RB-CHECKOUT-TIMEOUT");
    expect(INC_104_V1.content.diagnostics.id).toBe("DIAG-INC-104");
  });

  it("labels diagnostics as synthetic and says they are not AWS logs", () => {
    const d = INC_104_V1.content.diagnostics;
    expect(d.source).toBe("SYNTHETIC");
    expect(d.notice).toMatch(/not aws cloudwatch|NOT AWS/i);
  });

  it("states the approved range (100-2000 ms) in the runbook", () => {
    const text = INC_104_V1.content.runbook.sections.map((s) => s.body).join("\n");
    expect(text).toMatch(/100 to 2000/);
  });

  it("includes upstream latencies between 1200 and 1600 ms", () => {
    const lat = INC_104_V1.content.diagnostics.entries
      .map((e) => e.upstreamLatencyMs)
      .filter((n): n is number => typeof n === "number");
    expect(lat.length).toBeGreaterThanOrEqual(5);
    for (const n of lat) {
      expect(n).toBeGreaterThanOrEqual(1200);
      expect(n).toBeLessThanOrEqual(1600);
    }
  });
});

describe("secrecy boundary: no hidden test or rubric content in the employee-visible definition", () => {
  const visible = JSON.stringify(INC_104_V1.content);

  it("does not contain words that would indicate answers, hidden cases or rubric text", () => {
    for (const forbidden of [/expected/i, /hidden/i, /rubric/i, /answer/i, /solution/i, /passing/i, /\bgrader\b/i]) {
      expect(visible).not.toMatch(forbidden);
    }
  });

  it("does not hand the employee a final value: no 'request_timeout_ms' target is stated", () => {
    // The initial 800 is the broken starting config. No other candidate value may be
    // asserted as correct anywhere in the visible content.
    const asserted = [...visible.matchAll(/request_timeout_ms\s*(?:=|:|to)\s*(\d+)/g)].map((m) => m[1]);
    for (const v of asserted) expect(["800", "3000"]).toContain(v);
  });

  it("keeps suite and rubric as identifiers only, outside the visible content", () => {
    expect(INC_104_V1.testSuiteId).toBe("inc-104-checkout-timeout");
    expect(Object.keys(INC_104_V1).sort()).toEqual(["content", "rubricVersion", "testSuiteId", "testSuiteVersion"]);
    expect(visible).not.toContain("inc-104-checkout-timeout");
  });
});

describe("registry", () => {
  it("resolves an exact version and the latest published version", () => {
    expect(getPublishedScenario("inc-104", 1)).toBe(INC_104_V1);
    expect(getLatestPublished("inc-104")).toBe(INC_104_V1);
  });

  it("returns undefined for unknown ids and versions", () => {
    expect(getPublishedScenario("inc-104", 2)).toBeUndefined();
    expect(getPublishedScenario("nope", 1)).toBeUndefined();
    expect(getLatestPublished("nope")).toBeUndefined();
  });

  it("is immutable: published definitions cannot be altered at runtime", () => {
    expect(Object.isFrozen(PUBLISHED_SCENARIOS)).toBe(true);
    expect(Object.isFrozen(INC_104_V1.content.initialConfig)).toBe(true);
    expect(() => {
      (INC_104_V1.content.initialConfig as { request_timeout_ms: number }).request_timeout_ms = 1;
    }).toThrow();
  });
});
