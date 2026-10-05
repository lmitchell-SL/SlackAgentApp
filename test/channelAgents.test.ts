import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config, parseChannelAgents } from "../src/config";

describe("CHANNEL_AGENTS parsing", () => {
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([undefined, "", "  ", "; ;"])("treats %j as no pairings", (value) => {
    expect(parseChannelAgents(value).size).toBe(0);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("trims spaces and separates multiple pairs", () => {
    expect([...parseChannelAgents(" C0EXAMPLE01 = cFo AgEnT ; C0EXAMPLE02 = Chief of Staff ; ")]).toEqual([
      ["C0EXAMPLE01", ["cFo AgEnT"]],
      ["C0EXAMPLE02", ["Chief of Staff"]],
    ]);
  });

  it("logs bad entries without exposing their values and retains recognizable invalid locks", () => {
    const pairings = parseChannelAgents("not-a-pair; = private-name; C0EXAMPLE01= ; C0EXAMPLE02=bad=entry; C0EXAMPLE03=CFO Agent");
    expect([...pairings]).toEqual([
      ["C0EXAMPLE01", []],
      ["C0EXAMPLE02", []],
      ["C0EXAMPLE03", ["CFO Agent"]],
    ]);
    expect(console.error).toHaveBeenCalledTimes(4);
    for (const [message] of vi.mocked(console.error).mock.calls) {
      expect(message).toContain("CHANNEL_AGENTS");
      expect(message).not.toMatch(/private-name|not-a-pair|C0EXAMPLE|bad=entry/);
    }
  });

  it("reads several comma-separated agents per channel, ignoring empties", () => {
    expect([...parseChannelAgents("C0EXAMPLE01=CFO Agent, Legal Agent,, AETHON Ethics & Compliance Agent ; C0EXAMPLE02=Chief of Staff")]).toEqual([
      ["C0EXAMPLE01", ["CFO Agent", "Legal Agent", "AETHON Ethics & Compliance Agent"]],
      ["C0EXAMPLE02", ["Chief of Staff"]],
    ]);
  });

  it("keeps just the first pairing for a repeated channel", () => {
    expect([...parseChannelAgents("C0EXAMPLE01=CFO Agent; C0EXAMPLE01=Legal Agent")]).toEqual([
      ["C0EXAMPLE01", ["CFO Agent"]],
    ]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("repeats a channel"));
  });

  it("reads CHANNEL_AGENTS from the environment and treats missing values as empty", () => {
    vi.stubEnv("CHANNEL_AGENTS", " C0EXAMPLE01 = CFO Agent ");
    expect(config.channelAgents.get("C0EXAMPLE01")).toEqual(["CFO Agent"]);
    vi.stubEnv("CHANNEL_AGENTS", undefined);
    expect(config.channelAgents.size).toBe(0);
  });
});
