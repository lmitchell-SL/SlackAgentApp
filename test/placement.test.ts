import { describe, expect, it } from "vitest";
import { resolvePlacement, type PlacementSources } from "../src/anthropic";

function sources(over: Partial<PlacementSources> = {}): PlacementSources {
  return {
    agentSettings: {},
    latestSession: async () => null,
    defaultEnvironmentId: undefined,
    defaultVaultIds: [],
    firstEnvironment: async () => null,
    userVaults: new Map(),
    vaultHasCredentials: async () => true,
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

  it("fills an empty recent-session vault list from DEFAULT_VAULT_IDS", async () => {
    const p = await resolvePlacement(
      "agent_1",
      sources({ latestSession: async () => ({ environment_id: "env_recent", vault_ids: [] }), defaultVaultIds: ["vlt_d"] }),
    );
    expect(p).toEqual({ environment_id: "env_recent", vault_ids: ["vlt_d"], source: "recent-session" });
  });
});

describe("USER_VAULTS", () => {
  const recent = async () => ({ environment_id: "env_recent", vault_ids: ["vlt_recent"] });

  it("uses the starter's own vault instead of the agent's recent one, keeping the environment", async () => {
    const p = await resolvePlacement("agent_1", sources({ latestSession: recent, userVaults: new Map([["U_WENDY", ["vlt_wendy"]]]) }), "U_WENDY");
    expect(p).toEqual({ environment_id: "env_recent", vault_ids: ["vlt_wendy"], source: "recent-session", userVaults: true });
  });

  it("leaves people who are not listed on the usual vaults", async () => {
    const p = await resolvePlacement("agent_1", sources({ latestSession: recent, userVaults: new Map([["U_WENDY", ["vlt_wendy"]]]) }), "U_OTHER");
    expect(p).toEqual({ environment_id: "env_recent", vault_ids: ["vlt_recent"], source: "recent-session" });
  });

  it("falls back when the person's vault has no connected accounts yet", async () => {
    const p = await resolvePlacement(
      "agent_1",
      sources({ latestSession: recent, userVaults: new Map([["U_MATT", ["vlt_matt"]]]), vaultHasCredentials: async () => false }),
      "U_MATT",
    );
    expect(p).toEqual({ environment_id: "env_recent", vault_ids: ["vlt_recent"], source: "recent-session" });
  });

  it("keeps only listed vaults that have accounts, skipping ones it cannot check", async () => {
    const p = await resolvePlacement(
      "agent_1",
      sources({
        defaultEnvironmentId: "env_default",
        defaultVaultIds: ["vlt_d"],
        userVaults: new Map([["U_A", ["vlt_empty", "vlt_full", "vlt_broken"]]]),
        vaultHasCredentials: async (id) => {
          if (id === "vlt_broken") throw new Error("boom");
          return id === "vlt_full";
        },
      }),
      "U_A",
    );
    expect(p).toEqual({ environment_id: "env_default", vault_ids: ["vlt_full"], source: "defaults", userVaults: true });
  });

  it("also overrides AGENT_SETTINGS vaults", async () => {
    const p = await resolvePlacement(
      "agent_1",
      sources({ agentSettings: { agent_1: { environment_id: "env_set", vault_ids: ["vlt_set"] } }, userVaults: new Map([["U_A", ["vlt_a"]]]) }),
      "U_A",
    );
    expect(p).toEqual({ environment_id: "env_set", vault_ids: ["vlt_a"], source: "AGENT_SETTINGS", userVaults: true });
  });
});
