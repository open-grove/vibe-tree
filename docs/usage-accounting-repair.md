# Usage accounting repair

The accounting fix preserves cache-inclusive input for Codex/Gemini source events, and marks IPC summaries as already normalized. Codex paginated forks use independent counters; older forks retain the parent-baseline behavior. Complete JSONL records are checkpointed at newline boundaries. Claude usage with positive output is retained even without a stop reason, and later fragments update the same message ID. Hermes reasoning is a subset of output and is not added again; WAL changes trigger scans.

On upgrade, the watchers replay available active logs inside the existing installation window. Repeated IDs update Codex deltas or Claude message usage rather than creating another event. Older Claude fragments cannot reduce a completed message's recorded usage. Unavailable historical logs and cloud-authoritative entries are preserved.

## Repair existing local history

Build first, then preview a profile explicitly:

```sh
npm ci
npm run build
npm run repair:usage-accounting -- --user-data "/path/to/Vibe Tree user data"
```

The default is read-only. Quit Vibe Tree, review the counts, then apply:

```sh
npm run repair:usage-accounting -- --user-data "/path/to/Vibe Tree user data" --apply
```

Optional `--codex-root` and `--claude-root` arguments select custom source directories. The defaults are `~/.codex/sessions` and `~/.claude/projects`. The adjacent `archived_sessions` directory is included only when the original path can be recovered unambiguously from the saved Codex watcher state; unknown archives are reported as skipped rather than assigned new IDs. Repair should run on the same machine and profile that collected the logs.

The script replays source events after `usage-meta.json`'s `installedAt`, replaces records by their stable ID, clamps impossible Codex/Gemini cache subsets, and retains records whose logs are missing. It refuses active macOS app bundles or a profile lock, checks that the ledger did not change during replay, writes a private backup under `accounting-backups/`, atomically replaces the ledger, and invalidates its binary cache. Keep the app closed until it finishes. A second run against unchanged logs must report no changes. On platforms without an Electron profile lock, also ensure no development instance is using the profile.

The report distinguishes stored token totals from totals recomputed using the corrected accounting rules. These can differ in old ledgers. Repair does not claim to reconstruct deleted source logs or provider billing; Hermes historical reasoning overcounts cannot be reliably reconstructed from its existing per-session delta ledger. This repair does not replay Hermes history. Older Hermes checkpoints are rebased once to the current output counter so an inflated checkpoint cannot suppress future output. Their missing reasoning component means output accumulated during that first transition cannot be reconstructed precisely; the script does not invent it.

To roll back with the app closed, restore `usage-events.jsonl` from the reported backup and remove `usage-events.cache-v1`. Restore the prior application and watcher-state backups as well if reverting to the older parser behavior.

## Validation

```sh
npm run typecheck
npm run build
node scripts/test-usage-accounting.mjs
node scripts/test-usage-repair.mjs  # app must be stopped
node scripts/test-codex-session-watcher.mjs
node scripts/verify-renderer-ledger.mjs
node scripts/verify-cloud-sync.mjs
npm run smoke:electron
```

Fixtures cover first calls, pre-install baselines, independent paginated children, older full-history forks, partial UTF-8/CRLF records across restart, Claude partial/final replay, malformed cache deltas, raw/compact/cloud total parity, archived identities, and an idempotent offline repair with backup and lock checks. No private source logs are included.
