// Public endpoint for the Anthropic Console webhook: https://YOUR-SITE.netlify.app/anthropic-webhook
// Subscribed to session.status_idled and session.status_terminated. Payloads are thin
// (just ids), so the background function fetches the session and its events.

import type { Config } from "@netlify/functions";
import { unwrapWebhook } from "../../src/anthropic";
import { HANDLED_WEBHOOK_TYPES } from "../../src/bridge";
import { forwardOnce, WEBHOOK_SIGNATURE_HEADERS } from "../../src/handoff";

export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const raw = await req.text();

  let event;
  try {
    // Checks the webhook-id / webhook-timestamp / webhook-signature headers with
    // ANTHROPIC_WEBHOOK_SIGNING_KEY and rejects payloads older than ~5 minutes.
    event = unwrapWebhook(raw, req.headers);
  } catch {
    return new Response("Invalid signature", { status: 400 });
  }

  if (!HANDLED_WEBHOOK_TYPES.has(event.data.type)) return new Response(null, { status: 204 });
  // Every retry of the same event carries the same id; a failed hand-off answers 500 so
  // Anthropic retries it.
  const result = await forwardOnce(req, raw, {
    scope: "webhook",
    id: event.id,
    functionName: "anthropic-webhook-background",
    headers: WEBHOOK_SIGNATURE_HEADERS,
  });
  return result === "failed" ? new Response("Hand-off failed", { status: 500 }) : new Response(null, { status: 204 });
};

export const config: Config = { path: "/anthropic-webhook", method: "POST" };
