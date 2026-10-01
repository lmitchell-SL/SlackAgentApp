// Pure helpers that read a session's event list and decide what the bridge should do.
// Types are a small structural subset of the SDK's BetaManagedAgentsSessionEvent union,
// so real SDK events fit and tests can build plain objects.

export interface MinimalEvent {
  id: string;
  type: string;
  processed_at?: string | null;
  [k: string]: unknown;
}

export interface AgentMessage {
  id: string;
  text: string;
}

export interface PendingToolCall {
  id: string;
  type: "agent.tool_use" | "agent.mcp_tool_use";
  name: string;
  server?: string;
  input: unknown;
}

export interface PendingCustomTool {
  id: string;
  name: string;
}

export type StopReason =
  | { type: "requires_action"; event_ids: string[] }
  | { type: "end_turn" | "retries_exhausted" | "budget_reached" | "refusal" | string };

/** Text of an agent.message (text blocks only; redacted blocks are skipped). */
export function messageText(ev: MinimalEvent): string {
  const content = Array.isArray(ev.content) ? (ev.content as Array<{ type?: string; text?: string }>) : [];
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n\n")
    .trim();
}

/**
 * agent.message events not yet posted to Slack, in the order the list gives them
 * (the SDK lists events oldest-first by default). Empty messages are skipped.
 */
export function selectNewAgentMessages(events: MinimalEvent[], postedIds: Iterable<string>): AgentMessage[] {
  const posted = new Set(postedIds);
  const out: AgentMessage[] = [];
  const seen = new Set<string>();
  for (const ev of events) {
    if (ev.type !== "agent.message" || posted.has(ev.id) || seen.has(ev.id)) continue;
    seen.add(ev.id);
    const text = messageText(ev);
    if (text) out.push({ id: ev.id, text });
  }
  return out;
}

export function latestIdle(events: MinimalEvent[]): { id: string; stop_reason: StopReason } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.type === "session.status_idle" && ev.stop_reason) {
      return { id: ev.id, stop_reason: ev.stop_reason as StopReason };
    }
  }
  return null;
}

/** True when the agent started running again after the latest idle (so nothing is pending). */
export function runningAfterLatestIdle(events: MinimalEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i]!.type;
    if (t === "session.status_idle") return false;
    if (t === "session.status_running") return true;
  }
  return false;
}

/**
 * Tool calls waiting for a Slack decision: agent.tool_use / agent.mcp_tool_use with
 * evaluated_permission === "ask" and no user.tool_confirmation for them yet.
 * When `onlyIds` is given (the idle event's stop_reason.event_ids), only those count.
 */
export function pendingToolConfirmations(events: MinimalEvent[], onlyIds?: string[]): PendingToolCall[] {
  const confirmed = new Set(
    events.filter((e) => e.type === "user.tool_confirmation").map((e) => String(e.tool_use_id)),
  );
  const filter = onlyIds && onlyIds.length ? new Set(onlyIds) : null;
  return events
    .filter(
      (e) =>
        (e.type === "agent.tool_use" || e.type === "agent.mcp_tool_use") &&
        e.evaluated_permission === "ask" &&
        !confirmed.has(e.id) &&
        (!filter || filter.has(e.id)),
    )
    .map((e) => ({
      id: e.id,
      type: e.type as PendingToolCall["type"],
      name: String(e.name ?? "tool"),
      server: typeof e.mcp_server_name === "string" ? e.mcp_server_name : undefined,
      input: e.input,
    }));
}

/** agent.custom_tool_use events with no user.custom_tool_result yet. */
export function pendingCustomTools(events: MinimalEvent[], onlyIds?: string[]): PendingCustomTool[] {
  const answered = new Set(
    events.filter((e) => e.type === "user.custom_tool_result").map((e) => String(e.custom_tool_use_id)),
  );
  const filter = onlyIds && onlyIds.length ? new Set(onlyIds) : null;
  return events
    .filter((e) => e.type === "agent.custom_tool_use" && !answered.has(e.id) && (!filter || filter.has(e.id)))
    .map((e) => ({ id: e.id, name: String(e.name ?? "custom tool") }));
}

/** Most recent session.error message, if any. */
export function latestErrorMessage(events: MinimalEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.type === "session.error") {
      const err = ev.error as { message?: string; type?: string } | undefined;
      return err?.message || err?.type || "unknown error";
    }
  }
  return null;
}

/** One-line preview of a tool's input for the approval message. */
export function previewInput(input: unknown, max = 300): string {
  let s: string;
  try {
    s = typeof input === "string" ? input : JSON.stringify(input);
  } catch {
    s = String(input);
  }
  s = (s ?? "").replace(/\s+/g, " ").replace(/```/g, "ˋˋˋ");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function stopReasonNote(reason: StopReason): string | null {
  switch (reason.type) {
    case "retries_exhausted":
      return ":warning: The agent stopped after repeated errors (retries exhausted). Check the session in the Console, or start a new thread.";
    case "budget_reached":
      return ":money_with_wings: This session reached its spending budget and is paused. Someone with Console access can raise or remove the budget to continue.";
    case "refusal":
      return ":no_entry: The agent declined to continue with this request.";
    default:
      return null;
  }
}
