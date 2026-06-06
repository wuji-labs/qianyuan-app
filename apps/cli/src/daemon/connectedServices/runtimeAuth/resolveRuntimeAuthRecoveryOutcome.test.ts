import { describe, expect, it } from 'vitest';

import {
  isProvenRuntimeAuthRecoverySuccess,
  resolveRuntimeAuthRecoveryProof,
} from './resolveRuntimeAuthRecoveryOutcome';

describe('resolveRuntimeAuthRecoveryProof', () => {
  it('accepts a switch with verified account adoption as deterministic proof', () => {
    const result = {
      status: 'switch_attempted',
      result: {
        status: 'switched',
        activeProfileId: 'backup',
        generation: 2,
        verificationByServiceId: {
          'openai-codex': { status: 'verified' },
        },
      },
    };
    expect(resolveRuntimeAuthRecoveryProof(result)).toBe('account_adoption_verified');
    expect(isProvenRuntimeAuthRecoverySuccess(result)).toBe(true);
  });

  it('accepts a weakly_verified account adoption as deterministic proof', () => {
    const result = {
      status: 'observed_generation',
      activeProfileId: 'backup',
      generation: 3,
      verificationByServiceId: {
        'openai-codex': { status: 'weakly_verified', reason: 'probe_partial' },
      },
    };
    expect(resolveRuntimeAuthRecoveryProof(result)).toBe('account_adoption_verified');
  });

  it('accepts a genuinely fresh candidate (from-profile differs from active) as deterministic proof', () => {
    const result = {
      status: 'switch_attempted',
      result: {
        status: 'switched',
        fromProfileId: 'primary',
        activeProfileId: 'backup',
        generation: 2,
      },
    };
    expect(resolveRuntimeAuthRecoveryProof(result)).toBe('fresh_candidate_selected');
  });

  it('rejects a same-account hot apply (from-profile equals active) as no proof', () => {
    const result = {
      status: 'switch_attempted',
      result: {
        status: 'switched',
        fromProfileId: 'primary',
        activeProfileId: 'primary',
        generation: 2,
      },
    };
    expect(resolveRuntimeAuthRecoveryProof(result)).toBeNull();
    expect(isProvenRuntimeAuthRecoverySuccess(result)).toBe(false);
  });

  it('rejects a switch without verification and without a from-profile as no proof', () => {
    const result = {
      status: 'switch_attempted',
      result: {
        status: 'switched',
        activeProfileId: 'backup',
        generation: 2,
      },
    };
    expect(isProvenRuntimeAuthRecoverySuccess(result)).toBe(false);
  });

  it('rejects a bare credential_refreshed result as no proof', () => {
    expect(isProvenRuntimeAuthRecoverySuccess({ status: 'credential_refreshed' })).toBe(false);
    expect(isProvenRuntimeAuthRecoverySuccess({ status: 'credential_refreshed', restartRequested: true })).toBe(false);
  });

  it('rejects a generic ok:true result as no proof', () => {
    const result = {
      status: 'switch_attempted',
      result: { ok: true, action: 'restart_requested' },
    };
    expect(isProvenRuntimeAuthRecoverySuccess(result)).toBe(false);
  });

  it('ignores verification entries that are not verified/weakly_verified', () => {
    const result = {
      status: 'switched',
      activeProfileId: 'backup',
      verificationByServiceId: {
        'openai-codex': { status: 'unverified' },
      },
    };
    expect(isProvenRuntimeAuthRecoverySuccess(result)).toBe(false);
  });

  it('returns null for non-record inputs', () => {
    expect(resolveRuntimeAuthRecoveryProof(null)).toBeNull();
    expect(resolveRuntimeAuthRecoveryProof(undefined)).toBeNull();
    expect(resolveRuntimeAuthRecoveryProof('switched')).toBeNull();
  });
});
