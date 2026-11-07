# OnboardOS — AWS Deployment Guide (Phase 1)

**Status vocabulary** (from `docs/07-verification-and-release.md`):
- **Local** — passed local build/test only; no AWS resources exist or have been tested.
- **AWS verified** — an actual AWS request was made and a real response was received.
- **Deployed** — the resource is live and accessible from the expected endpoint.

Phase 1 currently has status: **Local** (as of the last `npm run verify` run).

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
npm run verify        # typecheck + unit tests + sam build

# Or build only (skips tests):
sam build --template-file infrastructure/template.yaml
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

Once `samconfig.toml` is saved, subsequent deploys can use:

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

Record the `ApiUrl` in `.env.example` as `VITE_API_BASE_URL` (do not commit a
`.env` file with real values).

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
