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
