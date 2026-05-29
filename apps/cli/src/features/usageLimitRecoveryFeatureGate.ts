import { resolveCliFeatureDecisionForServer } from './featureDecisionService';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';

const SESSION_USAGE_LIMIT_RECOVERY_FEATURE_GATE_TIMEOUT_MS = 800;

export function usageLimitRecoveryFeatureDisabledResult(): Readonly<{
  ok: false;
  errorCode: 'feature_disabled';
  error: 'sessions.usageLimitRecovery is disabled.';
}> {
  return {
    ok: false,
    errorCode: 'feature_disabled',
    error: 'sessions.usageLimitRecovery is disabled.',
  };
}

export async function resolveUsageLimitRecoveryFeatureEnabled(params: Readonly<{
  env?: NodeJS.ProcessEnv;
  serverUrl?: string;
  timeoutMs?: number;
}> = {}): Promise<boolean> {
  const resolved = await resolveCliFeatureDecisionForServer({
    featureId: 'sessions.usageLimitRecovery',
    env: params.env ?? process.env,
    serverUrl: params.serverUrl ?? resolveServerHttpBaseUrl(),
    timeoutMs: params.timeoutMs ?? SESSION_USAGE_LIMIT_RECOVERY_FEATURE_GATE_TIMEOUT_MS,
  });

  return resolved.decision.state === 'enabled';
}
