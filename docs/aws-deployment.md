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
