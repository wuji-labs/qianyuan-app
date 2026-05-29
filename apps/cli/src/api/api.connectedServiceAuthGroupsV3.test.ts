import { beforeEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';

import { ApiClient } from './api';

const { mockGet, mockPatch, mockPost } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPatch: vi.fn(),
  mockPost: vi.fn(),
}));

vi.mock('axios', () => ({
  default: { get: mockGet, isAxiosError: vi.fn(() => true), patch: mockPatch, post: mockPost },
  isAxiosError: vi.fn(() => true),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

function authGroupResponse(activeProfileId: string, generation: number) {
  return {
    group: {
      v: 1,
      serviceId: 'openai-codex',
      groupId: 'main',
      displayName: null,
      policy: { v: 1, autoSwitch: true },
      activeProfileId,
      generation,
      state: { v: 1 },
      members: [
        {
          v: 1,
          serviceId: 'openai-codex',
          groupId: 'main',
          profileId: activeProfileId,
          enabled: true,
          priority: 1,
          state: { v: 1 },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      createdAt: 1,
      updatedAt: 1,
    },
  };
}

describe('ApiClient connected service auth groups v3', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPatch.mockReset();
    mockPost.mockReset();
    vi.clearAllMocks();
  });

  it('gets an auth group from the v3 connected services groups endpoint', async () => {
    mockGet.mockResolvedValue({ status: 200, data: authGroupResponse('primary', 1) });
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    const group = await api.getConnectedServiceAuthGroup({ serviceId: 'openai-codex', groupId: 'main' });

    expect(group?.activeProfileId).toBe('primary');
    expect(group?.generation).toBe(1);
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/groups/main'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer happy-token' }),
      }),
    );
  });

  it('commits an auth group active profile through the CAS active-profile contract', async () => {
    mockPost.mockResolvedValue({ status: 200, data: authGroupResponse('backup', 2) });
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    const group = await api.updateConnectedServiceAuthGroupActiveProfile({
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
      expectedGeneration: 1,
    });

    expect(group.activeProfileId).toBe('backup');
    expect(group.generation).toBe(2);
    expect(axios.patch).not.toHaveBeenCalled();
    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/groups/main/active-profile'),
      { profileId: 'backup', expectedGeneration: 1 },
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer happy-token' }),
      }),
    );
  });

  it('updates auth group runtime state through the runtime-state contract', async () => {
    mockPatch.mockResolvedValue({ status: 200, data: authGroupResponse('primary', 1) });
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    const group = await api.updateConnectedServiceAuthGroupRuntimeState({
      serviceId: 'openai-codex',
      groupId: 'main',
      expectedGeneration: 1,
      memberStates: [
        {
          profileId: 'primary',
          state: {
            quotaExhaustedUntilMs: 5_000,
            lastFailureKind: 'usage_limit',
          },
        },
      ],
    });

    expect(group.activeProfileId).toBe('primary');
    expect(axios.patch).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/groups/main/runtime-state'),
      {
        expectedGeneration: 1,
        memberStates: [
          {
            profileId: 'primary',
            state: {
              quotaExhaustedUntilMs: 5_000,
              lastFailureKind: 'usage_limit',
            },
          },
        ],
      },
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer happy-token' }),
      }),
    );
  });
});

  it('throws ConnectedServiceAuthGroupGenerationConflictError on 409 conflict', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 409,
        data: { error: 'connect_group_generation_conflict', generation: 5 },
      },
    });
    const api = await ApiClient.create({
      token: 'happy-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    } as any);

    await expect(api.updateConnectedServiceAuthGroupActiveProfile({
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
      expectedGeneration: 1,
    })).rejects.toThrow('connected_service_auth_group_generation_conflict');
  });
