/**
 * Source-aware measurements and calculated comparisons (coworker v3.1). PURE.
 *
 * Why this exists. In the first real evaluation a model said the upstream latency "often exceeds" the saved timeout of 1800 ms, while
 * every recorded upstream latency (1206 to 1561 ms) is BELOW 1800 and above the old 800. The platform already holds those numbers as
 * TYPED fields (`upstreamLatencyMs` on each diagnostics entry) and the saved configuration as typed numbers, but it only handed them to
 * the model as prose, six `request_timeout_ms=800` log lines and one 1800 in another block, and left the comparison to the model.
 *
 * What this module does: collect numbers from a short registry of TYPED diagnostics fields (never by parsing message text), summarise
 * them, and compare them, arithmetically, with the numeric configuration values that carry the same unit. The result is shown to the
 * model as "calculated by the platform" so it does not have to guess the relation.
 *
 * What it deliberately does NOT do:
 *   - It does not read numbers out of free-text log lines (a "latency summary p50=... p95=..." line stays a quotation). Free text is not
 *     promoted to authoritative data.
 *   - It does not know which setting relates to which measurement; it compares by unit only and says so. Relevance is the model's and
 *     the employee's judgement, from the runbook.
 *   - It is not a hallucination detector. Claims about anything it holds no typed value for remain model-dependent.
 *
 * Boundary. A scenario can only have grounded measurements for fields it records in typed form. Scenario content is immutable once
 * published, so this module adds no data; a richer provenance model (typed metrics with source ids, units and windows in the scenario
 * definition) is the larger change that would be needed for more, and is documented rather than attempted here.
 */
import type { PublishedScenario } from "@onboardos/scenario-engine";

type Entry = PublishedScenario["content"]["diagnostics"]["entries"][number];

/** The typed numeric diagnostics fields that are measurements. A field is added here only when it is a number with a known unit. */
export const TYPED_MEASURES = [{ field: "upstreamLatencyMs", label: "upstream latency", unit: "ms" }] as const;
type Measure = (typeof TYPED_MEASURES)[number];

export interface Observation {
  value: number;
  /** Where the number came from, in the scenario's own terms. */
  source: string;
}

export interface MeasureSummary {
  field: Measure["field"];
  label: string;
  unit: string;
  observations: Observation[];
  min: number;
  median: number;
  max: number;
}

/** The unit of a configuration key, from its suffix. Only `_ms` is recognised; anything else is not compared. */
export function unitOfKey(key: string): "ms" | null {
  return /_ms$/i.test(key) ? "ms" : null;
}

const hhmmss = (ts: string): string => /T(\d\d:\d\d:\d\d)/.exec(ts)?.[1] ?? ts;

export function collectMeasurements(entries: readonly Entry[]): MeasureSummary[] {
  const out: MeasureSummary[] = [];
  for (const m of TYPED_MEASURES) {
    const observations: Observation[] = [];
    for (const e of entries) {
      const v = (e as Record<string, unknown>)[m.field];
      if (typeof v === "number" && Number.isFinite(v)) observations.push({ value: v, source: `${hhmmss(e.timestamp)} ${e.service}` });
    }
    if (observations.length === 0) continue;
    const sorted = observations.map((o) => o.value).sort((a, b) => a - b);
    out.push({
      field: m.field, label: m.label, unit: m.unit, observations,
      min: sorted[0]!, max: sorted[sorted.length - 1]!, median: sorted[Math.floor((sorted.length - 1) / 2)]!,
    });
  }
  return out;
}

export interface Comparison {
  label: string;
  unit: string;
  which: "CURRENT" | "BASELINE";
  key: string;
  configValue: number;
  count: number;
  below: number;
  above: number;
  equal: number;
}

export function compareWithConfig(
  summaries: readonly MeasureSummary[],
  current: Readonly<Record<string, unknown>>,
  baseline: Readonly<Record<string, unknown>>,
): Comparison[] {
  const out: Comparison[] = [];
  for (const s of summaries) {
    for (const [which, cfg] of [["CURRENT", current], ["BASELINE", baseline]] as const) {
      for (const [key, v] of Object.entries(cfg)) {
        if (typeof v !== "number" || unitOfKey(key) !== s.unit) continue;
        const vals = s.observations.map((o) => o.value);
        out.push({
          label: s.label, unit: s.unit, which, key, configValue: v, count: vals.length,
          below: vals.filter((x) => x < v).length, above: vals.filter((x) => x > v).length, equal: vals.filter((x) => x === v).length,
        });
      }
    }
  }
  return out;
}

const n = (x: number): string => String(x);

/** The block text, or [] when the scenario records no typed measurements (then the block is omitted entirely). */
export function describeGrounding(
  entries: readonly Entry[],
  current: Readonly<Record<string, unknown>>,
  baseline: Readonly<Record<string, unknown>>,
): string[] {
  const summaries = collectMeasurements(entries);
  if (summaries.length === 0) return [];
  const lines: string[] = [];
  lines.push("Typed measurements recorded with the scenario's diagnostics entries (scenario content captured when the scenario was set up; HISTORICAL observations, not live readings):");
  for (const s of summaries) {
    lines.push(`- ${s.label} (${s.unit}), ${s.observations.length} observation(s): lowest ${n(s.min)}, median ${n(s.median)}, highest ${n(s.max)}. Observed: ${s.observations.map((o) => `${n(o.value)} (${o.source})`).join("; ")}.`);
  }
  const comps = compareWithConfig(summaries, current, baseline);
  if (comps.length > 0) {
    lines.push("");
    lines.push("Calculated comparisons (arithmetic done by the platform on the numbers above and the configuration values with the same unit; the platform does NOT know which settings relate to which measurements, so whether a comparison matters is for you to judge from the materials):");
    for (const c of comps) {
      const tag = c.which === "CURRENT" ? "CURRENT (applies now)" : "BASELINE (historical)";
      const parts = [`${c.below} of ${c.count} observations are below it`, `${c.above} above it`];
      if (c.equal > 0) parts.push(`${c.equal} equal to it`);
      lines.push(`- ${c.label} versus ${tag} ${c.key} = ${n(c.configValue)} ${c.unit}: ${parts.join(", ")}.`);
    }
  }
  lines.push("");
  lines.push("Free-text lines in the logs (for example a 'latency summary' line) are quotations from the logs; they are not recomputed here and are not part of the calculations above.");
  return lines;
}
