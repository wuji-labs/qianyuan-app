import { describe, expect, it, vi } from 'vitest';

import { resolveRoutedUsageLimitRecoveryResumePromptMode } from './resolveRoutedUsageLimitRecoveryResumePromptMode';

const offIntent = {
  v: 1,
  status: 'waiting',
  issueFingerprint: 'usage-limit:sess_1:reset',
  armedAtMs: 1,
  resetAtMs: 2,
  nextCheckAtMs: 2,
  attemptCount: 0,
  maxAttempts: 3,
  lastProbeError: null,
  resumePromptMode: 'off',
  selectedAuth: { kind: 'native' },
} as const;

describe('resolveRoutedUsageLimitRecoveryResumePromptMode', () => {
  it('resolves the full plan tier order: explicit > intent > account > group > provider > default', async () => {
    await expect(resolveRoutedUsageLimitRecoveryResumePromptMode({
      explicit: 'standard',
      existingIntent: offIntent,
      accountSettings: { usageLimitRecoverySettingsV1: { resumePromptMode: 'off' } },
      loadGroupPolicy: () => ({ resumePromptMode: 'off' }),
      loadProviderConfig: () => ({ resumePromptMode: 'off' }),
    })).resolves.toBe('standard');

    await expect(resolveRoutedUsageLimitRecoveryResumePromptMode({
      existingIntent: offIntent,
      accountSettings: { usageLimitRecoverySettingsV1: { resumePromptMode: 'standard' } },
    })).resolves.toBe('off');

    await expect(resolveRoutedUsageLimitRecoveryResumePromptMode({
      accountSettings: { usageLimitRecoverySettingsV1: { resumePromptMode: 'off' } },
      loadGroupPolicy: () => ({ resumePromptMode: 'standard' }),
    })).resolves.toBe('off');

    await expect(resolveRoutedUsageLimitRecoveryResumePromptMode({
      loadGroupPolicy: () => ({ resumePromptMode: 'off' }),
      loadProviderConfig: () => ({ resumePromptMode: 'standard' }),
    })).resolves.toBe('off');

    await expect(resolveRoutedUsageLimitRecoveryResumePromptMode({
      loadProviderConfig: () => ({ resumePromptMode: 'off' }),
    })).resolves.toBe('off');

    await expect(resolveRoutedUsageLimitRecoveryResumePromptMode({})).resolves.toBe('standard');
  });

  it('does not consult group or provider tiers when a higher tier decides', async () => {
    const loadGroupPolicy = vi.fn(() => ({ resumePromptMode: 'off' }));
    const loadProviderConfig = vi.fn(() => ({ resumePromptMode: 'off' }));

    await expect(resolveRoutedUsageLimitRecoveryResumePromptMode({
      accountSettings: { usageLimitRecoverySettingsV1: { resumePromptMode: 'standard' } },
      loadGroupPolicy,
      loadProviderConfig,
    })).resolves.toBe('standard');

    expect(loadGroupPolicy).not.toHaveBeenCalled();
    expect(loadProviderConfig).not.toHaveBeenCalled();
  });

  it('does not consult the provider tier when group policy decides', async () => {
    const loadProviderConfig = vi.fn(() => ({ resumePromptMode: 'off' }));

    await expect(resolveRoutedUsageLimitRecoveryResumePromptMode({
      loadGroupPolicy: () => ({ resumePromptMode: 'standard' }),
      loadProviderConfig,
    })).resolves.toBe('standard');

    expect(loadProviderConfig).not.toHaveBeenCalled();
  });

  it('falls through tiers on loader failure and on invalid values', async () => {
    await expect(resolveRoutedUsageLimitRecoveryResumePromptMode({
      explicit: 'sometimes',
      existingIntent: { resumePromptMode: 'later' },
      accountSettings: { usageLimitRecoverySettingsV1: { resumePromptMode: 42 } },
      loadGroupPolicy: () => {
        throw new Error('group fetch failed');
      },
      loadProviderConfig: async () => ({ resumePromptMode: 'off' }),
    })).resolves.toBe('off');

    await expect(resolveRoutedUsageLimitRecoveryResumePromptMode({
      loadGroupPolicy: async () => {
        throw new Error('group fetch failed');
      },
      loadProviderConfig: async () => {
        throw new Error('provider config failed');
      },
    })).resolves.toBe('standard');
  });

  it('resolves custom mode from any tier without falling through', async () => {
    await expect(resolveRoutedUsageLimitRecoveryResumePromptMode({
      explicit: 'custom',
      accountSettings: { usageLimitRecoverySettingsV1: { resumePromptMode: 'off' } },
    })).resolves.toBe('custom');

    const loadProviderConfig = vi.fn(() => ({ resumePromptMode: 'off' }));
    await expect(resolveRoutedUsageLimitRecoveryResumePromptMode({
      accountSettings: { usageLimitRecoverySettingsV1: { resumePromptMode: 'custom' } },
      loadProviderConfig,
    })).resolves.toBe('custom');
    expect(loadProviderConfig).not.toHaveBeenCalled();
  });

  it('reads the account tier from both nested and flat settings shapes', async () => {
    await expect(resolveRoutedUsageLimitRecoveryResumePromptMode({
      accountSettings: { resumePromptMode: 'off' },
    })).resolves.toBe('off');

    await expect(resolveRoutedUsageLimitRecoveryResumePromptMode({
      accountSettings: { usageLimitRecoverySettingsV1: { resumePromptMode: 'off' } },
    })).resolves.toBe('off');
  });
});
