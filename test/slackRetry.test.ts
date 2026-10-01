import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeSlackSignature } from "../src/slackVerify";
import { MemoryKV, setKV } from "../src/store";

process.env.SLACK_SIGNING_SECRET = "s3cret";
process.env.ALLOWED_CHANNEL_IDS = "C0C6T53G5J4";
const { default: slackEvents } = await import("../netlify/functions/slack-events.mts");

function slackRequest(body: object, retryNum?: string) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-slack-request-timestamp": ts,
    "x-slack-signature": computeSlackSignature("s3cret", ts, raw),
  };
  if (retryNum) headers["x-slack-retry-num"] = retryNum;
  return new Request("https://site.netlify.app/slack/events", { method: "POST", body: raw, headers });
}

const event = {
  type: "event_callback",
  event_id: "Ev123",
  event: { type: "app_mention", channel: "C0C6T53G5J4", user: "U1", ts: "1.0", text: "<@UBOT> CFO: hi" },
};

describe("slack-events retries and hand-off", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    setKV(new MemoryKV());
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("answers 500 when the hand-off fails, then handles Slack's retry, then dedupes", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 500 }));
    expect((await slackEvents(slackRequest(event))).status).toBe(500);

    fetchMock.mockResolvedValueOnce(new Response("", { status: 202 }));
    expect((await slackEvents(slackRequest(event, "1"))).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]![0])).toBe("https://site.netlify.app/.netlify/functions/slack-events-background");

    expect((await slackEvents(slackRequest(event, "2"))).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2); // already handled: no second hand-off
  });

  it("forwards the raw body and Slack signature headers", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 202 }));
    const req = slackRequest(event);
    await slackEvents(req.clone());
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Headers;
    expect(init.body).toBe(JSON.stringify(event));
    expect(headers.get("x-slack-signature")).toBe(req.headers.get("x-slack-signature"));
    expect(headers.get("x-slack-request-timestamp")).toBe(req.headers.get("x-slack-request-timestamp"));
  });

  it("ignores other channels and answers the URL check", async () => {
    const other = { ...event, event_id: "Ev9", event: { ...event.event, channel: "C_OTHER" } };
    expect((await slackEvents(slackRequest(other))).status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    const res = await slackEvents(slackRequest({ type: "url_verification", challenge: "abc" }));
    expect(await res.json()).toEqual({ challenge: "abc" });
  });

  it("rejects a bad signature", async () => {
    const req = new Request("https://site.netlify.app/slack/events", {
      method: "POST",
      body: "{}",
      headers: { "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)), "x-slack-signature": "v0=bad" },
    });
    expect((await slackEvents(req)).status).toBe(401);
  });
});
