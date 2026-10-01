// The bridge's main logic. Called from the background functions after signatures are verified.

import type { BetaWebhookEvent } from "@anthropic-ai/sdk/resources/beta/webhooks";
import { formatAgentList, isHelpRequest, matchAgent, stripMentions, unescapeSlack, type AgentRef } from "./agentMatch";
import {
  confirmTool,
  createSession,
  interrupt,
  listAgents,
  listAllEvents,
  rejectCustomTool,
  resolvePlacement,
  retrieveSession,
  sendUserMessage,
  userText,
} from "./anthropic";
import { consoleSessionUrl, isAllowedChannel, isApprover } from "./config";
import {
  latestErrorMessage,
  latestIdle,
  pendingCustomTools,
  pendingToolConfirmations,
  previewInput,
  runningAfterLatestIdle,
  selectNewAgentMessages,
  stopReasonNote,
  type MinimalEvent,
  type PendingToolCall,
} from "./sessionEvents";
import {
  addReaction,
  botUserId,
  displayName,
  escapeSlack,
  postEphemeral,
  postMarkdown,
  postMessage,
  postNote,
  updateMessage,
} from "./slack";
import { classifySlackEvent, threadCommand, type SlackEventEnvelope } from "./slackEvents";
import {
  addPostedEventIds,
  claim,
  getSessionRecord,
  getThread,
  releaseClaim,
  saveSessionRecord,
  saveThread,
  type SessionRecord,
  type ThreadRecord,
} from "./store";

function errMsg(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
}

// ---- Slack messages -> sessions --------------------------------------------

export async function handleSlackEvent(envelope: SlackEventEnvelope): Promise<void> {
  if (envelope.type !== "event_callback") return;
  const bot = await botUserId(envelope.authorizations?.[0]?.user_id);
  const c = classifySlackEvent(envelope.event, bot);
  if (c.kind === "ignore") return;
  if (!isAllowedChannel(c.channel)) return;

  const text = unescapeSlack(stripMentions(c.text, bot));
  const thread = await getThread(c.channel, c.threadTs);
  if (thread) {
    await handleFollowUp(c.channel, c.threadTs, c.ts, c.user, text, thread);
    return;
  }
  // Plain thread replies in threads we don't own are ignored. Mentions start a session.
  if (c.kind === "mention") await startSession(c.channel, c.threadTs, c.ts, c.user, text);
}

async function startSession(channel: string, threadTs: string, ts: string, user: string, text: string) {
  let agents: AgentRef[];
  try {
    agents = await listAgents();
  } catch (err) {
    await postNote(channel, threadTs, `:x: I couldn't load the list of agents: ${escapeSlack(errMsg(err))}`);
    return;
  }

  if (isHelpRequest(text)) {
    await postNote(channel, threadTs, formatAgentList(agents));
    return;
  }
  const match = matchAgent(text, agents);
  if (!match) {
    await postNote(channel, threadTs, `I couldn't tell which agent you meant.\n\n${formatAgentList(agents)}`);
    return;
  }
  if (!match.rest) {
    await postNote(channel, threadTs, `What would you like to ask *${escapeSlack(match.agent.name)}*? Mention me again with your question, e.g. \`@SL Agents ${match.agent.name}: ...\``);
    return;
  }

  // Only one session per thread, even if two mentions arrive at once.
  if (!(await claim("thread-start", `${channel}:${threadTs}`))) {
    const existing = await getThread(channel, threadTs);
    if (existing) return handleFollowUp(channel, threadTs, ts, user, text, existing);
    await postNote(channel, threadTs, "I'm still starting a session in this thread. Try again in a moment.");
    return;
  }

  try {
    const name = await displayName(user);
    const placement = await resolvePlacement(match.agent.id);
    const session = await createSession({
      agent: match.agent,
      placement,
      text: userText(name, match.rest),
      titleSource: match.rest,
      channel,
      threadTs,
    });
    const sessionRec: SessionRecord = { channel, thread_ts: threadTs, agentName: match.agent.name, postedEventIds: [] };
    await saveSessionRecord(session.id, sessionRec);
    await saveThread(channel, threadTs, { sessionId: session.id, agentId: match.agent.id, agentName: match.agent.name });
    await postNote(
      channel,
      threadTs,
      `Working on it with *${escapeSlack(match.agent.name)}*… <${consoleSessionUrl(session.id)}|View the session in the Console>\nReply in this thread to keep talking. Say \`stop\` to interrupt.`,
    );
    await addReaction(channel, ts, "eyes");
  } catch (err) {
    await releaseClaim("thread-start", `${channel}:${threadTs}`);
    console.error("Session create failed", err);
    await postNote(channel, threadTs, `:x: I couldn't start a session with *${escapeSlack(match.agent.name)}*: ${escapeSlack(errMsg(err))}`);
  }
}

async function handleFollowUp(channel: string, threadTs: string, ts: string, user: string, text: string, thread: ThreadRecord) {
  const cmd = threadCommand(text);
  if (cmd === "reset") {
    await postNote(channel, threadTs, "To start fresh, post a new message in the channel (not in this thread) and mention me with the agent's name.");
    return;
  }

  let status: string;
  try {
    status = (await retrieveSession(thread.sessionId)).status;
  } catch (err) {
    await postNote(channel, threadTs, `:x: I couldn't reach this thread's session: ${escapeSlack(errMsg(err))}`);
    return;
  }
  if (status === "terminated") {
    await postNote(channel, threadTs, "This session has ended. Start a new thread to talk to the agent again.");
    return;
  }

  try {
    if (cmd === "stop") {
      await interrupt(thread.sessionId);
      await postNote(channel, threadTs, `:octagonal_sign: Stopped *${escapeSlack(thread.agentName)}*. Reply here to give it new directions.`);
      return;
    }
    if (!text) return;
    const name = await displayName(user);
    await sendUserMessage(thread.sessionId, userText(name, text));
    await addReaction(channel, ts, "eyes");
  } catch (err) {
    console.error("Sending to session failed", err);
    await postNote(channel, threadTs, `:x: I couldn't pass that on to *${escapeSlack(thread.agentName)}*: ${escapeSlack(errMsg(err))}`);
  }
}

// ---- Session updates (Console webhook) -> Slack ------------------------------

export const HANDLED_WEBHOOK_TYPES = new Set(["session.status_idled", "session.status_terminated"]);

export async function handleSessionWebhook(event: BetaWebhookEvent): Promise<void> {
  if (!HANDLED_WEBHOOK_TYPES.has(event.data.type)) return;
  const sessionId = event.data.id;
  const session = await retrieveSession(sessionId);

  let rec = await getSessionRecord(sessionId);
  if (!rec) {
    // Fall back to the session's own metadata (e.g. the webhook raced our Blobs write).
    const md = session.metadata ?? {};
    if (md.source !== "slack-bridge" || !md.slack_channel || !md.slack_thread_ts) return; // not one of ours
    rec = { channel: md.slack_channel, thread_ts: md.slack_thread_ts, agentName: session.agent?.name, postedEventIds: [] };
    if (isAllowedChannel(rec.channel) && !(await getThread(rec.channel, rec.thread_ts))) {
      await saveThread(rec.channel, rec.thread_ts, {
        sessionId,
        agentId: session.agent.id,
        agentName: session.agent.name,
      });
    }
  }
  if (!isAllowedChannel(rec.channel)) return;
  await syncSessionToSlack(sessionId, rec, session.status, session.agent?.name);
}

export async function syncSessionToSlack(sessionId: string, rec: SessionRecord, status: string, agentNameFromApi?: string) {
  const agentName = rec.agentName ?? agentNameFromApi ?? "The agent";
  const events = (await listAllEvents(sessionId)) as unknown as MinimalEvent[];

  // 1) Post agent replies we haven't posted yet, oldest first.
  const posted: string[] = [];
  try {
    for (const msg of selectNewAgentMessages(events, rec.postedEventIds)) {
      if (!(await claim("post", `${sessionId}/${msg.id}`))) continue; // another run is posting it
      try {
        await postMarkdown(rec.channel, rec.thread_ts, msg.text);
        posted.push(msg.id);
      } catch (err) {
        await releaseClaim("post", `${sessionId}/${msg.id}`);
        throw err;
      }
    }
  } finally {
    await addPostedEventIds(sessionId, posted, rec);
  }

  // 2) Then react to why the session stopped.
  if (status === "terminated") {
    if (await claim("terminated", sessionId)) {
      const error = latestErrorMessage(events);
      await postNote(
        rec.channel,
        rec.thread_ts,
        error
          ? `:warning: This session ended with an error: ${escapeSlack(error)}\nStart a new thread to try again.`
          : "This session has ended. Start a new thread to talk to the agent again.",
      );
    }
    return;
  }
  if (status !== "idle" || runningAfterLatestIdle(events)) return;

  const idle = latestIdle(events);
  if (!idle) return;

  if (idle.stop_reason.type === "requires_action") {
    const ids = "event_ids" in idle.stop_reason ? idle.stop_reason.event_ids : undefined;
    for (const call of pendingToolConfirmations(events, ids)) {
      if (!(await claim("approval", call.id))) continue;
      try {
        await postMessage({
          channel: rec.channel,
          thread_ts: rec.thread_ts,
          text: `${agentName} wants to use ${call.name}. Approve or deny?`,
          blocks: approvalBlocks(agentName, sessionId, call),
        });
      } catch (err) {
        await releaseClaim("approval", call.id);
        throw err;
      }
    }
    for (const tool of pendingCustomTools(events, ids)) {
      if (!(await claim("custom", tool.id))) continue;
      await rejectCustomTool(sessionId, tool.id, tool.name);
      await postNote(
        rec.channel,
        rec.thread_ts,
        `:information_source: *${escapeSlack(agentName)}* tried to use the custom tool \`${escapeSlack(tool.name)}\`, which this Slack bridge can't run. I told the agent to continue without it.`,
      );
    }
    return;
  }

  const note = stopReasonNote(idle.stop_reason);
  if (note && (await claim("idle-note", idle.id))) await postNote(rec.channel, rec.thread_ts, note);
}

export const APPROVE_ACTION = "tool_approve";
export const DENY_ACTION = "tool_deny";

export function approvalBlocks(agentName: string, sessionId: string, call: PendingToolCall): unknown[] {
  const value = JSON.stringify({ s: sessionId, e: call.id });
  const where = call.server ? ` from *${escapeSlack(call.server)}*` : "";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:raised_hand: *${escapeSlack(agentName)}* wants to use \`${escapeSlack(call.name)}\`${where}.\n\`\`\`${escapeSlack(previewInput(call.input))}\`\`\``,
      },
    },
    {
      type: "actions",
      block_id: "tool_confirmation",
      elements: [
        { type: "button", action_id: APPROVE_ACTION, style: "primary", text: { type: "plain_text", text: "Approve" }, value },
        { type: "button", action_id: DENY_ACTION, style: "danger", text: { type: "plain_text", text: "Deny" }, value },
      ],
    },
  ];
}

// ---- Button clicks -> tool confirmations -------------------------------------

export interface BlockActionsPayload {
  type: string;
  user?: { id: string };
  channel?: { id: string };
  container?: { channel_id?: string; message_ts?: string; thread_ts?: string };
  message?: { ts?: string; thread_ts?: string; blocks?: unknown[] };
  actions?: Array<{ action_id?: string; value?: string }>;
}

export async function handleInteraction(payload: BlockActionsPayload): Promise<void> {
  if (payload.type !== "block_actions") return;
  const action = payload.actions?.[0];
  if (!action || (action.action_id !== APPROVE_ACTION && action.action_id !== DENY_ACTION) || !action.value) return;

  let ref: { s?: string; e?: string };
  try {
    ref = JSON.parse(action.value) as { s?: string; e?: string };
  } catch {
    return;
  }
  const sessionId = ref.s;
  const eventId = ref.e;
  const user = payload.user?.id;
  const channel = payload.channel?.id ?? payload.container?.channel_id;
  const messageTs = payload.container?.message_ts ?? payload.message?.ts;
  const threadTs = payload.message?.thread_ts ?? payload.container?.thread_ts;
  if (!sessionId || !eventId || !user || !channel || !messageTs) return;
  if (!isAllowedChannel(channel)) return;

  if (!isApprover(user)) {
    await postEphemeral({ channel, user, thread_ts: threadTs, text: "Sorry, only approved people can approve or deny agent tool requests here." });
    return;
  }
  const rec = await getSessionRecord(sessionId);
  if (rec && rec.channel !== channel) return; // buttons must stay in their own channel

  if (!(await claim("decision", eventId))) {
    await postEphemeral({ channel, user, thread_ts: threadTs, text: "This request was already decided." });
    return;
  }

  const allow = action.action_id === APPROVE_ACTION;
  const name = await displayName(user);
  try {
    await confirmTool(sessionId, eventId, allow, allow ? undefined : `Denied in Slack by ${name}`);
  } catch (err) {
    await releaseClaim("decision", eventId);
    await postEphemeral({ channel, user, thread_ts: threadTs, text: `:x: I couldn't send your decision: ${errMsg(err)}` });
    return;
  }

  const verdict = allow ? `:white_check_mark: Approved by <@${user}>` : `:no_entry_sign: Denied by <@${user}>`;
  const original = (payload.message?.blocks ?? []).filter((b) => (b as { type?: string }).type !== "actions");
  await updateMessage({
    channel,
    ts: messageTs,
    text: `${allow ? "Approved" : "Denied"} by ${name}`,
    blocks: [...original, { type: "context", elements: [{ type: "mrkdwn", text: verdict }] }],
  });
}
