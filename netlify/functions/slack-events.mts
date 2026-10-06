// Public endpoint for Slack's Events API: https://YOUR-SITE.netlify.app/slack/events
// Slack wants an answer within 3 seconds, so this only checks the request and hands the
// real work to the slack-events-background function (which answers 202 at once).

import type { Config } from "@netlify/functions";
import { config as settings, isAllowedPlace } from "../../src/config";
import { forwardOnce, SLACK_SIGNATURE_HEADERS } from "../../src/handoff";
import type { SlackEventEnvelope } from "../../src/slackEvents";
import { verifySlackRequest } from "../../src/slackVerify";

const ok = () => new Response("", { status: 200 });

export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const raw = await req.text();

  const check = verifySlackRequest(req, raw, settings.slackSigningSecret);
  if (!check.ok) return new Response(`Invalid request: ${check.reason}`, { status: 401 });

  let body: SlackEventEnvelope;
  try {
    body = JSON.parse(raw) as SlackEventEnvelope;
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  // Slack's one-time check when you save the Request URL.
  if (body.type === "url_verification") return Response.json({ challenge: body.challenge });

  if (body.type !== "event_callback" || !isAllowedPlace(body.event?.channel) || !body.event_id) return ok();

  // Slack retries (x-slack-retry-num) are processed like first deliveries; a failed
  // hand-off answers 500 so Slack retries it.
  const result = await forwardOnce(req, raw, {
    scope: "slack-event",
    id: body.event_id,
    functionName: "slack-events-background",
    headers: SLACK_SIGNATURE_HEADERS,
  });
  return result === "failed" ? new Response("Hand-off failed", { status: 500 }) : ok();
};

export const config: Config = { path: "/slack/events", method: "POST" };
