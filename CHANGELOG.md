# Changelog

## 0.0.5-alpha.1 — 2026-07-29

- Pinned every command-process executable to the SHA-256 approved in the
  engine plan, reverified it before and after execution, and moved its cwd to
  an ignored per-engine directory outside the target project root.
- Extended Control Plane snapshots with deduplicated, content-addressed
  artifact blobs and exact artifact-set hashes.
- Added a crash-stale-aware maintenance lock so restore blocks new and
  already-open writers while replacing the DB and referenced artifacts through
  one journaled file transaction.
- Added an explicit human-controlled pause/resume switch for new run claims.
- Disabled HTTP redirects for OpenAI-compatible inference and bounded response
  bodies to a configurable 8 MiB default.
- Replaced audit payload key blacklisting with a conservative evidence
  allowlist and normalized untrusted actor labels.

## 0.0.4-alpha.1 — 2026-07-29

- Added OrgSpec `warn`, `block`, and `estimate` unknown-cost policy plus
  operator-supplied token pricing; unknown cost is never treated as zero.
- Added individual and cumulative artifact byte limits.
- Added general, mutation, and run-specific loopback dashboard rate limits.
- Added recursively redacted JSONL audit export.
- Added hashed, integrity-checked SQLite snapshots, automatic pre-migration
  backup, manual create/list, and exact-plan approved restore with a
  pre-restore safety backup.
- Added a shell-free command-process ModelEngine with absolute executable,
  bounded environment, output, timeout, and a neutral stdin/stdout contract.
- Added keyboard focus/escape handling, pressed filter state, skip navigation,
  mobile inspector accessibility, and desktop/mobile in-app Browser QA.

## 0.0.3-alpha.1 — 2026-07-29

- Added the provider-neutral Tool Runtime with OrgSpec allowlists, bounded
  workspace roots, exact-call human approval, hash-only execution evidence,
  and maximum tool iterations.
- Added built-in bounded directory-list, UTF-8 read, and approval-gated UTF-8
  write tools; no shell, network, package, or deployment executor is exposed.
- Added immutable file-apply journals, atomic apply locks, forced-exit
  rollback/finalization, automatic recovery, and the `recover` command.
- Added multi-process stress coverage for contested claims, idempotent command
  replay, and SQLite writer locks; busy timeout is installed before WAL setup.
- Added a dependency-free JavaScript packaging build, GitHub/npx entry path,
  clean temporary consumer install test, local installation-version matching,
  and explicit latest-release checks.

## 0.0.2-alpha.1 — 2026-07-29

- Added project-aware lean, balanced, and controlled proposals.
- Added versioned JSON CLI envelopes for coding agents and automation.
- Added dependency-free enforcement of the OrgSpec JSON Schema.
- Added staged bootstrap apply with preflight verification and rollback on
  exceptions.
- Added transactional outbox records, heartbeats, expired-lease recovery,
  visible run failure, retry generations, and runtime budget enforcement.
- Added structured artifacts, one bounded repair turn, cancellation
  propagation, bounded reasoning-mode control, JSON Schema request mode, and
  tool-call transport.
- Expanded the dashboard through triage, run, artifact review, retry,
  approval, and completion; secured every API read with a session token.
- Added a synthetic model-evaluation command for local/small-model testing.
- Restored the Korean dashboard copy as valid UTF-8.

## 0.0.1-alpha.1 — 2026-07-29

- Named the project CharterMesh and applied Apache-2.0.
- Added a universal coding-agent bootstrap protocol with exact plan approval.
- Added the SQLite Control Plane and action-centric dashboard projection.
- Added fake and OpenAI-compatible model engines.
- Added the built-in managed runner and end-to-end CLI lifecycle.
- Added the responsive loopback dashboard and API security checks.
- Added first-run, usage, and model-connection documentation.

This is pre-alpha software. The repository is package-ready, but no npm
registry publication is implied.
