import { beforeEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';

import { ApiClient } from './api';
import { logger } from '@/ui/logger';
import type { Credentials } from '@/persistence';

const { mockPost, mockGet } = vi.hoisted(() => ({
  mockPost: vi.fn(),
  mockGet: vi.fn(),
}));

vi.mock('axios', () => ({
  default: { post: mockPost, get: mockGet, isAxiosError: vi.fn(() => true) },
  isAxiosError: vi.fn(() => true),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

function createTestCredentials(): Credentials {
  return {
    token: 'happy-token',
    encryption: { type: 'legacy', secret: new Uint8Array(32) },
  };
}

function createAxiosResponseError(params: Readonly<{
  status: number;
  data?: unknown;
  headers?: Record<string, string>;
}>): Error & {
  response: {
    status: number;
    data: unknown;
    headers: Record<string, string>;
  };
} {
  const error = new Error(`Request failed with status ${params.status}`) as Error & {
    response: {
      status: number;
      data: unknown;
      headers: Record<string, string>;
    };
  };
  error.response = {
    status: params.status,
    data: params.data ?? { error: 'request_failed' },
    headers: params.headers ?? {},
  };
  return error;
}

describe('ApiClient connected services quotas v3', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('gets the account encryption mode from /v1/account/encryption', async () => {
    mockGet.mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });

    const api = await ApiClient.create(createTestCredentials());

    const mode = await api.getAccountEncryptionMode();
    expect(mode).toBe('plain');
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/v1/account/encryption'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
        }),
      }),
    );
  });

  it('returns unknown when account encryption mode lookup fails', async () => {
    mockGet.mockRejectedValue(createAxiosResponseError({
      status: 503,
      data: { error: 'server_unavailable' },
    }));

    const api = await ApiClient.create(createTestCredentials());

    await expect(api.getAccountEncryptionMode()).resolves.toBe('unknown');
  });

  it('gets plaintext quota snapshots from the v3 connected services quotas endpoint', async () => {
    mockGet.mockResolvedValue({
      status: 200,
      data: {
        content: {
          t: 'plain',
          v: {
            v: 1,
            serviceId: 'openai-codex',
            profileId: 'work',
            fetchedAt: 1,
            staleAfterMs: 300_000,
            planLabel: null,
            accountLabel: null,
            meters: [],
          },
        },
        metadata: { fetchedAt: 1, staleAfterMs: 300_000, status: 'ok' },
      },
    });

    const api = await ApiClient.create(createTestCredentials());

    const res = await api.getConnectedServiceQuotaSnapshotPlain({ serviceId: 'openai-codex', profileId: 'work' });
    expect(res?.content?.v?.serviceId).toBe('openai-codex');
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/profiles/work/quotas'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
        }),
      }),
    );
  });

  it('posts plaintext quota snapshots to the v3 connected services quotas endpoint', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { success: true } });

    const api = await ApiClient.create(createTestCredentials());

    await api.registerConnectedServiceQuotaSnapshotPlain({
      serviceId: 'openai-codex',
      profileId: 'work',
      content: {
        t: 'plain',
        v: {
          v: 1,
          serviceId: 'openai-codex',
          profileId: 'work',
          fetchedAt: Date.now(),
          staleAfterMs: 300_000,
          planLabel: null,
          accountLabel: null,
          meters: [],
        },
      },
      metadata: { fetchedAt: 1, staleAfterMs: 300_000, status: 'ok' },
    });

    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/profiles/work/quotas'),
      expect.any(Object),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
        }),
      }),
    );

    const serializedLogs = JSON.stringify(vi.mocked(logger.debug).mock.calls);
    expect(serializedLogs).not.toContain('staleAfterMs');
  });

  it('classifies plaintext quota read timeouts as retryable', async () => {
    const cause = Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
    mockGet.mockRejectedValue(cause);

    const api = await ApiClient.create(createTestCredentials());

    await expect(api.getConnectedServiceQuotaSnapshotPlain({
      serviceId: 'openai-codex',
      profileId: 'work',
    })).rejects.toMatchObject({
      name: 'ConnectedServiceQuotaApiError',
      kind: 'retryable',
      status: null,
      retryable: true,
      cause,
    });
  });

  it('preserves invalid plaintext quota payloads as protocol errors', async () => {
    mockGet.mockResolvedValue({
      status: 200,
      data: {
        content: { t: 'plain', v: { serviceId: 'openai-codex' } },
        metadata: { fetchedAt: 1, staleAfterMs: 300_000, status: 'ok' },
      },
    });

    const api = await ApiClient.create(createTestCredentials());

    await expect(api.getConnectedServiceQuotaSnapshotPlain({
      serviceId: 'openai-codex',
      profileId: 'work',
    })).rejects.toMatchObject({
      name: 'ConnectedServiceQuotaApiError',
      kind: 'protocol',
      status: null,
      retryable: false,
    });
  });

  it('returns null for missing plaintext quota snapshots', async () => {
    mockGet.mockRejectedValue(createAxiosResponseError({
      status: 404,
      data: { error: 'connect_quota_snapshot_not_found' },
    }));

    const api = await ApiClient.create(createTestCredentials());

    await expect(api.getConnectedServiceQuotaSnapshotPlain({
      serviceId: 'openai-codex',
      profileId: 'work',
    })).resolves.toBeNull();
  });
});
