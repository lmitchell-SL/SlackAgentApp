// Passes a verified request to a background function (which may run up to 15 minutes).
// We forward the raw body plus the original signature headers, and the background
// function verifies them again. That way no extra shared secret is needed, and a
// direct call to the background URL without a valid signature is rejected.

export const SLACK_SIGNATURE_HEADERS = ["x-slack-signature", "x-slack-request-timestamp", "content-type"];
export const WEBHOOK_SIGNATURE_HEADERS = ["webhook-id", "webhook-timestamp", "webhook-signature", "content-type"];

export function backgroundUrl(req: Request, functionName: string): string {
  return `${new URL(req.url).origin}/.netlify/functions/${functionName}`;
}

export async function handOff(req: Request, rawBody: string, functionName: string, headerNames: string[]) {
  const headers = new Headers();
  for (const name of headerNames) {
    const v = req.headers.get(name);
    if (v !== null) headers.set(name, v);
  }
  // Netlify answers a background function call with 202 right away.
  const res = await fetch(backgroundUrl(req, functionName), { method: "POST", headers, body: rawBody });
  if (res.status >= 400) throw new Error(`Hand-off to ${functionName} failed with HTTP ${res.status}`);
}
