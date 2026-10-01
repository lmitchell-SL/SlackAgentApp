import { describe, expect, it } from "vitest";
import { computeSlackSignature, verifySlackSignature } from "../src/slackVerify";

const secret = "8f742231b10e8888abcd99yyyzzz85a5";
const body = "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&command=%2Fweather&text=94070";
const ts = "1531420618";
const now = 1531420618 + 10;

describe("verifySlackSignature", () => {
  it("computes v0= plus a 64-character hex HMAC", () => {
    expect(computeSlackSignature(secret, ts, body)).toMatch(/^v0=[0-9a-f]{64}$/);
  });

  it("accepts a good signature", () => {
    const signature = computeSlackSignature(secret, ts, body);
    expect(verifySlackSignature({ rawBody: body, timestamp: ts, signature, signingSecret: secret, nowSeconds: now })).toEqual({ ok: true });
  });

  it("rejects a bad signature", () => {
    const signature = computeSlackSignature("wrong-secret", ts, body);
    const res = verifySlackSignature({ rawBody: body, timestamp: ts, signature, signingSecret: secret, nowSeconds: now });
    expect(res.ok).toBe(false);
  });

  it("rejects a tampered body", () => {
    const signature = computeSlackSignature(secret, ts, body);
    const res = verifySlackSignature({ rawBody: body + "x", timestamp: ts, signature, signingSecret: secret, nowSeconds: now });
    expect(res).toEqual({ ok: false, reason: "signature mismatch" });
  });

  it("rejects a signature of a different length without throwing", () => {
    const res = verifySlackSignature({ rawBody: body, timestamp: ts, signature: "v0=abc", signingSecret: secret, nowSeconds: now });
    expect(res.ok).toBe(false);
  });

  it("rejects stale requests (older than 5 minutes)", () => {
    const signature = computeSlackSignature(secret, ts, body);
    const res = verifySlackSignature({ rawBody: body, timestamp: ts, signature, signingSecret: secret, nowSeconds: Number(ts) + 301 });
    expect(res).toEqual({ ok: false, reason: "stale timestamp" });
  });

  it("rejects timestamps too far in the future", () => {
    const signature = computeSlackSignature(secret, ts, body);
    const res = verifySlackSignature({ rawBody: body, timestamp: ts, signature, signingSecret: secret, nowSeconds: Number(ts) - 301 });
    expect(res.ok).toBe(false);
  });

  it("rejects missing headers", () => {
    expect(verifySlackSignature({ rawBody: body, timestamp: null, signature: "v0=x", signingSecret: secret }).ok).toBe(false);
    expect(verifySlackSignature({ rawBody: body, timestamp: ts, signature: undefined, signingSecret: secret }).ok).toBe(false);
  });
});
