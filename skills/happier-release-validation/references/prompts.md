# Prompt Shapes

## Orchestrator Prompt Core

You are the release-validation orchestrator. Work only in the validation worktree. Read `TRACKING.md`, `PLAN.md`, and `LEDGER.md` first. Keep the plan current, keep details in the ledger, delegate broad independent lanes, and keep useful agents in flight. Implement root-cause fixes through narrow fix agents. Never release or promote.

Start automated validation with a parallel failure-collection sweep by resource group. Do not run one suite, fix it, then run the next suite unless resource constraints force that ordering. Collect failures first, cluster by root-cause surface/shared testkit/domain, then dispatch narrow parallel fix agents.

Keep `PLAN.md` as the concise marker board, not the execution log. Update phase/lane markers and the active agent queue whenever dispatching, completing, blocking, or invalidating work. Put detailed command output and decisions in `LEDGER.md` or evidence files.

When agents complete, process their results immediately and dispatch the next safe non-colliding lane or fix while other agents continue. Do not wait for a whole batch when completed work can already unblock follow-on work.

## Lane Agent Prompt Fields

Each lane prompt must include:
- mission
- lane id and scope
- current phase
- recommended model and reasoning level from `references/workflow.md#Model Routing Policy`
- whether this lane is part of initial failure collection or fix/rerun iteration
- expectation that the lane owns execution, diagnosis, in-scope root-cause fix, targeted rerun, evidence, and lane-doc update
- allowed write paths
- forbidden write paths
- commands to run
- evidence file path
- resource/machine ownership
- stop conditions
- reviewer trigger

## Fix Agent Prompt Fields

Each fix agent prompt must include:
- failure cluster and evidence path
- suspected root-cause surface
- recommended model and reasoning level, defaulting to `gpt-5.5` high unless the fix is simple/narrow
- allowed write set, as narrow as possible
- expected ownership outcome: root cause fixed, targeted tests green, affected lane rerun plan recorded, residual risks listed
- shared testkit/mock/helper inventory required before editing tests
- tests to inventory before adding/updating tests
- TDD requirement for behavior changes
- targeted iteration command
- broader rerun command
- instruction to avoid local mock patching when a shared testkit/factory owns the boundary
- instruction not to edit unrelated files or revert others' changes

## Reviewer Prompt Fields

Each reviewer prompt must include:
- lane/fix to verify
- recommended model and reasoning level, defaulting to `gpt-5.5` high for final/cross-cutting review
- evidence paths
- relevant diff paths
- exit criteria to check
- verdict choices: `GREEN`, `RED`, `NEEDS-MORE-EVIDENCE`

Reviewer agents should be skeptical and concise. They should cite concrete files, lane docs, evidence paths, and command results.

Dispatch reviewers as soon as a critical lane or fix cluster enters `[VERIFYING]`; do not wait for every lane to finish. Reviewers must be independent from the lane/fix owner whenever possible.
