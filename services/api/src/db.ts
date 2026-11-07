/**
 * db.ts — DynamoDB document client singleton and low-level data access.
 *
 * All DynamoDB access goes through this module. Higher-level domain logic
 * (routes, auth) calls these functions; they never construct SDK clients
 * or issue table names inline.
 *
 * Key layout (from architecture freeze §F and docs/04-data-and-api.md):
 *   Organization profile : PK=ORG#<orgId>       SK=PROFILE
 *   Membership record    : PK=ORG#<orgId>       SK=MEMBER#<userSub>
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import type { OrgRole, MembershipStatus } from "@onboardos/contracts";

// ---------------------------------------------------------------------------
// Client singleton — created once per Lambda warm instance.
// ---------------------------------------------------------------------------

const rawClient = new DynamoDBClient({});
export const docClient = DynamoDBDocumentClient.from(rawClient);

function coreTable(): string {
  const name = process.env["ONBOARDOS_CORE_TABLE"];
  if (!name) throw new Error("ONBOARDOS_CORE_TABLE environment variable is not set");
  return name;
}

// ---------------------------------------------------------------------------
// Domain types (internal — not exported from contracts)
// ---------------------------------------------------------------------------

export interface MembershipRecord {
  organizationId: string;
  organizationName: string;
  userSub: string;
  role: OrgRole;
  status: MembershipStatus;
  teamIds: string[];
}

// ---------------------------------------------------------------------------
// Data access functions
// ---------------------------------------------------------------------------

/**
 * Load all membership records for a given userSub across all organizations.
 *
 * Implementation: for the hackathon single-org demo, we look up the
 * configured org directly. We never perform a full table scan.
 * The caller filters to ACTIVE memberships before authorization decisions.
 */
export async function getMembershipsForUser(
  userSub: string,
): Promise<MembershipRecord[]> {
  const tableName = coreTable();
  const orgId = process.env["ONBOARDOS_ORG_ID"];

  if (!orgId) {
    return [];
  }

  const result = await docClient.send(
    new GetCommand({
      TableName: tableName,
      Key: {
        PK: `ORG#${orgId}`,
        SK: `MEMBER#${userSub}`,
      },
      ConsistentRead: true,
    }),
  );

  if (!result.Item) return [];

  const item = result.Item;

  const orgResult = await docClient.send(
    new GetCommand({
      TableName: tableName,
      Key: {
        PK: `ORG#${orgId}`,
        SK: "PROFILE",
      },
      ConsistentRead: true,
    }),
  );

  const orgName =
    typeof orgResult.Item?.["name"] === "string"
      ? orgResult.Item["name"]
      : orgId;

  return [
    {
      organizationId: orgId,
      organizationName: orgName,
      userSub,
      role: item["role"] as OrgRole,
      status: item["status"] as MembershipStatus,
      teamIds: Array.isArray(item["teamIds"]) ? (item["teamIds"] as string[]) : [],
    },
  ];
}
