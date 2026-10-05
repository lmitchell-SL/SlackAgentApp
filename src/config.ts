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

export function parseChannelAgents(value: string | undefined): Map<string, string> {
  const pairings = new Map<string, string>();
  for (const [index, entry] of (value ?? "").split(";").entries()) {
    if (!entry.trim()) continue;
    const parts = entry.split("=").map((part) => part.trim());
    const channel = parts[0];
    if (parts.length !== 2 || !channel || !parts[1]) {
      console.error(`CHANNEL_AGENTS entry ${index + 1} must be CHANNEL_ID=Agent Name`);
      if (channel && entry.includes("=") && !pairings.has(channel)) pairings.set(channel, "");
      continue;
    }
    if (pairings.has(channel)) {
      console.error(`CHANNEL_AGENTS entry ${index + 1} repeats a channel; keeping the first pairing`);
      continue;
    }
    pairings.set(channel, parts[1]);
  }
  return pairings;
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
  get channelAgents(): Map<string, string> {
    return parseChannelAgents(env("CHANNEL_AGENTS"));
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

/** True when the user may approve tool calls. An empty APPROVER_USER_IDS means anyone may. */
export function isApprover(userId: string, approvers = config.approverUserIds): boolean {
  return approvers.length === 0 || approvers.includes(userId);
}

export function consoleSessionUrl(sessionId: string, workspace = config.consoleWorkspace): string {
  return `https://platform.claude.com/workspaces/${workspace}/sessions/${sessionId}`;
}
