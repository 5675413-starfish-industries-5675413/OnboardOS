/**
 * Security/behaviour invariants for infrastructure/template.yaml.
 *
 * These are STATIC checks over the template text (no YAML parser is installed,
 * and adding one just for this is not warranted). Comments are stripped before
 * matching so a comment cannot satisfy or break an assertion. They guard the
 * decisions that matter for deployment safety; they do NOT replace
 * `sam validate --lint`, a CloudFormation change-set review, or live
 * verification.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const RAW = readFileSync(new URL("./template.yaml", import.meta.url), "utf8");

/** Remove full-line and trailing comments. */
function stripComments(s: string): string {
  return s
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/\s+#.*$/, ""))
    .join("\n");
}

const TEXT = stripComments(RAW);

/** The text of a top-level resource (2-space-indented key under Resources). */
function resource(name: string): string {
  const lines = TEXT.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) throw new Error(`Resource ${name} not found in template`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (/^ {2}\S/.test(l) || /^\S/.test(l)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** Everything in a block after the line `key:` until indentation returns. */
function listUnder(block: string, key: string): string[] {
  const lines = block.split("\n");
  const start = lines.findIndex((l) => l.trim() === `${key}:`);
  if (start < 0) return [];
  const indent = (lines[start]?.match(/^\s*/)?.[0].length ?? 0);
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (l.trim() === "") continue;
    if ((l.match(/^\s*/)?.[0].length ?? 0) <= indent && !l.trim().startsWith("-")) break;
    const m = l.trim().match(/^-\s*(.+)$/);
    if (m?.[1]) out.push(m[1].replace(/^["']|["']$/g, ""));
  }
  return out;
}


/** The API function's HttpApi events: name, method, path and the authorizer (if any). */
function apiRoutes(): Array<{ name: string; method: string; path: string; authorizer: string | null }> {
  const lines = resource("OnboardOSApiFunction").split("\n");
  const out: Array<{ name: string; method: string; path: string; authorizer: string | null }> = [];
  let cur: { name: string; method: string; path: string; authorizer: string | null } | null = null;
  let inEvents = false;
  for (const line of lines) {
    if (/^ {6}Events:$/.test(line)) { inEvents = true; continue; }
    if (inEvents && /^ {4}\S/.test(line)) break; // left the function's Properties (e.g. Metadata)
    if (!inEvents) continue;
    const header = line.match(/^ {8}(\w+):$/);
    if (header) { cur = { name: header[1] as string, method: "", path: "", authorizer: null }; out.push(cur); continue; }
    if (!cur) continue;
    const path = line.match(/^\s+Path:\s*(\S+)/); if (path) cur.path = path[1] as string;
    const method = line.match(/^\s+Method:\s*(\S+)/); if (method) cur.method = method[1] as string;
    const auth = line.match(/^\s+Authorizer:\s*(\S+)/); if (auth) cur.authorizer = auth[1] as string;
  }
  return out;
}

/** IAM statements of a role's inline policy, by Sid, with the actions and resources they name. */
function statements(roleName: string): Array<{ sid: string; actions: string[]; resources: string }> {
  return resource(roleName)
    .split(/\n\s*- Sid:\s*/)
    .slice(1)
    .map((chunk) => ({
      sid: (chunk.split("\n")[0] as string).trim(),
      actions: [...chunk.matchAll(/^\s+- ([a-z0-9-]+:[A-Za-z*]+)\s*$/gm)].map((m) => m[1] as string),
      resources: chunk.slice(chunk.indexOf("Resource:")),
    }));
}

describe("API routes and authorization", () => {
  const api = resource("OnboardOSApiFunction");

  const EXPECTED_ROUTES = [
    "GET /health",
    "GET /v1/me",
    "GET /v1/orgs/{orgId}/assignable-employees",
    "GET /v1/orgs/{orgId}/assignments",
    "POST /v1/orgs/{orgId}/assignments",
    "POST /v1/assignments/{assignmentId}/start",
    "GET /v1/sessions/{sessionId}",
    "POST /v1/sessions/{sessionId}/actions",
    "PUT /v1/sessions/{sessionId}/config",
    "POST /v1/sessions/{sessionId}/test-runs",
    "GET /v1/sessions/{sessionId}/test-runs/{runId}",
  ];

  it("declares exactly the intended routes: nothing extra can be added silently", () => {
    const declared = apiRoutes().map((r) => `${r.method} ${r.path}`);
    expect([...declared].sort()).toEqual([...EXPECTED_ROUTES].sort());
  });

  it("makes GET /health the ONLY public route (Phase 1 behaviour preserved)", () => {
    const unauthenticated = apiRoutes().filter((r) => r.authorizer === null);
    expect(unauthenticated.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /health"]);
  });

  it("protects every other route with the JWT authorizer", () => {
    for (const r of apiRoutes().filter((x) => x.path !== "/health")) {
      expect(r.authorizer, `${r.method} ${r.path}`).toBe("JwtAuthorizer");
    }
  });

  it("only uses methods the API implements (GET, POST and the one PUT; no PATCH/DELETE routes)", () => {
    for (const r of apiRoutes()) expect(["GET", "POST", "PUT"]).toContain(r.method);
    expect(apiRoutes().filter((r) => r.method === "PUT").map((r) => r.path)).toEqual(["/v1/sessions/{sessionId}/config"]);
  });

  it("validates tokens against this user pool and this SPA client", () => {
    const http = resource("OnboardOSHttpApi");
    expect(http).toContain('IdentitySource: "$request.header.Authorization"');
    expect(http).toMatch(/issuer:.*OnboardOSUserPool/);
    expect(http).toMatch(/audience:\s*\n\s*-\s*!Ref OnboardOSSpaClient/);
  });

  it("allows only the local dev origin (no wildcard) and the Authorization header", () => {
    const http = resource("OnboardOSHttpApi");
    expect(listUnder(http, "AllowOrigins")).toEqual(["http://localhost:5173"]);
    expect(listUnder(http, "AllowHeaders")).toContain("Authorization");
    expect(http).not.toMatch(/"\*"|'\*'/);
  });

  it("allows only the HTTP methods the API implements for cross-origin calls", () => {
    expect([...listUnder(resource("OnboardOSHttpApi"), "AllowMethods")].sort()).toEqual(["GET", "OPTIONS", "POST", "PUT"]);
  });
});

describe("private smoke-test function (Phase 1) is unchanged", () => {
  const smoke = resource("OnboardOSSmokeFunction");

  it("has no event source of any kind", () => {
    expect(smoke).not.toMatch(/^\s+Events:/m);
  });

  it("keeps its own handler, role and Core-table-only environment", () => {
    expect(smoke).toContain("Handler: smokeTest.smokeTestHandler");
    expect(smoke).toContain("Role: !GetAtt OnboardOSSmokeRole.Arn");
    expect(smoke).not.toContain("ONBOARDOS_EVENTS_TABLE");
    expect(smoke).not.toContain("ONBOARDOS_ORG_ID");
  });
});

describe("scenario runner function (Phase 2C) is private and has no data access", () => {
  const fn = resource("OnboardOSScenarioRunner");
  const role = resource("OnboardOSRunnerRole");

  it("has no event source of any kind: no HTTP route, no function URL, no trigger", () => {
    expect(fn).not.toMatch(/^\s+Events:/m);
    expect(fn).not.toMatch(/FunctionUrl|HttpApi|Api:|Schedule|SQS|SNS|S3|Kinesis|DynamoDB:/);
    expect(TEXT).not.toContain("AWS::Lambda::Url");
    expect(TEXT).not.toContain("AWS::Lambda::Permission"); // nothing outside IAM can invoke it
  });

  it("uses its own handler, code and dedicated role (never the API's or the smoke role)", () => {
    expect(fn).toContain("Handler: handler.runnerHandler");
    expect(fn).toContain("CodeUri: ../services/test-runner/");
    expect(fn).toContain("Role: !GetAtt OnboardOSRunnerRole.Arn");
    expect(fn).not.toContain("OnboardOSApiRole");
    expect(fn).not.toContain("OnboardOSSmokeRole");
  });

  it("bundles only its own entry point", () => {
    expect(fn).toMatch(/EntryPoints:\s*\n\s*-\s*src\/handler\.ts/);
  });

  it("has no environment variables at all (no table names, no secrets, nothing to read)", () => {
    expect(fn).not.toContain("Environment:");
    expect(fn).not.toMatch(/ONBOARDOS_/);
  });

  it("has a bounded runtime", () => {
    expect(fn).toMatch(/Timeout:\s*10\b/);
    expect(fn).toMatch(/MemorySize:\s*256\b/);
  });

  it("its role can ONLY write logs: no DynamoDB, no Lambda, no S3, no secrets, no Bedrock", () => {
    const actions = [...role.matchAll(/^\s+- ([a-z0-9-]+:[A-Za-z*]+)\s*$/gm)].map((m) => m[1]);
    expect([...actions].sort()).toEqual(["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]);
    for (const forbidden of ["dynamodb", "lambda:", "s3:", "secretsmanager", "ssm:", "bedrock", "kms:", "sts:AssumeRole\n          - "]) {
      expect(role.replace("Action: sts:AssumeRole", ""), forbidden).not.toContain(forbidden);
    }
    expect(role).not.toContain("OnboardOSCoreTable");
    expect(role).not.toContain("OnboardOSEventsTable");
  });

  it("only the API function is told the runner's name, and it has a retained log group", () => {
    expect(resource("OnboardOSApiFunction")).toContain("ONBOARDOS_RUNNER_FUNCTION_NAME: !Ref OnboardOSScenarioRunner");
    expect(resource("OnboardOSSmokeFunction")).not.toContain("RUNNER");
    expect(resource("OnboardOSRunnerLogGroup")).toMatch(/RetentionInDays:\s*!Ref LogRetentionDays/);
  });

  it("is not exposed through any output", () => {
    const outputs = TEXT.slice(TEXT.indexOf("\nOutputs:"));
    expect(outputs).not.toMatch(/Runner/);
  });
});

describe("IAM least privilege", () => {
  describe("API role (Phase 2C): exactly what the implemented routes use", () => {
    const role = "OnboardOSApiRole";
    const stmts = () => statements(role);
    const byId = (sid: string) => {
      const found = stmts().find((x) => x.sid === sid);
      if (!found) throw new Error(`statement ${sid} not found`);
      return found;
    };

    it("grants Core item access: GetItem, PutItem, UpdateItem on the table ARN only", () => {
      const st = byId("CoreItemAccess");
      expect([...st.actions].sort()).toEqual(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]);
      expect(st.resources).toContain("!GetAtt OnboardOSCoreTable.Arn");
      expect(st.resources).not.toContain("OnboardOSEventsTable");
      expect(st.resources).not.toContain("/index/");
    });

    it("grants Query only on the Core table and exactly the two named indexes (never a wildcard index)", () => {
      const st = byId("CoreQuery");
      expect(st.actions).toEqual(["dynamodb:Query"]);
      expect(st.resources).toContain("${OnboardOSCoreTable.Arn}/index/GSI1");
      expect(st.resources).toContain("${OnboardOSCoreTable.Arn}/index/GSI2");
      expect(st.resources).not.toContain("/index/*");
      expect(st.resources).not.toContain("OnboardOSEventsTable");
    });

    it("lets the API only APPEND to the Events table: PutItem, nothing else", () => {
      const st = byId("EventsAppend");
      expect(st.actions).toEqual(["dynamodb:PutItem"]);
      expect(st.resources).toContain("!GetAtt OnboardOSEventsTable.Arn");
      expect(st.resources).not.toContain("OnboardOSCoreTable");
    });

    it("has no other DynamoDB statement, and the complete action set is exactly the four used", () => {
      expect(stmts().map((x) => x.sid).filter((sid) => !/Logging|Logs/i.test(sid)).sort())
        .toEqual(["CoreItemAccess", "CoreQuery", "EventsAppend", "InvokeScenarioRunner"]);
      const all = [...resource(role).matchAll(/dynamodb:[A-Za-z*]+/g)].map((m) => m[0]);
      expect([...new Set(all)].sort()).toEqual([
        "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem",
      ]);
    });

    it("may invoke exactly one Lambda, the scenario runner, by ARN: no wildcard, no other lambda action", () => {
      const st = byId("InvokeScenarioRunner");
      expect(st.actions).toEqual(["lambda:InvokeFunction"]);
      const listed: string[] = [];
      for (const line of st.resources.split("\n").slice(1)) {
        if (!line.trim().startsWith("- ") || /^\s*- (PolicyName|Sid):/.test(line)) break;
        listed.push(line.trim().slice(2));
      }
      expect(listed).toEqual(["!GetAtt OnboardOSScenarioRunner.Arn"]);
      const lambdaActions = [...resource(role).matchAll(/lambda:[A-Za-z*]+/g)].map((m) => m[0]);
      expect([...new Set(lambdaActions)]).toEqual(["lambda:InvokeFunction"]);
    });

    it("never grants Scan, Delete, Batch, ConditionCheck, table administration or Events reads", () => {
      const text = resource(role);
      for (const forbidden of ["Scan", "DeleteItem", "BatchWriteItem", "BatchGetItem", "ConditionCheckItem", "DescribeTable", "CreateTable", "DeleteTable", "UpdateTable", "dynamodb:*"]) {
        expect(text, forbidden).not.toContain(forbidden);
      }
    });
  });

  it("keeps the smoke role to the four Phase 1 actions on the Core table only", () => {
    const role = resource("OnboardOSSmokeRole");
    const actions = [...role.matchAll(/dynamodb:[A-Za-z*]+/g)].map((m) => m[0]).sort();
    expect(actions).toEqual([
      "dynamodb:DeleteItem",
      "dynamodb:DescribeTable",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
    ]);
    expect(role).not.toContain("OnboardOSEventsTable");
  });

  it("uses no wildcard actions, no wildcard resources and no iam: permissions anywhere", () => {
    expect(TEXT).not.toMatch(/Action:\s*["']?\*["']?/);
    expect(TEXT).not.toMatch(/-\s*["']\*["']\s*$/m);
    expect(TEXT).not.toMatch(/Resource:\s*["']\*["']/);
    expect(TEXT).not.toMatch(/\biam:[A-Za-z*]+/);
  });

  it("does not make any Lambda role assumable by anything but Lambda", () => {
    for (const name of ["OnboardOSApiRole", "OnboardOSSmokeRole", "OnboardOSRunnerRole"]) {
      const role = resource(name);
      expect(role).toMatch(/Service:\s*lambda\.amazonaws\.com/);
      expect(role).not.toMatch(/AWS:\s/);
    }
  });
});

describe("Cognito", () => {
  it("disables self-registration", () => {
    expect(resource("OnboardOSUserPool")).toMatch(/AllowAdminCreateUserOnly:\s*true/);
  });

  const client = resource("OnboardOSSpaClient");

  it("is a public client: no secret, authorization-code flow only, no implicit grant", () => {
    expect(client).toMatch(/GenerateSecret:\s*false/);
    expect(listUnder(client, "AllowedOAuthFlows")).toEqual(["code"]);
    expect(client).not.toMatch(/implicit|client_credentials/i);
  });

  it("enables only the flows managed login needs: ALLOW_USER_AUTH (choice-based, covers password) + refresh", () => {
    // Regression: refresh-only left managed login with no documented sign-in method.
    // AWS docs: the sign-in forms managed login offers "depend on the configuration of
    // your user pool and your app client"; ALLOW_USER_AUTH enables choice-based sign-in.
    const flows = listUnder(client, "ExplicitAuthFlows");
    expect([...flows].sort()).toEqual(["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_AUTH"]);
  });

  it("does not enable plaintext-password, SRP, custom or admin API flows", () => {
    const flows = listUnder(client, "ExplicitAuthFlows").join();
    expect(flows).not.toMatch(/USER_PASSWORD_AUTH|SRP|ADMIN|CUSTOM/);
  });

  it("registers exact localhost callback/logout URLs (no wildcards)", () => {
    expect(listUnder(client, "CallbackURLs")).toEqual(["http://localhost:5173/callback"]);
    expect(listUnder(client, "LogoutURLs")).toEqual(["http://localhost:5173"]);
  });

  it("hides whether a username exists", () => {
    expect(client).toMatch(/PreventUserExistenceErrors:\s*ENABLED/);
  });

  it("makes the Hosted UI domain prefix unique: never the bare stack name", () => {
    const domain = resource("OnboardOSUserPoolDomain");
    // Regression: "onboardos-dev" alone is unlikely to be free in the region.
    expect(domain).not.toMatch(/Domain:\s*!Sub\s*["']\$\{AWS::StackName\}["']/);
    expect(domain).toContain("AWS::StackName");
    expect(domain).toContain("AWS::StackId");
  });
});

describe("Cognito sign-in page (managed login) -- a usable login page needs ALL of these", () => {
  // AWS docs (CreateUserPoolClient / CreateUserPoolDomain): clients created through the
  // API -- which CloudFormation uses -- get no branding style, and login pages are
  // unavailable until one is applied. ManagedLoginVersion 2 alone does not activate them.
  const pool = resource("OnboardOSUserPool");
  const domain = resource("OnboardOSUserPoolDomain");
  // Looked up lazily so a missing resource fails as a named test (below) instead
  // of aborting collection of the whole file.
  const branding = (): string => resource("OnboardOSManagedLoginBranding");

  it("creates a managed-login branding style resource", () => {
    expect(branding()).toContain("Type: AWS::Cognito::ManagedLoginBranding");
  });

  it("applies Cognito's default style, which requires omitting Settings and Assets", () => {
    expect(branding()).toMatch(/UseCognitoProvidedValues:\s*true/);
    expect(branding()).not.toMatch(/^\s+Settings:/m);
    expect(branding()).not.toMatch(/^\s+Assets:/m);
  });

  it("links the style to this user pool and the SPA client (a style belongs to a client)", () => {
    expect(branding()).toMatch(/UserPoolId:\s*!Ref OnboardOSUserPool\b/);
    expect(branding()).toMatch(/ClientId:\s*!Ref OnboardOSSpaClient\b/);
  });

  it("is created AFTER the domain: nothing else orders it, since it only Refs the pool and client", () => {
    expect(branding()).toMatch(/DependsOn:\s*OnboardOSUserPoolDomain\b/);
  });

  it("sets the domain to managed login (version 2) explicitly", () => {
    expect(domain).toMatch(/ManagedLoginVersion:\s*2\b/);
  });

  it("uses a feature plan that supports managed login (never LITE)", () => {
    expect(pool).toMatch(/UserPoolTier:\s*(ESSENTIALS|PLUS)\b/);
    expect(pool).not.toMatch(/UserPoolTier:\s*LITE\b/);
  });

  it("does not mix in classic hosted-UI customization (a domain uses one or the other)", () => {
    expect(TEXT).not.toContain("AWS::Cognito::UserPoolUICustomizationAttachment");
    expect(TEXT).not.toMatch(/ManagedLoginVersion:\s*1\b/);
  });

  it("keeps the redirect URIs the frontend's PKCE flow sends", () => {
    const client = resource("OnboardOSSpaClient");
    expect(listUnder(client, "CallbackURLs")).toEqual(["http://localhost:5173/callback"]);
    expect(listUnder(client, "LogoutURLs")).toEqual(["http://localhost:5173"]);
    expect(listUnder(client, "AllowedOAuthScopes").sort()).toEqual(["email", "openid", "profile"]);
  });
});

describe("outputs", () => {
  const outputs = TEXT.slice(TEXT.indexOf("\nOutputs:"));
  const keys = [...outputs.matchAll(/^ {2}([A-Za-z0-9]+):\s*$/gm)].map((m) => m[1]);

  it("preserves every Phase 1 output", () => {
    for (const k of ["ApiUrl", "ApiFunctionName", "SmokeFunctionName", "CoreTableName", "EventsTableName"]) {
      expect(keys).toContain(k);
    }
  });

  it("adds the Phase 2A outputs the frontend and seed script depend on", () => {
    for (const k of ["UserPoolId", "UserPoolClientId", "CognitoHostedUiDomain", "DemoOrgId"]) {
      expect(keys).toContain(k);
    }
  });

  it("exposes the full Hosted UI host, not just a prefix", () => {
    const block = outputs.slice(outputs.indexOf("CognitoHostedUiDomain:"));
    expect(block).toContain(".auth.${AWS::Region}.amazoncognito.com");
  });
});

describe("data tier (Phase 1) is preserved", () => {
  it("keeps both GSIs on the Core table and stack-scoped table names", () => {
    const core = resource("OnboardOSCoreTable");
    expect(core).toContain("IndexName: GSI1");
    expect(core).toContain("IndexName: GSI2");
    expect(core).toContain('TableName: !Sub "${AWS::StackName}-core"');
    expect(resource("OnboardOSEventsTable")).toContain('TableName: !Sub "${AWS::StackName}-events"');
  });
});
