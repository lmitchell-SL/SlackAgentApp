// Splits long markdown into pieces that fit in one Slack `markdown` block.
// Slack's markdown block allows 12,000 characters; we stay well under it.

export const MARKDOWN_BLOCK_LIMIT = 12_000;
export const DEFAULT_CHUNK_SIZE = 11_000;

const FENCE_RE = /^\s*(```|~~~)/;

function fenceMarker(fenceLine: string): string {
  return fenceLine.startsWith("~~~") ? "~~~" : "```";
}

/**
 * Greedy split on line boundaries. Prefers to break at blank lines, never splits a
 * line unless the line alone is too long, and keeps code fences balanced: if a chunk
 * ends inside a ``` block, the block is closed and reopened in the next chunk.
 */
export function chunkMarkdown(text: string, max = DEFAULT_CHUNK_SIZE): string[] {
  if (max < 20) throw new Error("chunk size too small");
  const trimmed = text.replace(/\s+$/u, "");
  if (trimmed.length <= max) return trimmed.length ? [trimmed] : [];

  const lines = trimmed.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;
  let openFence: string | null = null; // the fence line that opened the current code block

  const closeLen = () => (openFence ? 4 : 0); // "\n```"

  const flush = () => {
    if (current.length === 0) return;
    let body = current.join("\n");
    if (openFence) body += "\n" + fenceMarker(openFence);
    if (body.trim()) chunks.push(body);
    current = openFence ? [openFence] : [];
    currentLen = openFence ? openFence.length : 0;
  };

  const pushLine = (line: string) => {
    const add = (current.length ? 1 : 0) + line.length;
    if (currentLen + add + closeLen() > max && current.length) {
      // Prefer breaking at the last blank line in this chunk if it is not too far back.
      const lastBlank = openFence ? -1 : current.lastIndexOf("");
      if (lastBlank > 0 && lastBlank > current.length / 2) {
        const carry = current.slice(lastBlank + 1);
        current = current.slice(0, lastBlank);
        flush();
        current = carry;
        currentLen = carry.join("\n").length;
        // The carried lines plus this line may still be too long: then flush them on their own.
        if (current.length && currentLen + 1 + line.length + closeLen() > max) flush();
      } else {
        flush();
      }
    }
    current.push(line);
    currentLen += (current.length > 1 ? 1 : 0) + line.length;
  };

  for (const line of lines) {
    const fenceMatch = FENCE_RE.exec(line);
    // A single line longer than the limit is hard-split.
    const room = max - 8 - (openFence ? openFence.length + 1 : 0);
    if (line.length > room) {
      for (let i = 0; i < line.length; i += room) pushLine(line.slice(i, i + room));
    } else {
      pushLine(line);
    }
    if (fenceMatch) openFence = openFence ? null : line.trim();
  }
  if (current.length) {
    const body = current.join("\n");
    if (body.trim() && !(openFence && body.trim() === openFence)) chunks.push(body);
  }
  return chunks;
}

/** Short plain-text fallback for notifications (Slack shows it where blocks cannot render). */
export function plainFallback(text: string, max = 3000): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}
