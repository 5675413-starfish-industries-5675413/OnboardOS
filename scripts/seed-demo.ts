#!/usr/bin/env npx tsx
/**
 * seed-demo.ts -- operator-run provisioning of the three AWS demo
 * identities (org_admin, manager, employee).
 *
 * This is NEVER run by the build, tests, CI, or deployment. An operator runs it
 * by hand, after the stack is deployed.
 *
 * USAGE
 *   # 1. Plan only (default). Makes NO AWS calls.
 *   STACK_NAME=onboardos-dev AWS_REGION=us-east-1 npx tsx scripts/seed-demo.ts
 *
 *   # 2. Create the users + DynamoDB membership records (create-if-absent only).
 *   STACK_NAME=... AWS_REGION=... npx tsx scripts/seed-demo.ts --apply
 *
 *   # 3. ...and set permanent passwords at a hidden interactive prompt.
 *   STACK_NAME=... AWS_REGION=... npx tsx scripts/seed-demo.ts --apply --set-passwords
 *
 * FLAGS
 *   --apply           Required for any AWS call. Prompts you to type the stack
 *                     name to confirm unless --yes is also given.
 *   --set-passwords   Prompt (hidden, entered twice) for a permanent password for
 *                     each account that has no usable password yet. Needs a TTY.
 *   --yes             Skip the typed confirmation (non-interactive --apply).
 *
 * ENVIRONMENT
 *   STACK_NAME        Required. CloudFormation stack to read outputs from.
 *   AWS_REGION        Required (AWS_DEFAULT_REGION also accepted). No default, so
 *                     the script can never act in an unintended region.
 *   AWS credentials   From your shell (e.g. Workshop Studio). Never read from, or
 *                     written to, any file by this script.
 *   ADMIN_EMAIL / MANAGER_EMAIL / EMPLOYEE_EMAIL   Optional email overrides.
 *   DEMO_ORG_ID       Optional safety check only: must equal the stack's DemoOrgId
 *                     output, otherwise the script aborts.
 *
 * CREDENTIAL HANDLING
 *   Passwords are never generated, read from env/argv/files, logged, or stored.
 *   They are typed at a hidden prompt and sent directly to Cognito. Without
 *   --set-passwords, new users have no usable password at all.
 *
 * IAM PERMISSIONS THE OPERATOR NEEDS
 *   cloudformation:DescribeStacks  (the stack)
 *   cognito-idp:AdminGetUser, AdminCreateUser, AdminSetUserPassword  (the user pool)
 *   dynamodb:GetItem, dynamodb:PutItem  (the Core table)
 *
 * CLEANUP
 *   Delete users with `aws cognito-idp admin-delete-user`, or delete the stack
 *   (the user pool and tables are removed with it).
 */

import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createInterface } from "node:readline/promises";
import {
  buildDemoUsers,
  seedDemo,
  validatePassword,
  type Logger,
} from "./lib/seedDemo.js";

// ---------------------------------------------------------------------------
// Terminal helpers
// ---------------------------------------------------------------------------

const log: Logger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
};

/** Read a line from the terminal WITHOUT echoing it. Requires a TTY. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error("A terminal (TTY) is required for hidden password entry"));
      return;
    }
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let buffer = "";
    const finish = (): void => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\u0003") {            // Ctrl-C
          finish();
          reject(new Error("Cancelled"));
          return;
        }
        if (ch === "\r" || ch === "\n") { // Enter
          finish();
          resolve(buffer);
          return;
        }
        if (ch === "\u007f" || ch === "\b") { // Backspace
          buffer = buffer.slice(0, -1);
          continue;
        }
        buffer += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function promptNewPassword(email: string): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const first = await promptHidden(`  New password for ${email}: `);
    const problem = validatePassword(first);
    if (problem) {
      console.log(`  Password ${problem}.`);
      continue;
    }
    const second = await promptHidden("  Confirm password: ");
    if (first !== second) {
      console.log("  Passwords do not match.");
      continue;
    }
    return first;
  }
  throw new Error("Too many invalid attempts");
}

async function confirmStackName(stackName: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Type the stack name (${stackName}) to confirm: `);
    return answer.trim() === stackName;
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const KNOWN_FLAGS = new Set(["--apply", "--set-passwords", "--yes", "--help"]);

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => !KNOWN_FLAGS.has(a));
  if (unknown.length > 0 || args.includes("--help")) {
    console.error(`${unknown.length ? `Unknown argument(s): ${unknown.join(" ")}\n` : ""}` +
      "Usage: STACK_NAME=<stack> AWS_REGION=<region> npx tsx scripts/seed-demo.ts " +
      "[--apply] [--set-passwords] [--yes]\nSee the header of scripts/seed-demo.ts for details.");
    return unknown.length > 0 ? 2 : 0;
  }
  const apply = args.includes("--apply");
  const setPasswords = args.includes("--set-passwords");
  const assumeYes = args.includes("--yes");

  const stackName = process.env["STACK_NAME"];
  const region = process.env["AWS_REGION"] ?? process.env["AWS_DEFAULT_REGION"];
  if (!stackName) {
    console.error("ERROR: STACK_NAME is required.");
    return 2;
  }
  if (!region) {
    console.error("ERROR: AWS_REGION is required (no default, to avoid acting in the wrong region).");
    return 2;
  }
  if (setPasswords && !apply) {
    console.error("ERROR: --set-passwords requires --apply.");
    return 2;
  }
  if (setPasswords && !process.stdin.isTTY) {
    console.error("ERROR: --set-passwords needs an interactive terminal for hidden entry.");
    return 2;
  }

  const users = buildDemoUsers({
    admin: process.env["ADMIN_EMAIL"],
    manager: process.env["MANAGER_EMAIL"],
    employee: process.env["EMPLOYEE_EMAIL"],
  });

  console.log(`\n=== OnboardOS demo provisioning ${apply ? "(APPLY)" : "(PLAN ONLY -- no AWS calls)"} ===`);
  console.log(`Stack:  ${stackName}`);
  console.log(`Region: ${region}`);
  for (const u of users) console.log(`  ${u.role.padEnd(10)} ${u.email}`);
  console.log("Behavior: create-if-absent only; existing users/records are never modified.\n");

  if (!apply) {
    console.log("Plan only. Re-run with --apply to create users and memberships,");
    console.log("and add --set-passwords to set permanent passwords at a hidden prompt.");
    return 0;
  }

  // ---- Read stack outputs (read-only) --------------------------------------
  const cfn = new CloudFormationClient({ region });
  const described = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const outputs = Object.fromEntries(
    (described.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey ?? "", o.OutputValue ?? ""]),
  );
  const userPoolId = outputs["UserPoolId"];
  const coreTable = outputs["CoreTableName"];
  const orgId = outputs["DemoOrgId"];
  if (!userPoolId || !coreTable || !orgId) {
    console.error("ERROR: stack is missing required outputs: UserPoolId, CoreTableName, DemoOrgId.");
    console.error("       Has the Phase 2A template been deployed to this stack?");
    return 1;
  }
  const requestedOrg = process.env["DEMO_ORG_ID"];
  if (requestedOrg && requestedOrg !== orgId) {
    console.error(`ERROR: DEMO_ORG_ID "${requestedOrg}" does not match the stack's DemoOrgId "${orgId}".`);
    console.error("       The API Lambda only serves the stack's organization; refusing to seed another.");
    return 1;
  }

  console.log(`User pool:  ${userPoolId}`);
  console.log(`Core table: ${coreTable}`);
  console.log(`Org ID:     ${orgId}\n`);

  if (!assumeYes && !(await confirmStackName(stackName))) {
    console.error("Not confirmed (stack name did not match, or no terminal). Nothing was changed.");
    return 1;
  }

  // ---- Provision ------------------------------------------------------------
  const summary = await seedDemo(
    {
      cognito: new CognitoIdentityProviderClient({ region }),
      dynamo: DynamoDBDocumentClient.from(new DynamoDBClient({ region })),
      log,
    },
    { userPoolId, coreTable, orgId },
    users,
    { setPasswords, promptPassword: setPasswords ? promptNewPassword : undefined },
  );

  console.log("\n=== Summary ===");
  for (const u of summary.users) {
    console.log(
      `  ${u.role.padEnd(10)} cognito=${u.cognito} membership=${u.membership} password=${u.passwordSet}`,
    );
  }
  if (summary.failures > 0) {
    console.error(`\n${summary.failures} step(s) failed. Fix the cause and re-run; completed steps are skipped.`);
    return 1;
  }
  if (!setPasswords) {
    console.log("\nNew accounts have NO usable password yet. Re-run with --apply --set-passwords");
    console.log("to set them at a hidden prompt (already-set accounts are left untouched).");
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    // Print only the error name/message; SDK errors do not contain credentials.
    console.error("Provisioning failed:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
