import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';

vi.mock('@/utils/timing/time', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/timing/time')>();
    const immediate = async <T,>(callback: () => Promise<T>): Promise<T> => await callback();
    return {
        ...actual,
        backoff: immediate,
        backoffForever: immediate,
    };
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

const credentials: AuthCredentials = { token: 't', secret: 's' };

function mockServerConfig() {
    vi.doMock('@/sync/domains/server/serverRuntime', () => ({
        getActiveServerSnapshot: () => ({
            serverId: 'test',
            serverUrl: 'https://api.example.test',
            kind: 'custom',
            generation: 1,
        }),
    }));
}

function createGroupResponse() {
    return {
        group: {
            v: 1,
            serviceId: 'openai-codex',
            groupId: 'primary',
            displayName: 'Primary pool',
            policy: {
                v: 1,
                strategy: 'priority',
                autoSwitch: true,
                switchOn: {
                    usageLimit: true,
                    authExpired: true,
                    accountChanged: true,
                    refreshFailure: false,
                },
                cooldownMs: 30_000,
                honorProviderResetsAt: true,
                autoRestorePrimaryWhenReset: false,
                maxSwitchesPerTurn: 1,
                maxSwitchesPerSessionHour: 3,
            },
            activeProfileId: 'work',
            generation: 2,
            state: {},
            createdAt: 1,
            updatedAt: 2,
            members: [
                {
                    v: 1,
                    serviceId: 'openai-codex',
                    groupId: 'primary',
                    profileId: 'work',
                    priority: 10,
                    enabled: true,
                    state: {},
                    createdAt: 1,
                    updatedAt: 2,
                },
            ],
        },
    };
}

describe('apiConnectedServiceAuthGroupsV3', () => {
    it('lists connected-service auth groups through the v3 route', async () => {
        mockServerConfig();
        const fetchMock = vi.fn(async (input: unknown) => {
            const url = String(input);
            if (url === 'https://api.example.test/health') {
                return { ok: true, status: 200, json: async () => ({ ok: true }) };
            }
            return { ok: true, status: 200, json: async () => ({ groups: [createGroupResponse().group] }) };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { listConnectedServiceAuthGroupsV3 } = await import('./apiConnectedServiceAuthGroupsV3');
        const groups = await listConnectedServiceAuthGroupsV3(credentials, {
            serviceId: 'openai-codex',
        });

        expect(groups).toHaveLength(1);
        expect(groups[0]?.groupId).toBe('primary');
        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.example.test/v3/connect/openai-codex/groups',
            expect.objectContaining({
                method: 'GET',
                headers: expect.any(Headers),
            }),
        );
    });

    it('creates a connected-service auth group through the v3 route', async () => {
        mockServerConfig();
        const fetchMock = vi.fn(async (input: unknown) => {
            const url = String(input);
            if (url === 'https://api.example.test/health') {
                return { ok: true, status: 200, json: async () => ({ ok: true }) };
            }
            return { ok: true, status: 200, json: async () => createGroupResponse() };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { createConnectedServiceAuthGroupV3 } = await import('./apiConnectedServiceAuthGroupsV3');
        const group = await createConnectedServiceAuthGroupV3(credentials, {
            serviceId: 'openai-codex',
            groupId: 'primary',
            displayName: 'Primary pool',
            members: [{ profileId: 'work', priority: 10, enabled: true }],
            activeProfileId: 'work',
            policy: { autoSwitch: true },
        });

        expect(group.groupId).toBe('primary');
        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.example.test/v3/connect/openai-codex/groups',
            expect.objectContaining({
                method: 'POST',
                headers: expect.any(Headers),
                body: JSON.stringify({
                    groupId: 'primary',
                    displayName: 'Primary pool',
                    members: [{ profileId: 'work', priority: 10, enabled: true }],
                    activeProfileId: 'work',
                    policy: { autoSwitch: true },
                }),
            }),
        );
    });

    it('updates members and active profile through group-scoped routes', async () => {
        mockServerConfig();
        const fetchMock = vi.fn(async (input: unknown) => {
            const url = String(input);
            if (url === 'https://api.example.test/health') {
                return { ok: true, status: 200, json: async () => ({ ok: true }) };
            }
            return { ok: true, status: 200, json: async () => createGroupResponse() };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const {
            addConnectedServiceAuthGroupMemberV3,
            patchConnectedServiceAuthGroupMemberV3,
            removeConnectedServiceAuthGroupMemberV3,
            setConnectedServiceAuthGroupActiveProfileV3,
        } = await import('./apiConnectedServiceAuthGroupsV3');

        await addConnectedServiceAuthGroupMemberV3(credentials, {
            serviceId: 'openai-codex',
            groupId: 'primary',
            profileId: 'backup',
            priority: 20,
            enabled: true,
            expectedGeneration: 2,
        });
        await patchConnectedServiceAuthGroupMemberV3(credentials, {
            serviceId: 'openai-codex',
            groupId: 'primary',
            profileId: 'backup',
            patch: { enabled: false, expectedGeneration: 3 },
        });
        await setConnectedServiceAuthGroupActiveProfileV3(credentials, {
            serviceId: 'openai-codex',
            groupId: 'primary',
            profileId: 'work',
            expectedGeneration: 2,
        });
        await removeConnectedServiceAuthGroupMemberV3(credentials, {
            serviceId: 'openai-codex',
            groupId: 'primary',
            profileId: 'backup',
            expectedGeneration: 4,
        });

        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.example.test/v3/connect/openai-codex/groups/primary/members',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    profileId: 'backup',
                    priority: 20,
                    enabled: true,
                    expectedGeneration: 2,
                }),
            }),
        );
        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.example.test/v3/connect/openai-codex/groups/primary/members/backup',
            expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ enabled: false, expectedGeneration: 3 }) }),
        );
        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.example.test/v3/connect/openai-codex/groups/primary/active-profile',
            expect.objectContaining({ method: 'POST', body: JSON.stringify({ profileId: 'work', expectedGeneration: 2 }) }),
        );
        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.example.test/v3/connect/openai-codex/groups/primary/members/backup?expectedGeneration=4',
            expect.objectContaining({ method: 'DELETE' }),
        );
    });
});
