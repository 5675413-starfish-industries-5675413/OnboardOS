#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# invoke-smoke-test.sh
#
# Invokes the OnboardOS smoke-test Lambda and prints the structured result.
#
# PREREQUISITES
#   - AWS CLI v2 installed (aws --version should print "aws-cli/2.x")
#   - AWS credentials available as environment variables (Workshop Studio sets
#     these automatically — no --profile flag is required or accepted):
#       AWS_ACCESS_KEY_ID
#       AWS_SECRET_ACCESS_KEY
#       AWS_SESSION_TOKEN   (required for temporary/STS credentials)
#       AWS_REGION          (or set via STACK_REGION below)
#
# REQUIRED ENVIRONMENT VARIABLES
#   STACK_NAME    CloudFormation stack name, e.g. "onboardos-dev"
#
# OPTIONAL ENVIRONMENT VARIABLES
#   STACK_REGION  AWS region, defaults to AWS_REGION or us-east-1
#
# USAGE
#   STACK_NAME=onboardos-dev STACK_REGION=us-east-1 bash scripts/invoke-smoke-test.sh
#
# EXIT CODES
#   0 — smoke test returned ok=true and cleanupOk=true
#   1 — smoke test returned ok=false, credentials invalid, or invocation failed
# ---------------------------------------------------------------------------

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve configuration
# ---------------------------------------------------------------------------

if [[ -z "${STACK_NAME:-}" ]]; then
  echo "ERROR: STACK_NAME environment variable is required." >&2
  echo "Usage: STACK_NAME=<stack-name> bash scripts/invoke-smoke-test.sh" >&2
  exit 1
fi

REGION="${STACK_REGION:-${AWS_REGION:-us-east-1}}"

echo "Stack:  ${STACK_NAME}"
echo "Region: ${REGION}"
echo ""

# ---------------------------------------------------------------------------
# Step 1: Validate credentials (mandatory preflight — never skip)
# Prints Account and UserId only; does not print the ARN which may contain
# account details in some role configurations.
# ---------------------------------------------------------------------------

echo ">>> Validating AWS credentials..."
IDENTITY=$(aws sts get-caller-identity \
  --region "${REGION}" \
  --output json \
  --no-cli-pager 2>&1) || {
  echo "ERROR: aws sts get-caller-identity failed. Check that AWS_ACCESS_KEY_ID," >&2
  echo "       AWS_SECRET_ACCESS_KEY, and AWS_SESSION_TOKEN are set correctly." >&2
  exit 1
}

ACCOUNT=$(echo "${IDENTITY}" | grep '"Account"' | sed 's/.*: *"\([^"]*\)".*/\1/')
USER_ID=$(echo "${IDENTITY}" | grep '"UserId"'  | sed 's/.*: *"\([^"]*\)".*/\1/' | cut -c1-8)
echo "Account (redacted): ${ACCOUNT:0:4}...${ACCOUNT: -4}"
echo "UserId prefix:      ${USER_ID}..."
echo ""

# ---------------------------------------------------------------------------
# Step 2: Resolve SmokeFunctionName from CloudFormation stack outputs
# ---------------------------------------------------------------------------

echo ">>> Resolving SmokeFunctionName from stack '${STACK_NAME}'..."
OUTPUTS=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --region "${REGION}" \
  --output json \
  --no-cli-pager 2>&1) || {
  echo "ERROR: Could not describe stack '${STACK_NAME}' in region '${REGION}'." >&2
  echo "       Ensure the stack is deployed and the stack name is correct." >&2
  exit 1
}

# Extract SmokeFunctionName from CloudFormation Outputs array
SMOKE_FN=$(echo "${OUTPUTS}" | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
outputs = data['Stacks'][0].get('Outputs', [])
for o in outputs:
    if o['OutputKey'] == 'SmokeFunctionName':
        print(o['OutputValue'])
        break
" 2>/dev/null) || true

if [[ -z "${SMOKE_FN:-}" ]]; then
  echo "ERROR: SmokeFunctionName not found in stack outputs." >&2
  echo "       Check the stack deployed successfully and has a SmokeFunctionName output." >&2
  exit 1
fi

echo "SmokeFunctionName: ${SMOKE_FN}"
echo ""

# ---------------------------------------------------------------------------
# Step 3: Write payload to a temp file (AWS CLI v2 --payload file:// avoids
# base64-encoding issues and shell quoting problems across platforms)
# ---------------------------------------------------------------------------

PAYLOAD_FILE=$(mktemp /tmp/smoke-payload.XXXXXX.json)
RESULT_FILE=$(mktemp /tmp/smoke-result.XXXXXX.json)
trap 'rm -f "${PAYLOAD_FILE}" "${RESULT_FILE}"' EXIT

echo '{"action":"dynamo-ping"}' > "${PAYLOAD_FILE}"

# ---------------------------------------------------------------------------
# Step 4: Invoke the smoke-test Lambda
# --invocation-type RequestResponse  — synchronous invocation
# --log-type None                    — do not retrieve log tail (avoids base64)
# --cli-binary-format raw-in-base64-out  — AWS CLI v2 required flag for file://
# ---------------------------------------------------------------------------

echo ">>> Invoking ${SMOKE_FN}..."
INVOKE_OUTPUT=$(aws lambda invoke \
  --function-name "${SMOKE_FN}" \
  --region "${REGION}" \
  --invocation-type RequestResponse \
  --log-type None \
  --cli-binary-format raw-in-base64-out \
  --payload "file://${PAYLOAD_FILE}" \
  --output json \
  --no-cli-pager \
  "${RESULT_FILE}" 2>&1) || {
  echo "ERROR: aws lambda invoke failed." >&2
  echo "${INVOKE_OUTPUT}" >&2
  exit 1
}

HTTP_STATUS=$(echo "${INVOKE_OUTPUT}" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    print(d.get('StatusCode', 0))
except Exception:
    print(0)
" 2>/dev/null) || HTTP_STATUS="unknown"

# Detect Lambda function errors (HTTP 200 but runtime exception inside the function)
FUNCTION_ERROR=$(echo "${INVOKE_OUTPUT}" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    err = d.get('FunctionError', '')
    print(err)
except Exception:
    print('')
" 2>/dev/null) || FUNCTION_ERROR=""

echo ""
echo "Lambda HTTP status: ${HTTP_STATUS}"
if [[ -n "${FUNCTION_ERROR}" ]]; then
  echo "WARNING: Lambda FunctionError: ${FUNCTION_ERROR}" >&2
fi
echo ""

# ---------------------------------------------------------------------------
# Step 5: Print result
# ---------------------------------------------------------------------------

echo ">>> Smoke test result:"
if command -v jq &>/dev/null; then
  jq . "${RESULT_FILE}"
else
  cat "${RESULT_FILE}"
fi
echo ""

# ---------------------------------------------------------------------------
# Step 6: Evaluate result
# ---------------------------------------------------------------------------

OK=$(python3 -c "
import json, sys, os
try:
    size = os.path.getsize('${RESULT_FILE}')
    if size == 0:
        print('false')
        sys.exit(0)
    d = json.load(open('${RESULT_FILE}'))
    ok = d.get('ok', False)
    cleanup = d.get('cleanupOk', False)
    print('true' if (ok and cleanup) else 'false')
except Exception:
    print('false')
" 2>/dev/null) || OK="false"

if [[ "${OK}" == "true" ]]; then
  echo "RESULT: PASS — DynamoDB round-trip OK and cleanup succeeded."
  exit 0
else
  echo "RESULT: FAIL — Check the result JSON above for details." >&2
  exit 1
fi
