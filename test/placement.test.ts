import { describe, expect, it } from "vitest";
import { resolvePlacement, type PlacementSources } from "../src/anthropic";

function sources(over: Partial<PlacementSources> = {}): PlacementSources {
  return {
    agentSettings: {},
    latestSession: async () => null,
    defaultEnvironmentId: undefined,
    defaultVaultIds: [],
    firstEnvironment: async () => null,
    ...over,
  };
}

describe("resolvePlacement order", () => {
  const recent = async () => ({ environment_id: "env_recent", vault_ids: ["vlt_recent"] });

  it("1) AGENT_SETTINGS wins over everything", async () => {
    const p = await resolvePlacement(
      "agent_1",
      sources({
        agentSettings: { agent_1: { environment_id: "env_set", vault_ids: ["vlt_set"] } },
        latestSession: recent,
        defaultEnvironmentId: "env_default",
        firstEnvironment: async () => "env_first",
      }),
    );
    expect(p).toEqual({ environment_id: "env_set", vault_ids: ["vlt_set"], source: "AGENT_SETTINGS" });
  });

  it("ignores settings for other agents", async () => {
    const p = await resolvePlacement("agent_1", sources({ agentSettings: { agent_2: { environment_id: "env_x" } }, latestSession: recent }));
    expect(p.source).toBe("recent-session");
  });

  it("2) then the agent's most recent session", async () => {
    const p = await resolvePlacement("agent_1", sources({ latestSession: recent, defaultEnvironmentId: "env_default" }));
    expect(p).toEqual({ environment_id: "env_recent", vault_ids: ["vlt_recent"], source: "recent-session" });
  });

  it("3) then DEFAULT_ENVIRONMENT_ID / DEFAULT_VAULT_IDS (also when listing sessions fails)", async () => {
    const p = await resolvePlacement(
      "agent_1",
      sources({
        latestSession: async () => {
          throw new Error("boom");
        },
        defaultEnvironmentId: "env_default",
        defaultVaultIds: ["vlt_d"],
        firstEnvironment: async () => "env_first",
      }),
    );
    expect(p).toEqual({ environment_id: "env_default", vault_ids: ["vlt_d"], source: "defaults" });
  });

  it("4) then the first non-archived environment", async () => {
    const p = await resolvePlacement("agent_1", sources({ firstEnvironment: async () => "env_first" }));
    expect(p).toEqual({ environment_id: "env_first", vault_ids: [], source: "first-environment" });
  });

  it("fails clearly when there is no environment at all", async () => {
    await expect(resolvePlacement("agent_1", sources())).rejects.toThrow(/No environment found/);
  });
});
