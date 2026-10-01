// Thin wrappers over the Anthropic SDK's Managed Agents (beta) calls.
// Every binding here was checked against @anthropic-ai/sdk 0.131.0 type files.

import Anthropic from "@anthropic-ai/sdk";
import type { BetaManagedAgentsSession } from "@anthropic-ai/sdk/resources/beta/sessions/sessions";
import type { BetaManagedAgentsSessionEvent } from "@anthropic-ai/sdk/resources/beta/sessions/events";
import type { BetaWebhookEvent } from "@anthropic-ai/sdk/resources/beta/webhooks";
import { config, type AgentSetting } from "./config";
import type { AgentRef } from "./agentMatch";
import { cached } from "./store";

let _client: Anthropic | null = null;
/** Reads ANTHROPIC_API_KEY and ANTHROPIC_WEBHOOK_SIGNING_KEY from the environment. */
export function anthropic(): Anthropic {
  if (!_client) _client = new Anthropic();
  return _client;
}

export const AGENT_CACHE_MS = 5 * 60 * 1000;

/** All non-archived agents in the workspace (auto-paginated), cached ~5 minutes. */
export async function listAgents(): Promise<AgentRef[]> {
  return cached("agents", AGENT_CACHE_MS, async () => {
    const out: AgentRef[] = [];
    // include_archived defaults to false; we also filter archived_at defensively.
    for await (const a of anthropic().beta.agents.list({ limit: 100 })) {
      if (!a.archived_at) out.push({ id: a.id, name: a.name });
    }
    return out;
  });
}

export interface SessionPlacement {
  environment_id: string;
  vault_ids: string[];
  source: "recent-session" | "AGENT_SETTINGS" | "defaults" | "first-environment";
}

/**
 * Where a new session runs and which vaults (stored credentials) it gets:
 * 1) copy from the agent's most recent session, 2) AGENT_SETTINGS, 3) DEFAULT_* env vars,
 * 4) the first non-archived environment in the workspace.
 */
export async function resolvePlacement(agentId: string): Promise<SessionPlacement> {
  try {
    // sessions.list supports agent_id filtering, newest first by default (order: "desc").
    const page = await anthropic().beta.sessions.list({ agent_id: agentId, limit: 1, order: "desc" });
    const recent = page.data[0];
    if (recent?.environment_id) {
      return { environment_id: recent.environment_id, vault_ids: recent.vault_ids ?? [], source: "recent-session" };
    }
  } catch (err) {
    console.warn(`Could not list recent sessions for ${agentId}: ${String(err)}`);
  }

  const setting: AgentSetting | undefined = config.agentSettings[agentId];
  if (setting?.environment_id) {
    return { environment_id: setting.environment_id, vault_ids: setting.vault_ids ?? [], source: "AGENT_SETTINGS" };
  }

  if (config.defaultEnvironmentId) {
    return { environment_id: config.defaultEnvironmentId, vault_ids: config.defaultVaultIds, source: "defaults" };
  }

  for await (const env of anthropic().beta.environments.list({ limit: 100 })) {
    if (!env.archived_at) {
      return { environment_id: env.id, vault_ids: config.defaultVaultIds, source: "first-environment" };
    }
  }
  throw new Error("No environment found. Set DEFAULT_ENVIRONMENT_ID or create an environment in the Console.");
}

export function userText(displayName: string, text: string): string {
  return `[From ${displayName} via Slack] ${text}`;
}

export async function createSession(args: {
  agent: AgentRef;
  placement: SessionPlacement;
  /** Full first message, already prefixed with "[From <name> via Slack]". */
  text: string;
  /** The user's own words, used for the session title. */
  titleSource: string;
  channel: string;
  threadTs: string;
}): Promise<BetaManagedAgentsSession> {
  const titleText = args.titleSource.replace(/\s+/g, " ").trim().slice(0, 50);
  return anthropic().beta.sessions.create({
    agent: args.agent.id, // string shorthand = latest agent version; never create agents here
    environment_id: args.placement.environment_id,
    vault_ids: args.placement.vault_ids.length ? args.placement.vault_ids : undefined,
    title: `Slack · ${args.agent.name} · ${titleText}`,
    metadata: { source: "slack-bridge", slack_channel: args.channel, slack_thread_ts: args.threadTs },
    initial_events: [{ type: "user.message", content: [{ type: "text", text: args.text }] }],
  });
}

export async function retrieveSession(sessionId: string) {
  return anthropic().beta.sessions.retrieve(sessionId);
}

export async function sendUserMessage(sessionId: string, text: string) {
  await anthropic().beta.sessions.events.send(sessionId, {
    events: [{ type: "user.message", content: [{ type: "text", text }] }],
  });
}

export async function interrupt(sessionId: string) {
  await anthropic().beta.sessions.events.send(sessionId, { events: [{ type: "user.interrupt" }] });
}

export async function confirmTool(sessionId: string, toolUseEventId: string, allow: boolean, denyMessage?: string) {
  await anthropic().beta.sessions.events.send(sessionId, {
    events: [
      allow
        ? { type: "user.tool_confirmation", tool_use_id: toolUseEventId, result: "allow" }
        : { type: "user.tool_confirmation", tool_use_id: toolUseEventId, result: "deny", deny_message: denyMessage },
    ],
  });
}

export async function rejectCustomTool(sessionId: string, customToolUseId: string, toolName: string) {
  await anthropic().beta.sessions.events.send(sessionId, {
    events: [
      {
        type: "user.custom_tool_result",
        custom_tool_use_id: customToolUseId,
        is_error: true,
        content: [
          {
            type: "text",
            text: `The Slack bridge cannot run the custom tool "${toolName}". Continue without it, or tell the user what you need.`,
          },
        ],
      },
    ],
  });
}

/** Every event in the session, oldest first (SDK default order is "asc"). */
export async function listAllEvents(sessionId: string): Promise<BetaManagedAgentsSessionEvent[]> {
  const out: BetaManagedAgentsSessionEvent[] = [];
  for await (const ev of anthropic().beta.sessions.events.list(sessionId, { order: "asc", limit: 1000 })) {
    out.push(ev);
  }
  return out;
}

/** Verifies an Anthropic Console webhook (signature + ~5 min freshness) and parses it. Throws if invalid. */
export function unwrapWebhook(rawBody: string, headers: Headers): BetaWebhookEvent {
  const h: Record<string, string> = {};
  headers.forEach((value, key) => {
    h[key] = value;
  });
  return anthropic().beta.webhooks.unwrap(rawBody, { headers: h });
}
