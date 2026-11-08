import { describe, it, expect, beforeEach } from "vitest";
import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  buildDemoUsers,
  seedDemo,
  validatePassword,
  type CognitoLike,
  type DynamoLike,
  type Logger,
  type SeedTarget,
} from "../lib/seedDemo.js";

// ---------------------------------------------------------------------------
// In-memory fakes. No network, no AWS credentials, no SDK client construction.
// ---------------------------------------------------------------------------

type AnyCommand = { input: Record<string, unknown> };

class FakeCognito {
  users = new Map<string, { sub: string; status: string }>();
  sent: AnyCommand[] = [];
  /** Emails for which AdminCreateUser should fail. */
  failCreateFor = new Set<string>();
  /** If set, AdminSetUserPassword rejects with this error (message may echo input). */
  setPasswordError: Error | null = null;

  async send(cmd: AnyCommand): Promise<unknown> {
    this.sent.push(cmd);
    const input = cmd.input;
    if (cmd instanceof AdminGetUserCommand) {
      const u = this.users.get(String(input["Username"]));
      if (!u) throw Object.assign(new Error("User does not exist."), { name: "UserNotFoundException" });
      return { UserAttributes: [{ Name: "sub", Value: u.sub }], UserStatus: u.status };
    }
    if (cmd instanceof AdminCreateUserCommand) {
      const email = String(input["Username"]);
      if (this.failCreateFor.has(email)) {
        throw Object.assign(new Error("limit"), { name: "LimitExceededException" });
      }
      const sub = `sub-${email.split("@")[0]}-0000`;
      this.users.set(email, { sub, status: "FORCE_CHANGE_PASSWORD" });
      return { User: { Attributes: [{ Name: "sub", Value: sub }], UserStatus: "FORCE_CHANGE_PASSWORD" } };
    }
    if (cmd instanceof AdminSetUserPasswordCommand) {
      if (this.setPasswordError) throw this.setPasswordError;
      const u = this.users.get(String(input["Username"]));
      if (u) u.status = "CONFIRMED";
      return {};
    }
    throw new Error("unexpected Cognito command");
  }
  count(ctor: new (...a: never[]) => unknown): number {
    return this.sent.filter((c) => c instanceof ctor).length;
  }
}

class FakeDynamo {
  items = new Map<string, Record<string, unknown>>();
  puts: Array<Record<string, unknown>> = [];
  /** Full input of every successfully attempted PutItem (for condition assertions). */
  putInputs: Array<Record<string, unknown>> = [];
  /** Throw a conditional failure on the next PutItem even though the key was absent (race). */
  raceOnNextPut = false;
  /** Throw a non-conditional error for PutItems whose SK starts with this prefix. */
  failPutSkPrefix: string | null = null;

  private key(k: Record<string, unknown>): string {
    return `${String(k["PK"])}|${String(k["SK"])}`;
  }
  async send(cmd: AnyCommand): Promise<unknown> {
    const input = cmd.input;
    if (cmd instanceof GetCommand) {
      return { Item: this.items.get(this.key(input["Key"] as Record<string, unknown>)) };
    }
    if (cmd instanceof PutCommand) {
      const item = input["Item"] as Record<string, unknown>;
      this.putInputs.push(input);
      if (this.failPutSkPrefix && String(item["SK"]).startsWith(this.failPutSkPrefix)) {
        throw Object.assign(new Error("boom"), { name: "ProvisionedThroughputExceededException" });
      }
      const k = this.key(item);
      const conditional = input["ConditionExpression"] === "attribute_not_exists(PK)";
      if (this.raceOnNextPut || (conditional && this.items.has(k))) {
        this.raceOnNextPut = false;
        throw Object.assign(new Error("cond"), { name: "ConditionalCheckFailedException" });
      }
      this.items.set(k, item);
      this.puts.push(item);
      return {};
    }
    throw new Error("unexpected DynamoDB command");
  }
}

const TARGET: SeedTarget = { userPoolId: "pool-1", coreTable: "core-table", orgId: "northstar-cloud" };

let cognito: FakeCognito;
let dynamo: FakeDynamo;
let logs: string[];
let log: Logger;
const deps = () => ({
  cognito: cognito as unknown as CognitoLike,
  dynamo: dynamo as unknown as DynamoLike,
  log,
});

beforeEach(() => {
  cognito = new FakeCognito();
  dynamo = new FakeDynamo();
  logs = [];
  log = { info: (m) => logs.push(m), warn: (m) => logs.push(m) };
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("buildDemoUsers", () => {
  it("returns exactly org_admin, manager, employee with distinct emails", () => {
    const users = buildDemoUsers();
    expect(users.map((u) => u.role)).toEqual(["org_admin", "manager", "employee"]);
    expect(new Set(users.map((u) => u.email)).size).toBe(3);
  });

  it("normalises email case and honours overrides", () => {
    const users = buildDemoUsers({ admin: "  Boss@Example.COM " });
    expect(users[0]?.email).toBe("boss@example.com");
  });

  it("rejects an invalid email address", () => {
    expect(() => buildDemoUsers({ manager: "not-an-email" })).toThrow(/Invalid email/);
  });

  it("rejects two roles sharing one identity", () => {
    expect(() => buildDemoUsers({ admin: "a@b.co", employee: "A@B.co" })).toThrow(/distinct/);
  });
});

describe("validatePassword (mirrors the User Pool policy)", () => {
  it("accepts a compliant password", () => {
    expect(validatePassword("Correct-Horse-9-Battery")).toBeNull();
  });
  it.each([
    ["too short", "Aa1xxxxxxxx"],
    ["no uppercase", "alllowercase123"],
    ["no lowercase", "ALLUPPERCASE123"],
    ["no number", "NoNumbersHereAtAll"],
  ])("rejects a password that is %s", (_label, pw) => {
    expect(validatePassword(pw)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Credential handling -- regression tests for the guessable temporary password
// ---------------------------------------------------------------------------

describe("credential handling", () => {
  it("creates users WITHOUT any password and suppresses the invitation message", async () => {
    await seedDemo(deps(), TARGET, buildDemoUsers(), { setPasswords: false });

    const creates = cognito.sent.filter((c) => c instanceof AdminCreateUserCommand);
    expect(creates).toHaveLength(3);
    for (const c of creates) {
      // The previous implementation derived TemporaryPassword from Date.now().
      expect(c.input).not.toHaveProperty("TemporaryPassword");
      expect(c.input).not.toHaveProperty("Password");
      expect(c.input["MessageAction"]).toBe("SUPPRESS");
    }
    expect(cognito.count(AdminSetUserPasswordCommand)).toBe(0);
  });

  it("never prompts or sets a password unless explicitly requested", async () => {
    let prompted = 0;
    await seedDemo(deps(), TARGET, buildDemoUsers(), {
      setPasswords: false,
      promptPassword: async () => {
        prompted++;
        return "Irrelevant-Pass-123";
      },
    });
    expect(prompted).toBe(0);
    expect(cognito.count(AdminSetUserPasswordCommand)).toBe(0);
  });

  it("sends the operator-entered password to Cognito as Permanent, and never logs it", async () => {
    const SECRET = "Sup3r-Secret-Value-XYZ";
    const summary = await seedDemo(deps(), TARGET, buildDemoUsers(), {
      setPasswords: true,
      promptPassword: async () => SECRET,
    });

    const sets = cognito.sent.filter((c) => c instanceof AdminSetUserPasswordCommand);
    expect(sets).toHaveLength(3);
    for (const s of sets) {
      expect(s.input["Permanent"]).toBe(true);
      expect(s.input["Password"]).toBe(SECRET);
    }
    expect(summary.users.every((u) => u.passwordSet === "set")).toBe(true);
    // The secret must not appear in any log line.
    expect(logs.join("\n")).not.toContain(SECRET);
    // ...nor in the returned summary.
    expect(JSON.stringify(summary)).not.toContain(SECRET);
  });

  it("does not log the password even when Cognito's error message echoes it", async () => {
    const SECRET = "Echoed-Back-Pass-789";
    cognito.setPasswordError = Object.assign(
      new Error(`Password ${SECRET} did not conform with policy`),
      { name: "InvalidPasswordException" },
    );
    const summary = await seedDemo(deps(), TARGET, buildDemoUsers(), {
      setPasswords: true,
      promptPassword: async () => SECRET,
    });

    expect(summary.failures).toBe(3);
    expect(summary.users.every((u) => u.passwordSet === "failed")).toBe(true);
    expect(logs.join("\n")).not.toContain(SECRET);
    expect(logs.join("\n")).toContain("InvalidPasswordException"); // name is kept for diagnosis
  });

  it("does not send a policy-violating password to Cognito", async () => {
    const summary = await seedDemo(deps(), TARGET, buildDemoUsers(), {
      setPasswords: true,
      promptPassword: async () => "short",
    });
    expect(cognito.count(AdminSetUserPasswordCommand)).toBe(0);
    expect(summary.users.every((u) => u.passwordSet === "failed")).toBe(true);
  });

  it("does not reset the password of an account that already has one", async () => {
    // employee already signed in before (CONFIRMED); the others are brand new.
    cognito.users.set("employee@northstar-demo.example", { sub: "sub-employee-0000", status: "CONFIRMED" });
    const prompted: string[] = [];
    const summary = await seedDemo(deps(), TARGET, buildDemoUsers(), {
      setPasswords: true,
      promptPassword: async (email) => {
        prompted.push(email);
        return "Fresh-Password-456";
      },
    });
    expect(prompted).not.toContain("employee@northstar-demo.example");
    expect(prompted).toHaveLength(2);
    expect(summary.users.find((u) => u.role === "employee")?.passwordSet).toBe("not-needed");
  });

  it("refuses setPasswords without a prompt callback", async () => {
    await expect(
      seedDemo(deps(), TARGET, buildDemoUsers(), { setPasswords: true }),
    ).rejects.toThrow(/promptPassword/);
    expect(cognito.sent).toHaveLength(0); // nothing happened
  });
});

// ---------------------------------------------------------------------------
// Behaviour: create-if-absent, idempotency, conditional writes, failures
// ---------------------------------------------------------------------------

describe("provisioning behaviour", () => {
  it("creates the org profile and one ACTIVE membership per role, keyed by Cognito sub", async () => {
    const summary = await seedDemo(deps(), TARGET, buildDemoUsers(), { setPasswords: false });

    expect(summary.failures).toBe(0);
    expect(dynamo.items.get("ORG#northstar-cloud|PROFILE")?.["name"]).toBe("AWS");

    const roles = new Map<string, string>();
    for (const [k, item] of dynamo.items) {
      if (k.includes("|MEMBER#")) {
        expect(item["status"]).toBe("ACTIVE");
        expect(item["organizationId"]).toBe("northstar-cloud");
        roles.set(String(item["email"]), String(item["role"]));
      }
    }
    expect(Object.fromEntries(roles)).toEqual({
      "admin@northstar-demo.example": "org_admin",
      "manager@northstar-demo.example": "manager",
      "employee@northstar-demo.example": "employee",
    });
    // Membership key uses the sub that Cognito returned, not the email.
    expect(dynamo.items.has("ORG#northstar-cloud|MEMBER#sub-admin-0000")).toBe(true);
  });

  it("uses a conditional write for every PutItem", async () => {
    await seedDemo(deps(), TARGET, buildDemoUsers(), { setPasswords: false });
    expect(dynamo.putInputs).toHaveLength(4); // profile + 3 memberships
    for (const input of dynamo.putInputs) {
      expect(input["ConditionExpression"]).toBe("attribute_not_exists(PK)");
    }
  });

  it("is idempotent: a second run creates and overwrites nothing", async () => {
    await seedDemo(deps(), TARGET, buildDemoUsers(), { setPasswords: false });
    const createsAfterFirst = cognito.count(AdminCreateUserCommand);
    const putsAfterFirst = dynamo.puts.length;

    const second = await seedDemo(deps(), TARGET, buildDemoUsers(), { setPasswords: false });

    expect(cognito.count(AdminCreateUserCommand)).toBe(createsAfterFirst);
    expect(dynamo.puts.length).toBe(putsAfterFirst);
    expect(second.failures).toBe(0);
    expect(second.users.every((u) => u.cognito === "already-existed" && u.membership === "already-existed")).toBe(true);
  });

  it("never overwrites an existing membership, and warns when the role differs", async () => {
    cognito.users.set("admin@northstar-demo.example", { sub: "sub-admin-0000", status: "CONFIRMED" });
    dynamo.items.set("ORG#northstar-cloud|MEMBER#sub-admin-0000", {
      PK: "ORG#northstar-cloud", SK: "MEMBER#sub-admin-0000", role: "employee", status: "ACTIVE",
    });

    await seedDemo(deps(), TARGET, buildDemoUsers(), { setPasswords: false });

    expect(dynamo.items.get("ORG#northstar-cloud|MEMBER#sub-admin-0000")?.["role"]).toBe("employee");
    expect(logs.some((l) => l.includes("NOT modified") && l.includes('"employee"'))).toBe(true);
  });

  it("treats a concurrent-create ConditionalCheckFailedException as 'already existed', not a failure", async () => {
    dynamo.raceOnNextPut = true; // the organization profile loses a race
    const summary = await seedDemo(deps(), TARGET, buildDemoUsers(), { setPasswords: false });
    expect(summary.failures).toBe(0);
  });

  it("isolates failures: one user failing does not stop the others, and the run reports non-zero", async () => {
    cognito.failCreateFor.add("manager@northstar-demo.example");
    const summary = await seedDemo(deps(), TARGET, buildDemoUsers(), { setPasswords: false });

    expect(summary.failures).toBe(1);
    const byRole = Object.fromEntries(summary.users.map((u) => [u.role, u]));
    expect(byRole["manager"]?.cognito).toBe("failed");
    expect(byRole["manager"]?.membership).toBe("skipped"); // no sub => no membership
    expect(byRole["org_admin"]?.membership).toBe("created");
    expect(byRole["employee"]?.membership).toBe("created");
    expect(logs.join("\n")).toContain("LimitExceededException");
  });

  it("records a non-conditional DynamoDB error as a failure instead of hiding it", async () => {
    dynamo.failPutSkPrefix = "MEMBER#";
    const summary = await seedDemo(deps(), TARGET, buildDemoUsers(), { setPasswords: false });
    expect(summary.failures).toBe(3);
    expect(summary.users.every((u) => u.membership === "failed")).toBe(true);
  });

  it("creates users with the required attributes (verified email, preferred_username)", async () => {
    await seedDemo(deps(), TARGET, buildDemoUsers(), { setPasswords: false });
    const create = cognito.sent.find((c) => c instanceof AdminCreateUserCommand);
    const attrs = Object.fromEntries(
      (create?.input["UserAttributes"] as Array<{ Name: string; Value: string }>).map((a) => [a.Name, a.Value]),
    );
    expect(attrs["email_verified"]).toBe("true");
    expect(attrs["preferred_username"]).toBe("admin");
    expect(create?.input["UserPoolId"]).toBe("pool-1");
  });
});
