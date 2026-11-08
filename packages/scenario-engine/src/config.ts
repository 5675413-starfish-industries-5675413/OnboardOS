/**
 * Configuration validation and canonical hashing.
 *
 * Deterministic and side-effect free (node:crypto's SHA-256 is a pure function
 * of its input). The hash is computed ONLY on the server and by the runner
 * re-verifying a snapshot; a client-supplied hash is never trusted.
 */
import { createHash } from "node:crypto";
import {
  REQUEST_TIMEOUT_MAX_MS,
  REQUEST_TIMEOUT_MIN_MS,
  type IncidentConfig,
} from "@onboardos/contracts";

export type ConfigValidation =
  | { readonly ok: true; readonly config: IncidentConfig }
  | { readonly ok: false; readonly code: "INVALID_CONFIG" | "CONFIG_OUT_OF_POLICY"; readonly message: string };

/**
 * Validate an UNTRUSTED value as an IncidentConfig. Structure/type problems are
 * INVALID_CONFIG; a well-formed integer outside policy is CONFIG_OUT_OF_POLICY.
 * Unknown keys are rejected, never dropped silently.
 */
export function validateConfig(input: unknown): ConfigValidation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, code: "INVALID_CONFIG", message: "Configuration must be an object" };
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "request_timeout_ms") {
    return {
      ok: false,
      code: "INVALID_CONFIG",
      message: "Configuration must contain exactly the field request_timeout_ms",
    };
  }
  const value = record.request_timeout_ms;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return { ok: false, code: "INVALID_CONFIG", message: "request_timeout_ms must be an integer" };
  }
  if (value < REQUEST_TIMEOUT_MIN_MS || value > REQUEST_TIMEOUT_MAX_MS) {
    return {
      ok: false,
      code: "CONFIG_OUT_OF_POLICY",
      message: `request_timeout_ms must be between ${REQUEST_TIMEOUT_MIN_MS} and ${REQUEST_TIMEOUT_MAX_MS}`,
    };
  }
  return { ok: true, config: { request_timeout_ms: value } };
}

/** JSON with object keys sorted recursively; stable regardless of insertion order. */
export function canonicalConfigJson(config: IncidentConfig): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (typeof v === "object" && v !== null) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) out[k] = sort((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(config));
}

/** `sha256:<64 hex>` over the canonical JSON of the config. */
export function configHash(config: IncidentConfig): string {
  return `sha256:${createHash("sha256").update(canonicalConfigJson(config), "utf8").digest("hex")}`;
}

export const CONFIG_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
