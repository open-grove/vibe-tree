import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { scanCodexSessionFile } from "../dist/electron/codexSessionWatcher.js";
import { scanAgentSessionFile, parseClaudeLine } from "../dist/electron/agentSessionWatchers.js";
import { entryForLocalUsage } from "../dist/shared/localUsageLedger.js";
import { countedTokensForEntry } from "../dist/shared/tokenAccounting.js";

function readJson(path, fallback) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
}
function filesUnder(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesUnder(path) : entry.isFile() && path.endsWith(".jsonl") ? [path] : [];
  }).sort();
}
const digest = (value) => createHash("sha256").update(value).digest("hex");
function assertAppStopped(userData) {
  // Electron's profile lock also covers dev builds/custom executable names.
  if (existsSync(join(userData, "SingletonLock"))) throw new Error("Quit the app using this profile before applying a repair.");
  const commands = execFileSync("ps", ["-axo", "command="], { encoding: "utf8" });
  if (commands.split("\n").some((line) => /\/Vibe Tree\.app\/Contents\/MacOS\/(?:Vibe Tree|Electron)(?:$|\s)/.test(line.trim()))) {
    throw new Error("Quit Vibe Tree before applying a repair (dry-run is safe while it is running).");
  }
}

/** Reuse the live parsers and stable IDs; keep every record whose source log is unavailable. */
export async function repairUsageAccounting({ userData, codexRoot = join(homedir(), ".codex", "sessions"), claudeRoot = join(homedir(), ".claude", "projects"), apply = false }) {
  userData = resolve(userData);
  if (apply) assertAppStopped(userData);
  const ledgerPath = join(userData, "usage-events.jsonl");
  const raw = readFileSync(ledgerPath, "utf8");
  if (raw && !raw.endsWith("\n")) throw new Error("Ledger has an unfinished record; refusing to rewrite it.");
  const entries = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  if (entries.some((entry) => !entry.id || !Number.isFinite(entry.tokens))) throw new Error("Invalid ledger entry; repair aborted.");
  const originalById = new Map(entries.map((entry) => [entry.id, entry]));
  const byId = new Map(originalById);
  const historyStartAt = readJson(join(userData, "usage-meta.json"), {}).installedAt;
  const historyStartAtMs = Date.parse(historyStartAt);
  if (!Number.isFinite(historyStartAtMs)) throw new Error("A valid usage-meta.json installedAt is required.");
  const deviceId = readJson(join(userData, "device-settings.json"), {}).cloudSyncDeviceId;
  if (!deviceId) throw new Error("The profile has no cloudSyncDeviceId; open Vibe Tree once before repairing.");
  const onUsage = (event) => {
    const previous = byId.get(event.id);
    byId.set(event.id, entryForLocalUsage(event, deviceId, previous));
  };
  let clampedCacheEntries = 0;
  for (const entry of byId.values()) {
    if (entry.syncedFromCloud || !["codex-session", "gemini-session"].includes(entry.source)) continue;
    if (entry.cacheReadTokens > entry.inputTokens && entry.inputTokens >= 0) {
      const corrected = { ...entry, cacheReadTokens: entry.inputTokens };
      corrected.tokens = countedTokensForEntry(corrected);
      delete corrected.eventFingerprint;
      byId.set(entry.id, corrected);
      clampedCacheEntries++;
    }
  }
  // Local fingerprints cache the old breakdown. Drop a stale cache after accounting repairs;
  // the application's normal load path regenerates it. Remote identities stay authoritative.
  for (const entry of byId.values()) {
    if (entry.syncedFromCloud || entry.source === "cloud-sync" || !entry.eventFingerprint?.startsWith("v1|")) continue;
    const expected = ["v1", entry.source, entry.createdAt, entry.tokens, entry.inputTokens ?? 0,
      entry.outputTokens ?? 0, entry.cacheReadTokens ?? 0, entry.cacheWriteTokens ?? 0].join("|");
    if (entry.eventFingerprint !== expected) {
      const corrected = { ...entry };
      delete corrected.eventFingerprint;
      byId.set(entry.id, corrected);
    }
  }
  const previousState = readJson(join(userData, "codex-session-watcher.json"), {});
  const identities = new Map();
  for (const path of Object.keys(previousState.files ?? {})) {
    const name = basename(path);
    const paths = identities.get(name) ?? new Set();
    if (!path.includes("archived_sessions")) paths.add(path);
    identities.set(name, paths);
  }
  const state = { files: {}, cumulativeTokens: {}, acceptedCumulativeKeys: {}, currentModels: {} };
  const activeFiles = filesUnder(codexRoot);
  const activeNames = new Set(activeFiles.map((path) => basename(path)));
  const archivedFiles = filesUnder(join(dirname(codexRoot), "archived_sessions"));
  let codexFiles = 0;
  let skippedArchives = 0;
  for (const path of [...activeFiles, ...archivedFiles]) {
    const archived = archivedFiles.includes(path);
    if (archived && activeNames.has(basename(path))) continue;
    const known = identities.get(basename(path));
    if (archived && known?.size !== 1) { skippedArchives++; continue; }
    const identityPath = archived ? [...known][0] : path;
    state.files[path] = 0;
    await scanCodexSessionFile(path, state, "", { userDataPath: userData, historyStartAt, onUsage }, {
      importHistory: true, watcherStartedAt: Date.now(), historyStartAtMs, sessionsRoot: codexRoot,
      identityPath, includeArchived: true,
    });
    codexFiles++;
  }
  const claudeState = { files: {}, events: {}, sessions: {} };
  const claudeFiles = filesUnder(claudeRoot);
  for (const path of claudeFiles) {
    claudeState.files[path] = 0;
    scanAgentSessionFile(path, claudeState, { parseLine: parseClaudeLine }, {
      importHistory: true, watcherStartedAt: Date.now(), historyStartAtMs,
    }, onUsage);
  }
  const result = [...byId.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const changes = {};
  for (const entry of result) {
    const previous = originalById.get(entry.id);
    if (JSON.stringify(previous) === JSON.stringify(entry)) continue;
    const counts = changes[entry.source] ??= { added: 0, updated: 0 };
    counts[previous ? "updated" : "added"]++;
  }
  const report = {
    applied: false, codexFiles, claudeFiles: claudeFiles.length, skippedArchives, clampedCacheEntries, changes,
    entriesBefore: originalById.size, entriesAfter: result.length,
    storedTokensBefore: [...originalById.values()].reduce((sum, entry) => sum + entry.tokens, 0),
    countedTokensBefore: [...originalById.values()].reduce((sum, entry) => sum + countedTokensForEntry(entry), 0),
    countedTokensAfter: result.reduce((sum, entry) => sum + countedTokensForEntry(entry), 0),
  };
  if (apply && Object.keys(changes).length) {
    assertAppStopped(userData);
    if (digest(readFileSync(ledgerPath)) !== digest(raw)) throw new Error("Ledger changed during replay; quit Vibe Tree and retry.");
    const backup = join(userData, "accounting-backups", new Date().toISOString().replace(/[:.]/g, "-"));
    mkdirSync(backup, { recursive: true, mode: 0o700 });
    for (const name of ["usage-events.jsonl", "usage-events.cache-v1", "usage-meta.json", "device-settings.json", "codex-session-watcher.json", "claude-session-watcher.json"]) {
      const source = join(userData, name);
      if (existsSync(source)) {
        copyFileSync(source, join(backup, name));
        chmodSync(join(backup, name), 0o600);
      }
    }
    const temp = `${ledgerPath}.repair-${process.pid}.tmp`;
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, result.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temp, ledgerPath);
    rmSync(join(userData, "usage-events.cache-v1"), { force: true });
    report.applied = true;
    report.backup = backup;
    writeFileSync(join(backup, "repair-report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--apply") { options.apply = true; continue; }
    const field = { "--user-data": "userData", "--codex-root": "codexRoot", "--claude-root": "claudeRoot" }[key];
    if (!field || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`Invalid argument: ${key}`);
    options[field] = args[++i];
  }
  if (!options.userData) throw new Error("Usage: node scripts/repair-usage-accounting.mjs --user-data PATH [--apply]");
  console.log(JSON.stringify(await repairUsageAccounting(options), null, 2));
}
