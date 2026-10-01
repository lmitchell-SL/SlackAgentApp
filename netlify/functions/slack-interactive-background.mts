// Background worker for Approve / Deny clicks. Re-verifies the forwarded Slack signature.

import { handleInteraction, type BlockActionsPayload } from "../../src/bridge";
import { config as settings } from "../../src/config";
import { verifySlackRequest } from "../../src/slackVerify";

export default async (req: Request): Promise<void> => {
  const raw = await req.text();
  const check = verifySlackRequest(req, raw, settings.slackSigningSecret);
  if (!check.ok) {
    console.warn(`Rejected background interaction: ${check.reason}`);
    return;
  }
  const json = new URLSearchParams(raw).get("payload");
  if (!json) return;
  try {
    await handleInteraction(JSON.parse(json) as BlockActionsPayload);
  } catch (err) {
    console.error("handleInteraction failed", err);
  }
};
