// Minimal Slack Web API client using plain fetch and the bot token.

import { config } from "./config";
import { cached, kv } from "./store";
import { chunkMarkdown, plainFallback } from "./chunk";

/** Escapes &, < and > for Slack mrkdwn text. */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

type SlackResponse = { ok: boolean; error?: string; [k: string]: unknown };

export async function slackApi<T extends SlackResponse = SlackResponse>(
  method: string,
  body: Record<string, unknown>,
  opts: { form?: boolean } = {},
): Promise<T> {
  // Read methods (users.info, auth.test) take form-encoded bodies; write methods take JSON.
  const form = new URLSearchParams();
  if (opts.form) for (const [k, v] of Object.entries(body)) if (v !== undefined) form.set(k, String(v));
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.slackBotToken}`,
      "Content-Type": opts.form ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8",
    },
    body: opts.form ? form.toString() : JSON.stringify(body),
  });
  const json = (await res.json()) as T;
  if (!json.ok) {
    throw new Error(`Slack ${method} failed: ${json.error ?? res.status}`);
  }
  return json;
}

export async function postMessage(args: {
  channel: string;
  thread_ts?: string;
  text: string;
  blocks?: unknown[];
}): Promise<{ ts: string }> {
  const res = await slackApi<SlackResponse & { ts: string }>("chat.postMessage", {
    channel: args.channel,
    thread_ts: args.thread_ts,
    text: args.text,
    blocks: args.blocks,
    unfurl_links: false,
    unfurl_media: false,
  });
  return { ts: res.ts };
}

/** Posts a short Slack-mrkdwn note in a thread. */
export async function postNote(channel: string, threadTs: string, text: string) {
  return postMessage({ channel, thread_ts: threadTs, text });
}

/** Posts agent output as standard markdown, split across messages when long. */
export async function postMarkdown(channel: string, threadTs: string, markdown: string) {
  for (const piece of chunkMarkdown(markdown)) {
    await postMessage({
      channel,
      thread_ts: threadTs,
      // Escaped so agent text like "<!channel>" can't ping people through the fallback.
      text: escapeSlack(plainFallback(piece)),
      blocks: [{ type: "markdown", text: piece }],
    });
  }
}

export async function updateMessage(args: { channel: string; ts: string; text: string; blocks?: unknown[] }) {
  await slackApi("chat.update", args);
}

export async function postEphemeral(args: { channel: string; user: string; text: string; thread_ts?: string }) {
  await slackApi("chat.postEphemeral", args);
}

export async function addReaction(channel: string, ts: string, name: string) {
  try {
    await slackApi("reactions.add", { channel, timestamp: ts, name });
  } catch (err) {
    // "already_reacted" and similar are harmless.
    console.warn(String(err));
  }
}

/** Display name for a user (cached for a day). Falls back to the user id. */
export async function displayName(userId: string): Promise<string> {
  try {
    return await cached(`user/${userId}`, 24 * 60 * 60 * 1000, async () => {
      const res = await slackApi<
        SlackResponse & {
          user?: { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } };
        }
      >("users.info", { user: userId }, { form: true });
      const u = res.user;
      return u?.profile?.display_name || u?.profile?.real_name || u?.real_name || u?.name || userId;
    });
  } catch (err) {
    console.warn(`users.info failed for ${userId}: ${String(err)}`);
    return userId;
  }
}

/** The bot's own user id: from the event's authorizations, else auth.test (cached). */
export async function botUserId(fromEvent?: string): Promise<string> {
  if (fromEvent) return fromEvent;
  return cached("bot-user-id", 24 * 60 * 60 * 1000, async () => {
    const res = await slackApi<SlackResponse & { user_id: string }>("auth.test", {}, { form: true });
    return res.user_id;
  }, kv());
}
