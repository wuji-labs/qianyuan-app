/**
 * Decide whether a connected-service group switch attempt represents genuine usage-limit
 * recovery progress for Codex.
 *
 * Live bug being fixed: when the rate-limit probe sees exhausted quota and the group recovery
 * reports `switched`, the runtime previously returned an immediate retry
 * (`nextCheckAtMs: Date.now()`). If the "switch" landed on the SAME exhausted account (Codex
 * caches the account at process level and keeps failing until restarted with a DIFFERENT
 * account), that produced a tight immediate-retry storm.
 *
 * Deterministic-proof principle: a switch only counts as progress when the newly-selected
 * account is genuinely different from the exhausted one. Otherwise we wait until the provider
 * reset time (never an immediate retry), or go terminal when no candidate exists.
 *
 * Seam for wave-3: this helper proves a fresh CANDIDATE was selected. Full provider-outcome
 * proof (the provider actually accepting the new account and producing activity) is left to the
 * shared provider-outcome proof gate (`provider_activity`).
 *
 * Mapping onto the shared, provider-agnostic proof contract is thin and behavior-preserving:
 * see `mapCodexUsageLimitSwitchProgressToProof` below — it classifies an existing decision, it
 * does not change how the decision is made.
 */

import type { ProviderOutcomeProofKind } from '@/daemon/connectedServices/recovery/providerOutcomeProof';

export type CodexUsageLimitSwitchAttemptStatus =
  | 'switched'
  | 'observed_generation'
  | 'generation_apply_failed'
  | 'no_eligible_member'
  | 'manual_strategy'
  | 'auto_switch_disabled'
  | 'switch_reason_disabled'
  | 'switch_limit_reached';

export type CodexUsageLimitSwitchProgress =
  | Readonly<{ kind: 'retry' }>
  | Readonly<{ kind: 'wait_until_reset'; nextCheckAtMs: number }>
  | Readonly<{ kind: 'exhausted'; reason: string }>;

function normalizeProfileId(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function resolveWaitTime(input: Readonly<{
  resetAtMs: number | null;
  nowMs: number;
  fallbackNextCheckAtMs?: number | null;
}>): number {
  if (typeof input.resetAtMs === 'number' && Number.isFinite(input.resetAtMs)) {
    return Math.trunc(input.resetAtMs);
  }
  if (typeof input.fallbackNextCheckAtMs === 'number' && Number.isFinite(input.fallbackNextCheckAtMs)) {
    return Math.trunc(input.fallbackNextCheckAtMs);
  }
  // Last-resort: never an immediate retry. Push out by a minute to avoid a storm.
  return input.nowMs + 60_000;
}

export function resolveCodexUsageLimitSwitchProgress(input: Readonly<{
  switchAttemptStatus: CodexUsageLimitSwitchAttemptStatus | null;
  exhaustedProfileId: string | null;
  selectedProfileId: string | null;
  resetAtMs: number | null;
  nowMs: number;
  fallbackNextCheckAtMs?: number | null;
  errorCode?: string | null;
}>): CodexUsageLimitSwitchProgress {
  const waitUntilReset = (): CodexUsageLimitSwitchProgress => ({
    kind: 'wait_until_reset',
    nextCheckAtMs: resolveWaitTime(input),
  });

  switch (input.switchAttemptStatus) {
    case 'generation_apply_failed':
      return {
        kind: 'exhausted',
        reason: `connected_service_generation_apply_failed:${normalizeProfileId(input.errorCode) ?? 'unknown'}`,
      };
    case 'no_eligible_member':
      return { kind: 'exhausted', reason: 'connected_service_group_no_eligible_member' };
    case 'manual_strategy':
    case 'auto_switch_disabled':
    case 'switch_reason_disabled':
    case 'switch_limit_reached':
      // A real switch is not available right now; wait for the provider reset rather than loop.
      return waitUntilReset();
    case 'switched':
    case 'observed_generation': {
      const exhausted = normalizeProfileId(input.exhaustedProfileId);
      const selected = normalizeProfileId(input.selectedProfileId);
      // Only a genuinely different account counts as progress (fresh-candidate proof).
      if (selected !== null && selected !== exhausted) {
        return { kind: 'retry' };
      }
      // Same account (or unknown selection) => no fresh quota; wait until reset, never immediate.
      return waitUntilReset();
    }
    default:
      return waitUntilReset();
  }
}

/**
 * Thin mapping of an already-decided Codex usage-limit switch-progress outcome onto the shared,
 * provider-agnostic `ProviderOutcomeProofKind` contract. Behavior-preserving: this only classifies
 * an existing decision.
 *
 * - `retry` (a genuinely different account was selected) => `fresh_candidate_selected` (intermediate evidence, not recovered by itself).
 * - `exhausted` (no eligible member / generation apply failed) => `terminal_exhausted` (visible terminal).
 * - `wait_until_reset` => `null`: NOT proof. Same-account / unavailable-switch is still recovering;
 *   it waits for the provider reset under the scheduler lifecycle (never an immediate-retry storm).
 */
export function mapCodexUsageLimitSwitchProgressToProof(
  progress: CodexUsageLimitSwitchProgress,
): ProviderOutcomeProofKind | null {
  switch (progress.kind) {
    case 'retry':
      return 'fresh_candidate_selected';
    case 'exhausted':
      return 'terminal_exhausted';
    case 'wait_until_reset':
      return null;
  }
}
