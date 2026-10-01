// State kept in Netlify Blobs (a simple key-value store that Netlify hosts for the site).
// Everything goes through the small KV interface so tests can use an in-memory copy.

import { randomUUID } from "node:crypto";
import { getStore } from "@netlify/blobs";

export interface KV {
  get<T>(key: string): Promise<{ value: T; etag?: string } | null>;
  /** onlyIfNew: write only when the key does not exist. onlyIfMatch: write only when etag matches. */
  set(key: string, value: unknown, opts?: { onlyIfNew?: boolean; onlyIfMatch?: string }): Promise<boolean>;
  delete(key: string): Promise<void>;
}

export class BlobsKV implements KV {
  private store = getStore({ name: "slack-agent-bridge", consistency: "strong" });

  async get<T>(key: string) {
    const res = await this.store.getWithMetadata(key, { type: "json" });
    if (!res) return null;
    return { value: res.data as T, etag: res.etag };
  }

  async set(key: string, value: unknown, opts?: { onlyIfNew?: boolean; onlyIfMatch?: string }) {
    const options = opts?.onlyIfNew
      ? { onlyIfNew: true as const }
      : opts?.onlyIfMatch
        ? { onlyIfMatch: opts.onlyIfMatch }
        : undefined;
    const res = await this.store.setJSON(key, value, options);
    return res.modified;
  }

  async delete(key: string) {
    await this.store.delete(key);
  }
}

export class MemoryKV implements KV {
  private data = new Map<string, { value: string; etag: string }>();
  private n = 0;

  async get<T>(key: string) {
    const hit = this.data.get(key);
    return hit ? { value: JSON.parse(hit.value) as T, etag: hit.etag } : null;
  }

  async set(key: string, value: unknown, opts?: { onlyIfNew?: boolean; onlyIfMatch?: string }) {
    const hit = this.data.get(key);
    if (opts?.onlyIfNew && hit) return false;
    if (opts?.onlyIfMatch && (!hit || hit.etag !== opts.onlyIfMatch)) return false;
    this.data.set(key, { value: JSON.stringify(value), etag: `e${++this.n}` });
    return true;
  }

  async delete(key: string) {
    this.data.delete(key);
  }
}

let defaultKV: KV | null = null;
export function kv(): KV {
  if (!defaultKV) defaultKV = new BlobsKV();
  return defaultKV;
}
export function setKV(k: KV) {
  defaultKV = k;
}

// ---- Records ---------------------------------------------------------------

export interface ThreadRecord {
  sessionId: string;
  agentId: string;
  agentName: string;
}

export interface SessionRecord {
  channel: string;
  thread_ts: string;
  agentName?: string;
  postedEventIds: string[];
}

/** Keep the posted-id list from growing forever; claims (below) are the real guard. */
const MAX_POSTED_IDS = 500;

const keys = {
  thread: (channel: string, threadTs: string) => `thread/${channel}:${threadTs}`,
  session: (sessionId: string) => `session/${sessionId}`,
  claim: (scope: string, id: string) => `claim/${scope}/${id}`,
};

export function threadKey(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`;
}

export async function getThread(channel: string, threadTs: string, store = kv()) {
  return (await store.get<ThreadRecord>(keys.thread(channel, threadTs)))?.value ?? null;
}

export async function saveThread(channel: string, threadTs: string, rec: ThreadRecord, store = kv()) {
  await store.set(keys.thread(channel, threadTs), rec);
}

export async function getSessionRecord(sessionId: string, store = kv()) {
  return (await store.get<SessionRecord>(keys.session(sessionId)))?.value ?? null;
}

export async function saveSessionRecord(sessionId: string, rec: SessionRecord, store = kv()) {
  await store.set(keys.session(sessionId), rec);
}

/** Appends ids to postedEventIds with a compare-and-swap retry loop. */
export async function addPostedEventIds(sessionId: string, ids: string[], fallback: SessionRecord, store = kv()) {
  if (ids.length === 0) return;
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await store.get<SessionRecord>(keys.session(sessionId));
    const base = cur?.value ?? fallback;
    const merged = Array.from(new Set([...(base.postedEventIds ?? []), ...ids])).slice(-MAX_POSTED_IDS);
    const next: SessionRecord = { ...base, postedEventIds: merged };
    const ok = cur
      ? await store.set(keys.session(sessionId), next, cur.etag ? { onlyIfMatch: cur.etag } : undefined)
      : await store.set(keys.session(sessionId), next, { onlyIfNew: true });
    if (ok) return;
  }
  console.warn(`Could not update postedEventIds for ${sessionId} after retries`);
}

/**
 * Atomically claims a one-time action (posting a message, handling an event id, ...).
 * Returns true only for the first caller; everyone else gets false.
 */
export async function claim(scope: string, id: string, store = kv()): Promise<boolean> {
  return store.set(keys.claim(scope, id), { at: new Date().toISOString() }, { onlyIfNew: true });
}

/** True when the id has already been claimed (handled). */
export async function isClaimed(scope: string, id: string, store = kv()): Promise<boolean> {
  return (await store.get(keys.claim(scope, id))) !== null;
}

export async function releaseClaim(scope: string, id: string, store = kv()): Promise<void> {
  await store.delete(keys.claim(scope, id));
}

/**
 * Runs fn once per (scope, id). If fn throws, the claim is released so a later run can
 * retry. Returns false when another run already claimed it.
 */
export async function runOnce(scope: string, id: string, fn: () => Promise<void>, store = kv()): Promise<boolean> {
  if (!(await claim(scope, id, store))) return false;
  try {
    await fn();
  } catch (err) {
    await releaseClaim(scope, id, store);
    throw err;
  }
  return true;
}

// ---- Locks with expiry ---------------------------------------------------------

interface LockValue {
  until: number;
  token: string;
}

/**
 * Takes a lock that expires after ttlMs (so a crashed function can't hold it forever).
 * Returns a release function, or null when someone else holds a live lock.
 */
export async function tryLock(name: string, ttlMs: number, store = kv()): Promise<(() => Promise<void>) | null> {
  const key = `lock/${name}`;
  const now = Date.now();
  const mine: LockValue = { until: now + ttlMs, token: randomUUID() };
  const cur = await store.get<LockValue>(key);
  let got: boolean;
  if (!cur) got = await store.set(key, mine, { onlyIfNew: true });
  else if (cur.value.until < now && cur.etag) got = await store.set(key, mine, { onlyIfMatch: cur.etag });
  else got = false;
  if (!got) return null;
  return async () => {
    const held = await store.get<LockValue>(key);
    if (held?.value.token === mine.token) await store.delete(key);
  };
}

/** Runs fn while holding the lock, waiting (polling) up to waitMs for it. */
export async function withLock<T>(
  name: string,
  fn: () => Promise<T>,
  opts: { ttlMs?: number; waitMs?: number; pollMs?: number } = {},
  store = kv(),
): Promise<T> {
  const { ttlMs = 5 * 60_000, waitMs = 2 * 60_000, pollMs = 1000 } = opts;
  const deadline = Date.now() + waitMs;
  let release = await tryLock(name, ttlMs, store);
  while (!release) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for lock ${name}`);
    await new Promise((r) => setTimeout(r, pollMs));
    release = await tryLock(name, ttlMs, store);
  }
  try {
    return await fn();
  } finally {
    await release();
  }
}

// ---- Small caches ------------------------------------------------------------

interface Cached<T> {
  at: number;
  value: T;
}

export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>, store = kv()): Promise<T> {
  const hit = await store.get<Cached<T>>(`cache/${key}`);
  if (hit && Date.now() - hit.value.at < ttlMs) return hit.value.value;
  const value = await load();
  await store.set(`cache/${key}`, { at: Date.now(), value } satisfies Cached<T>);
  return value;
}
