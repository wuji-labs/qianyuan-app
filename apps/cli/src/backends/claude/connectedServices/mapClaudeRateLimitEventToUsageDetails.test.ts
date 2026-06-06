import { afterEach, describe, expect, it, vi } from 'vitest';

import { mapClaudeRateLimitEventToUsageDetails } from './mapClaudeRateLimitEventToUsageDetails';

describe('mapClaudeRateLimitEventToUsageDetails', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('maps Claude SDK rate_limit_event fields into normalized usage-limit details', () => {
    const details = mapClaudeRateLimitEventToUsageDetails({
      type: 'rate_limit_event',
      uuid: 'event-1',
      session_id: 'session-1',
      rate_limit_info: {
        status: 'rejected',
        resetsAt: 1_768_100_000_000,
        rateLimitType: 'five_hour',
        utilization: 100,
        overageStatus: 'rejected',
        overageResetsAt: 1_768_200_000_000,
        overageDisabledReason: 'out_of_credits',
      },
    });

    expect(details).toEqual({
      v: 1,
      resetAtMs: 1_768_100_000_000,
      retryAfterMs: null,
      quotaScope: 'account',
      recoverability: 'wait',
      providerLimitId: 'five_hour',
      planType: null,
      utilization: 100,
      overage: {
        status: 'rejected',
        resetAtMs: 1_768_200_000_000,
        disabledReason: 'out_of_credits',
      },
      action: null,
      connectedService: null,
    });
  });

  it('ignores allowed Claude SDK rate-limit telemetry', () => {
    expect(mapClaudeRateLimitEventToUsageDetails({
      type: 'rate_limit_event',
      uuid: 'event-allowed',
      session_id: 'session-allowed',
      rate_limit_info: {
        status: 'allowed',
        resetsAt: 1_779_097_200,
        rateLimitType: 'five_hour',
        overageStatus: 'rejected',
        overageDisabledReason: 'org_level_disabled',
        isUsingOverage: false,
      },
    })).toBeNull();
  });

  it('ignores Claude SDK rate-limit warning telemetry', () => {
    expect(mapClaudeRateLimitEventToUsageDetails({
      type: 'rate_limit_event',
      uuid: 'event-warning',
      session_id: 'session-warning',
      rate_limit_info: {
        status: 'allowed_warning',
        resetsAt: 1_779_097_200,
        rateLimitType: 'five_hour',
        utilization: 90,
        surpassedThreshold: 80,
      },
    })).toBeNull();
  });

  it('maps Claude response headers into retry timing when an API error exposes them', () => {
    expect(mapClaudeRateLimitEventToUsageDetails({
      response: {
        headers: {
          'retry-after': '30',
          'anthropic-ratelimit-tokens-reset': '2026-05-17T12:00:00.000Z',
        },
      },
    })).toMatchObject({
      v: 1,
      resetAtMs: Date.parse('2026-05-17T12:00:00.000Z'),
      retryAfterMs: 30_000,
      quotaScope: 'account',
      recoverability: 'wait',
    });
  });

  it('maps synthetic Claude assistant API-error rate-limit records', () => {
    expect(mapClaudeRateLimitEventToUsageDetails({
      type: 'assistant',
      uuid: 'api-error-assistant-1',
      isApiErrorMessage: true,
      error: {
        type: 'rate_limit_error',
        code: 'rate_limit',
        message: 'Claude API rate limit exceeded',
        status: 429,
        api_error_status: 429,
        reset_at: '2026-05-17T12:00:00.000Z',
      },
    })).toMatchObject({
      v: 1,
      resetAtMs: Date.parse('2026-05-17T12:00:00.000Z'),
      retryAfterMs: null,
      quotaScope: 'account',
      recoverability: 'wait',
      providerLimitId: 'rate_limit',
      utilization: null,
    });
  });

  it('maps synthetic Claude result API-error status records', () => {
    expect(mapClaudeRateLimitEventToUsageDetails({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      error: 'rate_limit',
      api_error_status: 429,
      retry_after_ms: 45_000,
    })).toMatchObject({
      v: 1,
      resetAtMs: null,
      retryAfterMs: 45_000,
      quotaScope: 'account',
      recoverability: 'wait',
      providerLimitId: 'rate_limit',
      utilization: null,
    });
  });

  it('classifies temporary server throttling as a transient provider limit', () => {
    expect(mapClaudeRateLimitEventToUsageDetails({
      type: 'assistant',
      uuid: 'api-error-assistant-transient',
      isApiErrorMessage: true,
      apiErrorStatus: 429,
      error: 'rate_limit',
      message: {
        type: 'message',
        role: 'assistant',
        content: [{
          type: 'text',
          text: 'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited',
        }],
      },
    })).toMatchObject({
      v: 1,
      providerLimitId: 'transient',
      recoverability: 'wait',
    });
  });

  it('classifies Claude 529 overloaded errors as provider capacity rather than quota exhaustion', () => {
    expect(mapClaudeRateLimitEventToUsageDetails({
      type: 'assistant',
      uuid: 'api-error-assistant-overloaded',
      isApiErrorMessage: true,
      apiErrorStatus: 529,
      error: 'server_error',
      message: {
        type: 'message',
        role: 'assistant',
        content: [{
          type: 'text',
          text: 'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.',
        }],
      },
    })).toMatchObject({
      v: 1,
      limitCategory: 'capacity',
      providerLimitId: 'server_overloaded',
      recoverability: 'wait',
      utilization: null,
    });
  });

  it('ignores synthetic Claude API-error records without rate-limit evidence', () => {
    expect(mapClaudeRateLimitEventToUsageDetails({
      type: 'assistant',
      uuid: 'api-error-assistant-2',
      isApiErrorMessage: true,
      error: {
        type: 'authentication_error',
        message: 'Invalid API key',
        status: 401,
        api_error_status: 401,
      },
    })).toBeNull();
  });

  it('maps HTTP-date retry-after headers into a relative retry delay', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-17T12:00:00.000Z'));

    expect(mapClaudeRateLimitEventToUsageDetails({
      response: {
        headers: {
          'retry-after': 'Sun, 17 May 2026 12:00:10 GMT',
        },
      },
    })).toMatchObject({
      retryAfterMs: 10_000,
      resetAtMs: Date.parse('2026-05-17T12:00:10.000Z'),
    });
  });

  it('maps generic reset-after headers with compact durations', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-17T12:00:00.000Z'));

    expect(mapClaudeRateLimitEventToUsageDetails({
      response: {
        headers: {
          'x-ratelimit-reset-after': '2m30s',
        },
      },
    })).toMatchObject({
      retryAfterMs: 150_000,
      resetAtMs: Date.parse('2026-05-17T12:02:30.000Z'),
    });
  });
});
