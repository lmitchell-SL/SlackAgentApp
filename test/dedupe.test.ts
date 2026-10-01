import { beforeEach, describe, expect, it } from "vitest";
import {
  latestIdle,
  pendingCustomTools,
  pendingToolConfirmations,
  runningAfterLatestIdle,
  selectNewAgentMessages,
  type MinimalEvent,
} from "../src/sessionEvents";
import { classifySlackEvent, threadCommand } from "../src/slackEvents";
import {
  addPostedEventIds,
  claim,
  getSessionRecord,
  getThread,
  MemoryKV,
  releaseClaim,
  saveSessionRecord,
  saveThread,
  threadKey,
} from "../src/store";

const msg = (id: string, text: string): MinimalEvent => ({ id, type: "agent.message", content: [{ type: "text", text }] });

const events: MinimalEvent[] = [
  { id: "u1", type: "user.message", content: [{ type: "text", text: "hi" }] },
  { id: "r1", type: "session.status_running" },
  msg("m1", "First reply"),
  { id: "t1", type: "agent.tool_use", name: "bash", input: { command: "ls" }, evaluated_permission: "allow" },
  { id: "t2", type: "agent.mcp_tool_use", name: "send_email", mcp_server_name: "gmail", input: { to: "a@b.c" }, evaluated_permission: "ask" },
  { id: "t3", type: "agent.tool_use", name: "write", input: {}, evaluated_permission: "ask" },
  { id: "c1", type: "agent.custom_tool_use", name: "lookup", input: {} },
  msg("m2", "Second reply"),
  { id: "m3", type: "agent.message", content: [{ type: "redacted" }] },
  { id: "conf3", type: "user.tool_confirmation", tool_use_id: "t3", result: "allow" },
  { id: "i1", type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: ["t2", "t3", "c1"] } },
];

describe("selectNewAgentMessages", () => {
  it("returns unposted agent messages in order and skips empty ones", () => {
    expect(selectNewAgentMessages(events, [])).toEqual([
      { id: "m1", text: "First reply" },
      { id: "m2", text: "Second reply" },
    ]);
  });
  it("skips ids already posted", () => {
    expect(selectNewAgentMessages(events, ["m1"]).map((m) => m.id)).toEqual(["m2"]);
    expect(selectNewAgentMessages(events, ["m1", "m2"])).toEqual([]);
  });
  it("ignores duplicate events in the list", () => {
    expect(selectNewAgentMessages([msg("a", "x"), msg("a", "x")], []).map((m) => m.id)).toEqual(["a"]);
  });
});

describe("pending actions", () => {
  it("finds 'ask' tool calls not yet confirmed", () => {
    const pending = pendingToolConfirmations(events, ["t2", "t3", "c1"]);
    expect(pending.map((p) => p.id)).toEqual(["t2"]);
    expect(pending[0]).toMatchObject({ name: "send_email", server: "gmail", type: "agent.mcp_tool_use" });
  });
  it("finds unanswered custom tool calls", () => {
    expect(pendingCustomTools(events).map((p) => p.id)).toEqual(["c1"]);
    const answered = [...events, { id: "x", type: "user.custom_tool_result", custom_tool_use_id: "c1" }];
    expect(pendingCustomTools(answered)).toEqual([]);
  });
  it("reads the latest idle stop reason", () => {
    expect(latestIdle(events)?.stop_reason.type).toBe("requires_action");
    expect(runningAfterLatestIdle(events)).toBe(false);
    expect(runningAfterLatestIdle([...events, { id: "r2", type: "session.status_running" }])).toBe(true);
  });
});

describe("Slack event filtering", () => {
  const bot = "UBOT";
  const base = { channel: "C1", user: "U1", ts: "2.0" };
  it("handles mentions via app_mention only", () => {
    expect(classifySlackEvent({ ...base, type: "app_mention", text: "<@UBOT> CFO: hi" }, bot).kind).toBe("mention");
    expect(classifySlackEvent({ ...base, type: "message", text: "<@UBOT> CFO: hi", thread_ts: "1.0" }, bot).kind).toBe("ignore");
  });
  it("uses the message ts as the thread for a top-level mention", () => {
    const c = classifySlackEvent({ ...base, type: "app_mention", text: "<@UBOT> hi" }, bot);
    expect(c).toMatchObject({ kind: "mention", threadTs: "2.0", inThread: false });
  });
  it("accepts plain thread replies", () => {
    expect(classifySlackEvent({ ...base, type: "message", text: "and Q3?", thread_ts: "1.0" }, bot)).toMatchObject({
      kind: "thread_message",
      threadTs: "1.0",
    });
  });
  it("ignores bots, edits, deletes, other subtypes, own messages and top-level chatter", () => {
    const ig = (ev: object) => classifySlackEvent({ ...base, type: "message", thread_ts: "1.0", text: "x", ...ev }, bot).kind;
    expect(ig({ bot_id: "B1" })).toBe("ignore");
    expect(ig({ subtype: "message_changed" })).toBe("ignore");
    expect(ig({ subtype: "message_deleted" })).toBe("ignore");
    expect(ig({ subtype: "channel_join" })).toBe("ignore");
    expect(ig({ user: "UBOT" })).toBe("ignore");
    expect(ig({ thread_ts: undefined })).toBe("ignore");
  });
  it("recognises thread commands", () => {
    expect(threadCommand("stop")).toBe("stop");
    expect(threadCommand("Stop!")).toBe("stop");
    expect(threadCommand("new session")).toBe("reset");
    expect(threadCommand("reset")).toBe("reset");
    expect(threadCommand("stop the presses")).toBeNull();
  });
});

describe("store: thread mapping and one-time claims", () => {
  let store: MemoryKV;
  beforeEach(() => {
    store = new MemoryKV();
  });

  it("maps a Slack thread to a session and back", async () => {
    await saveThread("C1", "1.0", { sessionId: "s1", agentId: "a1", agentName: "CFO Agent" }, store);
    await saveSessionRecord("s1", { channel: "C1", thread_ts: "1.0", postedEventIds: [] }, store);
    expect(await getThread("C1", "1.0", store)).toEqual({ sessionId: "s1", agentId: "a1", agentName: "CFO Agent" });
    expect(await getThread("C1", "9.9", store)).toBeNull();
    expect((await getSessionRecord("s1", store))?.thread_ts).toBe("1.0");
    expect(threadKey("C1", "1.0")).toBe("C1:1.0");
  });

  it("lets only the first caller claim an id", async () => {
    expect(await claim("slack-event", "Ev1", store)).toBe(true);
    expect(await claim("slack-event", "Ev1", store)).toBe(false);
    expect(await claim("slack-event", "Ev2", store)).toBe(true);
    await releaseClaim("slack-event", "Ev1", store);
    expect(await claim("slack-event", "Ev1", store)).toBe(true);
  });

  it("posts each agent message once even when two webhook runs overlap", async () => {
    const rec = { channel: "C1", thread_ts: "1.0", postedEventIds: [] as string[] };
    await saveSessionRecord("s1", rec, store);
    const postedToSlack: string[] = [];
    const run = async () => {
      const cur = (await getSessionRecord("s1", store))!;
      const ids: string[] = [];
      for (const m of selectNewAgentMessages(events, cur.postedEventIds)) {
        if (!(await claim("post", `s1/${m.id}`, store))) continue;
        postedToSlack.push(m.id);
        ids.push(m.id);
      }
      await addPostedEventIds("s1", ids, rec, store);
    };
    await Promise.all([run(), run()]);
    await run();
    expect(postedToSlack.sort()).toEqual(["m1", "m2"]);
    expect((await getSessionRecord("s1", store))?.postedEventIds.sort()).toEqual(["m1", "m2"]);
  });
});
