# Daemon Ownership Regression Scenarios

Each scenario must be exercised on Linux (Lima), macOS (host), and Windows (SSH) unless explicitly marked single-OS or already covered by a targeted automated test. Treat these as hypotheses/regression guards to reproduce and validate during release validation, not as pre-confirmed current bugs.

## Confirmed-Fixed Regression Guards

- [ ] **DO-01** Same-label launchctl bootstrap (macOS only): `service install` then `service start` against an already-owned label uses `kickstart`, not `bootstrap`; no `Bootstrap failed: 5: Input/output error`.
  - Automated sentinel: `apps/cli/src/cli/commands/daemon.serviceList.test.ts`
- [ ] **DO-02** Service takeover preserves relay ownership: `service install --takeover` on a machine with a manual daemon results in service-owned relay, never ownerless relay.
  - Automated sentinel: `apps/cli/src/cli/commands/daemon.service.test.ts`
- [ ] **DO-03** Stale plist/service file does not block manual daemon start: invalid service file is rejected by file-validity checks and manual daemon can proceed.
  - Automated sentinel: `apps/cli/src/daemon/service/discoverInstalledDaemonServiceEntries.test.ts`
- [ ] **DO-04** Launchctl kickstart materialization race is tolerated: transient missing-service state inside the materialization window is benign.
  - Automated sentinel: `apps/cli/src/cli/commands/daemon.service.test.ts`
- [ ] **DO-05** Stack-started daemon reports `startupSource: 'manual'`, not null.
  - Automated sentinel: `apps/stack/scripts/daemon.getDaemonEnv.test.mjs`
- [ ] **DO-06** Same-runtime socket reclaim disconnects prior socket on relay and leaves a single owner.
  - Automated sentinel: `packages/protocol/src/machineOwnership/daemonOwnership.test.ts`
- [ ] **DO-07** Installer preflights existing services from other lanes before interactive background-service replacement choices.
  - Automated sentinel: `scripts/release/installers_background_service_conflict_resolution.contract.test.mjs`

## Reproduce-And-Decide Items

- [ ] **DO-08** `daemon start --json` emits structured JSON on installed-service conflict. If it emits plain text, either fix it or record a human-approved known issue.
- [ ] **DO-09** Stack wrapper path for `service install --takeover` works in a live stack, not only isolated env-export tests.
- [ ] **DO-10** Direct CLI `service install --takeover` satisfies its ownership postcondition under rapid launchd churn within the expected timeout.

## State Matrix

Run each state per OS unless explicitly impossible. Record PASS/FAIL/N/A with evidence.

| State | Linux Lima | macOS Host | Windows SSH | Evidence |
|---|---|---|---|---|
| Clean install: no daemon state, no service | TODO | TODO | TODO | |
| Legacy daemon state with no startup source | TODO | TODO | TODO | |
| Manual daemon running, no service | TODO | TODO | TODO | |
| Service installed and running | TODO | TODO | TODO | |
| Service installed plus stale manual daemon state | TODO | TODO | TODO | |
| Service installed plus manual daemon conflict | TODO | TODO | TODO | |
| Multiple services from different lanes or versions | TODO | TODO | TODO | |
| Stale service file with no valid runtime | TODO | TODO | TODO | |
| Stack-started daemon reports manual startup source | TODO | TODO | TODO | |
| Service-managed daemon restart routes through service restart | TODO | TODO | TODO | |

## Expected Steady State

The dynamic following background service is the recommended steady state. Conflicts must be detected with actionable guidance, users must not lose sessions or account continuity, and the daemon-server relay ownership must remain coherent after upgrade.
