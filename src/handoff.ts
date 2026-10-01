// Passes a verified request to a background function (which may run up to 15 minutes).
// We forward the raw body plus the original signature headers, and the background
// function verifies them again. That way no extra shared secret is needed, and a
// direct call to the background URL without a valid signature is rejected.

export const SLACK_SIGNATURE_HEADERS = ["x-slack-signature", "x-slack-request-timestamp", "content-type"];
export const WEBHOOK_SIGNATURE_HEADERS = ["webhook-id", "webhook-timestamp", "webhook-signature", "content-type"];

import { claim, isClaimed } from "./store";

export type ForwardResult = "forwarded" | "already-handled" | "failed";

/**
 * Hands the request off at most once per id. The id is recorded as handled only after
 * the hand-off succeeds, so on "failed" the caller answers 500 and the sender retries.
 * (Each background function has its own one-time claim, so overlapping deliveries that
 * both get forwarded are still processed once.)
 */
export async function forwardOnce(
  req: Request,
  rawBody: string,
  opts: { scope: string; id: string; functionName: string; headers: string[] },
): Promise<ForwardResult> {
  if (await isClaimed(opts.scope, opts.id)) return "already-handled";
  try {
    await handOff(req, rawBody, opts.functionName, opts.headers);
  } catch (err) {
    console.error(err);
    return "failed";
  }
  await claim(opts.scope, opts.id);
  return "forwarded";
}

export function backgroundUrl(req: Request, functionName: string): string {
  return `${new URL(req.url).origin}/.netlify/functions/${functionName}`;
}

export async function handOff(req: Request, rawBody: string, functionName: string, headerNames: string[]) {
  const headers = new Headers();
  for (const name of headerNames) {
    const v = req.headers.get(name);
    if (v !== null) headers.set(name, v);
  }
  // Netlify answers a background function call with 202 right away. The timeout keeps us
  // inside Slack's 3-second window and turns a stalled call into a fast failure.
  const res = await fetch(backgroundUrl(req, functionName), {
    method: "POST",
    headers,
    body: rawBody,
    signal: AbortSignal.timeout(2000),
  });
  if (res.status >= 400) throw new Error(`Hand-off to ${functionName} failed with HTTP ${res.status}`);
}
