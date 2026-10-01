import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
// standardwebhooks is the library the Anthropic SDK uses inside webhooks.unwrap().
import { Webhook } from "standardwebhooks";

const key = "whsec_" + randomBytes(32).toString("base64");
process.env.ANTHROPIC_WEBHOOK_SIGNING_KEY = key;
process.env.ANTHROPIC_API_KEY = "test-key-not-used";

const { unwrapWebhook } = await import("../src/anthropic");

function signed(body: string, id = "whe_1") {
  const ts = new Date();
  const sig = new Webhook(key).sign(id, ts, body);
  return new Headers({
    "webhook-id": id,
    "webhook-timestamp": String(Math.floor(ts.getTime() / 1000)),
    "webhook-signature": sig,
  });
}

describe("unwrapWebhook (client.beta.webhooks.unwrap)", () => {
  const body = JSON.stringify({
    type: "event",
    id: "whe_1",
    created_at: new Date().toISOString(),
    data: { type: "session.status_idled", id: "sesn_1", organization_id: "o", workspace_id: "w" },
  });

  it("accepts a correctly signed payload", () => {
    const ev = unwrapWebhook(body, signed(body));
    expect(ev.id).toBe("whe_1");
    expect(ev.data.type).toBe("session.status_idled");
    expect(ev.data.id).toBe("sesn_1");
  });

  it("rejects a tampered payload", () => {
    const headers = signed(body);
    expect(() => unwrapWebhook(body.replace("sesn_1", "sesn_2"), headers)).toThrow();
  });

  it("rejects a payload without signature headers", () => {
    expect(() => unwrapWebhook(body, new Headers())).toThrow();
  });
});
