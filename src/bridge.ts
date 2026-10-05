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
import { config, consoleSessionUrl, dmAgentsFor, isAllowedPlace, isApprover, isDmChannel } from "./config";
import {
  terminalErrorMessage,
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
  runOnce,
  saveSessionRecord,
  saveThread,
  tryLock,
  withLock,
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
  if (!isAllowedPlace(c.channel)) return;

  const text = unescapeSlack(stripMentions(c.text, bot));
  const dm = isDmChannel(c.channel);
  const thread = await getThread(c.channel, c.threadTs);
  if (thread) {
    await handleFollowUp(c.channel, c.threadTs, c.ts, c.user, text, thread, dm);
    return;
  }
  // Plain thread replies in threads we don't own are ignored. Mentions (or top-level DMs) start a session.
  if (c.kind !== "mention") return;

  if (dm) {
    // Direct messages: only people listed in DM_AGENTS, each with their own agents.
    const mine = dmAgentsFor(c.user);
    if (mine === undefined) {
      await postNote(c.channel, c.threadTs, "Direct messages aren't set up for you yet. Ask an admin to add you to DM_AGENTS, or use one of the team channels.");
      return;
    }
    await startSession(c.channel, c.threadTs, c.ts, c.user, text, { pairedNames: mine, place: "dm" });
    return;
  }
  await startSession(c.channel, c.threadTs, c.ts, c.user, text, { pairedNames: config.channelAgents.get(c.channel), place: "channel" });
}

interface StartOptions {
  /** Agent names this place is limited to; undefined means any agent. */
  pairedNames: string[] | undefined;
  place: "channel" | "dm";
}

async function startSession(channel: string, threadTs: string, ts: string, user: string, text: string, opts: StartOptions) {
  let agents: AgentRef[];
  try {
    agents = await listAgents();
  } catch (err) {
    await postNote(channel, threadTs, `:x: I couldn't load the list of agents: ${escapeSlack(errMsg(err))}`);
    return;
  }

  const { pairedNames, place } = opts;
  const setting = place === "dm" ? "DM_AGENTS" : "CHANNEL_AGENTS";
  let allowedAgents: AgentRef[] | undefined;
  if (pairedNames !== undefined) {
    const found = pairedNames.map((name) => agents.find((agent) => agent.name.trim().toLowerCase() === name.toLowerCase()));
    if (found.length === 0 || found.some((agent) => !agent)) {
      console.error(`${setting} pairing does not match an available agent; check the configured agent name`);
      const who = place === "dm" ? "Your direct-message agents aren't" : "This channel's agent isn't";
      await postNote(channel, threadTs, `${who} set up correctly. Ask an admin to check ${setting}.`);
      return;
    }
    allowedAgents = [...new Map((found as AgentRef[]).map((agent) => [agent.id, agent])).values()];
  }

  if (isHelpRequest(text)) {
    await postNote(channel, threadTs, formatAgentList(allowedAgents ?? agents));
    return;
  }
  const namedAgent = matchAgent(text, agents);
  if (allowedAgents && namedAgent && !allowedAgents.some((agent) => agent.id === namedAgent.agent.id)) {
    const names = allowedAgents.map((agent) => escapeSlack(agent.name));
    const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    const where = place === "dm" ? "In direct messages you can use" : "This channel is set up for";
    await postNote(channel, threadTs, `${where} ${list} only.`);
    return;
  }
  // A channel locked to exactly one agent needs no name; otherwise the message must name an agent.
  const match = namedAgent ?? (allowedAgents?.length === 1 ? { agent: allowedAgents[0]!, rest: text } : null);
  if (!match) {
    await postNote(channel, threadTs, `I couldn't tell which agent you meant.\n\n${formatAgentList(allowedAgents ?? agents)}`);
    return;
  }
  if (!match.rest) {
    const how = place === "dm" ? `Send a new message with your question, e.g. \`${match.agent.name}: ...\`` : `Mention me again with your question, e.g. \`@SL Agents ${match.agent.name}: ...\``;
    await postNote(channel, threadTs, `What would you like to ask *${escapeSlack(match.agent.name)}*? ${how}`);
    return;
  }

  // Only one session per thread, even if two mentions arrive at once. The lock expires,
  // so a crash mid-start can't block the thread for good.
  const release = await tryLock(`thread-start/${channel}:${threadTs}`, 10 * 60_000);
  if (!release) {
    await postNote(channel, threadTs, "I'm still starting a session in this thread. Try again in a moment.");
    return;
  }
  try {
    // Another start may have finished just before we got the lock.
    const existing = await getThread(channel, threadTs);
    if (existing) return await handleFollowUp(channel, threadTs, ts, user, match.rest, existing);

    const [name, placement] = await Promise.all([displayName(user), resolvePlacement(match.agent.id)]);
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
    console.error("Session create failed", err);
    await postNote(channel, threadTs, `:x: I couldn't start a session with *${escapeSlack(match.agent.name)}*: ${escapeSlack(errMsg(err))}`);
  } finally {
    await release();
  }
}

async function handleFollowUp(channel: string, threadTs: string, ts: string, user: string, text: string, thread: ThreadRecord, dm = false) {
  const cmd = threadCommand(text);
  if (cmd === "reset") {
    const how = dm
      ? "To start fresh, send a new message here (not in this thread)."
      : "To start fresh, post a new message in the channel (not in this thread) and mention me with the agent's name.";
    await postNote(channel, threadTs, how);
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
  // One sync per session at a time, so replies are posted in order even when webhooks overlap.
  await withLock(`session/${sessionId}`, () => syncFromWebhook(sessionId));
}

async function syncFromWebhook(sessionId: string): Promise<void> {
  const session = await retrieveSession(sessionId);

  let rec = await getSessionRecord(sessionId);
  if (!rec) {
    // Fall back to the session's own metadata (e.g. the webhook raced our Blobs write).
    const md = session.metadata ?? {};
    if (md.source !== "slack-bridge" || !md.slack_channel || !md.slack_thread_ts) return; // not one of ours
    rec = { channel: md.slack_channel, thread_ts: md.slack_thread_ts, agentName: session.agent?.name, postedEventIds: [] };
    if (isAllowedPlace(rec.channel) && !(await getThread(rec.channel, rec.thread_ts))) {
      await saveThread(rec.channel, rec.thread_ts, {
        sessionId,
        agentId: session.agent.id,
        agentName: session.agent.name,
      });
    }
  }
  if (!isAllowedPlace(rec.channel)) return;
  await syncSessionToSlack(sessionId, rec, session.status, session.agent?.name);
}

export async function syncSessionToSlack(sessionId: string, rec: SessionRecord, status: string, agentNameFromApi?: string) {
  const agentName = rec.agentName ?? agentNameFromApi ?? "The agent";
  const events = (await listAllEvents(sessionId)) as unknown as MinimalEvent[];

  // 1) Post agent replies we haven't posted yet, oldest first.
  const posted: string[] = [];
  try {
    for (const msg of selectNewAgentMessages(events, rec.postedEventIds)) {
      const done = await runOnce("post", `${sessionId}/${msg.id}`, () => postMarkdown(rec.channel, rec.thread_ts, msg.text));
      if (done) posted.push(msg.id);
    }
  } finally {
    await addPostedEventIds(sessionId, posted, rec);
  }

  // 2) Then react to why the session stopped.
  if (status === "terminated") {
    // A normal end stays quiet; only an error end gets a note.
    const error = terminalErrorMessage(events);
    if (error && (await claim("terminated", sessionId))) {
      await postNote(
        rec.channel,
        rec.thread_ts,
        `:warning: This session ended with an error: ${escapeSlack(error)}\nStart a new thread to try again.`,
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
      await runOnce("approval", call.id, async () => {
        await postMessage({
          channel: rec.channel,
          thread_ts: rec.thread_ts,
          text: `${agentName} wants to use ${call.name}. Approve or deny?`,
          blocks: approvalBlocks(agentName, sessionId, call),
        });
      });
    }
    for (const tool of pendingCustomTools(events, ids)) {
      const done = await runOnce("custom", tool.id, () => rejectCustomTool(sessionId, tool.id, tool.name));
      if (!done) continue;
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
  if (!isAllowedPlace(channel)) return;

  // In a direct message, the person the DM belongs to may approve their own agent's requests.
  const dmOwner = isDmChannel(channel) && dmAgentsFor(user) !== undefined;
  if (!dmOwner && !isApprover(user)) {
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
