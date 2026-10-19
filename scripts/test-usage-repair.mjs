import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairUsageAccounting } from "./repair-usage-accounting.mjs";

// Run with Vibe Tree stopped. The same guard protects both fixture and real profiles.
const root = mkdtempSync(join(tmpdir(), "vibe-tree-repair-"));
try {
  const profile = join(root, "profile");
  const claudeRoot = join(root, "claude");
  mkdirSync(profile); mkdirSync(claudeRoot);
  const ledger = join(profile, "usage-events.jsonl");
  const original = JSON.stringify({ id: "keep-unavailable", createdAt: "2026-10-02T00:00:00Z", source: "manual", tokens: 42 }) + "\n";
  writeFileSync(ledger, original);
  writeFileSync(join(profile, "usage-events.cache-v1"), "old-cache");
  writeFileSync(join(profile, "usage-meta.json"), JSON.stringify({ installedAt: "2026-10-01T00:00:00Z" }));
  writeFileSync(join(profile, "device-settings.json"), JSON.stringify({ cloudSyncDeviceId: "device-test" }));
  writeFileSync(join(claudeRoot, "session.jsonl"), JSON.stringify({ type: "assistant", timestamp: "2026-10-02T01:00:00Z", message: { id: "partial", usage: { input_tokens: 10, output_tokens: 2 } } }) + "\n");
  const options = { userData: profile, claudeRoot, codexRoot: join(root, "sessions"), apply: true };
  const result = await repairUsageAccounting(options);
  assert.equal(result.applied, true); assert.equal(result.countedTokensAfter, 54);
  assert.equal(readFileSync(join(result.backup, "usage-events.jsonl"), "utf8"), original);
  assert.equal(statSync(join(result.backup, "usage-events.jsonl")).mode & 0o777, 0o600);
  assert.equal(existsSync(join(profile, "usage-events.cache-v1")), false, "invalidate the cached ledger after replacing its source");
  const repaired = readFileSync(ledger, "utf8");
  const again = await repairUsageAccounting(options);
  assert.equal(again.applied, false); assert.deepEqual(again.changes, {});
  assert.equal(readFileSync(ledger, "utf8"), repaired, "second apply is a byte-for-byte no-op");
  writeFileSync(join(profile, "SingletonLock"), "active");
  await assert.rejects(() => repairUsageAccounting(options), /Quit the app/);
  rmSync(join(profile, "SingletonLock"));
  writeFileSync(ledger, repaired + '{"id":');
  await assert.rejects(() => repairUsageAccounting(options), /unfinished record/);
  console.log("Offline repair passed: atomic replacement, private backup, cache invalidation, idempotence and active-profile guard.");
} finally { rmSync(root, { recursive: true, force: true }); }
