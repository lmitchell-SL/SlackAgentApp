// Background worker for Slack events (the "-background" file name makes Netlify run it
// as a background function: the caller gets 202 at once and it can run for up to 15 minutes).
// It re-checks the forwarded Slack signature, so it can't be called directly by anyone else.

import { handleSlackEvent } from "../../src/bridge";
import { config as settings } from "../../src/config";
import type { SlackEventEnvelope } from "../../src/slackEvents";
import { verifySlackRequest } from "../../src/slackVerify";
import { claim } from "../../src/store";

export default async (req: Request): Promise<void> => {
  const raw = await req.text();
  const check = verifySlackRequest(req, raw, settings.slackSigningSecret);
  if (!check.ok) {
    console.warn(`Rejected background Slack event: ${check.reason}`);
    return;
  }
  const body = JSON.parse(raw) as SlackEventEnvelope;
  if (!body.event_id || !(await claim("slack-event-bg", body.event_id))) return;
  try {
    await handleSlackEvent(body);
  } catch (err) {
    console.error("handleSlackEvent failed", err);
  }
};
