import {
  resolveSessionUsageLimitRecoveryResumePromptModeV1,
  type SessionUsageLimitRecoveryResumePromptModeV1,
} from '@happier-dev/protocol';

/**
 * Lazily-loaded lower precedence tiers for the routed resume-prompt-mode resolution.
 *
 * Plan tier order (Jun 10 usage-limit recovery unification plan, P1):
 *   1. explicit per-operation `resumePromptMode`
 *   2. existing recovery intent mode
 *   3. account setting default
 *   4. group-policy compatibility value
 *   5. provider/runtime config
 *   6. provider/runtime default (`standard`)
 *
 * Tiers 4–5 may require I/O (group fetch, provider adapter), so they are loader
 * callbacks consulted only when every higher tier is silent.
 */
export type RoutedUsageLimitRecoveryResumePromptTierSources = Readonly<{
  accountSettings?: unknown;
  loadGroupPolicy?: () => Promise<unknown> | unknown;
  loadProviderConfig?: () => Promise<unknown> | unknown;
}>;

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readMode(value: unknown): SessionUsageLimitRecoveryResumePromptModeV1 | null {
  return value === 'standard' || value === 'off' || value === 'custom' ? value : null;
}

function readAccountSettingsMode(value: unknown): SessionUsageLimitRecoveryResumePromptModeV1 | null {
  const accountSettings = readRecord(value);
  if (!accountSettings) return null;
  const nested = readRecord(accountSettings.usageLimitRecoverySettingsV1);
  return readMode(nested?.resumePromptMode) ?? readMode(accountSettings.resumePromptMode);
}

async function safeLoad(loader?: () => Promise<unknown> | unknown): Promise<unknown> {
  if (!loader) return null;
  try {
    return await loader() ?? null;
  } catch {
    return null;
  }
}

/**
 * Routed owner for resume-prompt-mode precedence: materializes the lazy
 * group-policy/provider-config tiers only when needed, then delegates the
 * canonical ordering to the protocol resolver so there is exactly one
 * precedence definition.
 */
export async function resolveRoutedUsageLimitRecoveryResumePromptMode(
  input: Readonly<{
    explicit?: unknown;
    existingIntent?: unknown;
  }> & RoutedUsageLimitRecoveryResumePromptTierSources,
): Promise<SessionUsageLimitRecoveryResumePromptModeV1> {
  const fastTierDecided =
    readMode(input.explicit) !== null
    || readMode(readRecord(input.existingIntent)?.resumePromptMode) !== null
    || readAccountSettingsMode(input.accountSettings) !== null;

  const groupPolicy = fastTierDecided ? undefined : await safeLoad(input.loadGroupPolicy);
  const groupTierDecided = readMode(readRecord(groupPolicy)?.resumePromptMode) !== null;
  const providerConfig = fastTierDecided || groupTierDecided
    ? undefined
    : await safeLoad(input.loadProviderConfig);

  return resolveSessionUsageLimitRecoveryResumePromptModeV1({
    explicit: input.explicit,
    existingIntent: input.existingIntent,
    accountSettings: input.accountSettings,
    groupPolicy,
    providerConfig,
  });
}
