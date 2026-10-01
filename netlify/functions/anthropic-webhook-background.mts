// Background worker for Console webhooks: posts agent replies, approval buttons and
// status notes to the session's Slack thread. Re-verifies the forwarded signature.

import { unwrapWebhook } from "../../src/anthropic";
import { handleSessionWebhook } from "../../src/bridge";
import { claim } from "../../src/store";

export default async (req: Request): Promise<void> => {
  const raw = await req.text();
  let event;
  try {
    event = unwrapWebhook(raw, req.headers);
  } catch (err) {
    console.warn(`Rejected background webhook: ${String(err)}`);
    return;
  }
  if (!(await claim("webhook-bg", event.id))) return;
  try {
    await handleSessionWebhook(event);
  } catch (err) {
    console.error("handleSessionWebhook failed", err);
  }
};
