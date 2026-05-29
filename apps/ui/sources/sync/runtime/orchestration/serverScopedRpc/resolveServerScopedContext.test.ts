import { afterEach, describe, expect, it, vi } from 'vitest';

const getCredentialsSpy = vi.hoisted(() => vi.fn());
const createEncryptionSpy = vi.hoisted(() => vi.fn());
const listServerProfilesSpy = vi.hoisted(() => vi.fn());
const getActiveServerSnapshotSpy = vi.hoisted(() => vi.fn());

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentialsForServerUrl: (...args: unknown[]) => getCredentialsSpy(...args),
    },
}));

vi.mock('@/auth/encryption/createEncryptionFromAuthCredentials', () => ({
    createEncryptionFromAuthCredentials: (...args: unknown[]) => createEncryptionSpy(...args),
}));

function normalizeId(raw: unknown): string {
    return String(raw ?? '').trim();
}

function resolveScopeId(profile: { id: string; serverIdentityId?: string | null }): string {
    return normalizeId(profile.serverIdentityId) || normalizeId(profile.id);
}

function findProfileByIdentifier(idRaw: unknown): { id: string; serverUrl: string; name: string; serverIdentityId?: string | null; legacyServerIds?: readonly string[] } | null {
    const id = normalizeId(idRaw);
    if (!id) return null;
    return (listServerProfilesSpy() as Array<{ id: string; serverUrl: string; name: string; serverIdentityId?: string | null; legacyServerIds?: readonly string[] }>).find((profile) => (
        normalizeId(profile.id) === id
        || normalizeId(profile.serverIdentityId) === id
        || (profile.legacyServerIds ?? []).some((legacyId) => normalizeId(legacyId) === id)
    )) ?? null;
}

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    listServerProfiles: (...args: unknown[]) => listServerProfilesSpy(...args),
    getServerProfileById: (id: unknown) => findProfileByIdentifier(id),
    resolveServerProfileScopeIdForIdentifier: (id: unknown) => {
        const profile = findProfileByIdentifier(id);
        return profile ? resolveScopeId(profile) : normalizeId(id);
    },
    areServerProfileIdentifiersEquivalent: (left: unknown, right: unknown) => {
        const leftId = normalizeId(left);
        const rightId = normalizeId(right);
        if (!leftId || !rightId) return false;
        if (leftId === rightId) return true;
        const leftProfile = findProfileByIdentifier(leftId);
        const rightProfile = findProfileByIdentifier(rightId);
        return Boolean(leftProfile && rightProfile && leftProfile.id === rightProfile.id);
    },
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: (...args: unknown[]) => getActiveServerSnapshotSpy(...args),
}));

describe('resolveServerScopedContext', () => {
    afterEach(() => {
        getCredentialsSpy.mockReset();
        createEncryptionSpy.mockReset();
        listServerProfilesSpy.mockReset();
        getActiveServerSnapshotSpy.mockReset();
    });

    it('returns active scope when serverId is missing', async () => {
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            generation: 1,
        });

        const { resolveServerScopedContext } = await import('./resolveServerScopedContext');
        const context = await resolveServerScopedContext({
            machineId: 'machine-1',
        });

        expect(context).toEqual({
            scope: 'active',
            machineId: 'machine-1',
            timeoutMs: 30000,
        });
    });

    it('returns active scope when the target profile id aliases the active durable server identity', async () => {
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'srv_server_a',
            serverUrl: 'https://server-a.example.test',
            generation: 1,
        });
        listServerProfilesSpy.mockReturnValue([
            {
                id: 'localhost-52753',
                serverIdentityId: 'srv_server_a',
                serverUrl: 'https://server-a.example.test',
                name: 'Server A',
            },
        ]);
        getCredentialsSpy.mockResolvedValue({ token: 'token-a', secret: 'secret-a' });

        const { resolveServerScopedContext } = await import('./resolveServerScopedContext');
        const context = await resolveServerScopedContext({
            machineId: 'machine-1',
            serverId: 'localhost-52753',
        });

        expect(context).toEqual({
            scope: 'active',
            machineId: 'machine-1',
            timeoutMs: 30000,
        });
        expect(getCredentialsSpy).not.toHaveBeenCalled();
    });

    it('returns scoped context with credentials and encryption when target differs from active server', async () => {
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            generation: 1,
        });
        listServerProfilesSpy.mockReturnValue([
            { id: 'server-b', serverUrl: 'https://server-b.example.test', name: 'Server B' },
        ]);
        getCredentialsSpy.mockResolvedValue({ token: 'token-b', secret: 'secret-b' });
        const fakeEncryption = {
            decryptEncryptionKey: vi.fn(async () => null),
            initializeMachines: vi.fn(async () => {}),
            getMachineEncryption: vi.fn(),
        };
        createEncryptionSpy.mockResolvedValue(fakeEncryption);

        const { resolveServerScopedContext } = await import('./resolveServerScopedContext');
        const context = await resolveServerScopedContext({
            machineId: 'machine-1',
            serverId: 'server-b',
            timeoutMs: 5000,
        });

        expect(context).toEqual({
            scope: 'scoped',
            machineId: 'machine-1',
            timeoutMs: 5000,
            targetServerId: 'server-b',
            targetServerUrl: 'https://server-b.example.test',
            token: 'token-b',
            encryption: fakeEncryption,
        });
    });

    it('can force scoped context for the active server', async () => {
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            generation: 1,
        });
        getCredentialsSpy.mockResolvedValue({ token: 'token-a', secret: 'secret-a' });
        const fakeEncryption = {
            decryptEncryptionKey: vi.fn(async () => null),
            initializeMachines: vi.fn(async () => {}),
            getMachineEncryption: vi.fn(),
        };
        createEncryptionSpy.mockResolvedValue(fakeEncryption);

        const { resolveServerScopedContext } = await import('./resolveServerScopedContext');
        const context = await resolveServerScopedContext({
            machineId: 'machine-1',
            forceScoped: true,
            timeoutMs: 5000,
        });

        expect(context).toEqual({
            scope: 'scoped',
            machineId: 'machine-1',
            timeoutMs: 5000,
            targetServerId: 'server-a',
            targetServerUrl: 'https://server-a.example.test',
            token: 'token-a',
            encryption: fakeEncryption,
        });
    });
});
