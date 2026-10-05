import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmTool, createSession, interrupt, listAgents, sendUserMessage } from "../src/anthropic";
import { APPROVE_ACTION, handleInteraction, handleSlackEvent } from "../src/bridge";
import { config, dmAgentsFor, isAllowedPlace, isDmChannel, parseDmAgents } from "../src/config";
import { postEphemeral, postNote } from "../src/slack";
import { classifySlackEvent } from "../src/slackEvents";
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
  postEphemeral: vi.fn(),
  addReaction: vi.fn(),
  updateMessage: vi.fn(),
}));

const agents = [
  { id: "agent_cfo", name: "CFO Agent" },
  { id: "agent_legal", name: "Legal Agent" },
  { id: "agent_mkt", name: "Marketing Agent" },
];

const DM = "D0EXAMPLE01";

async function dm(text: string, user = "UWENDY", threadTs?: string) {
  await handleSlackEvent({
    type: "event_callback",
    event: { type: "message", channel_type: "im", channel: DM, user, ts: "1.0", thread_ts: threadTs, text },
  });
}

describe("DM_AGENTS parsing and helpers", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("maps users to their agent lists", () => {
    const m = parseDmAgents(" UWENDY = CFO Agent, Legal Agent ; UMATT=Marketing Agent");
    expect(m.get("UWENDY")).toEqual(["CFO Agent", "Legal Agent"]);
    expect(m.get("UMATT")).toEqual(["Marketing Agent"]);
    expect(dmAgentsFor("UWENDY", m)).toEqual(["CFO Agent", "Legal Agent"]);
    expect(dmAgentsFor("UNOBODY", m)).toBeUndefined();
    expect(dmAgentsFor(undefined, m)).toBeUndefined();
  });

  it("recognizes DM channel ids", () => {
    expect(isDmChannel("D0EXAMPLE01")).toBe(true);
    expect(isDmChannel("C0EXAMPLE01")).toBe(false);
    expect(isDmChannel(undefined)).toBe(false);
  });

  it("listens in DMs only once DM_AGENTS names someone", () => {
    expect(isAllowedPlace(DM, ["C0EXAMPLE01"], new Map())).toBe(false);
    expect(isAllowedPlace(DM, ["C0EXAMPLE01"], new Map([["UWENDY", ["CFO Agent"]]]))).toBe(true);
    expect(isAllowedPlace("C0EXAMPLE01", ["C0EXAMPLE01"], new Map())).toBe(true);
    expect(isAllowedPlace("C0OTHER", ["C0EXAMPLE01"], new Map([["UWENDY", ["CFO Agent"]]]))).toBe(false);
  });

  it("reads DM_AGENTS from the environment", () => {
    vi.stubEnv("DM_AGENTS", "UWENDY=CFO Agent");
    expect(config.dmAgents.get("UWENDY")).toEqual(["CFO Agent"]);
    vi.stubEnv("DM_AGENTS", "");
    expect(config.dmAgents.size).toBe(0);
  });
});

describe("DM event classification", () => {
  const base = { channel: DM, user: "UWENDY", ts: "1.0" };

  it("treats a top-level direct message as a start without an @mention", () => {
    const c = classifySlackEvent({ ...base, type: "message", channel_type: "im", text: "CFO Agent: runway?" }, "UBOT");
    expect(c).toMatchObject({ kind: "mention", channel: DM, threadTs: "1.0", inThread: false });
  });

  it("keeps a DM thread reply as a thread message", () => {
    const c = classifySlackEvent({ ...base, type: "message", channel_type: "im", ts: "2.0", thread_ts: "1.0", text: "more" }, "UBOT");
    expect(c).toMatchObject({ kind: "thread_message", threadTs: "1.0" });
  });

  it("still ignores top-level channel messages without a mention", () => {
    const c = classifySlackEvent({ ...base, channel: "C0EXAMPLE01", type: "message", channel_type: "channel", text: "hello" }, "UBOT");
    expect(c.kind).toBe("ignore");
  });
});

describe("direct-message routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("ALLOWED_CHANNEL_IDS", "C0EXAMPLE01");
    vi.stubEnv("CHANNEL_AGENTS", "");
    vi.stubEnv("DM_AGENTS", "UWENDY=CFO Agent, Legal Agent; UMATT=Marketing Agent");
    vi.stubEnv("APPROVER_USER_IDS", "ULUCAS");
    vi.stubEnv("CONSOLE_WORKSPACE", "default");
    vi.mocked(listAgents).mockResolvedValue(agents);
    setKV(new MemoryKV());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("starts a session with a named allowed agent, no @mention needed", async () => {
    await dm("CFO Agent: what's our runway?");
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ agent: agents[0], titleSource: "what's our runway?" }));
    expect(await getThread(DM, "1.0")).toMatchObject({ agentId: "agent_cfo" });
  });

  it("needs no agent name when the person has exactly one agent", async () => {
    await dm("draft a launch post", "UMATT");
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ agent: agents[2], titleSource: "draft a launch post" }));
  });

  it("asks which agent when several are allowed and none is named", async () => {
    await dm("what's our runway?");
    expect(createSession).not.toHaveBeenCalled();
    expect(postNote).toHaveBeenCalledWith(DM, "1.0", expect.stringContaining("I couldn't tell which agent you meant"));
  });

  it("blocks an agent outside the person's list", async () => {
    await dm("Marketing Agent: draft a post");
    expect(createSession).not.toHaveBeenCalled();
    expect(postNote).toHaveBeenCalledWith(DM, "1.0", "In direct messages you can use CFO Agent and Legal Agent only.");
  });

  it("lists only the person's agents", async () => {
    await dm("agents");
    const note = vi.mocked(postNote).mock.calls[0]![2] as string;
    expect(note).toContain("• CFO Agent");
    expect(note).toContain("• Legal Agent");
    expect(note).not.toContain("Marketing Agent");
  });

  it("turns away people not in DM_AGENTS", async () => {
    await dm("CFO Agent: runway?", "UNOBODY");
    expect(listAgents).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(postNote).toHaveBeenCalledWith(DM, "1.0", expect.stringContaining("Direct messages aren't set up for you yet"));
  });

  it("stays silent in DMs when DM_AGENTS is empty", async () => {
    vi.stubEnv("DM_AGENTS", "");
    await dm("CFO Agent: runway?");
    expect(listAgents).not.toHaveBeenCalled();
    expect(postNote).not.toHaveBeenCalled();
  });

  it("fails closed when a listed agent does not exist", async () => {
    vi.stubEnv("DM_AGENTS", "UWENDY=CFO Agent, Missing Agent");
    await dm("CFO Agent: runway?");
    expect(createSession).not.toHaveBeenCalled();
    expect(postNote).toHaveBeenCalledWith(DM, "1.0", "Your direct-message agents aren't set up correctly. Ask an admin to check DM_AGENTS.");
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("Missing Agent");
  });

  it("continues and stops in the DM thread", async () => {
    await dm("CFO Agent: runway?");
    await dm("and next quarter?", "UWENDY", "1.0");
    expect(sendUserMessage).toHaveBeenCalledWith("session_example", "[From Example User via Slack] and next quarter?");
    await dm("stop", "UWENDY", "1.0");
    expect(interrupt).toHaveBeenCalledWith("session_example");
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("lets the DM owner approve even when not in APPROVER_USER_IDS", async () => {
    await saveThread(DM, "1.0", { sessionId: "session_example", agentId: "agent_cfo", agentName: "CFO Agent" });
    await saveSessionRecord("session_example", { channel: DM, thread_ts: "1.0", postedEventIds: [] });
    await handleInteraction({
      type: "block_actions",
      user: { id: "UWENDY" },
      channel: { id: DM },
      message: { ts: "2.0", thread_ts: "1.0", blocks: [] },
      actions: [{ action_id: APPROVE_ACTION, value: JSON.stringify({ s: "session_example", e: "event_example" }) }],
    });
    expect(confirmTool).toHaveBeenCalledWith("session_example", "event_example", true, undefined);
    expect(postEphemeral).not.toHaveBeenCalled();
  });

  it("does not change who may approve in channels", async () => {
    await saveSessionRecord("session_example", { channel: "C0EXAMPLE01", thread_ts: "1.0", postedEventIds: [] });
    await handleInteraction({
      type: "block_actions",
      user: { id: "UWENDY" },
      channel: { id: "C0EXAMPLE01" },
      message: { ts: "2.0", thread_ts: "1.0", blocks: [] },
      actions: [{ action_id: APPROVE_ACTION, value: JSON.stringify({ s: "session_example", e: "event_example" }) }],
    });
    expect(confirmTool).not.toHaveBeenCalled();
    expect(postEphemeral).toHaveBeenCalled();
  });
});
