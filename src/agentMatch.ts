// Picks which agent a Slack message is addressed to, e.g. "CFO Agent: what's our runway?".

export interface AgentRef {
  id: string;
  name: string;
}

export interface AgentMatch {
  agent: AgentRef;
  /** The rest of the message after the agent name, with leading ":", ",", "-" removed. */
  rest: string;
}

interface Token {
  value: string;
  end: number;
}

/** Slack escapes &, < and > in message text. Undo that. */
export function unescapeSlack(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** Removes user mentions like <@U123> (all of them, or only the given bot's). */
export function stripMentions(text: string, botUserId?: string): string {
  const re = botUserId ? new RegExp(`<@${botUserId}(\\|[^>]*)?>`, "g") : /<@[A-Z0-9]+(\|[^>]*)?>/g;
  return text.replace(re, " ").replace(/\s+/g, " ").trim();
}

/** Splits text into lowercase word tokens. "&" counts as the word "and". */
function tokenize(text: string): Token[] {
  const out: Token[] = [];
  const re = /[\p{L}\p{N}]+|&/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    out.push({ value: raw === "&" ? "and" : raw.toLowerCase(), end: m.index + raw.length });
  }
  return out;
}

/** Lowercase, no punctuation, single spaces. "AETHON Ethics & Compliance" -> "aethon ethics and compliance". */
export function normalize(text: string): string {
  return tokenize(text)
    .map((t) => t.value)
    .join(" ");
}

/** Token lists a name can be written as: the full name, and without a trailing "agent". */
function nameVariants(name: string): string[][] {
  const words = tokenize(name).map((t) => t.value);
  const variants = [words];
  if (words.length > 1 && words[words.length - 1] === "agent") variants.push(words.slice(0, -1));
  return variants;
}

function startsWith(tokens: Token[], words: string[]): boolean {
  if (words.length === 0 || tokens.length < words.length) return false;
  return words.every((w, i) => tokens[i]!.value === w);
}

function restAfter(text: string, tokens: Token[], count: number): string {
  // An optional "agent" word right after the name ("Legal agent: ...") is also consumed.
  let n = count;
  if (tokens[n]?.value === "agent") n += 1;
  const cut = tokens[n - 1]!.end;
  return text
    .slice(cut)
    .replace(/^[\s:,;.\-–—>|]+/u, "")
    .trim();
}

const HELP_WORDS = new Set(["", "help", "agents", "list", "list agents", "agents list", "agent list", "show agents"]);

export function isHelpRequest(text: string): boolean {
  return HELP_WORDS.has(normalize(text));
}

/**
 * Finds the agent whose name starts the message. Rules:
 * - Case and punctuation do not matter; a trailing word "agent" in the name is optional.
 * - The longest matching name wins ("Contract Tracker Agent" beats a shorter overlapping name).
 * - Fallback: if the first word equals the first word of exactly one agent's name, use it
 *   ("AETHON: ..." -> "AETHON Ethics & Compliance Agent").
 */
export function matchAgent(text: string, agents: AgentRef[]): AgentMatch | null {
  const clean = text.trim();
  const tokens = tokenize(clean);
  if (tokens.length === 0) return null;

  let best: { agent: AgentRef; count: number; chars: number } | null = null;
  for (const agent of agents) {
    for (const words of nameVariants(agent.name)) {
      if (!startsWith(tokens, words)) continue;
      const chars = words.join(" ").length;
      if (!best || words.length > best.count || (words.length === best.count && chars > best.chars)) {
        best = { agent, count: words.length, chars };
      }
    }
  }
  if (best) return { agent: best.agent, rest: restAfter(clean, tokens, best.count) };

  const first = tokens[0]!.value;
  const candidates = agents.filter((a) => nameVariants(a.name)[0]![0] === first);
  if (candidates.length === 1 && first !== "agent") {
    return { agent: candidates[0]!, rest: restAfter(clean, tokens, 1) };
  }
  return null;
}

export function formatAgentList(agents: AgentRef[]): string {
  const names = [...agents].sort((a, b) => a.name.localeCompare(b.name)).map((a) => `• ${a.name}`);
  const example = agents.find((a) => /cfo/i.test(a.name))?.name ?? agents[0]?.name ?? "CFO Agent";
  return [
    "*Agents you can talk to:*",
    ...names,
    "",
    `Start a message with the agent's name, for example:`,
    `\`@SL Agents ${example}: what's our runway?\``,
    "Then keep chatting in the thread. Say `stop` in the thread to interrupt the agent.",
  ].join("\n");
}
