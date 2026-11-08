/**
 * The reply verifier: it must withhold false statements about tests, results, saved values, actions, submission and approval,
 * and must leave truthful technical guidance alone. Both directions are tested, and the known blind spots are written down.
 * Pure function tests: no model, no AWS.
 */
import { describe, expect, it } from "vitest";
import { disposeReply, verifyReply, type VerifiedFacts } from "../evidenceVerifier.js";

const facts = (over: Partial<VerifiedFacts> = {}): VerifiedFacts => ({
  testRunsRequested: 0, currentRun: null, config: { request_timeout_ms: 1800 }, baseline: { request_timeout_ms: 800 }, configRevision: 1,
  phase: "INVESTIGATING", assignmentStatus: "IN_PROGRESS", ...over,
});
const NO_RUN = facts();
const PARTIAL = facts({ testRunsRequested: 1, currentRun: { status: "FAILED", passed: 3, total: 5 } });
const NONE_PASSED = facts({ testRunsRequested: 1, currentRun: { status: "FAILED", passed: 0, total: 5 } });
const ALL_PASSED = facts({ testRunsRequested: 1, currentRun: { status: "PASSED", passed: 5, total: 5 } });
const RUNNER_ERROR = facts({ testRunsRequested: 1, currentRun: { status: "ERROR", passed: 0, total: 0 } });
const kinds = (text: string, f: VerifiedFacts) => verifyReply(text, f).map((x) => x.kind);

describe("truthful technical guidance is NOT withheld", () => {
  const TRUTHFUL: Array<[string, string]> = [
    ["a recommendation naming the key", "Set request_timeout_ms to 2400 and run the tests in the app to see whether it helps."],
    ["a recommendation with an imperative", "Raise request_timeout_ms to 2000, which is the top of the policy range."],
    ["a policy range", "The policy keeps request_timeout_ms between 100 and 2000 milliseconds."],
    ["log narration with a check", "The health check passed at 09:01 according to the logs, so the upstream was reachable."],
    ["log narration with a returned status", "The upstream health check returned 504 for the first three requests in the incident logs."],
    ["a runbook list of checks", "The runbook lists 2 of 5 checks you can try first: the 5xx rate and the config change time."],
    ["a first-person walk-through", "I'll run through the evidence with you step by step."],
    ["a first-person structuring remark", "I set out the three options below."],
    ["a conditional about passing", "If your tests pass, the report is ready to submit."],
    ["a goal", "The goal is that all 5 checks pass once the timeout is above the upstream latency."],
    ["a question", "Did all the tests pass when you ran them?"],
    ["an honest limitation", "I can't run the tests for you, and no test result is shown yet."],
    ["old versus current value", "request_timeout_ms was 800 in the logs and is 1800 now."],
    ["the correct current value", "The saved request_timeout_ms is 1800."],
    ["an explicit equals", "request_timeout_ms = 1800 (saved revision 1)."],
    ["a hypothetical result", "If you saw 3 of 5 checks passed you would know the timeout is still too short."],
    ["advice about submission", "Submit your report when you are confident in the evidence."],
    ["a general technical statement", "A timeout shorter than the upstream latency makes requests fail even when the service is healthy."],
  ];
  it.each(TRUTHFUL)("%s", (_n, text) => {
    expect(kinds(text, NO_RUN)).toEqual([]);
  });

  it("partial success described as partial is true", () => {
    expect(kinds("Some of the checks passed; the timeout check failed.", PARTIAL)).toEqual([]);
    expect(kinds("3 of 5 checks passed, so you are close.", PARTIAL)).toEqual([]);
  });

  it("a real full pass can be stated", () => {
    expect(kinds("All 5 checks passed for your current configuration.", ALL_PASSED)).toEqual([]);
    expect(kinds("Your tests passed (5 of 5 checks passed).", ALL_PASSED)).toEqual([]);
  });

  it("having run tests can be said once a run was requested", () => {
    expect(kinds("You ran the tests already and 3 of 5 checks passed.", PARTIAL)).toEqual([]);
  });

  it("disposeReply shows a truthful answer unchanged and clips an over-long one without withholding", () => {
    const d = disposeReply({ text: "Set request_timeout_ms to 2400 and try again.", truncated: false }, NO_RUN, 8000);
    expect(d).toMatchObject({ visible: "ANSWER", truncated: false, text: "Set request_timeout_ms to 2400 and try again." });
    const long = disposeReply({ text: "a ".repeat(100), truncated: false }, NO_RUN, 50);
    expect(long).toMatchObject({ visible: "ANSWER", truncated: true });
    expect((long.text ?? "").length).toBe(50);
  });
});

describe("false statements are withheld", () => {
  it("no test run versus a claimed success", () => {
    expect(kinds("All tests passed.", NO_RUN)).toContain("TESTS_PASSED_WITHOUT_PASSING_RUN");
    expect(kinds("Your tests passed, nice work.", NO_RUN)).toContain("TESTS_PASSED_WITHOUT_PASSING_RUN");
    expect(kinds("The checks all came back green.", NO_RUN)).toContain("TESTS_PASSED_WITHOUT_PASSING_RUN");
    expect(kinds("5 of 5 checks passed.", NO_RUN)).toContain("CHECK_COUNT_MISMATCH");
  });

  it("actual partial success versus a false full success", () => {
    expect(kinds("All checks passed.", PARTIAL)).toContain("TESTS_PASSED_WITHOUT_PASSING_RUN");
    expect(kinds("Every test passed for your configuration.", PARTIAL)).toContain("TESTS_PASSED_WITHOUT_PASSING_RUN");
    expect(kinds("4 of 5 checks passed.", PARTIAL)).toContain("CHECK_COUNT_MISMATCH");
    expect(kinds("The tests passed.", NONE_PASSED)).toContain("TESTS_PASSED_WITHOUT_PASSING_RUN");
  });

  it("a runner error is not a pass", () => {
    expect(kinds("Your tests passed.", RUNNER_ERROR)).toContain("TESTS_PASSED_WITHOUT_PASSING_RUN");
  });

  it("a real pass is not misreported with the wrong count", () => {
    expect(kinds("3 of 5 checks passed.", ALL_PASSED)).toContain("CHECK_COUNT_MISMATCH");
  });

  it("tests claimed as run when none was requested", () => {
    expect(kinds("The tests ran and the result looks fine.", NO_RUN)).toContain("TESTS_RUN_WITHOUT_ANY_RUN");
    expect(kinds("You've already run the tests.", NO_RUN)).toContain("TESTS_RUN_WITHOUT_ANY_RUN");
  });

  it("a saved value stated wrongly, including the original production defect form", () => {
    expect(kinds("request_timeout_ms is 800.", NO_RUN)).toContain("CONFIG_VALUE_MISSTATED");
    expect(kinds("Compare `request_timeout_ms` (800) with upstream latency.", NO_RUN)).toContain("CONFIG_VALUE_MISSTATED");
    expect(kinds("The current request_timeout_ms is 77.", NO_RUN)).toContain("CONFIG_VALUE_MISSTATED");
  });

  it("incorrect AI action claims, in several forms", () => {
    for (const t of ["I ran the tests for you.", "I've saved the configuration.", "I'll run the tests now.", "I updated your timeout value.", "I submitted your report.", "I have applied the fix."]) {
      expect(kinds(t, NO_RUN), t).toContain("AI_CLAIMS_ACTION");
    }
  });

  it("submission and approval states", () => {
    expect(kinds("Your report has been submitted.", NO_RUN)).toContain("SUBMITTED_WITHOUT_SUBMISSION");
    expect(kinds("Your submission was approved.", facts({ phase: "SUBMITTED", assignmentStatus: "AWAITING_REVIEW" }))).toContain("APPROVED_WITHOUT_APPROVAL");
    expect(kinds("Your report has been submitted.", facts({ phase: "SUBMITTED" }))).toEqual([]);
    expect(kinds("Your submission was approved.", facts({ phase: "SUBMITTED", assignmentStatus: "APPROVED" }))).toEqual([]);
  });

  it("returns only kinds, never reply text", () => {
    expect(JSON.stringify(verifyReply("All tests passed. The secret-token-xyz.", NO_RUN))).not.toContain("secret-token-xyz");
  });
});

describe("DOCUMENTED LIMITS: what this check does NOT catch (false negatives), and its known cost (false positives)", () => {
  it("false negatives: paraphrase, other languages, unkeyed values, log-worded claims, other falsehoods", () => {
    expect(kinds("Everything is green on your side.", NO_RUN)).toEqual([]);
    expect(kinds("Alle Tests sind bestanden.", NO_RUN)).toEqual([]);
    expect(kinds("The timeout is currently 800 ms.", NO_RUN)).toEqual([]); // no key name, so no structured comparison
    expect(kinds("According to the incident logs the checks passed at 09:01.", NO_RUN)).toEqual([]); // log wording exempts a sentence that is not about the employee's own work
    expect(kinds("According to the logs the checks passed for your configuration.", NO_RUN)).toContain("TESTS_PASSED_WITHOUT_PASSING_RUN"); // ...but addressing "your" work is not exempt
    expect(kinds("The upstream service is owned by the payments team.", NO_RUN)).toEqual([]); // no structured data for this
    expect(kinds("2 of 5 checks failed.", PARTIAL)).toEqual([]); // failure counts are not compared
  });

  it("false positives that remain by design: a sentence worded as a flat claim is withheld even if the writer meant it loosely", () => {
    // 'tests passed' in the employee's own work with no run is a flat claim and is withheld; the employee can ask again.
    expect(kinds("Your tests passed in my head.", NO_RUN)).toContain("TESTS_PASSED_WITHOUT_PASSING_RUN");
    expect(kinds("I'll change the value to 1500 for you.", NO_RUN)).toContain("AI_CLAIMS_ACTION");
  });
});
