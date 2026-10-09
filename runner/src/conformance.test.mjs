import test from "node:test";
import assert from "node:assert/strict";
import { reviewConformance } from "./conformance.ts";

const env = { AI_GATEWAY_ACCOUNT_ID: "account", AI_GATEWAY_ID: "default", AI_GATEWAY_TOKEN: "gateway-token" };
const run = { provider: "openai", model: "gpt-6-sol" };

test("spec review sends the full spec and diff and rejects inconsistent verdicts", async () => {
  const original = globalThis.fetch;
  const spec = "## Acceptance criteria\n\n- Export visible rows.";
  const diff = "diff --git a/export.ts b/export.ts\n+exportVisibleRows();";
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), "https://api.cloudflare.com/client/v4/accounts/account/ai/v1/chat/completions");
      assert.equal(options.headers.Authorization, "Bearer gateway-token");
      assert.equal(options.headers["cf-aig-gateway-id"], "default");
      assert.equal(options.headers["cf-aig-authorization"], undefined);
      const body = JSON.parse(options.body);
      assert.equal(body.model, "openai/gpt-6-sol");
      assert.match(body.messages[1].content, /Export visible rows/);
      assert.match(body.messages[1].content, /exportVisibleRows/);
      return Response.json({ choices: [{ message: { content: JSON.stringify({ pass: true, unmet: [], unrelated: [], evidence: ["Export helper added"] }) } }] });
    };
    assert.equal((await reviewConformance(env, run, spec, diff)).pass, true);
    assert.equal((await reviewConformance(env, run, spec, "x".repeat(200_001))).pass, false);
    globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify({ pass: true, unmet: [], unrelated: ["Unrelated billing edit"], evidence: [] }) } }] });
    await assert.rejects(reviewConformance(env, run, spec, diff), /inconsistent verdict/);
  } finally { globalThis.fetch = original; }
});
