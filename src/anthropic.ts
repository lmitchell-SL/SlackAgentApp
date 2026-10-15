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
  source: "AGENT_SETTINGS" | "recent-session" | "defaults" | "first-environment";
  /** True when vault_ids came from USER_VAULTS for the person who started the session. */
  userVaults?: boolean;
}

export interface PlacementSources {
  agentSettings: Record<string, AgentSetting>;
  /** environment_id + vault_ids of the agent's most recent session, if any. */
  latestSession: (agentId: string) => Promise<{ environment_id: string; vault_ids: string[] } | null>;
  defaultEnvironmentId: string | undefined;
  defaultVaultIds: string[];
  /** First non-archived environment in the workspace, if any. */
  firstEnvironment: () => Promise<string | null>;
  /** USER_VAULTS: Slack user ID to that person's own vault IDs. */
  userVaults: Map<string, string[]>;
  /** True when the vault holds at least one active (non-archived) credential. */
  vaultHasCredentials: (vaultId: string) => Promise<boolean>;
}

export const VAULT_CHECK_CACHE_MS = 5 * 60 * 1000;

const liveSources = (): PlacementSources => ({
  agentSettings: config.agentSettings,
  defaultEnvironmentId: config.defaultEnvironmentId,
  defaultVaultIds: config.defaultVaultIds,
  latestSession: async (agentId) => {
    // sessions.list filters by agent_id and sorts newest first ("desc" is the default).
    const page = await anthropic().beta.sessions.list({ agent_id: agentId, limit: 1, order: "desc" });
    const recent = page.data[0];
    return recent?.environment_id ? { environment_id: recent.environment_id, vault_ids: recent.vault_ids ?? [] } : null;
  },
  userVaults: config.userVaults,
  vaultHasCredentials: (vaultId) =>
    cached(`vault-has-credentials/${vaultId}`, VAULT_CHECK_CACHE_MS, async () => {
      for await (const cred of anthropic().beta.vaults.credentials.list(vaultId, { limit: 20 })) {
        if (!cred.archived_at) return true;
      }
      return false;
    }),
  firstEnvironment: async () => {
    for await (const env of anthropic().beta.environments.list({ limit: 100 })) {
      if (!env.archived_at) return env.id;
    }
    return null;
  },
});

/**
 * Where a new session runs and which vaults (stored credentials) it gets:
 * 1) AGENT_SETTINGS for that agent, 2) the agent's most recent session (with DEFAULT_VAULT_IDS
 * when that session had no vaults), 3) DEFAULT_ENVIRONMENT_ID / DEFAULT_VAULT_IDS,
 * 4) the first non-archived environment.
 * Then, when the person who started the session is in USER_VAULTS, their own vaults replace
 * the vaults chosen above (the environment stays). A listed vault with no connected accounts
 * is skipped, and if none are left the vaults chosen above are kept, so tools never vanish
 * just because someone has not connected their accounts yet.
 */
export async function resolvePlacement(
  agentId: string,
  sources: PlacementSources = liveSources(),
  userId?: string,
): Promise<SessionPlacement> {
  const base = await basePlacement(agentId, sources);
  const mine = userId ? sources.userVaults.get(userId) : undefined;
  if (!mine || mine.length === 0) return base;
  const usable: string[] = [];
  for (const vaultId of mine) {
    try {
      if (await sources.vaultHasCredentials(vaultId)) usable.push(vaultId);
      else console.warn(`USER_VAULTS vault ${vaultId} has no connected accounts; skipping it`);
    } catch (err) {
      console.warn(`Could not check USER_VAULTS vault ${vaultId}; skipping it: ${String(err)}`);
    }
  }
  return usable.length ? { ...base, vault_ids: usable, userVaults: true } : base;
}

async function basePlacement(agentId: string, sources: PlacementSources): Promise<SessionPlacement> {
  const setting = sources.agentSettings[agentId];
  if (setting?.environment_id) {
    return { environment_id: setting.environment_id, vault_ids: setting.vault_ids ?? [], source: "AGENT_SETTINGS" };
  }

  try {
    const recent = await sources.latestSession(agentId);
    if (recent) {
      // A session that ran with no vaults would otherwise pass "no credentials" on to every
      // later session forever; fill the gap from DEFAULT_VAULT_IDS instead.
      const vault_ids = recent.vault_ids.length ? recent.vault_ids : sources.defaultVaultIds;
      return { environment_id: recent.environment_id, vault_ids, source: "recent-session" };
    }
  } catch (err) {
    console.warn(`Could not list recent sessions for ${agentId}: ${String(err)}`);
  }

  if (sources.defaultEnvironmentId) {
    return { environment_id: sources.defaultEnvironmentId, vault_ids: sources.defaultVaultIds, source: "defaults" };
  }

  const first = await sources.firstEnvironment();
  if (first) return { environment_id: first, vault_ids: sources.defaultVaultIds, source: "first-environment" };
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
