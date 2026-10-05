import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmTool, createSession, interrupt, listAgents, sendUserMessage } from "../src/anthropic";
import { APPROVE_ACTION, DENY_ACTION, handleInteraction, handleSlackEvent } from "../src/bridge";
import { postNote, updateMessage } from "../src/slack";
import { getThread, MemoryKV, saveSessionRecord, saveThread, setKV } from "../src/store";

vi.mock("../src/anthropic", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/anthropic")>(),
  listAgents: vi.fn(),
  resolvePlacement: vi.fn(async () => ({ environment_id: "env_example", vault_ids: [], source: "defaults" })),
  createSession: vi.fn(async () => ({ id: "session_example" })),
  retrieveSession: vi.fn(async () => ({ status: "idle" })),
  sendUserMessage: vi.fn(),
  interrupt: vi.fn(),
  confirmTool: vi.fn(),
}));

vi.mock("../src/slack", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/slack")>(),
  botUserId: vi.fn(async () => "UBOT"),
  displayName: vi.fn(async () => "Example User"),
  postNote: vi.fn(),
  addReaction: vi.fn(),
  updateMessage: vi.fn(),
}));

const agents = [
  { id: "agent_cfo", name: "CFO Agent" },
  { id: "agent_legal", name: "Legal Agent" },
];

async function mention(text: string, channel = "C0EXAMPLE01", threadTs?: string) {
  await handleSlackEvent({
    type: "event_callback",
    event: { type: "app_mention", channel, user: "UEXAMPLE", ts: "1.0", thread_ts: threadTs, text: `<@UBOT> ${text}` },
  });
}

describe("per-channel agent routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("ALLOWED_CHANNEL_IDS", "C0EXAMPLE01,C0EXAMPLE02");
    vi.stubEnv("CHANNEL_AGENTS", " C0EXAMPLE01 = cFo AgEnT ");
    vi.stubEnv("APPROVER_USER_IDS", "");
    vi.stubEnv("CONSOLE_WORKSPACE", "default");
    vi.mocked(listAgents).mockResolvedValue(agents);
    setKV(new MemoryKV());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("routes a bare message to the case-insensitively paired agent", async () => {
    await mention("What's our runway?");
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      agent: agents[0],
      text: "[From Example User via Slack] What's our runway?",
      titleSource: "What's our runway?",
    }));
    expect(await getThread("C0EXAMPLE01", "1.0")).toMatchObject({ agentId: "agent_cfo", agentName: "CFO Agent" });
  });

  it.each(["CFO Agent: What's our runway?", "cfo: What's our runway?"])("strips a paired agent prefix: %s", async (text) => {
    await mention(text);
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ agent: agents[0], titleSource: "What's our runway?" }));
  });

  it.each(["Legal Agent: Review this", "legal: Review this"])("blocks a different named agent: %s", async (text) => {
    await mention(text);
    expect(createSession).not.toHaveBeenCalled();
    expect(await getThread("C0EXAMPLE01", "1.0")).toBeNull();
    expect(postNote).toHaveBeenCalledWith("C0EXAMPLE01", "1.0", "This channel is set up for CFO Agent only.");
  });

  it("lists only the paired agent", async () => {
    await mention("agents");
    expect(createSession).not.toHaveBeenCalled();
    expect(postNote).toHaveBeenCalledWith("C0EXAMPLE01", "1.0", expect.stringContaining("• CFO Agent"));
    expect(vi.mocked(postNote).mock.calls[0]![2]).not.toContain("Legal Agent");
  });

  describe("channel with several agents", () => {
    beforeEach(() => vi.stubEnv("CHANNEL_AGENTS", "C0EXAMPLE01=CFO Agent, Legal Agent"));

    it.each([["CFO Agent: runway?", 0], ["legal: review this", 1]] as const)("routes to a named allowed agent: %s", async (text, index) => {
      await mention(text);
      expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ agent: agents[index] }));
    });

    it("asks which agent when none is named", async () => {
      await mention("What's our runway?");
      expect(createSession).not.toHaveBeenCalled();
      expect(postNote).toHaveBeenCalledWith("C0EXAMPLE01", "1.0", expect.stringContaining("I couldn't tell which agent you meant"));
    });

    it("lists exactly the allowed agents", async () => {
      await mention("agents");
      const note = vi.mocked(postNote).mock.calls[0]![2] as string;
      expect(note).toContain("• CFO Agent");
      expect(note).toContain("• Legal Agent");
    });

    it("blocks an agent that is not allowed and names the allowed ones", async () => {
      vi.mocked(listAgents).mockResolvedValue([...agents, { id: "agent_mkt", name: "Marketing Agent" }]);
      await mention("Marketing Agent: draft a post");
      expect(createSession).not.toHaveBeenCalled();
      expect(postNote).toHaveBeenCalledWith("C0EXAMPLE01", "1.0", "This channel is set up for CFO Agent and Legal Agent only.");
    });

    it("fails closed if any listed agent does not exist", async () => {
      vi.stubEnv("CHANNEL_AGENTS", "C0EXAMPLE01=CFO Agent, Missing Agent");
      await mention("CFO Agent: runway?");
      expect(createSession).not.toHaveBeenCalled();
      expect(postNote).toHaveBeenCalledWith("C0EXAMPLE01", "1.0", expect.stringContaining("isn't set up correctly"));
    });
  });

  it("still requires ALLOWED_CHANNEL_IDS even for a paired channel", async () => {
    vi.stubEnv("ALLOWED_CHANNEL_IDS", "C0EXAMPLE02");
    await mention("What's our runway?");
    expect(listAgents).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(postNote).not.toHaveBeenCalled();
  });

  it.each(["Missing Agent", "CFO", ""])("fails closed for an invalid paired agent: %j", async (name) => {
    vi.stubEnv("CHANNEL_AGENTS", `C0EXAMPLE01=${name}`);
    await mention("Legal Agent: Review this");
    expect(createSession).not.toHaveBeenCalled();
    expect(postNote).toHaveBeenCalledWith("C0EXAMPLE01", "1.0", "This channel's agent isn't set up correctly. Ask an admin to check CHANNEL_AGENTS.");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("does not match an available agent"));
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("Missing Agent");
  });

  it("reports an invalid pairing rather than listing other agents", async () => {
    vi.stubEnv("CHANNEL_AGENTS", "C0EXAMPLE01=Missing Agent");
    await mention("agents");
    expect(postNote).toHaveBeenCalledWith("C0EXAMPLE01", "1.0", expect.stringContaining("isn't set up correctly"));
    expect(createSession).not.toHaveBeenCalled();
  });

  it("keeps named routing and the full list in an unlocked channel", async () => {
    await mention("Legal: Review this", "C0EXAMPLE02");
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ agent: agents[1], titleSource: "Review this" }));
    await mention("agents", "C0EXAMPLE02", "2.0");
    expect(postNote).toHaveBeenCalledWith("C0EXAMPLE02", "2.0", expect.stringContaining("• Legal Agent"));
    expect(postNote).toHaveBeenCalledWith("C0EXAMPLE02", "2.0", expect.stringContaining("• CFO Agent"));
  });

  it("still requires an agent name in an unlocked channel", async () => {
    await mention("What's our runway?", "C0EXAMPLE02");
    expect(createSession).not.toHaveBeenCalled();
    expect(postNote).toHaveBeenCalledWith("C0EXAMPLE02", "1.0", expect.stringContaining("I couldn't tell which agent you meant"));
  });

  it.each([undefined, "", "  "])("keeps original behavior when CHANNEL_AGENTS is %j", async (value) => {
    vi.stubEnv("CHANNEL_AGENTS", value);
    await mention("What's our runway?");
    expect(createSession).not.toHaveBeenCalled();
    await mention("agents");
    expect(postNote).toHaveBeenCalledWith("C0EXAMPLE01", "1.0", expect.stringContaining("• Legal Agent"));
    await mention("Legal Agent: Review this");
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ agent: agents[1], titleSource: "Review this" }));
  });

  it("keeps plain replies, mentioned follow-ups, and stop in the existing thread", async () => {
    await mention("What's our runway?");
    await handleSlackEvent({
      type: "event_callback",
      event: { type: "message", channel: "C0EXAMPLE01", user: "UEXAMPLE", ts: "2.0", thread_ts: "1.0", text: "And next quarter?" },
    });
    expect(sendUserMessage).toHaveBeenCalledWith("session_example", "[From Example User via Slack] And next quarter?");
    await mention("More detail please", "C0EXAMPLE01", "1.0");
    expect(sendUserMessage).toHaveBeenCalledWith("session_example", "[From Example User via Slack] More detail please");
    await mention("stop", "C0EXAMPLE01", "1.0");
    expect(interrupt).toHaveBeenCalledWith("session_example");
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("still ignores plain replies in unowned threads", async () => {
    await handleSlackEvent({
      type: "event_callback",
      event: { type: "message", channel: "C0EXAMPLE01", user: "UEXAMPLE", ts: "2.0", thread_ts: "1.0", text: "Hello" },
    });
    expect(listAgents).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it.each([APPROVE_ACTION, DENY_ACTION])("preserves %s buttons in locked channels", async (action) => {
    await saveThread("C0EXAMPLE01", "1.0", { sessionId: "session_example", agentId: "agent_cfo", agentName: "CFO Agent" });
    await saveSessionRecord("session_example", { channel: "C0EXAMPLE01", thread_ts: "1.0", postedEventIds: [] });
    await handleInteraction({
      type: "block_actions",
      user: { id: "UEXAMPLE" },
      channel: { id: "C0EXAMPLE01" },
      message: { ts: "2.0", thread_ts: "1.0", blocks: [] },
      actions: [{ action_id: action, value: JSON.stringify({ s: "session_example", e: "event_example" }) }],
    });
    expect(confirmTool).toHaveBeenCalledWith("session_example", "event_example", action === APPROVE_ACTION,
      action === APPROVE_ACTION ? undefined : "Denied in Slack by Example User");
    expect(updateMessage).toHaveBeenCalled();
  });
});
