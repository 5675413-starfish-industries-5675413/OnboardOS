#!/usr/bin/env npx tsx
/**
 * eval-coworker-v31.ts -- the bounded, pinned evaluation of coworker prompt v3.1 against ONE named model at a time.
 * IT HAS NOT BEEN EXECUTED against a model. The default makes NO AWS calls and NO Bedrock calls.
 *
 *   npx tsx scripts/eval-coworker-v31.ts                 # dry run (same as --dry-run)
 *   npx tsx scripts/eval-coworker-v31.ts --help
 *   npx tsx scripts/eval-coworker-v31.ts --apply-review <results.json> <review.json>    # offline, zero calls
 *   npx tsx scripts/eval-coworker-v31.ts --execute-paid-bedrock-inference --model=<id> --max-calls=26   # PAID: needs separate authorization
 *
 * Paid mode: 26 sequential Converse calls (one per model case; 3 of the 29 cases are answered by the platform and make no call) to the one named allow-listed model in us-east-1 with production
 * inference settings, using the AWS credentials already in your shell (participant credentials; the deployed API role is not
 * involved). Required permission: bedrock:InvokeModel on that one model. Nothing else is read or written in AWS.
 * Output: eval-output/coworker-v3.1/ (gitignored). A second run of the same model is refused while its EXECUTED-<model>.lock
 * exists; the v2 and v3 evaluations' locks and artifacts are never read or written.
 *
 * It does not sign in as an employee, does not call OnboardOS endpoints, and does not touch Cognito, DynamoDB, CloudFormation,
 * IAM, Vercel or the scenario runner. See scripts/lib/evalCoworkerV3.ts for the enforced limits.
 */
import { BedrockConverseProvider, createBedrockClient } from "../services/api/src/bedrock.js";
import { EVAL_V31_REGION } from "../services/api/src/evals/coworkerEvalV31.js";
import { applyReview, buildPlan, execute, parseArgs, renderGate, renderPlan } from "./lib/evalCoworkerV31.js";

const HELP = `Usage:
  npx tsx scripts/eval-coworker-v31.ts [--dry-run]                       plan only, no calls
  npx tsx scripts/eval-coworker-v31.ts --apply-review <results> <review>  recompute the gate from a review, no calls
  npx tsx scripts/eval-coworker-v31.ts --execute-paid-bedrock-inference --model=<allow-listed id> --max-calls=26   PAID, needs separate authorization`;

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
      const run = await execute({
        root: process.cwd(),
        runId: new Date().toISOString().replace(/[:.]/g, "-"),
        model: cmd.model,
        env: process.env,
        makeProvider: () => new BedrockConverseProvider(createBedrockClient(EVAL_V31_REGION), cmd.model),
        clock: () => Date.now(),
        out: (l) => console.log(l),
      });
      console.log(renderGate(run.gate!));
      console.log(`results: eval-output/coworker-v3.1/${run.runId}-*/results.json   review template: .../review.json`);
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
