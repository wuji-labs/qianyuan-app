import { ConnectedServiceQuotaFetchError, type ConnectedServiceQuotaFetcher } from '../types';
import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

import { resolveMissingClaudeSubscriptionClaudeCodeScopes } from '../../descriptors/connectedAccountDescriptors';
import { isRecord, normalizePct, resolveConnectedServiceQuotaAccountLabel } from '../quotaNormalization';
import { parseRetryAfterHeader } from '../normalization';

const DEFAULT_BETA_HEADER_VALUE = 'oauth-2025-04-20';
const DEFAULT_CLAUDE_SUBSCRIPTION_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

function parseIsoDateMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveAccountLabel(record: ConnectedServiceCredentialRecordV1): string | null {
  return resolveConnectedServiceQuotaAccountLabel(record);
}

function createMissingClaudeCodeScopeQuotaError(): ConnectedServiceQuotaFetchError {
  return new ConnectedServiceQuotaFetchError(
    'Reconnect Claude in Happier before Claude Code quota can be used.',
    {
      status: 403,
      quotaFetchErrorCode: 'auth_failure',
      providerCode: 'missing_claude_code_scope',
    },
  );
}

const WINDOW_LABELS: Readonly<Record<string, string>> = Object.freeze({
  five_hour: '5-hour',
  seven_day: 'Weekly',
  seven_day_oauth_apps: 'Weekly (OAuth apps)',
  seven_day_sonnet: 'Weekly (Sonnet)',
  seven_day_opus: 'Weekly (Opus)',
  iguana_necktie: 'Unknown',
});

export function createClaudeSubscriptionQuotaFetcher(params?: Readonly<{
  usageUrl?: string;
  betaHeaderValue?: string;
  staleAfterMs?: number;
  userAgent?: string;
  nowMs?: () => number;
}>): ConnectedServiceQuotaFetcher {
  const usageUrl = typeof params?.usageUrl === 'string' && params.usageUrl.trim()
    ? params.usageUrl.trim()
    : DEFAULT_CLAUDE_SUBSCRIPTION_USAGE_URL;
  const betaHeaderValue = params?.betaHeaderValue ?? DEFAULT_BETA_HEADER_VALUE;
  const staleAfterMs =
    typeof params?.staleAfterMs === 'number' && Number.isFinite(params.staleAfterMs)
      ? Math.max(1, Math.trunc(params.staleAfterMs))
      : 300_000;
  const userAgent = params?.userAgent ?? 'happier';
  const nowMs = params?.nowMs ?? (() => Date.now());
  const retryAfterBackoffByProfileId = new Map<string, number>();

  async function fetchUsage(params: Readonly<{
    usageUrl: string;
    accessToken: string;
    betaHeaderValue: string;
    userAgent: string;
    signal: AbortSignal;
  }>): Promise<Response> {
    return fetch(params.usageUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${params.accessToken}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'anthropic-beta': params.betaHeaderValue,
        'User-Agent': params.userAgent,
      },
      signal: params.signal,
    });
  }

  async function throwUsageError(response: Response): Promise<never> {
    const body = await response.text().catch(() => '');
    if (response.status === 401) {
      throw new ConnectedServiceQuotaFetchError(
        'Anthropic usage fetch failed (401): reconnect Claude in Happier and retry.',
        { status: 401, quotaFetchErrorCode: 'auth_failure' },
      );
    }
    if (response.status === 403) {
      const scopeMatch = body.match(/scope requirement\s+([a-z0-9:_-]+)/i);
      const requiredScope = scopeMatch?.[1] ? String(scopeMatch[1]).trim() : '';
      if (requiredScope) {
        throw createMissingClaudeCodeScopeQuotaError();
      }
    }
    throw new Error(`Anthropic usage fetch failed (${response.status}): ${response.statusText}`);
  }

  return {
    serviceId: 'claude-subscription',
    pollPolicy: {
      minPollIntervalMs: 30 * 60_000,
      retryAfterBackoffMinMs: 15 * 60_000,
    },
    fetch: async ({ record, now, signal }) => {
      if (record.kind !== 'oauth') return null;
      if (resolveMissingClaudeSubscriptionClaudeCodeScopes(record.oauth.scope).length > 0) {
        throw createMissingClaudeCodeScopeQuotaError();
      }
      const profileId = String(record.profileId ?? '').trim();
      const backoffUntil = profileId ? (retryAfterBackoffByProfileId.get(profileId) ?? 0) : 0;
      if (backoffUntil > now) {
        return null;
      }

      let response = await fetchUsage({
        usageUrl,
        accessToken: record.oauth.accessToken,
        betaHeaderValue,
        userAgent,
        signal,
      });

      if (!response.ok && response.status === 429) {
        const retryAfter = parseRetryAfterHeader(response.headers?.get?.('retry-after'), { nowMs: nowMs() });
        const retryAfterMs = retryAfter.retryAfterMs ?? 5 * 60_000;
        if (profileId) {
          retryAfterBackoffByProfileId.set(profileId, now + Math.max(15 * 60_000, retryAfterMs));
        }
        return null;
      }

      if (!response.ok && response.status >= 500 && response.status < 600) {
        response = await fetchUsage({
          usageUrl,
          accessToken: record.oauth.accessToken,
          betaHeaderValue,
          userAgent,
          signal,
        });
      }

      if (!response.ok) await throwUsageError(response);

      const json: unknown = await response.json();
      const data = isRecord(json) ? json : {};

      const meters: Array<{
        meterId: string;
        label: string;
        used: number | null;
        limit: number | null;
        unit: 'unknown' | 'credits';
        utilizationPct: number | null;
        resetsAt: number | null;
        status: 'ok' | 'unavailable';
        details: Record<string, never>;
      }> = [];
      for (const [key, label] of Object.entries(WINDOW_LABELS)) {
        const window = isRecord(data[key]) ? data[key] : null;
        const utilizationPct = normalizePct(window?.utilization);
        meters.push({
          meterId: key,
          label,
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct,
          resetsAt: parseIsoDateMs(window?.resets_at),
          status: utilizationPct === null ? 'unavailable' : 'ok',
          details: {},
        });
      }

      const extra = isRecord(data.extra_usage) ? data.extra_usage : null;
      if (extra?.is_enabled) {
        const utilizationPct = normalizePct(extra.utilization);
        meters.push({
          meterId: 'extra_usage',
          label: 'Extra usage',
          used: typeof extra.used_credits === 'number' && Number.isFinite(extra.used_credits) ? extra.used_credits : null,
          limit: typeof extra.monthly_limit === 'number' && Number.isFinite(extra.monthly_limit) ? extra.monthly_limit : null,
          unit: 'credits',
          utilizationPct,
          resetsAt: null,
          status: utilizationPct === null ? 'unavailable' : 'ok',
          details: {},
        });
      }

      return {
        v: 1,
        serviceId: record.serviceId,
        profileId: record.profileId,
        fetchedAt: now,
        staleAfterMs,
        planLabel: null,
        accountLabel: resolveAccountLabel(record),
        meters,
      };
    },
  };
}
