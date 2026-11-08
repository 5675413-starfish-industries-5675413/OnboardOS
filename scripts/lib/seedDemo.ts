/**
 * Provisioning logic for the AWS demo identities.
 *
 * This module has NO side effects on import and never reads process.env,
 * process.argv, or the terminal -- everything is injected. The CLI wrapper
 * (scripts/seed-demo.ts) owns all I/O so this logic can be unit-tested with
 * fake AWS clients and no network access.
 *
 * Credential rules enforced here:
 *  - A password is NEVER generated, defaulted, logged, or returned by this
 *    module. New Cognito users are created WITHOUT a TemporaryPassword, so
 *    Cognito assigns a random one nobody sees (MessageAction SUPPRESS means it
 *    is not emailed either). The account is unusable until an operator sets a
 *    permanent password.
 *  - Permanent passwords arrive only through the injected `promptPassword`
 *    callback and go straight to the Cognito SDK call.
 *  - Existing users and records are never overwritten.
 */

import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  MessageActionType,
  type CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { GetCommand, PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DemoRole = "org_admin" | "manager" | "employee";

export interface DemoUser {
  email: string;
  preferredUsername: string;
  role: DemoRole;
  teamIds: string[];
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
}

export type CognitoLike = Pick<CognitoIdentityProviderClient, "send">;
export type DynamoLike = Pick<DynamoDBDocumentClient, "send">;

export interface SeedTarget {
  userPoolId: string;
  coreTable: string;
  orgId: string;
}

export interface SeedOptions {
  /** When true, prompt for and set permanent passwords for unusable accounts. */
  setPasswords: boolean;
  /** Hidden-input prompt supplied by the CLI. Required when setPasswords is true. */
  promptPassword?: (email: string) => Promise<string>;
}

export type UserOutcome =
  | "created"
  | "already-existed"
  | "failed";

export interface SeedSummary {
  users: Array<{
    email: string;
    role: DemoRole;
    cognito: UserOutcome;
    membership: "created" | "already-existed" | "skipped" | "failed";
    passwordSet: "set" | "not-needed" | "not-requested" | "failed";
  }>;
  failures: number;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Mirrors the User Pool PasswordPolicy in infrastructure/template.yaml. */
export const PASSWORD_MIN_LENGTH = 12;

/** Returns a human-readable problem, or null if the password meets the policy. */
export function validatePassword(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (!/[A-Z]/.test(password)) return "must contain an uppercase letter";
  if (!/[a-z]/.test(password)) return "must contain a lowercase letter";
  if (!/[0-9]/.test(password)) return "must contain a number";
  return null;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Build the three demo identities, allowing operator email overrides. */
export function buildDemoUsers(
  overrides: { admin?: string; manager?: string; employee?: string } = {},
): DemoUser[] {
  const users: DemoUser[] = [
    {
      email: (overrides.admin ?? "admin@northstar-demo.example").trim().toLowerCase(),
      preferredUsername: "admin",
      role: "org_admin",
      teamIds: [],
    },
    {
      email: (overrides.manager ?? "manager@northstar-demo.example").trim().toLowerCase(),
      preferredUsername: "manager",
      role: "manager",
      teamIds: ["cloud-team-1"],
    },
    {
      email: (overrides.employee ?? "employee@northstar-demo.example").trim().toLowerCase(),
      preferredUsername: "John Doe",
      role: "employee",
      teamIds: ["cloud-team-1"],
    },
  ];

  for (const u of users) {
    if (!EMAIL_PATTERN.test(u.email)) {
      throw new Error(`Invalid email address for ${u.role}: "${u.email}"`);
    }
  }
  if (new Set(users.map((u) => u.email)).size !== users.length) {
    // Two roles on one identity would silently collapse into one membership.
    throw new Error("Demo user emails must be distinct (one identity per role).");
  }
  return users;
}

function errorName(err: unknown): string {
  return typeof err === "object" && err !== null && "name" in err
    ? String((err as { name: unknown }).name)
    : "UnknownError";
}

/** Abbreviate a Cognito sub for logs; the full value is not needed there. */
function shortSub(sub: string): string {
  return `${sub.slice(0, 8)}...`;
}

// ---------------------------------------------------------------------------
// Cognito
// ---------------------------------------------------------------------------

export interface CognitoUserState {
  sub: string;
  created: boolean;
  /** Cognito UserStatus, e.g. FORCE_CHANGE_PASSWORD (no usable password) or CONFIRMED. */
  status: string;
}

/** Create the user if absent. Never modifies an existing user. */
export async function ensureCognitoUser(
  cognito: CognitoLike,
  userPoolId: string,
  user: DemoUser,
  log: Logger,
): Promise<CognitoUserState> {
  try {
    const existing = await cognito.send(
      new AdminGetUserCommand({ UserPoolId: userPoolId, Username: user.email }),
    );
    const sub = existing.UserAttributes?.find((a) => a.Name === "sub")?.Value;
    if (!sub) throw new Error(`Existing Cognito user ${user.email} has no sub attribute`);
    log.info(`  Cognito: ${user.email} already exists (sub ${shortSub(sub)}); not modified`);
    return { sub, created: false, status: existing.UserStatus ?? "UNKNOWN" };
  } catch (err) {
    if (errorName(err) !== "UserNotFoundException") throw err;
  }

  // No TemporaryPassword on purpose: Cognito generates a random one that is
  // never shown or emailed (SUPPRESS), so nobody can sign in until an operator
  // sets a permanent password.
  const created = await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: user.email,
      MessageAction: MessageActionType.SUPPRESS,
      UserAttributes: [
        { Name: "email", Value: user.email },
        { Name: "email_verified", Value: "true" },
        { Name: "preferred_username", Value: user.preferredUsername },
      ],
    }),
  );
  const sub = created.User?.Attributes?.find((a) => a.Name === "sub")?.Value;
  if (!sub) throw new Error(`Cognito did not return a sub for ${user.email}`);
  log.info(`  Cognito: created ${user.email} (sub ${shortSub(sub)}); no usable password yet`);
  return { sub, created: true, status: created.User?.UserStatus ?? "FORCE_CHANGE_PASSWORD" };
}

/**
 * Set a permanent password. The password is passed straight to the SDK and is
 * never logged; only the error NAME is surfaced on failure.
 */
export async function setPermanentPassword(
  cognito: CognitoLike,
  userPoolId: string,
  email: string,
  password: string,
): Promise<void> {
  const problem = validatePassword(password);
  if (problem) throw new Error(`Password ${problem}`);
  try {
    await cognito.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: userPoolId,
        Username: email,
        Password: password,
        Permanent: true,
      }),
    );
  } catch (err) {
    // Deliberately drop err.message: keep the secret out of any log path.
    throw new Error(`Cognito rejected the password (${errorName(err)})`);
  }
}

// ---------------------------------------------------------------------------
// DynamoDB
// ---------------------------------------------------------------------------

function isConditionalFailure(err: unknown): boolean {
  return errorName(err) === "ConditionalCheckFailedException";
}

export async function ensureOrganizationProfile(
  dynamo: DynamoLike,
  table: string,
  orgId: string,
  log: Logger,
): Promise<void> {
  const key = { PK: `ORG#${orgId}`, SK: "PROFILE" };
  const existing = await dynamo.send(
    new GetCommand({ TableName: table, Key: key, ConsistentRead: true }),
  );
  if (existing.Item) {
    log.info(`  DynamoDB: organization profile ${orgId} already exists; not modified`);
    return;
  }
  try {
    await dynamo.send(
      new PutCommand({
        TableName: table,
        Item: {
          ...key,
          organizationId: orgId,
          name: "AWS",
          createdAt: new Date().toISOString(),
          seeded: true,
        },
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
    log.info(`  DynamoDB: created organization profile ${orgId}`);
  } catch (err) {
    if (!isConditionalFailure(err)) throw err;
    log.info(`  DynamoDB: organization profile ${orgId} was created concurrently; not modified`);
  }
}

/** Create the membership if absent. Never overwrites an existing record. */
export async function ensureMembership(
  dynamo: DynamoLike,
  table: string,
  orgId: string,
  userSub: string,
  user: DemoUser,
  log: Logger,
): Promise<"created" | "already-existed"> {
  const key = { PK: `ORG#${orgId}`, SK: `MEMBER#${userSub}` };
  const existing = await dynamo.send(
    new GetCommand({ TableName: table, Key: key, ConsistentRead: true }),
  );
  if (existing.Item) {
    const existingRole = existing.Item["role"];
    if (existingRole !== user.role) {
      log.warn(
        `  DynamoDB: membership for ${user.email} exists with role "${String(existingRole)}" ` +
          `(wanted "${user.role}"); NOT modified`,
      );
    } else {
      log.info(`  DynamoDB: membership for ${user.email} (${user.role}) already exists; not modified`);
    }
    return "already-existed";
  }
  try {
    await dynamo.send(
      new PutCommand({
        TableName: table,
        Item: {
          ...key,
          organizationId: orgId,
          userSub,
          role: user.role,
          status: "ACTIVE",
          teamIds: user.teamIds,
          email: user.email,
          preferredUsername: user.preferredUsername,
          createdAt: new Date().toISOString(),
          seeded: true,
        },
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
  } catch (err) {
    if (!isConditionalFailure(err)) throw err;
    log.info(`  DynamoDB: membership for ${user.email} was created concurrently; not modified`);
    return "already-existed";
  }
  log.info(`  DynamoDB: created membership ${user.email} -> ${user.role} in ${orgId}`);
  return "created";
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Provision all demo users. A failure for one user is recorded and does not
 * stop the others; the caller should exit non-zero if `failures > 0`.
 * Re-running is safe: every step is create-if-absent.
 */
export async function seedDemo(
  deps: { cognito: CognitoLike; dynamo: DynamoLike; log: Logger },
  target: SeedTarget,
  users: DemoUser[],
  options: SeedOptions,
): Promise<SeedSummary> {
  const { cognito, dynamo, log } = deps;
  if (options.setPasswords && !options.promptPassword) {
    throw new Error("setPasswords requires a promptPassword callback");
  }

  const summary: SeedSummary = { users: [], failures: 0 };

  log.info(">>> Organization profile");
  try {
    await ensureOrganizationProfile(dynamo, target.coreTable, target.orgId, log);
  } catch (err) {
    // Without a profile the memberships would show the raw org id as its name;
    // treat it as a failure but continue so the operator sees every problem.
    log.warn(`  DynamoDB: could not ensure organization profile (${errorName(err)})`);
    summary.failures++;
  }

  for (const user of users) {
    log.info(`>>> ${user.role}: ${user.email}`);
    const row: SeedSummary["users"][number] = {
      email: user.email,
      role: user.role,
      cognito: "failed",
      membership: "skipped",
      passwordSet: options.setPasswords ? "not-needed" : "not-requested",
    };
    summary.users.push(row);

    let state: CognitoUserState;
    try {
      state = await ensureCognitoUser(cognito, target.userPoolId, user, log);
      row.cognito = state.created ? "created" : "already-existed";
    } catch (err) {
      log.warn(`  Cognito: failed for ${user.email} (${errorName(err)})`);
      summary.failures++;
      continue;
    }

    try {
      row.membership = await ensureMembership(
        dynamo, target.coreTable, target.orgId, state.sub, user, log,
      );
    } catch (err) {
      row.membership = "failed";
      log.warn(`  DynamoDB: membership failed for ${user.email} (${errorName(err)})`);
      summary.failures++;
    }

    // Only accounts with no usable password are prompted. A CONFIRMED user
    // already has a working password; resetting it would be an unexpected overwrite.
    if (options.setPasswords && options.promptPassword) {
      if (state.status !== "FORCE_CHANGE_PASSWORD") {
        log.info(`  Password: ${user.email} already has a password (${state.status}); not modified`);
        row.passwordSet = "not-needed";
      } else {
        try {
          const password = await options.promptPassword(user.email);
          await setPermanentPassword(cognito, target.userPoolId, user.email, password);
          row.passwordSet = "set";
          log.info(`  Password: permanent password set for ${user.email}`);
        } catch (err) {
          row.passwordSet = "failed";
          log.warn(
            `  Password: not set for ${user.email} (${err instanceof Error ? err.message : "error"})`,
          );
          summary.failures++;
        }
      }
    }
  }

  return summary;
}
