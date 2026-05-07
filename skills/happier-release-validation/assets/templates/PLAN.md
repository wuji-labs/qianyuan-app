# {{VERSION_WITH_PREFIX}} Release Validation Plan

Live workspace: `{{REVIEW_DIR}}`
Worktree: `{{WORKTREE_PATH}}`
Branch: `{{BRANCH_NAME}}`
Created: {{DATE}}

## Read First After Any Compact

1. Read `TRACKING.md`.
2. Read this `PLAN.md`.
3. Read the latest entries in `LEDGER.md`.
4. Continue from the first `[~]`, `FAILED`, or `[BLOCKED]` marker.
5. Do not restart completed lanes unless the ledger says their evidence was invalidated.

## Marker Legend

- `[ ]` not started
- `[~]` in progress
- `[x]` complete with evidence
- `[BLOCKED]` blocked, needs specific input
- `[FAILED]` failed, needs root-cause fix
- `[VERIFYING]` fix landed, rerun/reviewer pending
- `[VERIFYING-INVARIANT]` fix cluster landed, affected lane and `checks --profile fast` rerun pending
- `[DEFERRED-HUMAN-APPROVED]` explicitly deferred by human with release-note text

## Current Phase

[~] Phase 0: Bootstrap and anchor documents
[ ] Phase 1: Discovery, pre-mortem, environment prep
[ ] Phase 2: Automated local checks
[ ] Phase 3: Continuity and installer validation
[ ] Phase 4: Manual cross-OS QA
[ ] Phase 5: Fix/review iteration
[ ] Phase 6: Final validation dry-run and handoff

## Active Agent Queue

Keep this table short. It exists so the orchestrator can see current parallel work after compaction or long waits. Put detailed reports in `LEDGER.md` and lane evidence.

| Lane/Cluster | Role | Owner/Model | Status | Resource/Write Scope | Next Evidence |
|---|---|---|---|---|---|
| none | | | | | |

## Lane Roster

{{LANE_ROSTER}}

## Resource Notes

Keep this section concise. Put detailed execution in `LEDGER.md`.

- Browser auth state: `credentials/agent-browser-storage-state.json`
- Linux build VM: TBD
- Linux manual QA VM: TBD
- Windows connection: `~/connect_windows.sh`
- Docker availability: TBD
- Release artifact directory: TBD

## Active Resource Ownership

Use this table instead of a heavy lock system. Add rows before dispatching mutating agents; mark `Released` when done.

| Resource | Holder | Started | Released | Notes |
|---|---|---|---|---|
| browser-auth-state: `credentials/agent-browser-storage-state.json` | unassigned | | | single writer only |
| lima-vm: build | unassigned | | | exact VM name TBD |
| lima-vm: manual-qa | unassigned | | | exact VM name TBD |
| macos-service-state | unassigned | | | launchd/service mutations are sequential |
| windows-ssh-host | unassigned | | | installer/manual QA mutations are sequential |
| docker-daemon | unassigned | | | only lock for mutating Docker lanes |

## Dynamic Lanes

The generated lane roster is a starting map, not a ceiling. Add lanes here when new risks surface, and link their lane docs from `TRACKING.md`.
