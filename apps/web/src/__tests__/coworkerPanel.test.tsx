import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CoworkerTurnView } from "@onboardos/contracts";
import { TurnView } from "../views/CoworkerPanel.js";

const base: CoworkerTurnView = {
  turnId: "turn_1794045600000_0123456789ab", status: "COMPLETE", userText: "question", reply: "answer", truncated: false,
  modelId: "amazon.nova-micro-v1:0", createdAt: "2026-11-07T10:00:00.000Z", completedAt: "2026-11-07T10:00:01.000Z",
  errorCode: null, errorMessage: null,
};
const html = (t: Partial<CoworkerTurnView>) => renderToStaticMarkup(createElement(TurnView, { turn: { ...base, ...t } }));

describe("a coworker turn renders as inert text", () => {
  it("escapes HTML and script in both the question and the AI's answer", () => {
    const out = html({ userText: '<img src=x onerror=alert(1)>', reply: '<script>alert("pwned")</script><b>bold</b>' });
    expect(out).not.toMatch(/<script|<img|<b>/);
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("&lt;img");
  });

  it("does not turn markdown or links into live elements", () => {
    const out = html({ reply: "[click](javascript:alert(1)) **x** https://example.com" });
    expect(out).not.toMatch(/<a |<strong|href=/);
  });

  it("attributes the answer to the AI and the model, never to a person", () => {
    const out = html({});
    expect(out).toContain("AI coworker · amazon.nova-micro-v1:0");
    expect(out).toContain("answer");
  });
});

describe("states are shown honestly", () => {
  it("PENDING shows progress and no answer text", () => {
    const out = html({ status: "PENDING", reply: null, completedAt: null });
    expect(out).toContain("Thinking");
    expect(out).not.toContain("answer");
  });
  it("ERROR shows the fixed message and says no answer was recorded, with no reply text", () => {
    const out = html({ status: "ERROR", reply: null, errorCode: "AI_TIMEOUT", errorMessage: "The AI coworker took too long to answer. Please try again." });
    expect(out).toContain("took too long");
    expect(out).toContain("No answer was recorded");
    expect(out).toContain('role="alert"');
  });
  it("a truncated answer is labelled", () => {
    expect(html({ truncated: true })).toContain("cut short");
    expect(html({ truncated: false })).not.toContain("cut short");
  });
});
