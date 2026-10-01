// Public endpoint for Slack button clicks: https://YOUR-SITE.netlify.app/slack/interactive
// Verifies the request, then hands it to slack-interactive-background so Slack gets
// its answer within 3 seconds.

import type { Config } from "@netlify/functions";
import { config as settings } from "../../src/config";
import { handOff, SLACK_SIGNATURE_HEADERS } from "../../src/handoff";
import { verifySlackRequest } from "../../src/slackVerify";

export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const raw = await req.text();
  const check = verifySlackRequest(req, raw, settings.slackSigningSecret);
  if (!check.ok) return new Response(`Invalid request: ${check.reason}`, { status: 401 });

  // Slack sends a form field called "payload" holding JSON.
  if (!new URLSearchParams(raw).get("payload")) return new Response("Missing payload", { status: 400 });

  try {
    await handOff(req, raw, "slack-interactive-background", SLACK_SIGNATURE_HEADERS);
  } catch (err) {
    console.error(err);
  }
  return new Response("", { status: 200 });
};

export const config: Config = { path: "/slack/interactive", method: "POST" };
