# OnboardOS — AWS Workshop Studio Service Provisioning Order

**No AWS services have been verified or provisioned by this document.** Team members join the organizer's Workshop Studio using their individual eligible university identities, then use personal temporary credentials only through approved secure mechanisms. Do not put the workshop access code or credentials in GitHub, issue text, screenshots, AI chats, or Devpost.

## Preflight conditions

1. Sign in to workshop using your own @scu.edu email; ensure the organizer associates you with the correct team. Determine the workshop account's expiration time, default Region, and remaining usage quota. Designate one AWS deployment owner.
2. Obtain CLI credentials exactly as Workshop Studio documents; export/set a separate `workshop` CLI profile with session token. Do not create permanent personal IAM credentials just to make development work.
3. Confirm `aws --version`, `sam --version`, `node --version`; prefer a Node 24 compatible local runtime if the toolchain supports it.
4. Run the safe identity preflight, e.g. `aws sts get-caller-identity --profile workshop`. Never paste its raw identifying output into public documentation.
5. Check allowed service consoles and regions. A successful `list-*` does not prove permission to create/invoke; an AccessDenied on `list-*` also does not always prove create is denied. Confirm each service with a deliberately minimal real operation when approved.
6. Verify Bedrock *runtime invocation* for a chosen model/inference profile; `list-foundation-models` is not sufficient. Record only the model identifier and successful/failed status, not credentials.

## Ordered, gated service setup

| Order | Service | Required proof | Resource policy/contract | If blocked |
|---|---|---|---|---|
| 0 | Workshop IAM/STS | Valid temporary identity, known Region and account limits | No permanent keys; don't change external account IAM | Use permitted workshop console mechanisms or organizer help |
| 1 | Lambda + CloudWatch | Can deploy/invoke a minimal API handler, see sanitized logs | Restricted execution role, bounded timeout and retention | Use organizer-provided permitted Lambda role/resource; document difference |
| 2 | API Gateway HTTP API | HTTPS `/v1/health` calls handler | JWT-protected application routes, public minimal health | Check allowed API entry; no unauthenticated mutation endpoint |
| 3 | DynamoDB | Write/read session sentinel under scoped credentials | Two tables and known GSIs, conditional writes | Another authorized persistent AWS store only via documented ADR |
| 4 | Cognito | Three authenticated user identities + access token accepted by API | Public SPA app client, PKCE, access-token JWT and backend membership | Scoped server-auth demo fallback; not frontend role switch |
| 5 | Test Runner Lambda | API invokes dedicated fixed evaluator; records 800ms fail and 1800ms pass | Predefined suite, read-only validated config, output includes revision hash | Do not claim real AWS-backed testing without live proof |
| 6 | Bedrock | Actual permitted model inference, validated JSON or text | Coworker/evaluator not state authority; bounded token/rate budget | Show AI as unavailable; avoid false generated evaluation claims |
| 7 | S3 | Private object round-trip for evidence manifest / report | Block public access, scoped keys and short-lived URLs | Keep small artifacts in DynamoDB temporarily; defer exported files |
| 8 | Frontend hosting | Hosted SPA signs in and hits API using CORS allowlist | Amplify if permitted; Vercel if not | Serve static local demo if necessary, disclose limitations |
| 9 | Optional worker | Asynchronous Bedrock review reaches terminal status and does not duplicate | Invoke permission, idempotent status, retry-safe handler | Bounded sync path if latency permits, or explicit review-pending/error |

**Use one SAM template when CloudFormation/role permissions allow**. If role creation is blocked, inspect whether organizers supply approved precreated roles. Do not bypass event account policies; ask a workshop mentor for permitted alternatives. Keep the same logical app architecture even if physical provisioning differs.

## Identity and region checks (read-only commands)

```bash
aws --version
sam --version
node --version
aws sts get-caller-identity --profile workshop
aws configure list --profile workshop
# Replace <REGION> with the workshop-supported region.
aws bedrock list-foundation-models --region <REGION> --profile workshop
```

A real Bedrock inference must be separately tested with a permitted model ID. The exact invocation payload varies by model, so do not guess an identifier or use the existence of a catalog entry as evidence of entitlement.

## Deployment gate checklist

- [ ] Every teammate can authenticate to their own workshop dashboard.
- [ ] One deployment owner and target AWS Region confirmed.
- [ ] Lambda and CloudWatch smoke test verified.
- [ ] HTTP API reaches Lambda securely.
- [ ] DynamoDB write/read verified, and conditional write conflict tested.
- [ ] Cognito or disclosed secure demo-auth fallback proves role boundaries.
- [ ] API Lambda invokes only the fixed test-runner, with genuine computed results.
- [ ] Bedrock has at least one successful real inference and visible failure handling.
- [ ] S3 private artifact access tested, if enabled.
- [ ] Hosted frontend-to-AWS-to-browser golden path completed.
- [ ] Deployed commit SHA recorded; backup demo video and README prepared for account expiry.

## IAM permissions by backend role (design intent, not a policy ready to apply)

- **API Lambda:** CloudWatch Logs writes, item-level required DynamoDB operations on named tables/GSIs, limited S3 object operations, Bedrock inference only for chosen model/profile, `lambda:InvokeFunction` only on named test-runner/review-worker function ARNs.
- **Runner Lambda:** CloudWatch logging and the narrowest required ability to run a fixed suite on the API-supplied validated config snapshot. No `iam:*`, no general `lambda:InvokeFunction`, no production workload privileges.
- **AI review worker:** specific frozen-submission reads, own evaluation-status writes, selected Bedrock model inference, CloudWatch logging. No manager decision writing.
- **Frontend:** Cognito user-pool authentication and HTTPS application API only. No browser AWS IAM credentials.

## Docs used for decisions

- Lambda TypeScript + SAM: https://docs.aws.amazon.com/lambda/latest/dg/typescript-package.html
- API Gateway JWT: https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html
- DynamoDB transactions: https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html
- Lambda invocation and async retries: https://docs.aws.amazon.com/lambda/latest/api/API_Invoke.html
- Bedrock structured output: https://docs.aws.amazon.com/bedrock/latest/userguide/structured-output.html
- IAM Lambda roles: https://docs.aws.amazon.com/lambda/latest/dg/lambda-permissions.html
- S3 presigned object access: https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html
