# OnboardOS — AWS Deployment Guide (Phase 1 + Phase 2A)

**Status vocabulary** (from `docs/07-verification-and-release.md`):
- **Local** — passed local build/test only; no AWS resources exist or have been tested.
- **AWS verified** — an actual AWS request was made and a real response was received.
- **Deployed** — the resource is live and accessible from the expected endpoint.

Phase 1 status: the deployment owner reports stack `onboardos-dev` (us-east-1) is `CREATE_COMPLETE`,
`GET /health` returned HTTP 200, and the private smoke Lambda completed a real DynamoDB write/read/delete.
That was reported to this repository's maintainers; it was **not re-verified** while preparing Phase 2A.
Phase 2A status: **Local** only (see below). Nothing in Phase 2A has been deployed or AWS verified.

---

## Phase 1 scope

This phase deploys:
- API Gateway HTTP API — public `GET /health` only
- API Lambda (`OnboardOSApiFunction`) — HTTP routing, no DynamoDB access yet
- Smoke-test Lambda (`OnboardOSSmokeFunction`) — internal DynamoDB round-trip test, no public endpoint
- DynamoDB `<stack>-core` table — with GSI1 (employee assignments) and GSI2 (manager review queue)
- DynamoDB `<stack>-events` table
- Two IAM execution roles (least-privilege per function)
- Two CloudWatch log groups (7-day retention)

Not in Phase 1: Cognito, Bedrock, S3, scenario runner, or frontend hosting.

---

## Prerequisites

### Tools

```bash
aws --version        # must print aws-cli/2.x  (v1 has different --payload behaviour)
sam --version        # must be >= 1.100
node --version       # must be >= 20
python3 --version    # used by the smoke-test script
jq --version         # optional but recommended for readable output
```

### AWS credentials

Workshop Studio issues temporary credentials as environment variables. Set them
in your shell before running any `aws` or `sam` command:

```bash
export AWS_ACCESS_KEY_ID=<from Workshop Studio>
export AWS_SECRET_ACCESS_KEY=<from Workshop Studio>
export AWS_SESSION_TOKEN=<from Workshop Studio>
export AWS_REGION=us-east-1
```

**Never paste these values into source code, documentation, issue text,
screenshots, or AI chat sessions.**

### Mandatory preflight

```bash
aws sts get-caller-identity
```

Expected output shape (values will differ):
```json
{
    "UserId": "AROA...:session-name",
    "Account": "123456789012",
    "Arn": "arn:aws:sts::123456789012:assumed-role/..."
}
```

If this command returns an error, fix credentials before proceeding. Do not
attempt `sam deploy` with invalid credentials.

---

## Build

Always build before deploying:

```bash
# From the repo root
npm run verify   # typecheck + frontend build + unit tests + sam build (--build-in-source)

# Or build only (skips tests):
sam build --template-file infrastructure/template.yaml --build-in-source
```

After a successful build, artifacts are in `.aws-sam/build/`:
- `.aws-sam/build/OnboardOSApiFunction/handler.js`
- `.aws-sam/build/OnboardOSSmokeFunction/smokeTest.js`

These files must exist before `sam deploy`.

---

## First deployment (`sam deploy --guided`)

Run from the repo root after a successful build:

```bash
sam deploy --guided --template-file .aws-sam/build/template.yaml
```

Interactive prompts and recommended answers:

| Prompt | Recommended answer |
|---|---|
| Stack Name | `onboardos-dev` (or any name unique within your account) |
| AWS Region | `us-east-1` (or your workshop region) |
| Parameter LogRetentionDays | `7` (default) |
| Confirm changes before deploy | `y` |
| Allow SAM CLI IAM role creation | `y` |
| Disable rollback | `n` |
| Save arguments to configuration file | `y` |
| SAM configuration file | `samconfig.toml` (default) |
| SAM configuration environment | `default` (default) |

SAM will print a changeset with all resources to be created. Review it before
typing `y` to confirm.

The `--capabilities CAPABILITY_IAM` flag is required because the template
creates IAM roles. SAM adds this automatically when you answer `y` to the IAM
prompt. If you use `sam deploy` non-interactively later, pass:

```bash
sam deploy --capabilities CAPABILITY_IAM
```

### Re-deployment (after first deploy)

**Note:** this checkout has no `samconfig.toml` (it is not tracked and appears in no git history),
so Phase 1's saved guided-deploy settings are not available here. For Phase 2A use the explicit
commands in the Phase 2A section instead. If a `samconfig.toml` is later generated it contains
stack name / region / bucket / parameters only (no credentials), but review it before committing.

Once a `samconfig.toml` exists, subsequent deploys can use:

```bash
npm run build     # re-build if source changed
sam deploy        # uses samconfig.toml, no --guided needed
```

---

## Record stack outputs

After a successful deploy, record all outputs:

```bash
aws cloudformation describe-stacks \
  --stack-name <STACK_NAME> \
  --query "Stacks[0].Outputs" \
  --output table
```

Expected output shape:

| OutputKey | OutputValue | Description |
|---|---|---|
| ApiUrl | `https://<id>.execute-api.us-east-1.amazonaws.com` | Public API base URL |
| ApiFunctionName | `<stack>-OnboardOSApiFunction-<suffix>` | API Lambda name |
| SmokeFunctionName | `<stack>-OnboardOSSmokeFunction-<suffix>` | Smoke-test Lambda name |
| CoreTableName | `<stack>-core` | DynamoDB Core table name |
| EventsTableName | `<stack>-events` | DynamoDB Events table name |

The frontend reads `ApiUrl` as `VITE_API_BASE_URL` from `apps/web/.env.local` (see Phase 2A).
Never commit a file containing real deployment values or credentials.

---

## Verification steps

### Local (pre-deploy)

```bash
# TypeScript, tests, and sam build
npm run verify

# SAM template linting
sam validate --template-file infrastructure/template.yaml --lint
```

Status: **Local**

### AWS verified (post-deploy)

#### 1. Health endpoint

```bash
curl -s https://<ApiUrl>/health | python3 -m json.tool
```

Expected response (status 200):
```json
{
    "status": "ok",
    "service": "onboardos-api",
    "timestamp": "2026-11-07T12:00:00.000Z"
}
```

Status: **AWS verified** once this returns `status: "ok"`.

#### 2. DynamoDB smoke test

Run the provided script (requires deployed stack):

```bash
STACK_NAME=<your-stack-name> STACK_REGION=us-east-1 bash scripts/invoke-smoke-test.sh
```

Expected output includes:
```json
{
  "ok": true,
  "tableStatus": "ACTIVE",
  "cleanupOk": true,
  "message": "DynamoDB round-trip OK (DescribeTable -> PutItem -> GetItem -> DeleteItem)",
  "requestId": "...",
  "durationMs": ...
}
```

`ok` and `cleanupOk` must both be `true` to consider DynamoDB connectivity verified.

Status: **AWS verified** once both fields are `true`.

#### 3. DynamoDB tables

```bash
# Replace <CoreTableName> and <EventsTableName> with stack output values
aws dynamodb describe-table --table-name <CoreTableName> \
  --query "Table.{Status:TableStatus,GSIs:GlobalSecondaryIndexes[*].IndexName}"

aws dynamodb describe-table --table-name <EventsTableName> \
  --query "Table.{Status:TableStatus}"
```

Expected: `"Status": "ACTIVE"`. Core table should show `["GSI1","GSI2"]`.

#### 4. CloudWatch log groups

```bash
aws logs describe-log-groups \
  --log-group-name-prefix "/aws/lambda/<STACK_NAME>" \
  --query "logGroups[*].{Name:logGroupName,Retention:retentionInDays}"
```

Expected: two groups, each with `retentionInDays: 7`.

---

## Smoke-test script reference

The script `scripts/invoke-smoke-test.sh`:

1. Validates AWS credentials via `sts get-caller-identity` — aborts if invalid
2. Resolves `SmokeFunctionName` from CloudFormation stack outputs
3. Invokes the Lambda synchronously using `--cli-binary-format raw-in-base64-out`
   (required for AWS CLI v2 with `--payload file://`)
4. Prints the result JSON
5. Exits 0 if `ok=true` and `cleanupOk=true`, exits 1 otherwise

The smoke-test Lambda:
- Writes a disposable item keyed to the Lambda request ID
- Reads it back with `ConsistentRead: true`
- Validates `_smoke=true` in the returned item
- Deletes the item in a `finally` block
- Returns `ok=false` if cleanup fails — a partially-run test is not clean

This function has **no API Gateway event source**. It cannot be reached via HTTP.
Only IAM-authorised `aws lambda invoke` calls can trigger it.

---

## Cleanup and rollback

### Full stack teardown

```bash
sam delete --stack-name <STACK_NAME> --region us-east-1
```

Type `y` at the confirmation prompt. This deletes:
- Both Lambda functions
- Both DynamoDB tables and all their data (`DeletionPolicy: Delete`)
- Both IAM roles
- The HTTP API
- Both CloudWatch log groups

**Data loss warning:** Both DynamoDB tables are configured with
`DeletionPolicy: Delete`. All data is permanently deleted when the stack is
torn down. Export any important data before running `sam delete`.

### Changeset failure rollback

If `sam deploy` fails mid-way, CloudFormation automatically rolls back to the
previous stable state. If the stack ends up in `ROLLBACK_COMPLETE` state, it
must be deleted before a fresh deploy is attempted:

```bash
aws cloudformation delete-stack --stack-name <STACK_NAME>
# Wait for deletion to complete:
aws cloudformation wait stack-delete-complete --stack-name <STACK_NAME>
# Then retry the deploy:
sam deploy --guided --template-file .aws-sam/build/template.yaml
```

---

## Known blockers and assumptions

| # | Item | Impact | Mitigation |
|---|---|---|---|
| 1 | `iam:CreateRole` and `iam:PutRolePolicy` required | SAM cannot create execution roles | Ask workshop mentor for pre-created roles; update `Role:` in `template.yaml` to reference existing role ARNs |
| 2 | Node.js 24 runtime availability | `nodejs24.x` may not be available in all regions or workshop accounts | Change `Runtime: nodejs24.x` to `nodejs22.x` in `infrastructure/template.yaml` Globals; re-test and re-build |
| 3 | `@aws-sdk/*` bundled in smokeTest.js | If runtime SDK version conflicts, bundled version wins | Bundling is intentional for the smoke function; no action needed unless size is a concern |
| 4 | Temporary credential expiry | Workshop Studio credentials expire; `sam deploy` will fail mid-run if they expire | Keep the deploy window short (<15 min); refresh credentials and retry if expired |
| 5 | CloudFormation `ROLLBACK_COMPLETE` | Stack must be deleted before retry | See rollback procedure above |
| 6 | CORS origin `http://localhost:5173` | Phase 1 allows only localhost; production frontend URL must be added in Phase 3 | Update `CorsConfiguration.AllowOrigins` in `template.yaml` before frontend deployment |
| 7 | Log group creation race | Lambda may create its log group before CloudFormation does; retention may not apply to logs written before the explicit log group resource is created | The explicit `AWS::Logs::LogGroup` resource mitigates this but is not 100% guaranteed on the very first invocation if Lambda runs before CloudFormation creates the group |

---

## Next steps after Phase 1 is AWS verified

Proceed to Phase 2 per `docs/15-aws-provisioning-order.md` Gate 3:

1. Set up Cognito user pool and three identities (org admin, manager, employee)
2. Add JWT authorizer to `OnboardOSHttpApi`
3. Implement `GET /v1/me` and seed org/membership data
4. Grant API Lambda the DynamoDB permissions it needs for domain routes
5. Add API Lambda unit tests for authorization paths

---

## Phase 2A scope

Phase 2A extends the existing stack with:

- Cognito User Pool (`OnboardOSUserPool`): email sign-in, **self-registration disabled** (admin-created users only).
- Cognito SPA app client (`OnboardOSSpaClient`): public client (no secret), authorization-code + PKCE only. API auth flows limited to `ALLOW_USER_AUTH` (choice-based sign-in used by managed login) and refresh; no plaintext-password, SRP, custom or admin flows.
- Cognito domain (`OnboardOSUserPoolDomain`): `<stack-name>-<8 hex of stack UUID>.auth.<region>.amazoncognito.com`, set to **managed login (`ManagedLoginVersion: 2`)**.
- Cognito managed login branding style (`OnboardOSManagedLoginBranding`): Cognito's default style, linked to the SPA client. **Required for a usable sign-in page** (see next section).
- User pool feature plan pinned to `ESSENTIALS` (managed login is not available on `LITE`).
- API Gateway JWT authorizer on `GET /v1/me`; `GET /health` stays public.
- `GET /v1/me`: authenticated identity plus ACTIVE DynamoDB memberships (role comes only from DynamoDB).
- API Lambda role gains `dynamodb:GetItem` on the Core table (no Query/Scan/Put/Update/Delete, no Events table, no indexes).
- React/Vite SPA in `apps/web` (login, PKCE callback, `/v1/me`, role display, sign-out).
- Operator-run provisioning script `scripts/seed-demo.ts` (never runs automatically).

**Status: Local.** Nothing here is deployed or AWS verified.

---

## What the update changes in `onboardos-dev`

Derived by running SAM's translator locally on the Phase 1 template (commit `bee8161`) and on the current
template, then diffing the resulting CloudFormation resources:

| Resource | Change |
|---|---|
| `OnboardOSUserPool`, `OnboardOSSpaClient`, `OnboardOSUserPoolDomain`, `OnboardOSManagedLoginBranding` | **Added** |
| `OnboardOSApiFunctionApiGetMePermission` (Lambda permission for the new route) | **Added** |
| `OnboardOSApiFunction` | Modified: `Description`, `Environment` (+`ONBOARDOS_ORG_ID`), new code |
| `OnboardOSApiRole` | Modified: `Description`, `Policies` (+inline policy `OnboardOSApiDynamoDB`: `dynamodb:GetItem` on Core table ARN) |
| `OnboardOSHttpApi` | Modified: OpenAPI `Body` only (new `/v1/me` route, `JwtAuthorizer`, CORS +`Authorization`/`OPTIONS`) |
| `OnboardOSCoreTable`, `OnboardOSEventsTable` | **Unchanged** |
| `OnboardOSSmokeFunction`, `OnboardOSSmokeRole`, both log groups, default stage, health permission | **Unchanged** |
| Removed resources | None |

**This is not a CloudFormation change-set.** No change-set has been created or reviewed, so *whether any
modified resource would be replaced is not verified.* From the CloudFormation resource documentation the
modified properties above are update-in-place (no replacement) and the tables' properties are untouched, but
that must be confirmed by the change-set gate below before executing anything.

**Parameter drift.** The template has two parameters with defaults (`LogRetentionDays=7`,
`DemoOrgId=northstar-cloud`). With no saved `samconfig.toml`, a deploy applies those defaults. If the
deployed stack was created with different values, the update would change them. Check first (gate step 2).

---

## Pre-deploy gate: review a change-set before executing

> Read **"IAM actions the new and existing Cognito resources need"** (below the gate steps) and run its read-only
> pre-flight **before step 4**. The sign-in page also depends on the branding style described below it.

All commands below are for the deployment owner. Replace placeholders; never paste credentials anywhere.

```bash
# 1. Confirm account and region are the intended ones (output contains identifiers; do not publish it)
aws sts get-caller-identity
echo "$AWS_REGION"          # must be the stack's region (us-east-1)

# 2. Confirm the stack is healthy and read its CURRENT parameter values
aws cloudformation describe-stacks --stack-name onboardos-dev --region us-east-1 \
  --query "Stacks[0].[StackStatus,Parameters]" --output json
#    StackStatus must be CREATE_COMPLETE or UPDATE_COMPLETE. Otherwise STOP.
#    If a parameter differs from the template default, pass it explicitly in step 4.

# 3. Local verification must be green on the commit being deployed
npm run verify

# 4. Create the change-set WITHOUT executing it
#    (--resolve-s3 uses/creates SAM's managed artifact bucket; a samconfig.toml is not present)
sam deploy --stack-name onboardos-dev --region us-east-1 \
  --capabilities CAPABILITY_IAM --resolve-s3 --no-execute-changeset
#    add: --parameter-overrides LogRetentionDays=<current> DemoOrgId=<current>   if step 2 showed non-defaults

# 5. Inspect it
aws cloudformation list-change-sets --stack-name onboardos-dev --region us-east-1
aws cloudformation describe-change-set --stack-name onboardos-dev --region us-east-1 \
  --change-set-name <name shown by list-change-sets> \
  --query "Changes[].ResourceChange.{Action:Action,Logical:LogicalResourceId,Type:ResourceType,Replacement:Replacement}" \
  --output table
```

**Go / no-go from the table:**

- Expected `Add`: `OnboardOSUserPool`, `OnboardOSSpaClient`, `OnboardOSUserPoolDomain`, `OnboardOSManagedLoginBranding`, `OnboardOSApiFunctionApiGetMePermission`.
- Expected `Modify` with `Replacement: False`: `OnboardOSApiFunction`, `OnboardOSApiRole`, `OnboardOSHttpApi`.
- **STOP** (do not execute) if any `Remove`, or any `Replacement` of `True`/`Conditional` on a table, function, role, log group or the HTTP API, or if either DynamoDB table appears at all.

Then execute the exact change-set you reviewed and wait:

```bash
aws cloudformation execute-change-set --stack-name onboardos-dev --region us-east-1 --change-set-name <name>
aws cloudformation wait stack-update-complete --stack-name onboardos-dev --region us-east-1
```

Record the new outputs afterwards:

```bash
aws cloudformation describe-stacks --stack-name onboardos-dev --region us-east-1 \
  --query "Stacks[0].Outputs" --output table
```

New outputs: `UserPoolId`, `UserPoolClientId`, `CognitoHostedUiDomain` (full host), `CognitoIssuerUrl`, `DemoOrgId`.

### Why a branding style is part of the stack (sign-in page requirement)

A user pool, app client and domain are **not enough** for a working sign-in page when created through
CloudFormation. From the Amazon Cognito API reference:

- `CreateUserPoolClient`: "Unlike app clients created in the console, Amazon Cognito doesn't automatically
  assign a branding style to app clients that you configure with this API operation. Managed login and
  classic hosted UI pages aren't available for your client until after you apply a branding style."
- `CreateUserPoolDomain`: "A `ManagedLoginVersion` value of 2 does not activate managed login pages for your
  app client. When you create an app client programmatically, your app client has no branding style... When
  you use the API or an SDK, you must create a branding style yourself."
- `CreateManagedLoginBranding`: "To create a new style with default settings, set `UseCognitoProvidedValues`
  to true and don't provide values for any other options."
- Managed login requires a feature plan other than Lite; the classic hosted UI and managed login are
  alternatives, "not used together", on one domain.

So the stack contains, in this order: user pool (`UserPoolTier: ESSENTIALS`) and app client, then the domain
(`ManagedLoginVersion: 2`), then `AWS::Cognito::ManagedLoginBranding` with `UseCognitoProvidedValues: true`
(no `Settings`/`Assets`, as the docs require), linked to the SPA client via `ClientId`. The branding resource
has an explicit `DependsOn: OnboardOSUserPoolDomain`, because its `Ref`s only order it after the pool and
client. Deletion runs in the reverse order.

Frontend compatibility (checked against the docs; the code is unchanged): the app uses `/oauth2/authorize`
with S256 PKCE only (the only method Cognito supports), `/oauth2/token` as a public client without a secret,
and `/logout` with `client_id` + `logout_uri` (a registered sign-out URL). Managed login and the classic UI
both return `Access-Control-Allow-Origin: *` from the token endpoint, which is what the browser `fetch` needs.

**Auth flows.** On managed login the sign-in methods offered "depend on the configuration of your user pool
and your app client" (docs: *Configure authentication methods for managed login*), and `ALLOW_USER_AUTH` is
the documented flow for choice-based sign-in, which includes password. An earlier draft of this branch set the
client to refresh-only; that is not supported by the docs for managed login and was corrected. Not enabled on
purpose: `ALLOW_USER_PASSWORD_AUTH` (plaintext password via the API), SRP, custom and admin flows.

**Cost.** `ESSENTIALS` is the documented CloudFormation default for new pools, but it is a priced feature
plan. Check the Amazon Cognito pricing page for current rates before deploying in a billed account.

**Fallback if managed login cannot be created in the workshop account** (not implemented, not tested): classic
hosted UI, i.e. `ManagedLoginVersion: 1` plus `AWS::Cognito::UserPoolUICustomizationAttachment` (`ClientId`
is required; `CSS` is optional). It would need its own template change and change-set. Whether an attachment
with no CSS is accepted, and whether the classic pages then work for a programmatic client, is **not verified**.

### IAM actions the new and existing Cognito resources need

From the public CloudFormation registry schemas (resource-handler `permissions`), not from a live test. The
Phase 1 simulation covered only "Cognito user-pool creation".

| Resource | Handler permissions (create unless noted) |
|---|---|
| `AWS::Cognito::ManagedLoginBranding` **(new)** | `cognito-idp:CreateManagedLoginBranding`, `cognito-idp:DescribeManagedLoginBrandingByClient`; read `DescribeManagedLoginBranding`; update `UpdateManagedLoginBranding`; delete `DeleteManagedLoginBranding` |
| `AWS::Cognito::UserPoolDomain` | `cognito-idp:CreateUserPoolDomain`, `DescribeUserPoolDomain`, `cloudfront:UpdateDistribution`, `kms:CreateGrant`, `kms:Decrypt`, `kms:DescribeKey`, `kms:Encrypt`, `kms:GenerateDataKeyWithoutPlaintext`, `kms:ReEncryptFrom`, `kms:ReEncryptTo`; delete `DeleteUserPoolDomain` |
| `AWS::Cognito::UserPoolClient` | `cognito-idp:CreateUserPoolClient`, `iam:PassRole`, `iam:PutRolePolicy`, `iam:CreateServiceLinkedRole`; delete `DeleteUserPoolClient`, `iam:DeleteRolePolicy` |
| `AWS::Cognito::UserPool` | `cognito-idp:CreateUserPool` and related (Phase 1 simulation only covered creation) |

The `cloudfront`/`kms` entries are listed for the domain type as a whole (custom domains use CloudFront and
ACM); whether a **prefix** domain exercises them is not verified. The `iam:*` entries on the app client were
not in earlier versions of this guide. A restricted workshop role may deny any of these.

Read-only pre-flight the deployment owner can run (replace the ARN; the output is not proof, because
simulation ignores resource policies and SCPs):

```bash
aws iam simulate-principal-policy --policy-source-arn <role-or-user-arn> --region us-east-1 \
  --action-names cognito-idp:CreateUserPoolClient cognito-idp:CreateUserPoolDomain \
                 cognito-idp:CreateManagedLoginBranding cognito-idp:DescribeManagedLoginBrandingByClient \
                 cognito-idp:DeleteManagedLoginBranding cloudfront:UpdateDistribution \
                 iam:PassRole iam:PutRolePolicy iam:CreateServiceLinkedRole \
  --query "EvaluationResults[].[EvalActionName,EvalDecision]" --output table
```

If the update fails on a Cognito or IAM permission, CloudFormation rolls back to the previous state
(Phase 1 intact). `ManagedLoginBranding` is also the most likely failure point if the account's Cognito
feature set is restricted; the error will name the denied action.

---

## Configure and run the frontend

Vite reads env files from the **app directory** (`apps/web/`), not the repository root, including when
started through npm workspaces. A root-level `.env` is silently ignored. (Verified: a value in a root
`.env` did not reach the bundle; the same value in `apps/web/.env.local` did.)

```bash
cp apps/web/.env.example apps/web/.env.local     # gitignored
# Edit apps/web/.env.local with the stack outputs:
#   VITE_API_BASE_URL          <- ApiUrl
#   VITE_COGNITO_CLIENT_ID     <- UserPoolClientId
#   VITE_COGNITO_DOMAIN        <- CognitoHostedUiDomain   (full host)
#   VITE_COGNITO_USER_POOL_ID  <- UserPoolId              (informational)

npm --workspace=apps/web run dev      # then open http://localhost:5173  (restart after editing .env.local)
npm run build:web                     # production bundle -> apps/web/dist
```

Use exactly `http://localhost:5173`. The app client registers only `http://localhost:5173/callback` and
`http://localhost:5173`; `127.0.0.1` or another port fails with `redirect_mismatch`. The dev server uses
`strictPort`, so it errors instead of silently moving to another port. If required variables are missing,
the login page shows which ones and disables the sign-in button.

Hosting the SPA elsewhere requires adding its URL to the app client's `CallbackURLs`/`LogoutURLs` and to
the API's `AllowOrigins` in the template (Phase 3).

---

## Provision demo users (operator-run, explicit)

`scripts/seed-demo.ts` is never invoked by build, test, CI, or deploy. It is create-if-absent only.

**Credential handling:** the script never generates, accepts via env/argv/files, logs, or stores a password.
New users are created without any password (Cognito assigns an unseen random one; no email is sent), so they
cannot sign in until you set a permanent password at a **hidden, confirmed prompt** that goes straight to
Cognito. (An earlier draft derived a temporary password from the clock; that was guessable and has been removed.)

Permissions the operator needs: `cloudformation:DescribeStacks`; `cognito-idp:AdminGetUser`,
`AdminCreateUser`, `AdminSetUserPassword` on the user pool; `dynamodb:GetItem`, `PutItem` on the Core table.

```bash
export STACK_NAME=onboardos-dev AWS_REGION=us-east-1     # credentials come from your shell; AWS_REGION has no default

# 1. Plan only: prints what would happen, makes NO AWS calls (the default)
npx tsx scripts/seed-demo.ts

# 2. Create users + memberships. Prompts you to type the stack name to confirm.
npx tsx scripts/seed-demo.ts --apply

# 3. Same, and set permanent passwords (hidden prompt, entered twice; needs an interactive terminal)
npx tsx scripts/seed-demo.ts --apply --set-passwords
```

- Passwords: 12+ chars with upper, lower and a digit (the pool policy). Use a different one per account; never reuse real passwords.
- Accounts that already have a password are **not** prompted or reset.
- Existing users/memberships are never overwritten; a role mismatch is reported as a warning.
- The script reads `DemoOrgId` from the stack outputs and aborts if `DEMO_ORG_ID` is set to something else.
- Re-running is safe; failures are reported per user and the exit code is non-zero.

Cleanup: `aws cognito-idp admin-delete-user --user-pool-id <UserPoolId> --username <email>`; membership items
can be deleted from the Core table; deleting the stack removes the pool and tables.

---

## Phase 2A verification (all require a deployed update and provisioned users)

Nothing below has been run. Treat every item as **not verified** until it has been executed.

Set `API` to the `ApiUrl` output (no trailing slash) in your shell. `TOKEN` below means an access token held only
in a local shell variable.

Handling tokens: the access token is in the tab's `sessionStorage` (`onboardos.access_token`). Treat it as a
secret: do not paste it into chat, tickets, screenshots or docs; use it only in a local shell variable.

| # | Check | Command / action | Expected |
|---|---|---|---|
| 1 | Health still public | `curl -s -o /dev/null -w "%{http_code}" "$API/health"` | `200` |
| 2 | Anonymous denied | `curl -s -o /dev/null -w "%{http_code}" "$API/v1/me"` | `401` (from API Gateway) |
| 3 | Garbage / tampered token denied | `curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer not.a.jwt" "$API/v1/me"` | `401` (Gateway) |
| 4 | Expired token denied | Use an access token after its 60-minute lifetime | `401` (Gateway) |
| 5 | Wrong-pool/wrong-audience token denied | Token from another pool/client | `401` (Gateway) |
| 6 | **ID token misuse denied** | Capture `id_token` from the DevTools Network response of `POST /oauth2/token` (the app does not store it) and send as Bearer | `401` with body `{"code":"UNAUTHORIZED",...}`. The Gateway authorizer accepts it (same issuer/audience); the **Lambda** rejects `token_use=id`. Only a Lambda-style body proves that path. |
| 7 | Access token works | Browser sign-in, then `curl -H "Authorization: Bearer $TOKEN" "$API/v1/me"` | `200` with `userSub` and one ACTIVE membership |
| 8 | Role comes from DynamoDB | Sign in as admin, manager, employee in turn | `org_admin` / `manager` / `employee` respectively |
| 9 | Suspended denied | Set the member's `status` to `SUSPENDED` (see below) | `200` with `memberships: []`; UI shows "no active organization membership" |
| 10 | Unknown identity gets nothing | A Cognito user with no membership item | `200` with `memberships: []` |
| 11 | Browser flow | Sign in; refresh `/app`; sign out; reopen `/app` | Session survives refresh in the same tab; after sign-out `/app` returns to login |
| 12 | Callback hygiene | After sign-in, inspect the address bar and browser history | No `code=`/`state=` remain |
| 12a | **Sign-in page exists** (do this right after deploy, before seeding users) | Open `https://<CognitoHostedUiDomain>/oauth2/authorize?client_id=<UserPoolClientId>&response_type=code&scope=openid&redirect_uri=http%3A%2F%2Flocalhost%3A5173%2Fcallback` in a browser | A Cognito **sign-in form** renders. An error page, "login pages unavailable" or a bare error means no branding style was applied. Exact failure presentation is unverified. |
| 13 | Phase 1 intact | Run `scripts/invoke-smoke-test.sh` | `ok:true`, `cleanupOk:true` |

Item 9 command (reverse it afterwards by setting `ACTIVE`):

```bash
aws dynamodb update-item --table-name <CoreTableName> \
  --key '{"PK":{"S":"ORG#northstar-cloud"},"SK":{"S":"MEMBER#<userSub>"}}' \
  --update-expression "SET #s = :s" --expression-attribute-names '{"#s":"status"}' \
  --expression-attribute-values '{":s":{"S":"SUSPENDED"}}'
```

---

## Build architecture note: `--build-in-source`

`@onboardos/contracts` is a local workspace package. SAM's default build copies `services/api` to an isolated
temp directory where workspace symlinks do not exist, so `npm install` there fails with E404. With
`--build-in-source` SAM bundles from the real source tree, where `node_modules/@onboardos/contracts` is
already linked, and esbuild inlines it. The package is never fetched from the npm registry and the deployed
artifact is self-contained.

Implications: run builds from the repository root after `npm install`/`npm ci`. The build does not modify
`package.json` or `package-lock.json` (checked). `npm test` resolves the contracts package from source (see
`vitest.config.mjs`), so tests no longer depend on a previous `tsc --build`.

---

## Rollback

- **Deploy fails mid-update:** CloudFormation rolls back automatically; Phase 1 resources stay as they were.
  Check `StackStatus` is `UPDATE_ROLLBACK_COMPLETE`. If it is `UPDATE_ROLLBACK_FAILED`, stop and escalate.
- **Remove Phase 2A after a successful update (keep Phase 1 data):** redeploy the Phase 1 template from
  commit `bee8161`. Use a separate worktree so the Phase 2A tree is untouched:
  `git worktree add ../onboardos-phase1 bee8161`, then in it `npm ci`, `sam build` (that commit's default
  build), and the same change-set gate above with `sam deploy`. This **deletes the user pool, its users, the
  domain and the `/v1/me` route**; both DynamoDB tables are unchanged. Re-seeding is required to restore it.
- **`sam delete` is not a rollback.** It deletes the whole stack including both tables and all data
  (`DeletionPolicy: Delete`). Use it only for full teardown.

---

## Known limitations (Phase 2A)

| # | Limitation | Impact | Resolution |
|---|---|---|---|
| 1 | Cognito domain prefixes are unique per **region across all accounts** | A taken prefix fails the deploy and rolls back | Prefix is `<stack>-<8 hex of the stack UUID>`; stack name must be lowercase and at most 54 characters. Not verified against a real account. |
| 2 | ID tokens pass the Gateway authorizer; only the Lambda rejects them | Rejection exists only in `auth.ts` | Acceptable here. Optional hardening: require an `openid` scope on the route so Gateway rejects ID tokens (scope presence in the access token is unverified, so not enabled) |
| 3 | Display name | Cognito **access** tokens carry no `email`/`preferred_username`, so `/v1/me` `username` will usually be the Cognito `username` claim or `sub`, and the UI shows that | Cosmetic. Follow-up: show the display name stored on the DynamoDB membership record |
| 4 | Single-organization lookup | Only `ONBOARDOS_ORG_ID` is consulted; a user in another org sees no membership | Multi-org needs a user-keyed GSI; deferred |
| 5 | CORS and Cognito URLs are `localhost:5173` only | A hosted frontend would fail until URLs are added | Phase 3 |
| 6 | Tokens in `sessionStorage` | Readable by any script running on the origin (XSS) | Access token only (no refresh/ID token stored), cleared on tab close, 60-minute lifetime |
| 7 | `sam deploy` artifact bucket | `--resolve-s3` uses/creates SAM's managed bucket stack (outside `onboardos-dev`) | Reused if the Phase 1 guided deploy created it |
| 8 | Live behaviour unverified | JWT signature/expiry/audience enforcement; that the default managed-login style renders; that the page offers a password sign-in for `ALLOW_USER_AUTH` on a password-only pool; Cognito's acceptance of the template; IAM for the Cognito resources | Run the verification table after deploy |
| 9 | Managed login look | Cognito's default style; no custom branding | Acceptable for the demo; customize later via `Settings`/`Assets` |
| 10 | Feature plan cost | `ESSENTIALS` is a priced plan | See the Amazon Cognito pricing page; the explicit setting makes the choice visible |
| 11 | Sign-in factors | The pool does not set `SignInPolicy`; passwordless/passkey methods are expected to stay off (password only) but that default is unverified | Confirm the sign-in form shows only password |

---

## Phase 2B: INC-104 scenario and assignment slice

**Status: Local.** Nothing in this section has been deployed or verified against AWS. It adds a manager →
employee workflow: a manager assigns INC-104, the employee finds it, starts the investigation, and reads the
authoritative session state back after a refresh. Cognito and the data tier are not touched.

### Routes

| Route | Who (decided server-side) | Purpose |
|---|---|---|
| `GET /health` | public | unchanged |
| `GET /v1/me` | any signed-in user | unchanged |
| `GET /v1/orgs/{orgId}/assignable-employees` | `manager`, `org_admin` | employees the caller may assign (team-scoped for managers) |
| `GET /v1/orgs/{orgId}/assignments` | `employee`, `manager`, `org_admin` | employee: own assignments; manager/admin: assignments they created |
| `POST /v1/orgs/{orgId}/assignments` | `manager`, `org_admin` | assign the latest published INC-104 (idempotent) |
| `POST /v1/assignments/{assignmentId}/start` | the assigned `employee` only | start or resume (idempotent) |
| `GET /v1/sessions/{sessionId}` | the session's `employee` only | authoritative state |
| `POST /v1/sessions/{sessionId}/actions` | the session's `employee` only | `OPEN_TICKET` / `OPEN_RUNBOOK` / `OPEN_DIAGNOSTICS` with `expectedStateVersion` |

Every route except `/health` sits behind the JWT authorizer; the Lambda then authorizes against the DynamoDB
membership record and ownership. Denials are an opaque `404` (no access / not yours / does not exist) or `403`
(a real member lacking the role). Request bodies are strict: a forged `role`, `organizationId`, `status` or
`passed` field is a `400`, never silently ignored.

### What the update changes in `onboardos-dev`

Derived by running SAM's translator locally on the deployed Phase 2A template (`main`) and the new one and
diffing the resulting CloudFormation. **This is not a CloudFormation change-set**, so replacement behaviour is
not verified; the gate in "Pre-deploy gate" above still applies unchanged.

| Resource | Change |
|---|---|
| 6 x `OnboardOSApiFunctionApi{ListAssignableEmployees,ListAssignments,CreateAssignment,StartAssignment,GetSession,SessionAction}Permission` | **Added** (Lambda invoke permissions for the new routes) |
| `OnboardOSApiFunction` | Modified: `Description`, new code |
| `OnboardOSApiRole` | Modified: `Description`, `Policies` (see matrix) |
| `OnboardOSHttpApi` | Modified: OpenAPI `Body` only (+6 routes, all JWT-protected; CORS +`POST`) |
| `OnboardOSUserPool`, `OnboardOSSpaClient`, `OnboardOSUserPoolDomain`, `OnboardOSManagedLoginBranding` | **Unchanged** (Cognito is not touched) |
| `OnboardOSCoreTable`, `OnboardOSEventsTable` | **Unchanged** |
| `OnboardOSSmokeFunction`, `OnboardOSSmokeRole`, both log groups, default stage | **Unchanged** (the smoke artifact is byte-for-byte the same size as before) |
| Removed resources | None |

### API role permissions (the only IAM change)

| Statement | Before (Phase 2A) | After (Phase 2B) | Used by |
|---|---|---|---|
| Core table items | `GetItem` | `GetItem`, `PutItem`, `UpdateItem` | membership/assignment/session reads; create assignment; session + assignment writes |
| Core table + `GSI1` + `GSI2` | none | `Query` | member directory (single partition); employee list (`GSI1`); manager list (`GSI2`) |
| Events table | none | `PutItem` only | append-only event history |
| Not granted | | `Scan`, `DeleteItem`, `Batch*`, `ConditionCheckItem`, any Events read/update/delete, wildcard indexes | |

`TransactWriteItems` has no IAM action of its own; it is authorized by the per-item `PutItem`/`UpdateItem`
above on each table written. Index permissions name `GSI1` and `GSI2` exactly (no `/index/*`).

### Deploy procedure

Use the same reviewed-change-set procedure as Phase 2A ("Pre-deploy gate", above), with the same command and
parameters you used to deploy Phase 2A (check the stack's current parameter values first; a deploy without
them applies template defaults). Expected change-set:

- `Add`: the six `OnboardOSApiFunctionApi*Permission` resources.
- `Modify`, `Replacement: False`: `OnboardOSApiFunction`, `OnboardOSApiRole`, `OnboardOSHttpApi`.
- **STOP** if anything Cognito (`OnboardOSUserPool`, `OnboardOSSpaClient`, `OnboardOSUserPoolDomain`,
  `OnboardOSManagedLoginBranding`), either table, or the smoke function appears at all, or if any `Remove`
  or any `Replacement` of `True`/`Conditional` appears.

No new Workshop permission is needed beyond what Phase 2A already exercised for the Lambda, IAM role and
HTTP API updates. No Cognito API is called by this change.

### Seed data requirement

Manager scope uses `teamIds`. `scripts/seed-demo.ts` writes `cloud-team-1` for the demo manager and employee,
so the demo works as seeded. A membership with a missing or malformed `teamIds` is treated as invalid and
**fails closed** (a manager with no teams can assign nobody).

### Live verification (NOT RUN: execute after deployment, in this order)

Use real sign-ins for the three demo identities; keep tokens in local shell variables and never paste them
anywhere. `API` = the `ApiUrl` output; `ORG` = `northstar-cloud`.

| # | As | Action | Expected |
|---|---|---|---|
| 1 | manager | open the app | manager screen; employee dropdown lists only team employees |
| 2 | manager | Assign INC-104 | success; row appears as **Assigned** |
| 3 | manager | click Assign again / reload and re-assign | "already assigned"; **one** row (idempotent) |
| 4 | employee (separate browser profile) | open the app | the INC-104 assignment is listed |
| 5 | employee | Start investigation | session page; ticket/runbook/diagnostics open; diagnostics labelled **Synthetic** |
| 6 | employee | refresh the session page | same state and `viewed` flags (read back from the server) |
| 7 | employee | go back and press Resume | same session id; no second session |
| 8 | manager | refresh | assignment shows **In progress** |
| 9 | admin | open the app | the existing identity screen only |
| 10 | curl, employee token | `GET $API/v1/orgs/$ORG/assignable-employees` | `403` |
| 11 | curl, manager token | `GET $API/v1/sessions/<employee's session id>` | `404` (manager preview is not part of this slice) |
| 12 | curl, no token | any `/v1/*` route | `401` from API Gateway |
| 13 | curl, employee token | `POST .../actions` with a stale `expectedStateVersion` | `409` |
| 14 | curl, manager token | `POST .../assignments` with an extra `"role":"org_admin"` field | `400` |

Read-only data checks (the deployment owner, after step 5; table names from the stack outputs):

```bash
aws dynamodb query --table-name <EventsTableName> --region us-east-1 \
  --key-condition-expression "PK = :p" --expression-attribute-values '{":p":{"S":"SESSION#<sessionId>"}}' \
  --query "Items[].[SK.S,type.S,stateVersion.N]" --output table
# Expect SEQ#0000000001 INVESTIGATION_STARTED, then one row per item opened, contiguous.
```

### Known limitations (Phase 2B)

| # | Limitation | Impact |
|---|---|---|
| 1 | Assignment lists read `GSI1`/`GSI2`, which are eventually consistent | a just-created assignment can be absent from an immediate re-read; the manager screen merges the server's own create response, and Refresh converges |
| 2 | Managers/admins list only assignments they created | there is no org-wide view; a second manager does not see the first's assignments |
| 3 | One assignment per (organization, scenario version, employee) | re-assigning returns the existing one; a new attempt arrives with revisions/review |
| 4 | Manager read-only session preview is not implemented | managers get `404` on a session; deliberate, listed in the architecture freeze for a later slice |
| 5 | No pagination | assignment lists cap at 50 and the member directory at 100 (the demo has three members) |
| 6 | Events are written but have no read API | the timeline view arrives with the review slice; verify through DynamoDB |
| 7 | No config editing, test runs or submission | `SAVE_CONFIG`, tests and reports are rejected as unknown actions; the next slice adds them |
| 8 | `GSI2` partition reuse | the manager partition holds `ASSIGN#...` entries now; the frozen design's `REVIEWABLE#...` entries will share it later (see ADR-016) |
| 9 | All behaviour is verified only against an in-memory DynamoDB and the real handler code | real DynamoDB, the JWT authorizer and the deployed UI are unverified until the table above is executed |

### Rollback

Phase 2B is additive: it changes IAM, routes and code, not data or identity. To roll back, redeploy the
previous (Phase 2A) template through the same change-set gate; this removes the six routes, their
permissions and the extra IAM, and leaves Cognito and both tables as they are. Assignments, sessions and
events already written stay in the tables (harmless; ignored by Phase 2A code). `sam delete` is not a
rollback: it deletes the tables.

---

## Phase 2C: immutable config revisions and a real Lambda test runner

**Status: Local. Not committed, not deployed, NOT VERIFIED ON AWS.** Everything in this section is verified only by
unit/integration tests against an in-memory DynamoDB and the real handler code. No AWS request has been made
for this phase. The first real runner invocation happens in "Live verification" below.

An employee investigating INC-104 can edit `request_timeout_ms` (100-2000), save it as a numbered, immutable,
SHA-256-hashed revision, run a fixed hidden suite in a dedicated private Lambda, and see persisted results tied
to that exact revision. Results for an older configuration stay in history, marked **Stale**.

### Routes added (all JWT-protected; the Lambda then checks ownership and ACTIVE employee membership)

| Route | Body | Result |
|---|---|---|
| `PUT /v1/sessions/{sessionId}/config` | `{ expectedStateVersion, config: { request_timeout_ms } }` | new revision N+1; `422 CONFIG_OUT_OF_POLICY` outside 100-2000; `422 CONFIG_UNCHANGED`; `400` for wrong type/unknown field/forged `configHash`/`revision`/`status`/`passed`; `409` stale version |
| `POST /v1/sessions/{sessionId}/test-runs` | `{ expectedStateVersion }` **only** | tests the **current** revision; `201 { testRun, session }`; `409 RUN_IN_PROGRESS`/`VERSION_CONFLICT`; `429 RUN_LIMIT_REACHED` (20) |
| `GET /v1/sessions/{sessionId}/test-runs/{runId}` | none | `{ testRun, session }`; also closes a run that never finished (see "Stranded runs") |

The client never sends a revision number, hash, suite id, expectation or result. Anything else is a `400`.
Another user's session or run id is an opaque `404`.

### Data model (same `SESSION#<id>` partition of the Core table)

| Item | Key | Written | Immutable? |
|---|---|---|---|
| Session state (existing) | `SESSION#id / STATE` | every action | replaced under `stateVersion = :expected` |
| Config revision N | `SK = CONFIG#<10-digit N>` | with the state change, `attribute_not_exists` | **yes**, never updated |
| Test run | `SK = TEST#<runId>`, `runId = run_<4-digit n>_<12 hex>` | PENDING with the state change; replaced once by the terminal record only `if status = PENDING` | terminal record is final |
| Events (Events table) | `SEQ#<stateVersion>` | with every state change | append-only |

New state fields: `configRevision` (0 = scenario baseline, which is **not** stored as an item), `configHash`,
`testRunsRequested`, `activeTestRunId`. They are optional on read, so sessions stored by Phase 2B load with the
defaults a fresh session starts with, and are upgraded on their next write. A stored `configHash` that disagrees
with the stored `config` is treated as corruption (HTTP 500, fail closed). A stored run whose status disagrees
with its own cases (for example `PASSED` with a failing case) or whose snapshot does not hash to its recorded
hash is skipped and logged, never displayed.

`configHash` is `sha256:` + hex SHA-256 of the canonical (sorted-key) JSON of the config, computed only on the
server and re-computed independently by the runner (checked with `shasum`: `800` ->
`fa812173...0386`, `1400` -> `825d32dd...c891f`, `1800` -> `610a9550...86ca`).

### Runner protocol (freeze doc, section H)

1. Persist the run `PENDING`, with the session state change and the `TEST_RUN_REQUESTED` event, in one transaction.
   The runner client is obtained **before** this write, so a misconfigured runner fails with a 500 and leaves nothing behind.
2. Invoke `OnboardOSScenarioRunner` synchronously (`RequestResponse`, `LogType None`, aborted after 15 s; the runner's own timeout is 10 s, the API function's 29 s). The request carries the server-held snapshot, its hash and the suite identity.
3. Validate the response strictly: schema, the echoed `testRunId`/`suiteId`/`suiteVersion`/`configHash` must equal what was sent, case ids unique and bounded, and `status = PASSED` **iff** every case passed. Any violation is `ERROR`, never a pass.
4. Persist the terminal state (`PASSED`/`FAILED`/`ERROR`), the run record and the `TEST_RUN_COMPLETED` event (actor `system:scenario-runner`) in one transaction conditional on the run still being `PENDING`. A race with a save is retried (up to 3 reads); an already-terminal run is returned unchanged (idempotent).

Stored `errorCode`s: `RUNNER_INVOCATION_FAILED`, `RUNNER_TIMEOUT`, `RUNNER_FUNCTION_ERROR`, `RUNNER_BAD_RESPONSE`,
`RUNNER_MISMATCH`, `RUNNER_REJECTED`, `STRANDED`. Each has one fixed user-safe message; raw SDK/Lambda error text is never stored or returned.

**Stranded runs.** A `PENDING` run older than 60 s cannot still be executing. The next poll (`GET .../test-runs/{runId}`) or
the next run request records it as `ERROR / STRANDED` through the same conditional write (the first terminal write wins; a late
original completion cannot overwrite it). A run request that performs this repair returns `409 VERSION_CONFLICT`; the client reloads and retries.

### Suite (hidden) and what the employee sees

The suite lives only in `services/test-runner/src/suites/inc104.ts`. Five checks: `schema-valid`, `within-policy`,
`revision-hash-matches`, `latency-profile-a`, `latency-profile-b`. Expected: **800 -> FAILED 3/5, 1400 -> FAILED 4/5,
1800 -> PASSED 5/5.** The employee receives case names, PASS/FAIL and a neutral message only: no thresholds, no suite id,
no function name or ARN. Out-of-policy values cannot be saved at all (the server rejects them before a revision exists).

The `executor` block (`kind: AWS_LAMBDA`, `region`, `runnerRequestId`, `invokeRequestId`) is shown so a human can find the exact
CloudWatch log line. It is evidence that the runner function answered, not a cryptographic attestation.

### Staleness

Computed at read time only: a run is **current** iff its `configRevision`, `configHash` and `suiteVersion` equal the session's now.
Finished runs that are not current are `stale: true`. Nothing is rewritten: a later save never mutates or deletes an earlier run.
Saving while a run is in flight is allowed; that run completes and is recorded as stale.
Reverting to an earlier value is a **new** revision, so evidence from the earlier identical value stays stale.

### What the update changes in `onboardos-dev`

Derived by running SAM's translator locally on the `HEAD` (Phase 2B) template and the new one and diffing the CloudFormation
it produces. **This is not a CloudFormation change-set**; replacement behaviour is not verified. The reviewed-change-set gate
("Pre-deploy gate", above) applies unchanged.

| Resource | Change |
|---|---|
| `OnboardOSScenarioRunner` (`AWS::Lambda::Function`) | **Added.** Handler `handler.runnerHandler`, `CodeUri ../services/test-runner/`, Timeout 10, Memory 256, **no `Events`, no `Environment`** |
| `OnboardOSRunnerRole` (`AWS::IAM::Role`) | **Added.** CloudWatch Logs only |
| `OnboardOSRunnerLogGroup` | **Added.** Retention = `LogRetentionDays` |
| `OnboardOSApiFunctionApi{SaveConfig,RunTests,GetTestRun}Permission` | **Added** (API Gateway invoke permission for the 3 routes) |
| `OnboardOSApiFunction` | Modified: `Description`, new code, new env var `ONBOARDOS_RUNNER_FUNCTION_NAME` (`Ref` of the runner: a name, not a secret) |
| `OnboardOSApiRole` | Modified: `Description`, `Policies` (+ `InvokeScenarioRunner`) |
| `OnboardOSHttpApi` | Modified: OpenAPI `Body` only (+3 JWT-protected routes; CORS `AllowMethods` + `PUT`) |
| Cognito (4 resources), both tables, smoke function/role, other log groups, stage, Outputs | **Unchanged** |
| Removed resources | None |

The runner has no output, so its name is not published; see step 2 below to look it up.

### IAM matrix (what each identity can do)

| Identity | Allowed | Explicitly not |
|---|---|---|
| `OnboardOSApiRole` (existing + new) | Core `GetItem`/`PutItem`/`UpdateItem`; Core+GSI1+GSI2 `Query`; Events `PutItem`; **`lambda:InvokeFunction` on the runner ARN only**; logs | `Scan`, `Delete*`, `Batch*`, Events reads, any other Lambda, wildcard resources |
| `OnboardOSRunnerRole` (new) | `logs:CreateLogGroup/CreateLogStream/PutLogEvents` on `/aws/lambda/<stack>-*` | any DynamoDB, any Lambda, S3, Secrets Manager, SSM, KMS, Bedrock |
| Runner function resource policy | none added: no HTTP route, no function URL, no event source, no `AWS::Lambda::Permission` | invocation by anything but an IAM principal holding `lambda:InvokeFunction` |
| Browser / any end user | the 3 JWT-protected routes above | calling the runner, reading the suite, supplying results |

The API's DynamoDB statements are unchanged: revisions and runs are `PutItem`s and `Query`s on the Core table.
The log-group resource is a stack-name pattern (as for the other roles), because naming the function's own log group would make the role and function depend on each other.

### Deploy procedure

Same reviewed-change-set procedure as before, with the same parameters. Expected change-set:

- `Add`: `OnboardOSScenarioRunner`, `OnboardOSRunnerRole`, `OnboardOSRunnerLogGroup`, the three `OnboardOSApiFunctionApi*Permission`.
- `Modify`, `Replacement: False`: `OnboardOSApiFunction`, `OnboardOSApiRole`, `OnboardOSHttpApi`.
- **STOP** if Cognito, either table, or the smoke function appears, or any `Remove` / `Replacement: True|Conditional` appears.
- Roles are unnamed, so the existing `CAPABILITY_IAM` is sufficient (do not add `CAPABILITY_NAMED_IAM`).

New Workshop permission this exercises: creating one more Lambda function and IAM role, and `lambda:InvokeFunction` at runtime. If the
account restricts Lambda invocation or IAM role creation, step 1 below fails loudly; there is no fallback that fakes a result.

### Live verification (NOT RUN: execute after deployment; every row must pass before calling this "cloud verified")

`FN` = the runner's physical name:
```bash
aws cloudformation describe-stack-resource --stack-name onboardos-dev --region us-east-1 \
  --logical-resource-id OnboardOSScenarioRunner --query "StackResourceDetail.PhysicalResourceId" --output text
```

| # | Who | Action | Expected |
|---|---|---|---|
| 1 | operator (needs invoke rights) | invoke the runner directly for 800, 1400, 1800 (commands below) | `FAILED` 3 of 5; `FAILED` 4 of 5; `PASSED` 5 of 5; a `executor.requestId` in each |
| 2 | operator | invoke with a **wrong** `configHash` | `{"ok":false,"errorCode":"HASH_MISMATCH"}` |
| 3 | operator | confirm no public path: `aws lambda list-function-url-configs --function-name $FN`; `aws lambda get-policy --function-name $FN` | no URL config; no resource policy (or `ResourceNotFoundException`) |
| 4 | employee | open the session, Save `1800`, **Run tests** | revision 1; run **Passed 5/5**; "Executed on AWS Lambda" with two request ids |
| 5 | employee | Save `1400`, Run tests | run **Failed 4/5**; the earlier 1800 run is shown **Stale**, still Passed |
| 6 | employee | Save `800`, then Save `1800`, without running | revision 4 (after steps 4 and 5); no current evidence; all earlier runs Stale |
| 7 | employee | refresh the page | same revisions, runs and stale flags (read from DynamoDB) |
| 8 | curl, employee token | `PUT .../config` with `{"expectedStateVersion":N,"config":{"request_timeout_ms":5000}}` | `422 CONFIG_OUT_OF_POLICY` |
| 9 | curl, employee token | `POST .../test-runs` with `{"expectedStateVersion":N,"status":"PASSED"}` | `400` |
| 10 | curl, another employee's / manager's token | all 3 routes on that session | `404` |
| 11 | CloudWatch | `/aws/lambda/<RunnerFunctionName>` | one `scenario_run` JSON line per run with the same `requestId` as the run's `runnerRequestId` |

Direct invocation (uses the canonical hashes; payload shown for 800):
```bash
aws lambda invoke --function-name "$FN" --region us-east-1 --cli-binary-format raw-in-base64-out \
  --payload '{"testRunId":"run_0001_000000000000","scenarioId":"inc-104","scenarioVersion":1,"suiteId":"inc-104-checkout-timeout","suiteVersion":1,"configSnapshot":{"request_timeout_ms":800},"configHash":"sha256:fa812173342a39f8644ec44f9009cbd00be1f92c8a9c97e0d45fb00006bf0386"}' \
  /tmp/runner-out.json && cat /tmp/runner-out.json
# 1400 -> sha256:825d32dd1b2f4f98e7d7ecd536304ebbd8fc2ae554f31ac6b2e76d5008dc891f
# 1800 -> sha256:610a9550b739187eb3b6e8299258063ffdde813eed492505e596e2dd036386ca
```

Read-only data check after step 4 (table name from the stack outputs):
```bash
aws dynamodb query --table-name <CoreTableName> --region us-east-1 \
  --key-condition-expression "PK = :p AND begins_with(SK, :s)" \
  --expression-attribute-values '{":p":{"S":"SESSION#<sessionId>"},":s":{"S":"TEST#"}}' \
  --query "Items[].[SK.S,status.S,configRevision.N,configHash.S]" --output table
```

Open question to resolve by observation in step 11: whether the `invokeRequestId` the API receives equals the runner's own
`context.awsRequestId`. AWS documents the invoke response's request id; this code does **not** assume they are equal and does not
enforce it. Record what you observe.

### Known limitations (Phase 2C)

| # | Limitation | Impact |
|---|---|---|
| 1 | **Nothing here is verified on AWS** | the Lambda `Invoke` call, IAM, the JWT authorizer, real DynamoDB conditions and the UI are untested until the table above is run |
| 2 | The runner is trusted to execute honestly | the API validates shape, echoes and internal consistency, but a *compromised* runner that returned self-consistent false results could not be detected; the defence is that only the stack's code is deployed there, it holds no data access, and no one else may invoke it |
| 3 | Synchronous invocation inside an API request | a slow runner makes the request slow (bounded at 15 s); the client polls if it loses the response |
| 4 | Stranded-run repair happens on a poll or the next run request | a PENDING run can remain visible for up to 60 s after a crash, plus the time until someone polls |
| 5 | A stored run or revision that fails validation is hidden (logged), not repaired | the employee sees fewer items rather than false ones |
| 6 | 20 runs and 30 revisions per session; one run in flight | by design; bounded storage and cost |
| 7 | The UI is not covered by component tests | request shapes, validation helpers and presentation rules are unit-tested; the React page itself is type-checked and built only |
| 8 | Employees can still probe thresholds by experiment | pass/fail is the product; it is capped at 20 runs and gives no numbers |
| 9 | `invokeRequestId` vs. runner `requestId` equality is unverified | see the open question above |
| 10 | No Bedrock, report submission, manager review of runs, or step functions | later slices |

### Rollback

Redeploy the Phase 2B template through the same change-set gate. This removes the runner, its role and log group, the three routes and
permissions and the `InvokeFunction` statement, and leaves Cognito and both tables as they are. Stored revisions, runs and the extra state
fields remain in the Core table (harmless to Phase 2B code, which ignores unknown attributes; its next write to a session drops the
Phase 2C state fields, leaving revision and run items orphaned but intact). `sam delete` is not a rollback: it deletes the tables.

---

## Phase 2D: frozen submission and human manager review (ONB-10)

**Status: Local. Not committed, not deployed, NOT VERIFIED ON AWS.** Everything here is verified only by unit and
integration tests against an in-memory DynamoDB and the real handler code (the runner is the real runner handler called
in-process). No AWS request was made for this phase. **There is no Bedrock in this phase**: every submission records
`evaluation.status = NOT_CONFIGURED`, and the manager UI says so.

The loop: employee investigates -> runs tests -> submits an incident report -> evidence is frozen -> a manager reads the frozen
evidence -> approves or requests a revision -> after a revision request the employee begins the next attempt and resubmits.

### Routes added (all JWT-protected; the Lambda authorizes every call against DynamoDB)

| Route | Who | Body | Result |
|---|---|---|---|
| `POST /v1/sessions/{sessionId}/submissions` | the session's employee | header `Idempotency-Key` (8-64 of `A-Za-z0-9_-`); `{ expectedStateVersion, testRunId, configRevision, configHash, report{rootCause,correctiveAction,verification,remainingRisks} }` | `201` new / `200` identical replay; `422 EVIDENCE_NOT_CURRENT`, `422 EVIDENCE_NOT_COMPLETED`, `409 EVIDENCE_MISMATCH`, `409 RUN_IN_PROGRESS`, `409 ALREADY_SUBMITTED`, `409 IDEMPOTENCY_CONFLICT`, `409 VERSION_CONFLICT`, `400` shape |
| `GET /v1/reviews/{submissionId}` | assigning manager; org admin of that org | none | read-only evidence bundle (`submission`, `employee`, `assignment`, `history`, `timeline`, `canDecide`) |
| `POST /v1/reviews/{submissionId}/decision` | same | `{ decision: APPROVE\|REQUEST_REVISION, feedback? }` | `200`; `409 ALREADY_DECIDED`, `409 NOT_AWAITING_REVIEW`, `422 ATTEMPT_LIMIT_REACHED`, `400` (revision needs >= 10 chars of feedback) |
| `POST /v1/assignments/{id}/start` (existing) | the assigned employee | none | now also: `REVISION_REQUESTED` -> creates attempt N+1 (`201`); any other started status -> reopens the existing session (`200`) |

Anything unauthorized (unknown id, other tenant, other manager's employee, the employee themself) is the same opaque `404`.
Request bodies are strict; a forged `status`, `submissionId`, `employeeSub`, `passed`, `reviewerSub`, `rubricVersion`, `evaluation` or `testRun` is a `400`.
The reviewer's identity is the verified token's subject, never the body.

### What a submission is (server-built, immutable)

The request supplies only the report text and an **assertion** of the evidence the employee believes they are looking at
(`testRunId`, `configRevision`, `configHash`). The server derives the real evidence from its own records and rejects any difference:

* usable evidence = the **newest run whose revision, hash and suite version equal the session's current ones**;
* none (never run, or the config changed since) -> `422 EVIDENCE_NOT_CURRENT`; PENDING -> `409`; ERROR -> `422 EVIDENCE_NOT_COMPLETED` (an ERROR run on the current config is not skipped in favour of an older pass);
* a **FAILED** run is accepted and labelled FAILED everywhere (employee page, manager page, stored record). It is honest evidence, not a resolution.

Stored once, never updated, at `PK=ASSIGN#<assignmentId>, SK=SUBMISSION#<NN>` (create-if-absent): server-generated `submissionId` and attempt, org, assignment,
session, employee, scenario id/version, `rubricVersion`, `manifestVersion`, the report, the exact config revision/hash/snapshot, the frozen terminal run (cases,
suite version, executor region and request ids), what was opened, the last evidence event sequence, `submittedAt` and `evaluation`.

### One transaction, five effects

Session `INVESTIGATING -> SUBMITTED` (conditional on `stateVersion` and owner) + immutable submission (create-only) + idempotency ledger entry
(create-only, `PK=SESSION#id, SK=IDEM#SUBMIT#<key>`, holds a hash of the request content) + assignment `IN_PROGRESS -> AWAITING_REVIEW`
(conditional on this very session) + the `SUBMISSION_CREATED` event at the new state version. Any failed condition cancels all of it.

* Same key + same content -> the original submission (`200`, `created:false`), nothing written. Same key + different content -> `409 IDEMPOTENCY_CONFLICT`.
* Two simultaneous submissions: exactly one commits; the loser is `409` (different keys) or a replay (same key).
* Once submitted the attempt is locked by the engine: save-config, run-tests, open-item and re-submit are all rejected. Earlier revisions and runs stay readable.

### Lifecycle and the no-AI state

`ASSIGNED -> IN_PROGRESS -> AWAITING_REVIEW -> APPROVED | REVISION_REQUESTED -> (employee begins) IN_PROGRESS` (attempt N+1).
`SUBMITTED` and `EVALUATING` stay in the contract but are **not produced**. Without AI a submission goes straight to `AWAITING_REVIEW` with
`evaluation = NOT_CONFIGURED`, because a separate `SUBMITTED -> AWAITING_REVIEW` write would not be atomic and could strand a submission where no
manager could see it. When Bedrock arrives, the submit transaction targets `EVALUATING` instead and a worker moves it to `AWAITING_REVIEW`.

### Decisions (immutable, one per submission)

A decision is an append-only item at `ASSIGN#<id> / DECISION#<NN>` (create-only; one slot per attempt, so a second decision cannot exist) written in the same transaction as the session's
`REVIEW_DECIDED` event (the engine action `RECORD_REVIEW`, which refuses the employee and the system identity), and the assignment move to `APPROVED` / `REVISION_REQUESTED`
(conditional on `AWAITING_REVIEW` and on this being `latestSubmissionId`). Repeating the identical decision by the same reviewer is an idempotent `200`; anything else is `409 ALREADY_DECIDED`.

### Revision attempts

`REQUEST_REVISION` leaves attempt N exactly as it is. The employee's **Begin attempt N+1** calls the existing start route, which creates a **new session**
(`sessionIdFor(assignmentId, N+1)`), a first event, and moves the assignment to `IN_PROGRESS` pointing at it, atomically and conditional on the previous session id (a double click yields one attempt).
Attempt N+1 starts from the scenario baseline (revision 0), not from attempt N's configuration; attempt N's submission and the manager's feedback stay visible on the page.
Maximum 5 attempts: a revision cannot be requested on the 5th, and a 6th cannot begin. Attempt 1 uses the existing deterministic ids, so live Phase 2B/2C records are unchanged;
`attemptNumber`, `latestSubmissionId`, `submissionId` and `reviewDecision` are optional on read and default to attempt 1 / none.

### Manager queue and timeline (no scan, no new index)

The review queue is the manager's **existing** `GSI2` `ASSIGN#` listing filtered to `AWAITING_REVIEW`; the assignment gained `latestSubmissionId`. The `GSI2SK` prefix is unchanged.
The timeline is a bounded single-partition `Query` of the Events table for that session (<= 250 events), cut off at the submission event.

### What the update changes in `onboardos-dev`

Derived by running SAM's translator locally on the `HEAD` template (Phase 2C as merged) and on the new one and diffing the CloudFormation. **This is not a change set**; replacement behaviour is unverified.

| Resource | Change |
|---|---|
| `OnboardOSApiFunctionApi{SubmitReport,GetReview,DecideReview}Permission` | **Added** (API Gateway invoke permission for the 3 routes) |
| `OnboardOSApiFunction` | Modified: `Description`, new code only (no environment change) |
| `OnboardOSApiRole` | Modified: `Description`, `Policies` (+ `EventsRead`) |
| `OnboardOSHttpApi` | Modified: OpenAPI `Body` only (+3 JWT-protected routes; CORS `AllowHeaders` + `Idempotency-Key`) |
| Cognito (4), both tables, runner function/role/log group, smoke function/role, other log groups, Outputs | **Unchanged** |
| Removed resources | None |

### IAM delta (the only one)

| Identity | Added | Still not allowed |
|---|---|---|
| `OnboardOSApiRole` | `dynamodb:Query` on the **Events table ARN only** (sid `EventsRead`), to read one session's events for the evidence timeline | any Events `Scan`/`GetItem`/`UpdateItem`/`DeleteItem`; any index (the table has none); `Scan` anywhere |
| `OnboardOSRunnerRole`, Cognito, tables | nothing | |

Submissions, decisions and the ledger are `PutItem`/`UpdateItem`/`GetItem`/`Query` on the Core table, already granted.

### Deploy procedure

Same reviewed-change-set gate, same parameters. Expected change set: `Add` the three `OnboardOSApiFunctionApi*Permission`; `Modify`, `Replacement: False`: `OnboardOSApiFunction`, `OnboardOSApiRole`, `OnboardOSHttpApi`.
**STOP** if Cognito, either table, the runner, or the smoke function appears, or any `Remove` / `Replacement: True|Conditional`.
Roles are unnamed, so the existing `CAPABILITY_IAM` is sufficient.

### Live verification (NOT RUN: execute after deployment; every row must pass before calling this verified on AWS)

Use real sign-ins (employee and manager in separate browser profiles). Keep tokens out of shared places.

| # | As | Action | Expected |
|---|---|---|---|
| 1 | employee | open the assigned session, **no test run yet**: look at *Incident report* | submit is disabled; reason "Run the tests ..." |
| 2 | employee | Save `1400`, Run tests, then write all four report fields and **Submit for review** | submitted; page shows *Awaiting review*, evidence "Failed 4 of 5", "executed on AWS Lambda", the runner request id |
| 3 | employee | refresh | still *Submitted*; config/test/report controls are not editable |
| 4 | employee | (DevTools) repeat the submit request with the **same** `Idempotency-Key` | `200`, same `submissionId`, no second record |
| 5 | manager | Refresh the *Review queue* (GSI is eventually consistent: allow a few seconds) | the submission appears; click **Review** |
| 6 | manager | read the page | report, frozen config hash, **Failed 4/5** with the case table, Lambda region and two request ids, timeline of 5+ events ending at *Submitted the incident report* |
| 7 | CloudWatch | open `/aws/lambda/<RunnerFunctionName>` | a `scenario_run` line whose `requestId` equals the page's *runner request* id |
| 8 | manager | **Request revision** with fewer than 10 characters | refused client-side and `400` server-side |
| 9 | manager | Request revision with real feedback | status *Revision requested*; decision shown read-only; refresh persists it |
| 10 | manager | try to decide again (UI is gone; use curl) | `409 ALREADY_DECIDED` |
| 11 | employee | open the assignment list, **Read the feedback**, then **Begin attempt 2** | new session, attempt 2, baseline config, attempt 1 + feedback listed under *Earlier attempts* |
| 12 | employee | Save `1800`, Run tests (expect Passed 5/5), submit | *Awaiting review*; assignment shows attempt 2 |
| 13 | manager | review attempt 2: *All attempts* lists both; **Approve** | *Approved*; employee refresh shows *Approved* and both attempts |
| 14 | curl, employee token | `GET /v1/reviews/<submissionId>` and `POST .../decision` | `404` |
| 15 | curl, a manager who did not assign it / another tenant | same | `404` |
| 16 | curl, no token | any new route | `401` from API Gateway |
| 17 | browser | submit the report from the real origin | the CORS preflight accepts `Idempotency-Key` (no console CORS error) |

Read-only data check (after step 2): `aws dynamodb query --table-name <CoreTableName> --key-condition-expression "PK = :p AND begins_with(SK, :s)" --expression-attribute-values '{":p":{"S":"ASSIGN#<assignmentId>"},":s":{"S":"SUBMISSION#"}}'`.

### Known limitations (Phase 2D)

| # | Limitation | Impact |
|---|---|---|
| 1 | **Nothing here is verified on AWS** | real DynamoDB conditions, IAM (`EventsRead`), Cognito identities, the CORS preflight and the deployed UI are unverified |
| 2 | **No Bedrock / no AI evaluation** | `evaluation = NOT_CONFIGURED`; `SUBMITTED`/`EVALUATING` are reserved and never written |
| 3 | The queue reads `GSI2` (eventually consistent) | a just-submitted item can take a few seconds to appear; Refresh converges |
| 4 | Attempt N+1 starts from the scenario baseline, not attempt N's config | deliberate (fresh, auditable attempt); feedback and the old attempt stay visible |
| 5 | Org admins can review through the API but have no UI | the admin screen is still the identity screen |
| 6 | Idempotency keys exist for **submission** only | decisions and attempt-begin are naturally idempotent (create-only slots, previous-session condition) but have no key ledger |
| 7 | The timeline shows up to 250 events and skips malformed ones | a session holds at most about 222 events (200 actions + 20 run completions + 1 submission + 1 decision), below the limit |
| 8 | No component tests for the React pages | request shapes, validation and presentation rules are unit-tested; **manual browser verification matters** (rows 1-13 above) |
| 9 | Reviewer must be the assigner or an org admin | a second manager on the team cannot review; there is no delegation |
| 10 | A stored submission that fails validation is hidden and the review route returns `500`/`404` | fail closed, never rendered |

### Rollback

Redeploy the Phase 2C template through the same gate: removes the three routes/permissions and `EventsRead`. Submissions, decisions, ledger entries and the extra state fields stay in the Core table, ignored by Phase 2C code
(which cannot write `SUBMITTED` sessions or read these items). An assignment left in `AWAITING_REVIEW`/`APPROVED`/`REVISION_REQUESTED` would be shown by the older UI as its raw status and could not be started. `sam delete` is not a rollback: it deletes the tables.

---

## Phase 4: AI coworker on Amazon Bedrock

**Status: built and verified LOCALLY only. Not committed, not deployed, NOT verified end-to-end on AWS.** The only real Bedrock call made in this project
so far is the Phase 0 smoke test (`amazon.nova-micro-v1:0`, `us-east-1`, Converse, as the Workshop participant role: reply `ready`, 7 input / 2 output tokens,
`end_turn`, 228 ms). It did **not** run as the API Lambda's role. Every automated test uses a fake provider; none of them proves a deployed call.

An employee asks the coworker about the incident they were assigned, gets a Bedrock-written answer, and finds the same conversation after a refresh.
The coworker is **advisory text**: it has no tools and cannot run tests, edit configuration, submit, approve or change anything.

### Routes (JWT-protected; session ownership re-checked on every call)

| Route | Body | Result |
|---|---|---|
| `GET /v1/sessions/{sessionId}/messages` | none | `{ turns[], coworker{ enabled, canSend, reason, modelId, completedTurns, attemptsUsed, limits } }`. Also closes an abandoned reservation. Readable after submission. |
| `POST /v1/sessions/{sessionId}/messages` | header `Idempotency-Key` (8-64 of `A-Za-z0-9_-`); `{ "message": "<1-600 chars>" }` (strict) | `201 { turn, coworker, created:true }`; `200 ... created:false` for an identical retry; the turn is `COMPLETE`, or `ERROR` with a fixed message when the provider failed. |

Errors: `400` shape/length/forged field; `404` not your session (opaque, same for every non-owner); `409 COWORKER_BUSY` (one in flight), `409 IDEMPOTENCY_CONFLICT`
(same key, different text), `409 SESSION_NOT_OPEN` (attempt submitted); `429 COWORKER_LIMIT_REACHED`; `503 AI_UNAVAILABLE` (no model configured).
The request cannot carry a model, role, organization, prompt, session status, test result or credentials: any extra field is a `400`.
A turn exposes only `turnId, status, userText, reply, truncated, modelId, createdAt, completedAt, errorCode, errorMessage`. Token counts, the Bedrock request id, stop reason and
latency are stored on the turn for audit and **never** returned to the browser.

### What the model is told (`coworkerContext.ts`, pure)

Built on the server, after `loadOwnedSession`, from records the server loaded: the employee-visible scenario (ticket, runbook, **synthetic** diagnostics, labelled as such), which items were
opened, the current saved configuration, the newest finished test result **for the current configuration** (the same neutral case names and PASS/FAIL the employee already sees), and the last 6 completed
turns. It is handed no suite id, thresholds, rubric, manager decision, subject id, email, other user's data or credentials: the function has no parameter that could carry them.
Employee text and scenario text are fenced as data, fence characters are neutralized, and the instructions say the data is not instructions. Prompt version `coworker-v1` is stored on every turn.
The model may explain and ask questions; it is told it cannot run or predict tests, act in AWS, or see hidden material.

### Persistence and the one-paid-call rule (Core table; no new table)

| Key (all under `SESSION#<id>`) | Item |
|---|---|
| `CHAT#CTL` | control: revision `ctlRev`, lock holder `ctlActive`, `ctlLease`, `ctlAttempts`, `ctlCompleted` |
| `CHAT#MSG#turn_<13-digit ms>_<12 hex>` | one turn (opaque, sortable by creation time) |
| `CHAT#IDEM#<key>` | idempotency ledger: request hash + turn id |

These cannot collide with `STATE`, `CONFIG#`, `TEST#`, `IDEM#SUBMIT#`, events or submissions (a test asserts it).
A reservation is ONE `TransactWriteItems`: `ConditionCheck` on `STATE` (still `INVESTIGATING` and still this employee's) + the control item moved to the new holder with incremented
counters, **conditional on the revision just read** (or on not existing, the first time) + closing a previous holder's expired turn as `STRANDED` + the new `PENDING` turn
(create-only) + the ledger entry (create-only). Only the request whose transaction commits calls Bedrock, once, outside the transaction (`maxAttempts: 1`, 20 s abort). Completion is a second conditional
transaction: the turn must still be `PENDING` and the lock must still belong to this turn, so a late result after a takeover is discarded and cannot overwrite the closed turn or free someone else's lock.

* Limits: 600 characters per message, 20 successful turns, 30 total attempts (errors count), one in flight, 6 turns of history, 400 output tokens, reply capped at 2000 characters.
* Same key + same text returns the stored turn with **no** new model call (also while it is `PENDING`, and for an `ERROR` turn). Same key + different text is `409`. A deliberate retry after an error uses a **new** key.
* A reservation not finished within 60 s is closed as `STRANDED` by the next read or question.
* Chat is **not** scenario state: it never writes `STATE`, never changes `stateVersion`, writes no Events, and is unaffected by the 200-action cap. New messages are accepted only while the attempt is `INVESTIGATING`; history stays readable after submission.

**Not guaranteed:** exactly-once billing. If Bedrock accepts and processes a request but the connection drops before we hear back, the service may have billed a call that we record as `ERROR`; the user then asks again with a new key.
If the answer cannot be stored after a successful call, the turn stays `PENDING` until the lease closes it as `STRANDED` and that answer is lost (not shown, not invented).

**Consequence for evidence:** frozen submissions do not include chat and are unchanged. A later phase can add an optional field to *new* submissions (counts, model id, first/last time, a digest of the ordered turns, not the text); old submissions
would read "not recorded", never "none" (ADR-038).

### Infrastructure changes (additive; the coworker is OFF by default)

| Change | Detail |
|---|---|
| Parameter `CoworkerModelId` | default `""`; `AllowedValues`: `""` or `amazon.nova-micro-v1:0` only |
| Condition `HasCoworkerModel` | parameter is not empty |
| API function env | `ONBOARDOS_COWORKER_MODEL_ID: !Ref CoworkerModelId` |
| Routes | `GET` and `POST /v1/sessions/{sessionId}/messages`, both behind the JWT authorizer (CORS already allows `Idempotency-Key`) |
| API role policy `OnboardOSApiCoworker` | **only when the parameter is non-empty** (`Fn::If` ... `AWS::NoValue`): `bedrock:InvokeModel` on `arn:aws:bedrock:${AWS::Region}::foundation-model/${CoworkerModelId}` (one action, one resource) and `dynamodb:ConditionCheckItem` on the Core table ARN |
| Unchanged | the three existing API role policies (verified byte-identical in the translated output), both tables, Cognito, the runner function and role, the smoke function, the Outputs, the Vercel configuration |

`dynamodb:ConditionCheckItem` is the one grant that is not Bedrock: `TransactWriteItems` authorizes a `ConditionCheck` by that action, and the reservation uses one on `STATE` so it can verify the session is still open without writing it.
It is created only with the coworker policy, and a template test asserts it appears once, on the Core table. If it were missing the symptom would be `500` on every `POST` (the first thing to look for in the live check).

CloudFormation diff against `main` (SAM translator; **not** a change set, so replacement behaviour is unverified): **Added** `OnboardOSApiFunctionApi{ListCoworkerMessages,SendCoworkerMessage}Permission`;
**Modified in place** `OnboardOSApiFunction` (one environment variable), `OnboardOSApiRole` (one conditional policy), `OnboardOSHttpApi` (OpenAPI body: one path with GET and POST); no resource removed; Outputs unchanged.

### Deployment commands (PREPARED, NOT EXECUTED)

Deploy in two steps so infrastructure and behaviour change separately. Use the same stack, region and parameters as the last deployment (check `aws cloudformation describe-stacks --stack-name onboardos-dev --query 'Stacks[0].Parameters'` first and pass those values explicitly).

```bash
# 0. Local gate on the exact commit being deployed
npm ci && npm run verify
sam validate --template-file infrastructure/template.yaml --lint

# 1. Build, then create a change set WITHOUT executing it (coworker stays OFF: CoworkerModelId="")
sam build --template-file infrastructure/template.yaml --build-in-source
sam deploy --stack-name onboardos-dev --region us-east-1 --resolve-s3 --capabilities CAPABILITY_IAM \
  --no-execute-changeset --no-confirm-changeset --no-fail-on-empty-changeset \
  --parameter-overrides LogRetentionDays=<current> DemoOrgId=<current> CoworkerModelId=""   # add the other current parameter values

# 2. Review the change set (see "Expected change set"), then, only after approval:
aws cloudformation describe-change-set --stack-name onboardos-dev --region us-east-1 --change-set-name <name> \
  --query 'Changes[].ResourceChange.[Action,LogicalResourceId,ResourceType,Replacement]' --output table
aws cloudformation execute-change-set --stack-name onboardos-dev --region us-east-1 --change-set-name <name>

# 3. Turn the coworker ON as a second, separate change set (adds the Bedrock policy), reviewed the same way
sam deploy ... --no-execute-changeset ... --parameter-overrides ... CoworkerModelId="amazon.nova-micro-v1:0"
```

**Expected change set, step 1 (feature OFF):** `Add` `OnboardOSApiFunctionApiListCoworkerMessagesPermission` and `OnboardOSApiFunctionApiSendCoworkerMessagePermission`;
`Modify`, `Replacement: False`: `OnboardOSApiFunction`, `OnboardOSHttpApi`, and `OnboardOSApiRole` **only if CloudFormation counts the removed-by-condition policy as a change** (with the feature off the role's policies are identical to today).
**Step 3 (feature ON):** `Modify`, `Replacement: False`: `OnboardOSApiFunction` (env value), `OnboardOSApiRole` (adds `OnboardOSApiCoworker`).
**STOP** if the change set shows any `Remove`, any `Replacement` of `True`/`Conditional`, or touches either table, Cognito, the runner function or role, or the smoke function. Roles are unnamed, so `CAPABILITY_IAM` is sufficient.
Do not run `sam deploy` without `--no-execute-changeset` for this change.

### Live verification (NOT RUN; every row must pass before calling this verified on AWS)

| # | As | Action | Expected |
|---|---|---|---|
| 1 | employee | open a session with the stack deployed but the coworker OFF | panel says the AI coworker is not available; the input is disabled; nothing simulated |
| 2 | operator | step 3 (ON). Employee reloads | panel shows `amazon.nova-micro-v1:0` and is enabled |
| 3 | employee | ask "What should I check first?" | an answer within a few seconds, labelled "AI coworker · amazon.nova-micro-v1:0" (this is the first proof that the **API Lambda's role** can invoke the model) |
| 4 | operator | CloudWatch, API log group | one `coworker_turn` line with `status:"COMPLETE"`, a Bedrock `requestId`, token counts, **no** question or answer text |
| 5 | employee | refresh the page | same conversation |
| 6 | employee | ask while the previous answer is pending (two tabs) | the second gets "still answering" (409); only one `coworker_turn` line |
| 7 | employee | repeat a request with the same `Idempotency-Key` (DevTools) | `200`, `created:false`, no new log line |
| 8 | employee | Save config, run tests, then ask "did my change work?" | the answer is consistent with the shown test result and does not claim to have run anything |
| 9 | employee | submit the report, then reopen the session | history visible, input disabled with the read-only reason; `POST` returns `409` |
| 10 | curl, another employee / manager / admin | `GET`/`POST .../messages` on that session | `404` |
| 11 | curl, no token | the same | `401` from API Gateway |
| 12 | operator | set `CoworkerModelId=""` again | panel returns to unavailable; history still readable |
| 13 | browser | the existing workflow: assign, investigate, save, run tests, submit, review | unchanged |

If row 3 returns an `ERROR` turn, read the stored `errorCode` / the log's error name: `AI_UNAVAILABLE` points at IAM (`bedrock:InvokeModel`), the model id, or an SCP; the `500` described above points at `ConditionCheckItem`.

### Known limitations (Phase 4)

| # | Limitation | Impact |
|---|---|---|
| 1 | **No deployed check has run** | the Lambda role's Bedrock permission, `ConditionCheckItem`, the empty-string environment variable and the UI are untested on AWS |
| 2 | Billing is at-least-once under network ambiguity | see above; capped at 30 attempts per session |
| 3 | Synchronous: the POST waits for the model (up to 20 s) | a slow model means a slow request; the page shows a waiting state and polls if the response is lost |
| 4 | No streaming | the answer appears whole |
| 5 | A completed answer that cannot be stored is lost | the turn closes as `STRANDED` after 60 s |
| 6 | Model answers can be wrong | the panel says so; they never feed evidence or decisions |
| 7 | Chat is not in the frozen evidence | managers cannot see it (deliberate; ADR-038) |
| 8 | The React panel has no DOM-level tests | request shapes, rules and the rendering of a turn (server-rendered, so escaping is checked) are tested; **manual browser verification matters** |
| 9 | One model, one prompt version, English only | `coworker-v1` |
| 10 | Local tooling: the SAM build step removes `@types/aws-lambda` from `node_modules`, so a second consecutive `npm run verify` needs `npm ci` | unaffected CI / fresh clone |

### Rollback

Fastest: redeploy with `CoworkerModelId=""` (removes the Bedrock policy; the API then answers `503 AI_UNAVAILABLE` and the panel says so). Full: redeploy the previous template through the same gate (removes the two routes and permissions).
Stored `CHAT#` items are ignored by older code and harmless. `sam delete` is not a rollback: it deletes the tables.

### Release coordination: frontend and backend deploy separately (Phase 4)

* **Vercel** builds the SPA from Git (`vercel.json` only adds an SPA rewrite). **SAM** deploys the API and is run by hand. Merging this branch to `main` therefore ships the new web code to production *before* the two `/messages` routes exist.
* The panel is behind **`VITE_COWORKER_ENABLED`** (build-time, default OFF; only the value `true`, any case, enables it). With it unset the merged frontend renders no coworker UI and makes no `/messages` request, so a merge that runs ahead of the stack is harmless. Nothing else in this branch changes how the web app talks to the existing API (`SessionView` and every existing request are unchanged).
* **Order:** (1) merge to `main` (frontend deploys, panel hidden); (2) deploy the stack with `CoworkerModelId=""` and verify the existing workflow; (3) deploy again with `CoworkerModelId="amazon.nova-micro-v1:0"` and verify `GET`/`POST` with a token; (4) set `VITE_COWORKER_ENABLED=true` in Vercel and redeploy the frontend; (5) run the live checks below. The reverse order of (3) and (4) would show a panel reporting "not available" (harmless, honest) or, before (2), failing requests.
* Rollback in either direction is independent: unset the Vercel variable and redeploy to hide the panel; set `CoworkerModelId=""` to turn the backend off.

### Release audit notes (Phase 4)

| Area | Finding |
|---|---|
| Reservation atomicity, IAM | One `TransactWriteItems` (ConditionCheck on `STATE` + control item at a read revision + turn + ledger [+ stranded close]); no two actions target one item (AWS forbids ConditionCheck and Update on the same item). The `ConditionCheck` is authorized by `dynamodb:ConditionCheckItem`, which the conditional policy grants on the Core table only. No code path needs it when the coworker is disabled (POST answers `503` before any transaction; GET and stranded reconciliation use only `UpdateItem`). |
| Concurrency | Same key and different keys, five-way races, takeover races, quota races and late completions are covered by tests; the fake DynamoDB now also rejects unused expression placeholders, as real DynamoDB does. **The fake proves the logic, not AWS behaviour:** the first deployed run is the real check. |
| Submit while an answer is pending | Allowed: chat holds no lock on scenario state. The answer is recorded, the frozen submission and `STATE` are untouched, and later messages get `409 SESSION_NOT_OPEN`. **Defect found and fixed:** the POST response used the phase read *before* the model call, so it could report `canSend: true` after a mid-answer submission; it now reads the phase when responding. |
| Timeouts | Bedrock abort 20 s, SDK request timeout 20 s, Lambda 29 s (inherited), API Gateway 30 s, lease 60 s. The Bedrock SDK client uses an HTTP/2 handler: the timeout is verified on the resolved handler configuration, `connectionTimeout` (an HTTP/1 option that would be ignored) was removed and the SDK default `disableConcurrentStreams` restated. A connection reused after a Lambda freeze could fail its first call; that is recorded as an `ERROR` turn and the user asks again (no automatic retry by design). |
| Isolation | Ledger, control and turns are keyed by session; every read re-parses and re-checks `sessionId`; the model input has no parameter for another user's data. |
| Frontend | No SDK, model id, prompt or suite text in the browser source or the built bundle (tests and a bundle scan). |
