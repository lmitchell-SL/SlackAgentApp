// Decides which Slack events the bridge acts on.

export interface SlackMessageEvent {
  type: string;
  subtype?: string;
  channel?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  edited?: unknown;
}

export interface SlackEventEnvelope {
  type: "event_callback" | "url_verification" | string;
  event_id?: string;
  challenge?: string;
  event?: SlackMessageEvent;
  authorizations?: Array<{ user_id?: string }>;
}

export type Classified =
  | { kind: "mention"; channel: string; user: string; text: string; ts: string; threadTs: string; inThread: boolean }
  | { kind: "thread_message"; channel: string; user: string; text: string; ts: string; threadTs: string }
  | { kind: "ignore"; reason: string };

/**
 * Slack sends both `app_mention` and `message` for a message that @mentions the bot.
 * We handle mentions only via `app_mention`, and skip `message` events that contain
 * the bot's user id. Bot messages, edits, deletes and other subtypes are ignored.
 */
export function classifySlackEvent(ev: SlackMessageEvent | undefined, botUserId: string): Classified {
  if (!ev) return { kind: "ignore", reason: "no event" };
  if (ev.bot_id) return { kind: "ignore", reason: "bot message" };
  if (ev.subtype) return { kind: "ignore", reason: `subtype ${ev.subtype}` };
  if (ev.edited) return { kind: "ignore", reason: "edited" };
  if (!ev.channel || !ev.user || !ev.ts) return { kind: "ignore", reason: "missing fields" };
  if (ev.user === botUserId) return { kind: "ignore", reason: "own message" };
  const text = ev.text ?? "";

  if (ev.type === "app_mention") {
    return {
      kind: "mention",
      channel: ev.channel,
      user: ev.user,
      text,
      ts: ev.ts,
      threadTs: ev.thread_ts ?? ev.ts,
      inThread: !!ev.thread_ts && ev.thread_ts !== ev.ts,
    };
  }
  if (ev.type === "message") {
    if (botUserId && text.includes(`<@${botUserId}`)) return { kind: "ignore", reason: "handled as app_mention" };
    if (!ev.thread_ts || ev.thread_ts === ev.ts) return { kind: "ignore", reason: "not a thread reply" };
    return { kind: "thread_message", channel: ev.channel, user: ev.user, text, ts: ev.ts, threadTs: ev.thread_ts };
  }
  return { kind: "ignore", reason: `event type ${ev.type}` };
}

export type ThreadCommand = "stop" | "reset" | null;

export function threadCommand(text: string): ThreadCommand {
  const t = text.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
  if (t === "stop" || t === "cancel" || t === "interrupt") return "stop";
  if (t === "new session" || t === "reset" || t === "restart" || t === "start over") return "reset";
  return null;
}
