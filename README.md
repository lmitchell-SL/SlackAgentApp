# SL Agents: Slack bridge for Claude Managed Agents

This small app lets a team talk to the Claude Console "Managed Agents" from one Slack channel.
It runs on Netlify Functions (small pieces of server code that Netlify runs on demand).

New here and not a coder? Follow **[SETUP.md](SETUP.md)**. It walks you through every click.

Code: <https://github.com/lmitchell-SL/SlackAgentApp>

## What it does

- In the channel, write `@SL Agents CFO Agent: what's our runway?`.
  Short forms work too: `CFO: ...`, `cfo agent - ...`, `Legal: ...`, `chief of staff, ...`, `AETHON: ...`.
- The bridge starts a new agent **session** (one conversation with one agent) and replies in a thread
  with a link to watch it live in the Console.
- The agent's answers appear in that thread. Reply in the thread (no @mention needed) to keep talking.
- If the agent wants to use a tool that needs permission, the thread shows **Approve** / **Deny** buttons.
- In a thread, `stop` interrupts the agent. `new session` or `reset` tells you to start a new thread.
- `@SL Agents agents` (or `help`, `list`) shows every agent and an example, or only the paired agent in a locked channel.

## How it works (short)

```
Slack ──► /slack/events ──► slack-events-background ──► Anthropic API (create session / send message)
                                                                 │
Slack ◄── anthropic-webhook-background ◄── /anthropic-webhook ◄──┘  (Console webhook: session idled / terminated)
Slack ──► /slack/interactive ──► slack-interactive-background ──► Anthropic API (tool confirmation)
```

1. **`slack-events`** checks Slack's signature, answers Slack's URL check, checks the channel is
   allowed, skips event ids it already handled, then hands the raw request to a
   **background function** and answers Slack within 3 seconds. Background functions are named
   `*-background` and can run for up to 15 minutes. An event id is marked as handled only after the
   hand-off works; if the hand-off fails, Slack gets an error and retries (retries are processed
   like first deliveries).
2. **`slack-events-background`** checks the signature again, works out which agent you meant
   (the agent list is read live from the API and cached for 5 minutes), and creates a session.
   The session's environment and vaults come from, in order: `AGENT_SETTINGS` for that agent,
   then that agent's most recent session, then `DEFAULT_ENVIRONMENT_ID` / `DEFAULT_VAULT_IDS`,
   then the first non-archived environment in the workspace. Every message to the agent starts with
   `[From <name> via Slack]` so the agent knows who is talking.
3. When the agent stops working, Anthropic calls **`anthropic-webhook`**. It checks the signature
   with the SDK's `client.beta.webhooks.unwrap`, drops duplicates, and hands off to
   **`anthropic-webhook-background`**, which reads the session's events and posts every new agent
   message (as Slack markdown, split if long), then any Approve / Deny buttons or status notes.
   A session that ends normally stays quiet; one that ends with an error gets a short note.
4. **`slack-interactive`** handles button clicks and sends the decision to the agent.

State (which thread belongs to which session, what was already posted) is kept in **Netlify Blobs**,
a key-value store that comes with every Netlify site. Nothing needs to be set up for it.

## Environment variables

Set these in Netlify (**Site configuration → Environment variables**). See `.env.example`.

| Name | Required | What it is |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Yes | API key from the Console workspace that holds your agents. |
| `ANTHROPIC_WEBHOOK_SIGNING_KEY` | Yes | The `whsec_...` secret shown once when you create the Console webhook. |
| `SLACK_BOT_TOKEN` | Yes | Slack "Bot User OAuth Token" (`xoxb-...`). |
| `SLACK_SIGNING_SECRET` | Yes | Slack app "Signing Secret". |
| `ALLOWED_CHANNEL_IDS` | Yes | Comma-separated channel IDs where the bot works, e.g. `C0EXAMPLE01`. Empty means the bot answers nowhere. |
| `CHANNEL_AGENTS` | No | Lock channels to one agent with semicolon-separated pairs, e.g. `C0EXAMPLE01=CFO Agent; C0EXAMPLE02=Chief of Staff`. Spaces are trimmed and full agent names ignore case. Channels must still be in `ALLOWED_CHANNEL_IDS`. Empty or missing leaves routing unchanged. |
| `DM_AGENTS` | No | Let people use the bot in a direct message, each with their own agents: `U0EXAMPLE01=CFO Agent, Legal Agent; U0EXAMPLE02=Marketing Agent`. Empty means the bot ignores DMs. See below. |
| `APPROVER_USER_IDS` | No | Comma-separated Slack user IDs allowed to press Approve / Deny. Empty means anyone in the channel. |
| `CONSOLE_WORKSPACE` | No | Console workspace ID used in session links. Empty means `default`. |
| `DEFAULT_ENVIRONMENT_ID` | No | Environment to use when an agent has no earlier session to copy from. |
| `DEFAULT_VAULT_IDS` | No | Comma-separated vault IDs to attach in that case. |
| `AGENT_SETTINGS` | No | JSON map: `{"agent_id": {"environment_id": "env_...", "vault_ids": ["vlt_..."]}}`. Takes priority over copying from the agent's last session. |

### Pair a channel with an agent

Set `CHANNEL_AGENTS` to pair each channel with one agent from the existing agent list.
In a paired channel, write `@SL Agents what's our runway?` without an agent name.
Naming the paired agent still works; naming a different agent gets a thread reply saying
the channel is set up for the paired agent only. `@SL Agents agents` lists only that agent.
Thread replies, `stop`, and Approve / Deny buttons work as before.
Channels not paired keep the usual agent-name routing, and pairing never grants channel access.
If the agent name does not exist, the bot asks an admin to check `CHANNEL_AGENTS` instead of starting a session.
Use full agent names, not message shortcuts such as `CFO`. For duplicate channel entries,
the first pairing wins and an error is logged. Malformed entries are logged without their values;
a recognizable channel with an empty or malformed agent value stays locked with a setup error.
All channel IDs shown here are made-up placeholders; replace them with your own in Netlify only.

### Direct messages

Set `DM_AGENTS` to let named people talk to agents in a direct message with the bot. Each entry
is a Slack user ID and the agents that person may use, in the same format as `CHANNEL_AGENTS`.
In a DM no @mention is needed: `CFO Agent: what's our runway?` starts a session and the bot
replies in a thread under that message, as in a channel. With exactly one agent, the name can be
left out. Naming an agent not on the list gets "In direct messages you can use ... only."
`agents` lists only that person's agents. People not in `DM_AGENTS` get a short note saying DMs
aren't set up for them; with `DM_AGENTS` empty, the bot ignores DMs entirely.
In a DM the person may approve or deny their own agent's tool requests even when they are not
in `APPROVER_USER_IDS`. Channel approvals are unchanged.
Slack needs the `im:history` scope and the `message.im` event, plus the Messages tab in App Home,
all included in `slack-app-manifest.yml`; after adding them, reinstall the app to the workspace.

## Security notes

- **Anyone in an allowed channel can drive the agents**, including their tools and any connected
  accounts (vaults: stored logins such as Gmail or HubSpot). Treat channel membership as access to
  the agents. Keep the channel private and small.
- A DM is private to one person, but that person has the same power over their listed agents.
  List only agents each person should be able to run on their own.
- Use `APPROVER_USER_IDS` so only named people can approve tool calls that need permission.
  Tools set to "always allow" on the agent run without asking, so review agent tool settings in the Console.
- Keys live only in Netlify environment variables. Never commit them. `.env` files are git-ignored.
- Every request is signature-checked: Slack requests with the signing secret (HMAC-SHA256,
  constant-time compare, max 5 minutes old) and Console webhooks with the SDK. The background
  functions re-check the forwarded signatures, so calling them directly does nothing.
- The bridge never creates, edits or archives agents. It only starts sessions for existing agents.
- Messages are posted to Slack, so anything an agent writes is visible to the whole channel.
- People listed in `DM_AGENTS` can also talk to their agents in a **direct message** with the bot,
  with no @mention: `CFO Agent: what's our runway?`. Only that person sees the conversation.

## Limits

- Each idle webhook re-reads the session's full event list, which is fine for normal chats but
  can get slow for very long sessions.
- Webhooks are not a durable log: if Anthropic gives up delivering one, replies from that turn
  appear only after the agent's next turn (or in the Console).
- The bridge can't run custom tools; it tells the agent so when one is called.

## Development

```sh
npm install
npm run typecheck
npm test
```

Code layout:

- `netlify/functions/*.mts` — the six functions (three public endpoints, three background workers).
- `src/slackVerify.ts` — Slack signature check.
- `src/agentMatch.ts` — agent-name matching and the help text.
- `src/sessionEvents.ts` — reads session events: new messages, pending approvals, stop reasons.
- `src/bridge.ts` — main flow (start session, follow-ups, webhook sync, button clicks).
- `src/anthropic.ts` — Anthropic SDK calls. `src/slack.ts` — Slack Web API via `fetch`.
- `src/store.ts` — Netlify Blobs state and one-time "claims" used for de-duplication.
- `src/chunk.ts` — splits long markdown under Slack's 12,000-character block limit.

Slack endpoints: `/slack/events` and `/slack/interactive`. Console webhook: `/anthropic-webhook`.
