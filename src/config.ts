// Reads settings from environment variables (set in Netlify, never in code).

export interface AgentSetting {
  environment_id?: string;
  vault_ids?: string[];
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

export function requireEnv(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export function csv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parses a pairing list such as CHANNEL_AGENTS or DM_AGENTS:
 * "KEY=Agent One, Agent Two; KEY2=Agent Three". Each key maps to its list of allowed agent names.
 */
export function parsePairings(value: string | undefined, label: string, keyLabel: string, keyWord: string): Map<string, string[]> {
  const pairings = new Map<string, string[]>();
  for (const [index, entry] of (value ?? "").split(";").entries()) {
    if (!entry.trim()) continue;
    const parts = entry.split("=").map((part) => part.trim());
    const key = parts[0];
    const names = (parts[1] ?? "").split(",").map((name) => name.trim()).filter(Boolean);
    if (parts.length !== 2 || !key || names.length === 0) {
      console.error(`${label} entry ${index + 1} must be ${keyLabel}=Agent Name[, Agent Name...]`);
      if (key && entry.includes("=") && !pairings.has(key)) pairings.set(key, []);
      continue;
    }
    if (pairings.has(key)) {
      console.error(`${label} entry ${index + 1} repeats a ${keyWord}; keeping the first pairing`);
      continue;
    }
    pairings.set(key, names);
  }
  return pairings;
}

/** Parses CHANNEL_AGENTS: "CHANNEL=Agent One, Agent Two; CHANNEL2=Agent Three". */
export function parseChannelAgents(value: string | undefined): Map<string, string[]> {
  return parsePairings(value, "CHANNEL_AGENTS", "CHANNEL_ID", "channel");
}

/** Parses DM_AGENTS: "USER=Agent One, Agent Two; USER2=Agent Three". Each Slack user maps to the agents they may use in a direct message. */
export function parseDmAgents(value: string | undefined): Map<string, string[]> {
  return parsePairings(value, "DM_AGENTS", "USER_ID", "user");
}

export const config = {
  get slackBotToken(): string {
    return requireEnv("SLACK_BOT_TOKEN");
  },
  get slackSigningSecret(): string {
    return requireEnv("SLACK_SIGNING_SECRET");
  },
  get allowedChannelIds(): string[] {
    return csv(env("ALLOWED_CHANNEL_IDS"));
  },
  get channelAgents(): Map<string, string[]> {
    return parseChannelAgents(env("CHANNEL_AGENTS"));
  },
  get dmAgents(): Map<string, string[]> {
    return parseDmAgents(env("DM_AGENTS"));
  },
  get approverUserIds(): string[] {
    return csv(env("APPROVER_USER_IDS"));
  },
  get consoleWorkspace(): string {
    return env("CONSOLE_WORKSPACE") ?? "default";
  },
  get defaultEnvironmentId(): string | undefined {
    return env("DEFAULT_ENVIRONMENT_ID");
  },
  get defaultVaultIds(): string[] {
    return csv(env("DEFAULT_VAULT_IDS"));
  },
  get agentSettings(): Record<string, AgentSetting> {
    const raw = env("AGENT_SETTINGS");
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, AgentSetting>;
      }
    } catch {
      console.error("AGENT_SETTINGS is not valid JSON; ignoring it");
    }
    return {};
  },
};

/** True when the channel is in ALLOWED_CHANNEL_IDS. An empty list allows nothing. */
export function isAllowedChannel(channelId: string | undefined, allowed = config.allowedChannelIds): boolean {
  return !!channelId && allowed.includes(channelId);
}

/** Slack direct-message channel IDs start with "D". */
export function isDmChannel(channelId: string | undefined): boolean {
  return !!channelId && /^D[A-Z0-9]+$/.test(channelId);
}

/**
 * True when the bot should listen in this channel: a channel in ALLOWED_CHANNEL_IDS, or any
 * direct message once DM_AGENTS names at least one person. Who may actually talk in a DM is
 * checked later against DM_AGENTS.
 */
export function isAllowedPlace(channelId: string | undefined, allowed = config.allowedChannelIds, dmAgents = config.dmAgents): boolean {
  return isAllowedChannel(channelId, allowed) || (isDmChannel(channelId) && dmAgents.size > 0);
}

/** The agents a user may reach in a direct message, or undefined when they are not in DM_AGENTS. */
export function dmAgentsFor(userId: string | undefined, dmAgents = config.dmAgents): string[] | undefined {
  return userId ? dmAgents.get(userId) : undefined;
}

/** True when the user may approve tool calls. An empty APPROVER_USER_IDS means anyone may. */
export function isApprover(userId: string, approvers = config.approverUserIds): boolean {
  return approvers.length === 0 || approvers.includes(userId);
}

export function consoleSessionUrl(sessionId: string, workspace = config.consoleWorkspace): string {
  return `https://platform.claude.com/workspaces/${workspace}/sessions/${sessionId}`;
}
