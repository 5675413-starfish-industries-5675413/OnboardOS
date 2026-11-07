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

describe("API routes and authorization", () => {
  const api = resource("OnboardOSApiFunction");

  it("declares exactly two HTTP routes: public GET /health and protected GET /v1/me", () => {
    const paths = [...api.matchAll(/^\s+Path:\s*(\S+)/gm)].map((m) => m[1]);
    expect(paths.sort()).toEqual(["/health", "/v1/me"]);
  });

  it("leaves GET /health without any authorizer (Phase 1 behaviour preserved)", () => {
    const health = api.slice(api.indexOf("ApiHealth:"), api.indexOf("ApiGetMe:"));
    expect(health).toContain("Path: /health");
    expect(health).not.toMatch(/Auth/);
  });

  it("protects GET /v1/me with the JWT authorizer", () => {
    const me = api.slice(api.indexOf("ApiGetMe:"));
    expect(me).toMatch(/Path:\s*\/v1\/me/);
    expect(me).toMatch(/Authorizer:\s*JwtAuthorizer/);
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

describe("IAM least privilege", () => {
  it("gives the API role exactly dynamodb:GetItem on the Core table and nothing else", () => {
    const role = resource("OnboardOSApiRole");
    const dynamoActions = [...role.matchAll(/dynamodb:[A-Za-z*]+/g)].map((m) => m[0]);
    expect(dynamoActions).toEqual(["dynamodb:GetItem"]);
    expect(role).toContain("!GetAtt OnboardOSCoreTable.Arn");
    expect(role).not.toContain("OnboardOSEventsTable");
    expect(role).not.toContain("/index/");
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

  it("does not make either Lambda role assumable by anything but Lambda", () => {
    for (const name of ["OnboardOSApiRole", "OnboardOSSmokeRole"]) {
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
