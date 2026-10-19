import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scanCodexSessionFile } from "../dist/electron/codexSessionWatcher.js";
import { scanAgentSessionFile, parseClaudeLine, __test as agents } from "../dist/electron/agentSessionWatchers.js";
import { countedTokensForEntry, countedTokenBreakdownForEntry } from "../dist/shared/tokenAccounting.js";
import { entryForLocalUsage, upsertUsageEntries } from "../dist/shared/localUsageLedger.js";
import { ledgerForRenderer } from "../dist/electron/rendererLedger.js";
import { repairUsageAccounting } from "./repair-usage-accounting.mjs";

const root = mkdtempSync(join(tmpdir(), "vibe-tree-accounting-"));
const at = "2026-10-10T12:00:00.000Z";
const historyStartAt = "2026-10-01T00:00:00.000Z";
const settings = { importHistory: true, historyStartAtMs: Date.parse(historyStartAt), watcherStartedAt: Date.parse(at), sessionsRoot: root };
const codexState = () => ({ files: {}, cumulativeTokens: {}, acceptedCumulativeKeys: {}, currentModels: {} });
const meta = (payload = {}) => ({ timestamp: at, type: "session_meta", payload });
const usage = (input, output = 0, cached = 0) => ({ input_tokens: input, output_tokens: output, cached_input_tokens: cached });
const token = (total, last = total, timestamp = at) => ({ timestamp, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: last, model: "test-model" } } });
const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
function write(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }
async function scan(path, state, overrides = {}) {
  const events = [];
  await scanCodexSessionFile(path, state, "", { userDataPath: root, onUsage: (event) => events.push(event) }, { ...settings, ...overrides });
  return events;
}
const claude = (id, output, stop = null, timestamp = at) => ({ timestamp, type: "assistant", message: { id, model: "claude-test", stop_reason: stop, usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 20 } } });
try {
  const normal = join(root, "normal.jsonl");
  write(normal, jsonl([meta(), token(usage(100, 10, 80)), token(usage(200, 20, 180), usage(100, 10, 100))]));
  const state = codexState();
  const normalEvents = await scan(normal, state);
  assert.deepEqual(normalEvents.map((event) => event.totalTokens), [110, 110], "count the first real API call");
  assert.equal((await scan(normal, state)).length, 0, "polling the same bytes must be idempotent");
  const replay = await scan(normal, codexState());
  assert.deepEqual(replay, normalEvents, "restart replay retains exact stable IDs and usage");

  const parent = join(root, "parent-id.jsonl");
  write(parent, jsonl([meta(), token(usage(1000000))]));
  const child = join(root, "child.jsonl");
  write(child, jsonl([meta({ forked_from_id: "parent-id", history_mode: "paginated" }), token(usage(100)), token(usage(200), usage(100))]));
  assert.deepEqual((await scan(child, codexState())).map((event) => event.totalTokens), [100, 100], "paginated child counters are independent of parent");
  const boundary = join(root, "boundary.jsonl");
  write(boundary, jsonl([meta(), token(usage(100), usage(100), "2026-09-30T23:59:00.000Z"), token(usage(160), usage(60))]));
  assert.deepEqual((await scan(boundary, codexState())).map((event) => event.totalTokens), [60], "pre-install usage is a baseline, never imported");

  const partial = join(root, "partial.jsonl");
  const firstLine = jsonl([meta(), token(usage(100))]);
  const secondLine = JSON.stringify({ ...token(usage(200), usage(100)), text: "树🌳" }) + "\r\n";
  const secondBytes = Buffer.from(secondLine);
  const split = secondBytes.indexOf(Buffer.from("🌳")) + 2;
  write(partial, Buffer.concat([Buffer.from(firstLine), secondBytes.subarray(0, split)]));
  let partialState = codexState();
  assert.equal((await scan(partial, partialState)).length, 1);
  assert.equal(partialState.files[partial], Buffer.byteLength(firstLine), "never checkpoint half a record");
  partialState = JSON.parse(JSON.stringify(partialState));
  appendFileSync(partial, secondBytes.subarray(split));
  assert.deepEqual((await scan(partial, partialState)).map((event) => event.totalTokens), [100], "resume a split multibyte CRLF record across restart");

  const cacheChange = join(root, "cache-change.jsonl");
  write(cacheChange, jsonl([meta(), token(usage(100, 0, 0)), token(usage(110, 1, 100), usage(10, 1, 10))]));
  const cacheEvents = await scan(cacheChange, codexState());
  assert.equal(cacheEvents[1].cacheReadTokens, 10, "cache delta cannot exceed inclusive input delta");

  const cPath = join(root, "claude.jsonl");
  const cBytes = Buffer.from(jsonl([claude("message", 4)]));
  write(cPath, cBytes.subarray(0, cBytes.length - 8));
  const cState = { files: { [cPath]: 0 }, events: {}, sessions: {} };
  const cEvents = [];
  const cScan = () => scanAgentSessionFile(cPath, cState, { parseLine: parseClaudeLine }, settings, (event) => cEvents.push(event));
  cScan(); assert.equal(cEvents.length, 0); assert.equal(cState.files[cPath], 0);
  appendFileSync(cPath, cBytes.subarray(cBytes.length - 8)); cScan();
  assert.equal(cEvents.length, 1, "interrupted response with reported usage is retained");
  const first = { ...entryForLocalUsage(cEvents[0], "device-test"), eventFingerprint: "old-breakdown" };
  const finalEvent = parseClaudeLine(JSON.stringify(claude("message", 100, "end_turn", "2026-10-10T12:01:00.000Z")), cPath, 0);
  const final = entryForLocalUsage(finalEvent, "device-test", first);
  assert.equal(final.eventFingerprint, undefined, "changed usage invalidates a cached cloud fingerprint");
  assert.equal(final.tokens, 130); assert.equal(final.createdAt, first.createdAt);
  assert.equal(entryForLocalUsage(cEvents[0], "device-test", final), final, "older fragments cannot decrease final usage");
  assert.equal(entryForLocalUsage(finalEvent, "device-test", final), final, "unchanged replay does not append a revision");
  assert.equal(upsertUsageEntries([first], [final]).length, 1);
  const old = { ...first, id: "old", createdAt: historyStartAt };
  assert.deepEqual(upsertUsageEntries([final], [old, final]).map((entry) => entry.id), [final.id, "old"], "historical replay preserves chronological ordering");

  assert.deepEqual(agents.hermesUsageSnapshot({ input_tokens: 10, output_tokens: 100, reasoning_tokens: 80, cache_read_tokens: 20 }), { inputTokens: 10, outputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 0 }, "Hermes output already contains reasoning");

  const oldHermes = { inputTokens: 10, outputTokens: 180, cacheReadTokens: 20, cacheWriteTokens: 0 };
  const hermesNow = agents.hermesUsageSnapshot({ input_tokens: 10, output_tokens: 100, reasoning_tokens: 80, cache_read_tokens: 20 });
  const rebasedHermes = agents.hermesPreviousSnapshot(hermesNow, oldHermes);
  assert.equal(rebasedHermes.outputTokens, 100);
  assert.equal(agents.hermesPreviousSnapshot({ ...hermesNow, outputTokens: 120 }, rebasedHermes, 1).outputTokens, 100, "after migration, the next 20 output tokens remain countable");

  const entries = [
    ...normalEvents.map((event) => entryForLocalUsage(event, "device-test")), final,
    { id: "gemini-session:one", createdAt: at, source: "gemini-session", tokens: 1100, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 800 },
    { id: "codex-session:cloud", createdAt: at, source: "cloud-sync", agent: "codex-desktop", tokens: 1500, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 800 },
    { id: "bare", createdAt: at, source: "codex-session", tokens: 55 },
    { id: "bad-cache", createdAt: at, source: "codex-session", tokens: 500, inputTokens: 10, outputTokens: 1, cacheReadTokens: 400 },
    { id: "live", createdAt: "2026-10-11T12:00:00Z", source: "codex-session", tokens: 100, inputTokens: 100, cacheReadTokens: 50 },
  ];
  const ledger = { entries, installedAt: historyStartAt, settings: {} };
  const sum = (list) => list.reduce((total, entry) => total + countedTokensForEntry(entry), 0);
  for (const view of ["pet", "menubar"]) {
    const compact = ledgerForRenderer(ledger, view, new Date("2026-10-11T12:01:00Z"));
    assert.equal(sum(compact.entries), sum(entries), `${view} downstream counting preserves cached and authoritative totals`);
    assert.equal(sum(ledgerForRenderer(compact, view, new Date("2026-10-11T12:01:00Z")).entries), sum(entries));
    const expectedBreakdown = entries.map(countedTokenBreakdownForEntry);
    const actualBreakdown = compact.entries.map(countedTokenBreakdownForEntry);
    for (const field of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]) {
      assert.equal(actualBreakdown.reduce((sum, item) => sum + item[field], 0), expectedBreakdown.reduce((sum, item) => sum + item[field], 0));
    }
  }
  assert.equal(countedTokensForEntry(entries[6]), 11, "malformed inclusive cache fields cannot inflate total");

  // Offline replay retains archive identities and unmappable historical entries.
  const data = join(root, "profile");
  const codexRoot = join(root, "recovery", "sessions");
  const originalPath = join(codexRoot, "2026", "10", "10", "archive.jsonl");
  const archivedPath = join(dirname(codexRoot), "archived_sessions", "archive.jsonl");
  write(originalPath, jsonl([meta(), token(usage(100)), token(usage(200), usage(100))]));
  const archiveEvents = await scan(originalPath, codexState());
  write(archivedPath, readFileSync(originalPath)); rmSync(originalPath);
  const existingArchiveEntry = entryForLocalUsage(archiveEvents[1], "device-test");
  const retained = { ...old, id: "missing-log", tokens: 7 };
  write(join(data, "usage-events.jsonl"), jsonl([existingArchiveEntry, retained]));
  write(join(data, "usage-meta.json"), JSON.stringify({ installedAt: historyStartAt }));
  write(join(data, "device-settings.json"), JSON.stringify({ cloudSyncDeviceId: "device-test" }));
  write(join(data, "codex-session-watcher.json"), JSON.stringify({ files: { [originalPath]: 1 } }));
  const options = { userData: data, codexRoot, claudeRoot: join(root, "absent-claude") };
  const before = readFileSync(join(data, "usage-events.jsonl"), "utf8");
  const plan = await repairUsageAccounting(options);
  assert.equal(plan.changes["codex-session"].added, 1); assert.equal(plan.entriesAfter, 3);
  assert.equal(readFileSync(join(data, "usage-events.jsonl"), "utf8"), before, "dry-run is read-only");
  write(join(data, "usage-events.jsonl"), jsonl([existingArchiveEntry, retained, entryForLocalUsage(archiveEvents[0], "device-test")]));
  const again = await repairUsageAccounting(options);
  assert.deepEqual(again.changes, {}, "a second replay after repair has no changes");
  console.log("Usage accounting regressions passed (first events, fork modes, partial lines, revisions, cache, archives).");
} finally { rmSync(root, { recursive: true, force: true }); }
