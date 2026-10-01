import { createHmac, timingSafeEqual } from "node:crypto";

/** Slack rejects (and so do we) requests whose timestamp is more than 5 minutes off. */
export const MAX_SKEW_SECONDS = 5 * 60;

export interface SlackVerifyInput {
  rawBody: string;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  signingSecret: string;
  /** Current time in seconds. Injected for tests. */
  nowSeconds?: number;
}

export type SlackVerifyResult = { ok: true } | { ok: false; reason: string };

export function computeSlackSignature(signingSecret: string, timestamp: string, rawBody: string): string {
  const base = `v0:${timestamp}:${rawBody}`;
  return "v0=" + createHmac("sha256", signingSecret).update(base, "utf8").digest("hex");
}

/**
 * Checks the X-Slack-Signature header: HMAC-SHA256 of `v0:${ts}:${rawBody}` with the
 * app's signing secret, compared in constant time, and rejects stale timestamps.
 */
export function verifySlackSignature(input: SlackVerifyInput): SlackVerifyResult {
  const { rawBody, timestamp, signature, signingSecret } = input;
  if (!signingSecret) return { ok: false, reason: "no signing secret configured" };
  if (!timestamp || !signature) return { ok: false, reason: "missing signature headers" };
  if (!/^\d+$/.test(timestamp)) return { ok: false, reason: "bad timestamp" };

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > MAX_SKEW_SECONDS) {
    return { ok: false, reason: "stale timestamp" };
  }

  const expected = Buffer.from(computeSlackSignature(signingSecret, timestamp, rawBody), "utf8");
  const given = Buffer.from(signature, "utf8");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true };
}

/** Verifies a Fetch API Request (headers) against a raw body already read. */
export function verifySlackRequest(req: Request, rawBody: string, signingSecret: string): SlackVerifyResult {
  return verifySlackSignature({
    rawBody,
    timestamp: req.headers.get("x-slack-request-timestamp"),
    signature: req.headers.get("x-slack-signature"),
    signingSecret,
  });
}
