import type { LedgerEntry, UsageEvent } from "./types.js";
import { countedTokensForEntry } from "./tokenAccounting.js";

/** Replays replace Codex deltas; Claude fragments update one message, never add it twice. */
export function entryForLocalUsage(event: UsageEvent, deviceId: string, existing?: LedgerEntry): LedgerEntry {
  if (existing && (existing.syncedFromCloud || existing.source === "cloud-sync" || existing.source !== event.source)) {
    return existing;
  }
  if (existing && event.source !== "codex-session" && event.source !== "claude-session") return existing;
  const entry: LedgerEntry = {
    ...existing,
    id: event.id,
    createdAt: existing?.createdAt ?? event.createdAt,
    source: event.source,
    tokens: event.totalTokens,
    note: `${event.agent}${event.model ? ` · ${event.model}` : ""}`,
    agent: event.agent,
    provider: event.provider,
    model: event.model,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheReadTokens: event.cacheReadTokens,
    cacheWriteTokens: event.cacheWriteTokens,
    deviceId: existing?.deviceId ?? deviceId,
  };
  if (existing && event.source === "claude-session") {
    // A replay may encounter an early fragment after the final message was saved.
    for (const field of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
      entry[field] = Math.max(existing[field] ?? 0, entry[field] ?? 0);
    }
  }
  entry.tokens = countedTokensForEntry(entry);
  if (existing && ["tokens", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"].some(
    (field) => entry[field as keyof LedgerEntry] !== existing[field as keyof LedgerEntry],
  )) delete entry.eventFingerprint;
  if (existing && Object.keys(entry).every((key) => entry[key as keyof LedgerEntry] === existing[key as keyof LedgerEntry])) {
    return existing;
  }
  return entry;
}

/** Keep history sorted even when old files are replayed while live events arrive. */
export function upsertUsageEntries(entries: LedgerEntry[], updates: LedgerEntry[]): LedgerEntry[] {
  const updatesById = new Map(updates.map((entry) => [entry.id, entry]));
  const incoming = [...updatesById.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const merged: LedgerEntry[] = [];
  let index = 0;
  for (const entry of entries) {
    if (updatesById.has(entry.id)) continue;
    while (index < incoming.length && Date.parse(incoming[index].createdAt) >= Date.parse(entry.createdAt)) {
      merged.push(incoming[index++]);
    }
    merged.push(entry);
  }
  return merged.concat(incoming.slice(index));
}
