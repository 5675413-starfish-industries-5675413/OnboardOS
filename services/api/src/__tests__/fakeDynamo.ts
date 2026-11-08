/**
 * In-memory DynamoDB for tests -- implements ONLY the semantics the application
 * relies on, and throws on anything else so an unsupported expression can never
 * pass silently:
 *
 *  - Get / Put / Update / Query / TransactWrite (the real SDK command classes);
 *  - ConditionExpression: attribute_not_exists, attribute_exists, "<attr> = :v"
 *    joined with AND (with #name substitution);
 *  - TransactWrite is all-or-nothing and throws TransactionCanceledException
 *    when any condition fails; a single Put with a failed condition throws
 *    ConditionalCheckFailedException;
 *  - Query on a GSI is sparse (items lacking the index keys are absent), and
 *    ConsistentRead on a GSI is rejected exactly as DynamoDB rejects it;
 *  - items containing `undefined` are rejected (DocumentClient marshalling error).
 *
 * `beforeTransact` runs inside a transaction just before its conditions are
 * evaluated, so a test can simulate a competing writer landing between the
 * application's read and its write.
 */

import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

export type Item = Record<string, unknown>;

interface NamedError extends Error {
  CancellationReasons?: Array<{ Code: string }>;
}

function namedError(name: string, message: string): NamedError {
  const e: NamedError = new Error(message);
  e.name = name;
  return e;
}

function assertNoUndefined(value: unknown, path = "item"): void {
  if (value === undefined) throw new Error(`FakeDynamo: undefined value at ${path} (DocumentClient would reject this)`);
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) assertNoUndefined(v, `${path}.${k}`);
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

interface ExprInput {
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
}

function evalCondition(expr: string | undefined, current: Item | undefined, input: ExprInput): boolean {
  if (!expr) return true;
  const names = input.ExpressionAttributeNames ?? {};
  const values = input.ExpressionAttributeValues ?? {};
  const attr = (token: string): string => (token.startsWith("#") ? (names[token] ?? token) : token);

  return expr.split(/\s+AND\s+/).every((clause) => {
    let m: RegExpMatchArray | null;
    if ((m = clause.match(/^attribute_not_exists\((#?\w+)\)$/))) {
      return !current || current[attr(m[1] as string)] === undefined;
    }
    if ((m = clause.match(/^attribute_exists\((#?\w+)\)$/))) {
      return !!current && current[attr(m[1] as string)] !== undefined;
    }
    if ((m = clause.match(/^(#?\w+)\s*=\s*(:\w+)$/))) {
      return !!current && same(current[attr(m[1] as string)], values[m[2] as string]);
    }
    throw new Error(`FakeDynamo: unsupported condition clause "${clause}"`);
  });
}

function applyUpdate(base: Item, expr: string, input: ExprInput): Item {
  const names = input.ExpressionAttributeNames ?? {};
  const values = input.ExpressionAttributeValues ?? {};
  const m = expr.match(/^SET\s+(.+)$/);
  if (!m) throw new Error(`FakeDynamo: unsupported UpdateExpression "${expr}"`);
  const next = { ...base };
  for (const assignment of (m[1] as string).split(/\s*,\s*/)) {
    const a = assignment.match(/^(#?\w+)\s*=\s*(:\w+)$/);
    if (!a) throw new Error(`FakeDynamo: unsupported assignment "${assignment}"`);
    const key = (a[1] as string).startsWith("#") ? (names[a[1] as string] ?? (a[1] as string)) : (a[1] as string);
    next[key] = values[a[2] as string];
  }
  return next;
}

interface TxOp {
  table: string;
  key: Item;
  condition?: string;
  input: ExprInput;
  apply: (current: Item | undefined) => Item;
  /** ConditionCheck: evaluated, never written. */
  noWrite?: boolean;
}

/**
 * Real DynamoDB rejects an expression that supplies a placeholder it does not use. A lenient fake would
 * hide that class of bug until deployment, so reject it here too.
 */
function assertPlaceholdersUsed(input: ExprInput & { ConditionExpression?: string; UpdateExpression?: string }): void {
  const text = `${input.ConditionExpression ?? ""} ${input.UpdateExpression ?? ""}`;
  for (const k of Object.keys(input.ExpressionAttributeValues ?? {})) {
    if (!text.includes(k)) throw namedError("ValidationException", `Value provided in ExpressionAttributeValues unused in expressions: keys: {${k}}`);
  }
  for (const k of Object.keys(input.ExpressionAttributeNames ?? {})) {
    if (!text.includes(k)) throw namedError("ValidationException", `Value provided in ExpressionAttributeNames unused in expressions: keys: {${k}}`);
  }
}

export class FakeDynamo {
  private tables = new Map<string, Map<string, Item>>();
  /** Every command sent, for assertions. */
  readonly sent: Array<{ command: string; table?: string; index?: string }> = [];
  /** Runs inside a transaction before conditions are evaluated. */
  beforeTransact: ((ops: Array<{ table: string; key: Item }>) => void) | null = null;
  /** Fault injection: return an Error to throw for a command. */
  fail: ((command: string, input: Record<string, unknown>) => Error | null) | null = null;

  private table(name: string): Map<string, Item> {
    let t = this.tables.get(name);
    if (!t) this.tables.set(name, (t = new Map()));
    return t;
  }
  private static id(key: Item): string {
    return `${String(key["PK"])}\u0000${String(key["SK"])}`;
  }

  // -- test helpers ----------------------------------------------------------
  put(table: string, item: Item): void {
    assertNoUndefined(item);
    this.table(table).set(FakeDynamo.id(item), structuredClone(item));
  }
  get(table: string, key: Item): Item | undefined {
    const v = this.table(table).get(FakeDynamo.id(key));
    return v ? structuredClone(v) : undefined;
  }
  all(table: string): Item[] {
    return [...this.table(table).values()].map((v) => structuredClone(v));
  }
  count(table: string): number {
    return this.table(table).size;
  }

  // -- the client surface the application uses --------------------------------
  async send(cmd: { input: Record<string, unknown> }): Promise<Record<string, unknown>> {
    const input = cmd.input as Record<string, any>;

    if (cmd instanceof GetCommand) {
      this.sent.push({ command: "Get", table: input["TableName"] });
      this.maybeFail("Get", input);
      const item = this.get(input["TableName"], input["Key"]);
      return item ? { Item: item } : {};
    }

    if (cmd instanceof PutCommand) {
      this.sent.push({ command: "Put", table: input["TableName"] });
      this.maybeFail("Put", input);
      const current = this.get(input["TableName"], input["Item"]);
      if (!evalCondition(input["ConditionExpression"], current, input)) {
        throw namedError("ConditionalCheckFailedException", "The conditional request failed");
      }
      this.put(input["TableName"], input["Item"]);
      return {};
    }

    if (cmd instanceof UpdateCommand) {
      this.sent.push({ command: "Update", table: input["TableName"] });
      this.maybeFail("Update", input);
      const current = this.get(input["TableName"], input["Key"]);
      if (!evalCondition(input["ConditionExpression"], current, input)) {
        throw namedError("ConditionalCheckFailedException", "The conditional request failed");
      }
      this.put(input["TableName"], applyUpdate(current ?? { ...input["Key"] }, input["UpdateExpression"], input));
      return {};
    }

    if (cmd instanceof QueryCommand) {
      this.sent.push({ command: "Query", table: input["TableName"], index: input["IndexName"] });
      this.maybeFail("Query", input);
      return this.query(input);
    }

    if (cmd instanceof TransactWriteCommand) {
      this.sent.push({ command: "TransactWrite" });
      this.maybeFail("TransactWrite", input);
      return this.transact(input["TransactItems"]);
    }

    throw new Error("FakeDynamo: unsupported command");
  }

  private maybeFail(command: string, input: Record<string, unknown>): void {
    const err = this.fail?.(command, input);
    if (err) throw err;
  }

  private query(input: Record<string, any>): Record<string, unknown> {
    const index: string | undefined = input["IndexName"];
    if (index && input["ConsistentRead"]) {
      throw namedError("ValidationException", "Consistent reads are not supported on global secondary indexes");
    }
    const pkAttr = index ? `${index}PK` : "PK";
    const skAttr = index ? `${index}SK` : "SK";
    const expr: string = input["KeyConditionExpression"];
    const m = expr.match(new RegExp(`^${pkAttr}\\s*=\\s*(:\\w+)(?:\\s+AND\\s+begins_with\\(${skAttr},\\s*(:\\w+)\\))?$`));
    if (!m) throw new Error(`FakeDynamo: unsupported KeyConditionExpression "${expr}" for ${index ?? "table"}`);
    const values = input["ExpressionAttributeValues"] ?? {};
    const pk = values[m[1] as string];
    const prefix = m[2] ? String(values[m[2]]) : undefined;

    let items = [...this.table(input["TableName"]).values()]
      .filter((it) => it[pkAttr] === pk && (prefix === undefined || String(it[skAttr] ?? "").startsWith(prefix)))
      .sort((a, b) => String(a[skAttr]).localeCompare(String(b[skAttr])));
    if (input["ScanIndexForward"] === false) items = items.reverse();
    if (typeof input["Limit"] === "number") items = items.slice(0, input["Limit"]);
    return { Items: items.map((i) => structuredClone(i)) };
  }

  private transact(transactItems: Array<Record<string, any>>): Record<string, unknown> {
    const ops: TxOp[] = transactItems.map((t) => {
      if (t["Put"]) {
        const p = t["Put"];
        return {
          table: p.TableName, key: p.Item, condition: p.ConditionExpression, input: p,
          apply: () => structuredClone(p.Item),
        };
      }
      if (t["ConditionCheck"]) {
        const c = t["ConditionCheck"];
        return {
          table: c.TableName, key: c.Key, condition: c.ConditionExpression, input: c,
          apply: (cur) => cur ?? { ...c.Key }, noWrite: true,
        };
      }
      if (t["Update"]) {
        const u = t["Update"];
        return {
          table: u.TableName, key: u.Key, condition: u.ConditionExpression, input: u,
          apply: (cur) => applyUpdate(cur ?? { ...u.Key }, u.UpdateExpression, u),
        };
      }
      throw new Error("FakeDynamo: unsupported transact item");
    });

    // DynamoDB forbids two operations on one item within a transaction.
    const ids = ops.map((o) => `${o.table}\u0000${FakeDynamo.id(o.key)}`);
    if (new Set(ids).size !== ids.length) {
      throw namedError("ValidationException", "Transaction request cannot include multiple operations on one item");
    }
    ops.forEach((o) => assertNoUndefined(o.key));
    ops.forEach((o) => assertPlaceholdersUsed(o.input as never));

    this.beforeTransact?.(ops.map((o) => ({ table: o.table, key: o.key })));

    const results = ops.map((o) => evalCondition(o.condition, this.get(o.table, o.key), o.input));
    if (results.some((r) => !r)) {
      const e = namedError("TransactionCanceledException", "Transaction cancelled, please refer cancellation reasons");
      e.CancellationReasons = results.map((r) => ({ Code: r ? "None" : "ConditionalCheckFailed" }));
      throw e;
    }
    for (const o of ops) {
      if (o.noWrite) continue;
      this.put(o.table, o.apply(this.get(o.table, o.key)));
    }
    return {};
  }
}
