import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  buildLoginUrl,
  buildLogoutUrl,
  config,
  hostedUiHost,
  missingConfig,
  tokenEndpoint,
} from "../lib/config.js";
import { CLIENT_ID, HOST, ORIGIN, setupBrowserEnv } from "./helpers.js";

beforeEach(() => {
  setupBrowserEnv();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("missingConfig (fail fast instead of building a broken login URL)", () => {
  it("is empty when every required variable is set", () => {
    expect(missingConfig()).toEqual([]);
  });

  it("names each missing required variable", () => {
    vi.stubEnv("VITE_API_BASE_URL", "");
    vi.stubEnv("VITE_COGNITO_CLIENT_ID", "");
    vi.stubEnv("VITE_COGNITO_DOMAIN", "");
    expect(missingConfig()).toEqual([
      "VITE_API_BASE_URL",
      "VITE_COGNITO_CLIENT_ID",
      "VITE_COGNITO_DOMAIN",
    ]);
  });

  it("treats whitespace-only values as missing", () => {
    vi.stubEnv("VITE_COGNITO_DOMAIN", "   ");
    expect(missingConfig()).toEqual(["VITE_COGNITO_DOMAIN"]);
  });
});

describe("config values", () => {
  it("strips trailing slashes from the API base URL so paths never contain '//'", () => {
    vi.stubEnv("VITE_API_BASE_URL", "https://api.example.com///");
    expect(config.apiBaseUrl).toBe("https://api.example.com");
  });

  it("defaults the region to us-east-1", () => {
    vi.stubEnv("VITE_AWS_REGION", "");
    expect(config.cognito.region).toBe("us-east-1");
  });
});

describe("Hosted UI URLs", () => {
  it("accepts a full Hosted UI host as-is", () => {
    expect(hostedUiHost()).toBe(HOST);
  });

  it("expands a bare domain prefix using the configured region", () => {
    vi.stubEnv("VITE_COGNITO_DOMAIN", "onboardos-dev-1a2b3c4d");
    vi.stubEnv("VITE_AWS_REGION", "us-west-2");
    expect(hostedUiHost()).toBe("onboardos-dev-1a2b3c4d.auth.us-west-2.amazoncognito.com");
  });

  it("builds a token endpoint on the Hosted UI host", () => {
    expect(tokenEndpoint()).toBe(`https://${HOST}/oauth2/token`);
  });

  it("registers the exact callback and logout URIs the app client allows", () => {
    const login = new URL(buildLoginUrl("challenge", "state-1"));
    expect(login.searchParams.get("redirect_uri")).toBe("http://localhost:5173/callback");
    expect(login.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(login.searchParams.get("scope")).toBe("openid email profile");

    const logout = new URL(buildLogoutUrl());
    expect(logout.searchParams.get("logout_uri")).toBe("http://localhost:5173");
  });

  it("derives redirect URIs from the supplied origin", () => {
    const login = new URL(buildLoginUrl("c", "s", "https://app.example.com"));
    expect(login.searchParams.get("redirect_uri")).toBe("https://app.example.com/callback");
    expect(ORIGIN).toBe("http://localhost:5173"); // helper default stays aligned with template.yaml
  });

  it("URL-encodes state so it cannot inject extra query parameters", () => {
    const url = new URL(buildLoginUrl("c", "a&client_id=evil"));
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("state")).toBe("a&client_id=evil");
  });
});
