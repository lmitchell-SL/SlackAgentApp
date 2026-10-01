# Setup guide (no coding needed)

This guide connects four things: **GitHub** (where the code is stored), **Netlify** (which runs the
code), **Slack** (where your team chats), and the **Claude Console** (where your agents live).

It takes about 30 minutes. Keep a notes file open. You will copy a few values into it as you go.
Treat those values like passwords. Do not paste them in Slack or email.

---

## Step A. Create the Netlify site

Netlify is the service that runs this app on the internet.

1. Go to <https://app.netlify.com> and log in.
2. Click **Add new project** (it may say **Add new site**), then **Import an existing project**.
3. Click **GitHub**. If asked, allow Netlify to see your GitHub account.
4. Pick the repository **lmitchell-SL/SlackAgentApp**.
5. Leave all the build settings as they are. Click **Deploy**.
6. Wait for the deploy to finish (a minute or two). The status turns green and says **Published**.
7. At the top of the page you will see the site address, like `https://something-1234.netlify.app`.
   Copy it into your notes as **SITE URL**.
   - Optional: to get a nicer name, go to **Site configuration → Change site name**.
     Then copy the new address instead.

In the rest of this guide, `YOUR-SITE` means the first part of that address
(for `https://sl-agents.netlify.app`, `YOUR-SITE` is `sl-agents`).

---

## Step B. Create the Slack app

A Slack "app" is how a bot joins your workspace. The file `slack-app-manifest.yml` describes it.
A manifest is a settings file that Slack reads, so you do not have to click each setting.

1. Go to <https://api.slack.com/apps> and click **Create New App**.
2. Choose **From a manifest**.
3. Pick your Slack workspace. Click **Next**.
4. Choose the **YAML** tab. Delete what is in the box.
5. Open `slack-app-manifest.yml` from the GitHub repository, copy all of it, and paste it in the box.
6. In the pasted text, replace **both** places that say `YOUR-SITE` with your site name from Step A.
   They should look like `https://sl-agents.netlify.app/slack/events` and
   `https://sl-agents.netlify.app/slack/interactive`.
7. Click **Next**, then **Create**.
8. On the left, click **Install App**, then **Install to Workspace**, then **Allow**.
9. Copy the **Bot User OAuth Token** (it starts with `xoxb-`). Save it in your notes as **SLACK_BOT_TOKEN**.
10. On the left, click **Basic Information**. Under **App Credentials**, find **Signing Secret**.
    Click **Show**, copy it, and save it as **SLACK_SIGNING_SECRET**.
11. Open Slack and go to the channel the team will use. Type `/invite @SL Agents` and press Enter.
12. Find the channel ID: click the channel name at the top, then scroll to the bottom of the
    **About** tab. It looks like `C0C6T53G5J4`. Save it as **ALLOWED_CHANNEL_IDS**.

> Slack may show a warning that the **Request URL** did not verify. That is normal right now,
> because the app does not have its keys yet. You will fix it in Step E.

---

## Step C. Create an Anthropic API key

An API key is a password that lets this app talk to Claude on your behalf.

1. Go to <https://platform.claude.com> and log in.
2. Make sure the workspace picker (top left) shows **Default**. That is where your agents are.
3. Go to **Settings → API keys** (it may be under **Manage**).
4. Click **Create key**. Name it `slack-bridge`. Choose the **Default** workspace.
5. Copy the key (it starts with `sk-ant-`). You only see it once. Save it as **ANTHROPIC_API_KEY**.

---

## Step D. Register the Console webhook

A webhook is a message the Console sends to the app when something happens, for example
"the agent finished replying". This is how answers get back to Slack.

1. In the Console, go to **Manage → Webhooks**.
2. Click **Add endpoint** (or **Create webhook**).
3. For the URL, enter your SITE URL followed by `/anthropic-webhook`.
   Example: `https://sl-agents.netlify.app/anthropic-webhook`.
4. Under event types, tick exactly these two:
   - `session.status_idled`
   - `session.status_terminated`
5. Click **Create** (or **Save**).
6. The Console shows a **signing secret** that starts with `whsec_`. It is shown **only once**.
   Copy it now and save it as **ANTHROPIC_WEBHOOK_SIGNING_KEY**.

---

## Step E. Add the keys to Netlify and redeploy

Environment variables are settings that Netlify gives to the app. They keep keys out of the code.

1. Go back to your site in Netlify.
2. Click **Site configuration → Environment variables**.
3. Click **Add a variable → Add a single variable**. Add each of these, one at a time.
   Paste the value from your notes. Leave the other options as they are.

   | Key | Value |
   | --- | --- |
   | `ANTHROPIC_API_KEY` | from Step C |
   | `ANTHROPIC_WEBHOOK_SIGNING_KEY` | from Step D (starts with `whsec_`) |
   | `SLACK_BOT_TOKEN` | from Step B (starts with `xoxb-`) |
   | `SLACK_SIGNING_SECRET` | from Step B |
   | `ALLOWED_CHANNEL_IDS` | from Step B, e.g. `C0C6T53G5J4` |

   Optional: add `APPROVER_USER_IDS` with the Slack member IDs of people allowed to press
   **Approve**. (In Slack, click a person → **⋮ More** → **Copy member ID**.) Separate several IDs
   with commas. If you leave it out, anyone in the channel can approve.
4. Click **Deploys** at the top, then **Trigger deploy → Deploy site**.
   Netlify only reads new variables on a fresh deploy.
5. Wait until the deploy says **Published**.
6. Go back to <https://api.slack.com/apps>, open **SL Agents**, click **Event Subscriptions**.
   If the Request URL shows a warning, click **Retry**. It should now say **Verified**.
   Click **Save Changes** if the button is active.

---

## Step F. Test it

1. In the channel, write: `@SL Agents agents`
   - You should get a reply in a thread listing all the agents.
2. Then write: `@SL Agents CFO Agent: hello`
   - Within a few seconds you should see **Working on it with CFO Agent…** and a Console link.
   - The agent's answer appears in the same thread when it is done.
3. Reply in that thread (no @mention needed) to keep the conversation going.

### If something does not work

- **No reply at all:** check that the app is in the channel (`/invite @SL Agents`), that the channel ID
  is in `ALLOWED_CHANNEL_IDS`, and that you redeployed after adding variables.
- **"Working on it" appears, but no answer:** check the Console webhook URL ends in
  `/anthropic-webhook`, both event types are ticked, and `ANTHROPIC_WEBHOOK_SIGNING_KEY` matches.
- **See error details:** in Netlify, open **Logs → Functions**, and pick the function
  (for example `slack-events-background` or `anthropic-webhook-background`).

### Good to know

- Anyone in the channel can use the agents, including the accounts the agents are connected to.
  Keep the channel to people you trust, and consider setting `APPROVER_USER_IDS`.
- Each new top-level message starts a new conversation. Use the thread to continue one.
