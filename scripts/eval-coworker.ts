#!/usr/bin/env npx tsx
/**
 * eval-coworker.ts -- the FROZEN, bounded evaluation of coworker prompt v2 against the real model.
 *
 * Default and --dry-run make NO AWS calls and NO Bedrock calls. They print the plan and exit.
 *
 *   npx tsx scripts/eval-coworker.ts                 # dry run (same as --dry-run)
 *   npx tsx scripts/eval-coworker.ts --help
 *   npx tsx scripts/eval-coworker.ts --apply-review <results.json> <review.json>    # offline, zero calls
 *   npx tsx scripts/eval-coworker.ts --execute-paid-bedrock-inference --max-calls=12   # PAID: needs separate authorization
 *
 * Paid mode: 12 sequential Converse calls (one per case) to amazon.nova-micro-v1:0 in us-east-1 with production
 * inference settings, using the AWS credentials already in your shell. Required permission: bedrock:InvokeModel on
 * that one model. Nothing else is read or written in AWS. Output: eval-output/coworker-v2/ (gitignored).
 * A second paid run is refused while eval-output/coworker-v2/EXECUTED.lock exists.
 *
 * It does not sign in as an employee, does not call OnboardOS endpoints, and does not touch Cognito, DynamoDB,
 * CloudFormation, Vercel or the scenario runner. See scripts/lib/evalCoworker.ts for the enforced limits.
 */
import { BedrockConverseProvider, createBedrockClient } from "../services/api/src/bedrock.js";
import { EVAL_MODEL_ID, EVAL_REGION } from "../services/api/src/evals/coworkerEval.js";
import { applyReview, buildPlan, execute, parseArgs, renderGate, renderPlan, PAID_COMMAND } from "./lib/evalCoworker.js";

const HELP = `Usage:
  npx tsx scripts/eval-coworker.ts [--dry-run]                      plan only, no calls
  npx tsx scripts/eval-coworker.ts --apply-review <results> <review>  recompute the gate from a human review, no calls
  ${PAID_COMMAND}   PAID, needs separate authorization`;

async function main(): Promise<number> {
  const cmd = parseArgs(process.argv.slice(2));
  switch (cmd.mode) {
    case "help":
      console.log(HELP);
      return 0;
    case "error":
      console.error(cmd.message);
      return 2;
    case "dry-run": {
      const plan = buildPlan();
      console.log(renderPlan(plan));
      return plan.suiteFingerprint.matches && plan.requestsFingerprint.matches && plan.cases.every((c) => c.structuralFailures.length === 0) ? 0 : 1;
    }
    case "apply-review": {
      const { gate, outPath } = applyReview(cmd.results, cmd.review);
      console.log(renderGate(gate));
      console.log(`written: ${outPath}`);
      return gate.overall === "PASS" ? 0 : 1;
    }
    case "execute": {
      const root = process.cwd();
      const run = await execute({
        root,
        runId: new Date().toISOString().replace(/[:.]/g, "-"),
        env: process.env,
        makeProvider: () => new BedrockConverseProvider(createBedrockClient(EVAL_REGION), EVAL_MODEL_ID),
        clock: () => Date.now(),
        out: (l) => console.log(l),
      });
      console.log(renderGate(run.gate!));
      console.log(`results: eval-output/coworker-v2/${run.runId}/results.json   review template: .../review.json`);
      if (run.stoppedEarly) console.error(run.stoppedEarly);
      return run.complete ? 0 : 1;
    }
  }
}

main().then(
  (code) => { process.exitCode = code; },
  (err: unknown) => {
    // Only the message of OUR OWN guard errors is printed; nothing from the environment, request or credentials.
    console.error(err instanceof Error ? err.message : "failed");
    process.exitCode = 1;
  },
);
