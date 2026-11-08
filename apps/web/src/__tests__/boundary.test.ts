/**
 * Trust-boundary guard for the browser bundle (architecture invariant 5).
 *
 * The web app must receive scenario content from the API AFTER authorization.
 * It must never bundle the fixtures or the engine, and never contain AWS SDK or
 * server code. This scans the real source tree, so a stray import fails CI.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "__tests__" ? [] : sourceFiles(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

const FILES = sourceFiles(SRC);

describe("browser source boundary", () => {
  it("scans a meaningful number of files", () => {
    expect(FILES.length).toBeGreaterThan(10);
  });

  it.each([
    ["the scenario fixtures", /scenario-fixtures/],
    ["the scenario engine", /scenario-engine/],
    ["the AWS SDK", /@aws-sdk\//],
    ["server code", /services\/(api|test-runner)/],
    ["a relative path into packages/", /\.\.\/.*packages\//],
  ])("never imports %s", (_label, pattern) => {
    for (const file of FILES) {
      const imports = readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => /^\s*(import|export)\b.*\bfrom\b|^\s*import\s*\(/.test(l));
      for (const line of imports) expect(line, file).not.toMatch(pattern);
    }
  });

  it("contains no scenario content: nothing from INC-104 is hard-coded in the UI", () => {
    for (const file of FILES) {
      const text = readFileSync(file, "utf8");
      for (const leaked of ["CHG-5521", "payments-upstream", "Priya Raman", "Dan Okafor", "RB-CHECKOUT-TIMEOUT", "DIAG-INC-104"]) {
        expect(text, `${leaked} in ${file}`).not.toContain(leaked);
      }
    }
  });

  it("never sets a role, organization owner, status or pass/fail value from client state", () => {
    const api = readFileSync(join(SRC, "lib", "api.ts"), "utf8");
    // The request bodies the client builds: only these keys may appear in them.
    expect(api).not.toMatch(/\brole\s*:/);
    expect(api).not.toMatch(/\bpassed\s*:/);
    expect(api).not.toMatch(/\bstatus\s*:\s*["']/);
  });
});
