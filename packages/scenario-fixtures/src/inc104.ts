import type { LogEntry, ScenarioPublic } from "@onboardos/contracts";
import type { PublishedScenario } from "@onboardos/scenario-engine";

/**
 * INC-104 -- "Checkout API timeouts after a configuration change".
 *
 * Everything in this file is shown to the assigned employee. It deliberately
 * contains no hidden test cases, expected configuration values, or rubric
 * text: the runbook states the policy bound and the logs show observed
 * behavior; deriving a safe value is the employee's job. The test suite and
 * rubric are referenced by identifier only (below); their content lives in a
 * separate, server-only location that is NOT part of this package.
 *
 * This is a toy model used to exercise the evidence pipeline, not a claim that
 * real incidents are fixed by editing one number.
 */

const log = (
  timestamp: string,
  level: LogEntry["level"],
  service: string,
  message: string,
  extra: Pick<LogEntry, "upstreamLatencyMs" | "httpStatus"> = {},
): LogEntry => ({ timestamp, level, service, message, ...extra });

const DIAGNOSTIC_ENTRIES: LogEntry[] = [
  log("2026-11-06T13:58:02Z", "INFO", "config-service",
    "CHG-5521 applied to checkout-api: request_timeout_ms 3000 -> 800 (reason: reduce tail latency)"),
  log("2026-11-06T13:58:09Z", "INFO", "checkout-api",
    "config reloaded: request_timeout_ms=800"),
  log("2026-11-06T14:01:44Z", "INFO", "checkout-api",
    "GET /health 200 in 12ms", { httpStatus: 200 }),
  log("2026-11-06T14:02:11Z", "INFO", "payments-upstream",
    "POST /v2/authorize completed in 1243ms (order=ord_88213)", { upstreamLatencyMs: 1243, httpStatus: 200 }),
  log("2026-11-06T14:02:11Z", "ERROR", "checkout-api",
    "upstream request exceeded request_timeout_ms=800; returning 504 (order=ord_88213)", { httpStatus: 504 }),
  log("2026-11-06T14:03:27Z", "INFO", "payments-upstream",
    "POST /v2/authorize completed in 1388ms (order=ord_88219)", { upstreamLatencyMs: 1388, httpStatus: 200 }),
  log("2026-11-06T14:03:27Z", "ERROR", "checkout-api",
    "upstream request exceeded request_timeout_ms=800; returning 504 (order=ord_88219)", { httpStatus: 504 }),
  log("2026-11-06T14:05:02Z", "WARN", "checkout-api",
    "5xx rate over last 5m: 31.2% (baseline 0.4%)"),
  log("2026-11-06T14:06:40Z", "INFO", "payments-upstream",
    "POST /v2/authorize completed in 1561ms (order=ord_88231)", { upstreamLatencyMs: 1561, httpStatus: 200 }),
  log("2026-11-06T14:06:40Z", "ERROR", "checkout-api",
    "upstream request exceeded request_timeout_ms=800; returning 504 (order=ord_88231)", { httpStatus: 504 }),
  log("2026-11-06T14:08:15Z", "INFO", "payments-upstream",
    "POST /v2/authorize completed in 1297ms (order=ord_88240)", { upstreamLatencyMs: 1297, httpStatus: 200 }),
  log("2026-11-06T14:08:15Z", "ERROR", "checkout-api",
    "upstream request exceeded request_timeout_ms=800; returning 504 (order=ord_88240)", { httpStatus: 504 }),
  log("2026-11-06T14:09:58Z", "INFO", "payments-upstream",
    "POST /v2/authorize completed in 1206ms (order=ord_88252)", { upstreamLatencyMs: 1206, httpStatus: 200 }),
  log("2026-11-06T14:09:58Z", "ERROR", "checkout-api",
    "upstream request exceeded request_timeout_ms=800; returning 504 (order=ord_88252)", { httpStatus: 504 }),
  log("2026-11-06T14:11:30Z", "INFO", "payments-upstream",
    "latency summary (last 10m): p50=1310ms p95=1540ms max=1598ms; 0 upstream errors"),
  log("2026-11-06T14:12:03Z", "WARN", "checkout-api",
    "customer-facing checkout failures rising; see INC-104"),
];

export const INC_104_PUBLIC: ScenarioPublic = {
  scenarioId: "inc-104",
  version: 1,
  title: "INC-104: Checkout API timeouts",
  summary:
    "Checkout requests began failing with 504 responses shortly after a service configuration change. " +
    "Investigate the ticket, the runbook and the diagnostics.",
  ticket: {
    id: "INC-104",
    title: "Checkout API returning 504 Gateway Timeout",
    severity: "SEV2",
    status: "OPEN",
    service: "checkout-api",
    reportedAt: "2026-11-06T14:12:00Z",
    reporter: "Priya Raman (Customer Support)",
    description:
      "Since about 14:00 UTC a large share of checkout attempts fail with a 504. Customers can browse and add " +
      "to cart normally. Support has seen more than 40 affected orders in the last 15 minutes. The failures " +
      "began soon after a configuration change was applied to checkout-api. The payments provider reports " +
      "no incident on their side.",
    comments: [
      {
        author: "Priya Raman",
        at: "2026-11-06T14:13:00Z",
        body: "Customers see \"Something went wrong\" at the payment step. Orders are not being created.",
      },
      {
        author: "Dan Okafor (SRE on-call)",
        at: "2026-11-06T14:16:00Z",
        body:
          "CHG-5521 changed request_timeout_ms on checkout-api at 13:58. Rolling back is not an option " +
          "(the prior value was disabled by policy). We need the correct value within policy. " +
          "Please investigate and report your findings.",
      },
    ],
  },
  runbook: {
    id: "RB-CHECKOUT-TIMEOUT",
    title: "Runbook: checkout-api upstream timeouts",
    sections: [
      {
        heading: "Symptoms",
        body:
          "Elevated 504 responses from checkout-api while the payments provider reports healthy. " +
          "checkout-api logs show \"upstream request exceeded request_timeout_ms\".",
      },
      {
        heading: "Diagnosis",
        body:
          "1. Find when the 5xx rate began and compare it with recent configuration changes.\n" +
          "2. Compare checkout-api's request_timeout_ms with the latency the upstream actually takes " +
          "(see the payments-upstream completion lines).\n" +
          "3. A timeout shorter than normal upstream latency makes otherwise successful requests fail.",
      },
      {
        heading: "Configuration reference: request_timeout_ms",
        body:
          "The maximum time checkout-api waits for the payments upstream before returning 504.\n" +
          "Type: integer, milliseconds.\n" +
          "Approved range by policy: 100 to 2000 ms inclusive. Values outside this range are not permitted.\n" +
          "Choose a value that gives the upstream's observed latency reasonable headroom while staying " +
          "inside the approved range.",
      },
      {
        heading: "Reporting",
        body:
          "Record what you checked, the evidence you relied on, the change you propose and why. " +
          "Do not rely on guesses; cite the log lines and the policy range.",
      },
    ],
  },
  diagnostics: {
    id: "DIAG-INC-104",
    title: "checkout-api and payments-upstream diagnostics",
    source: "SYNTHETIC",
    notice:
      "Synthetic incident data generated for this exercise. These are NOT AWS CloudWatch logs and " +
      "do not come from any production system.",
    entries: DIAGNOSTIC_ENTRIES,
  },
  initialConfig: { request_timeout_ms: 800 },
};

/**
 * Published definition. The suite/rubric fields are IDENTIFIERS ONLY (they let
 * a later slice bind results to an exact suite version); they are not exposed
 * to employees and carry no test content.
 */
export const INC_104_V1: PublishedScenario = {
  content: INC_104_PUBLIC,
  testSuiteId: "inc-104-checkout-timeout",
  testSuiteVersion: 1,
  rubricVersion: 1,
};
