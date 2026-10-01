// Public endpoint for Slack's Events API: https://YOUR-SITE.netlify.app/slack/events
// Slack wants an answer within 3 seconds, so this only checks the request and hands the
// real work to the slack-events-background function.

import type { Config } from "@netlify/functions";
import { config as settings, isAllowedChannel } from "../../src/config";
import { handOff, SLACK_SIGNATURE_HEADERS } from "../../src/handoff";
import type { SlackEventEnvelope } from "../../src/slackEvents";
import { verifySlackRequest } from "../../src/slackVerify";
import { claim, releaseClaim } from "../../src/store";

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

  // Slack retries when we were slow. We already took the first delivery, so just say OK.
  if (req.headers.get("x-slack-retry-num")) return ok();

  if (body.type !== "event_callback" || !isAllowedChannel(body.event?.channel)) return ok();
  if (!body.event_id || !(await claim("slack-event", body.event_id))) return ok();

  try {
    await handOff(req, raw, "slack-events-background", SLACK_SIGNATURE_HEADERS);
  } catch (err) {
    console.error(err);
    await releaseClaim("slack-event", body.event_id);
  }
  return ok();
};

export const config: Config = { path: "/slack/events", method: "POST" };
