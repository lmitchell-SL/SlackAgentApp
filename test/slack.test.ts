import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { neutralizeSpecialMentions, postMarkdown } from "../src/slack";

describe("neutralizeSpecialMentions", () => {
  it.each([
    ["<!channel>", "&lt;!channel&gt;"],
    ["<!here>", "&lt;!here&gt;"],
    ["<!everyone>", "&lt;!everyone&gt;"],
    ["<!here|here>", "&lt;!here|here&gt;"],
    ["<!subteam^S0123ABC>", "&lt;!subteam^S0123ABC&gt;"],
    ["<!subteam^S0123ABC|@finance>", "&lt;!subteam^S0123ABC|@finance&gt;"],
    ["<!CHANNEL>", "&lt;!CHANNEL&gt;"],
  ])("%s is shown as text", (input, expected) => {
    expect(neutralizeSpecialMentions(`Heads up ${input} please`)).toBe(`Heads up ${expected} please`);
  });

  it("leaves markdown and other text untouched", () => {
    const md = "**Runway:** 14 months & rising\n> quoted\n<https://example.com|link> `a < b` <@U123>";
    expect(neutralizeSpecialMentions(md)).toBe(md);
  });
});

describe("postMarkdown", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    fetchMock = vi.fn(async () => Response.json({ ok: true, ts: "1.1" }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("neutralizes special mentions in both the markdown block and the fallback text", async () => {
    await postMarkdown("C1", "1.0", "Team <!channel> and <!subteam^S1|@ops>: **done** & > ok");
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    const block = body.blocks[0];
    expect(block.type).toBe("markdown");
    expect(block.text).toBe("Team &lt;!channel&gt; and &lt;!subteam^S1|@ops&gt;: **done** & > ok");
    expect(block.text).not.toMatch(/<!/);
    expect(body.text).not.toMatch(/<!/);
  });
});
