/**
 * @onboardos/contracts — public Zod schemas and TypeScript types.
 *
 * SECURITY BOUNDARY: This package is imported by both the frontend (apps/web)
 * and the backend (services/api). It MUST NOT contain:
 *   - Hidden test cases or expected answers
 *   - Manager-only rubrics or grading criteria
 *   - AWS credentials, ARNs, or internal resource identifiers
 *   - Staff-only annotations or administrative fields
 *
 * Every exported type here is visible to the browser bundle.
 */

export * from "./apiError.js";
export * from "./membership.js";
export * from "./me.js";
export * from "./scenario.js";
export * from "./assignment.js";
export * from "./testRun.js";
export * from "./submission.js";
export * from "./review.js";
export * from "./coworker.js";
export * from "./session.js";
