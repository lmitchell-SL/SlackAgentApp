import { describe, expect, it } from "vitest";
import { formatAgentList, isHelpRequest, matchAgent, normalize, stripMentions, unescapeSlack } from "../src/agentMatch";

const names = [
  "SL Partner Program Agent",
  "AETHON Ethics & Compliance Agent",
  "Legal Agent",
  "Contract Tracker Agent",
  "Chief of Staff Agent",
  "CFO Agent",
  "Accounting and Finance Manager",
  "Content Creation Agent",
  "Cold Outreach Agent",
  "Marketing Agent",
  "CRM Maintenance Agent",
];
const agents = names.map((name, i) => ({ id: `agent_${i}`, name }));

function m(text: string) {
  const r = matchAgent(text, agents);
  return r ? { name: r.agent.name, rest: r.rest } : null;
}

describe("normalize", () => {
  it("lowercases, strips punctuation and turns & into and", () => {
    expect(normalize("AETHON Ethics & Compliance Agent!")).toBe("aethon ethics and compliance agent");
  });
});

describe("matchAgent", () => {
  it.each([
    ["CFO Agent: what's our runway?", "CFO Agent", "what's our runway?"],
    ["CFO: what's our runway?", "CFO Agent", "what's our runway?"],
    ["cfo agent - what's our runway?", "CFO Agent", "what's our runway?"],
    ["CFO Agent, what's our runway?", "CFO Agent", "what's our runway?"],
    ["Legal: review this NDA", "Legal Agent", "review this NDA"],
    ["legal agent review this NDA", "Legal Agent", "review this NDA"],
    ["contract tracker: which contracts renew in May?", "Contract Tracker Agent", "which contracts renew in May?"],
    ["chief of staff, plan my week", "Chief of Staff Agent", "plan my week"],
    ["Chief of Staff Agent: plan my week", "Chief of Staff Agent", "plan my week"],
    ["accounting and finance manager close the books", "Accounting and Finance Manager", "close the books"],
    ["Accounting & Finance Manager: close the books", "Accounting and Finance Manager", "close the books"],
    ["AETHON: is this ad compliant?", "AETHON Ethics & Compliance Agent", "is this ad compliant?"],
    ["aethon ethics & compliance agent: check this", "AETHON Ethics & Compliance Agent", "check this"],
    ["AETHON Ethics and Compliance: check this", "AETHON Ethics & Compliance Agent", "check this"],
    ["SL Partner Program: new partner list", "SL Partner Program Agent", "new partner list"],
    ["content creation agent: draft a post", "Content Creation Agent", "draft a post"],
    ["Cold outreach: 10 leads", "Cold Outreach Agent", "10 leads"],
    ["marketing - campaign ideas", "Marketing Agent", "campaign ideas"],
    ["CRM maintenance: dedupe contacts", "CRM Maintenance Agent", "dedupe contacts"],
    ["CRM: dedupe contacts", "CRM Maintenance Agent", "dedupe contacts"],
  ])("%s -> %s", (text, name, rest) => {
    expect(m(text)).toEqual({ name, rest });
  });

  it("returns an empty rest when only the name is given", () => {
    expect(m("CFO Agent")).toEqual({ name: "CFO Agent", rest: "" });
  });

  it("does not match a name in the middle of a word", () => {
    expect(m("CFOs are great")).toBeNull();
    expect(m("legalese please")).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(m("what's the weather?")).toBeNull();
    expect(m("")).toBeNull();
  });

  it("does not use first-word matching when it is ambiguous", () => {
    const more = [...agents, { id: "x", name: "Content Review Agent" }];
    expect(matchAgent("content: hello", more)).toBeNull();
    expect(matchAgent("content creation: hello", more)?.agent.name).toBe("Content Creation Agent");
  });

  it("prefers the longest matching name", () => {
    const overlap = [
      { id: "a", name: "Contract Agent" },
      { id: "b", name: "Contract Tracker Agent" },
    ];
    expect(matchAgent("contract tracker: status", overlap)?.agent.id).toBe("b");
    expect(matchAgent("contract: status", overlap)?.agent.id).toBe("a");
  });
});

describe("help and text cleanup", () => {
  it.each(["agents", "help", "list", "Help!", "  list agents ", ""])("%j is a help request", (t) => {
    expect(isHelpRequest(t)).toBe(true);
  });
  it("normal questions are not help requests", () => {
    expect(isHelpRequest("help me with runway")).toBe(false);
  });
  it("strips the bot mention and Slack escapes", () => {
    const raw = "<@U0BOT> AETHON Ethics &amp; Compliance Agent: is &lt;this&gt; ok?";
    const text = unescapeSlack(stripMentions(raw, "U0BOT"));
    expect(text).toBe("AETHON Ethics & Compliance Agent: is <this> ok?");
    expect(m(text)).toEqual({ name: "AETHON Ethics & Compliance Agent", rest: "is <this> ok?" });
  });
  it("lists every agent with an example", () => {
    const list = formatAgentList(agents);
    for (const n of names) expect(list).toContain(n);
    expect(list).toContain("@SL Agents CFO Agent:");
  });
});
