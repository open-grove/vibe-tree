import type { LedgerEntry } from "./types.js";

export interface CountedTokenBreakdown {
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function countedTokensForEntry(entry: LedgerEntry) {
  if (entry.tokenAccounting === "normalized" || entry.source === "cloud-sync" || entry.syncedFromCloud) return safeTokens(entry.tokens);
  if (!hasTokenBreakdown(entry)) return safeTokens(entry.tokens);

  const inputTokens = countedInputTokensForEntry(entry);
  const outputTokens = safeTokens(entry.outputTokens ?? 0);
  const cacheReadTokens = countedCacheReadTokensForEntry(entry);
  const cacheWriteTokens = safeTokens(entry.cacheWriteTokens ?? 0);
  return inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
}

export function countedTokenBreakdownForEntry(entry: LedgerEntry): CountedTokenBreakdown {
  const tokens = countedTokensForEntry(entry);
  const inputTokens = countedInputTokensForEntry(entry);
  const outputTokens = safeTokens(entry.outputTokens ?? 0);
  const cacheReadTokens = countedCacheReadTokensForEntry(entry);
  const cacheWriteTokens = safeTokens(entry.cacheWriteTokens ?? 0);
  const breakdown = { tokens, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
  const breakdownTotal = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  if (!shouldNormalizeAuthoritativeBreakdown(entry, tokens, breakdownTotal)) return breakdown;
  return normalizeBreakdownToTotal(breakdown, tokens, breakdownTotal);
}

export function countedInputTokensForEntry(entry: LedgerEntry) {
  const inputTokens = safeTokens(entry.inputTokens ?? 0);
  const cacheReadTokens = countedCacheReadTokensForEntry(entry);
  return inputTokensIncludeCacheRead(entry) ? Math.max(0, inputTokens - cacheReadTokens) : inputTokens;
}

function countedCacheReadTokensForEntry(entry: LedgerEntry) {
  const cached = safeTokens(entry.cacheReadTokens ?? 0);
  return inputTokensIncludeCacheRead(entry) ? Math.min(safeTokens(entry.inputTokens ?? 0), cached) : cached;
}

function hasTokenBreakdown(entry: LedgerEntry) {
  return (
    entry.inputTokens !== undefined ||
    entry.outputTokens !== undefined ||
    entry.cacheReadTokens !== undefined ||
    entry.cacheWriteTokens !== undefined
  );
}

function inputTokensIncludeCacheRead(entry: LedgerEntry) {
  if (entry.tokenAccounting === "normalized") return false;
  return (
    entry.source === "codex-session" ||
    entry.agent === "codex-desktop" ||
    entry.source === "gemini-session" ||
    (entry.source === "cloud-sync" && (entry.id.startsWith("codex-session:") || entry.id.startsWith("gemini-session:")))
  );
}

function shouldNormalizeAuthoritativeBreakdown(entry: LedgerEntry, tokens: number, breakdownTotal: number) {
  if (tokens <= 0 || breakdownTotal <= 0) return false;
  if (entry.source !== "cloud-sync" && !entry.syncedFromCloud) return false;
  return Math.abs(breakdownTotal - tokens) > Math.max(1, Math.round(tokens * 0.01));
}

function normalizeBreakdownToTotal(
  breakdown: CountedTokenBreakdown,
  tokens: number,
  breakdownTotal: number,
): CountedTokenBreakdown {
  const parts = [
    breakdown.inputTokens,
    breakdown.outputTokens,
    breakdown.cacheReadTokens,
    breakdown.cacheWriteTokens,
  ].map((value) => {
    const exact = (value / breakdownTotal) * tokens;
    const floor = Math.floor(exact);
    return { floor, fraction: exact - floor };
  });
  let remaining = tokens - parts.reduce((total, part) => total + part.floor, 0);
  for (const part of [...parts].sort((left, right) => right.fraction - left.fraction)) {
    if (remaining <= 0) break;
    part.floor += 1;
    remaining -= 1;
  }
  return {
    tokens,
    inputTokens: parts[0]?.floor ?? 0,
    outputTokens: parts[1]?.floor ?? 0,
    cacheReadTokens: parts[2]?.floor ?? 0,
    cacheWriteTokens: parts[3]?.floor ?? 0,
  };
}

function safeTokens(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
