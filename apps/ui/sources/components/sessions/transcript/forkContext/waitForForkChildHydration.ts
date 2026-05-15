import type { Metadata } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';

const DEFAULT_FORK_HYDRATION_TIMEOUT_MS = 2500;
const DEFAULT_FORK_HYDRATION_POLL_INTERVAL_MS = 50;

export type ForkChildHydrationResult = Readonly<{
    hydrated: boolean;
    timedOut: boolean;
}>;

function readForkMetadataVersion(metadata: Metadata | null | undefined): number | null {
    if (!metadata || typeof metadata !== 'object') return null;
    const fork = (metadata as Record<string, unknown>).forkV1;
    if (!fork || typeof fork !== 'object' || Array.isArray(fork)) return null;
    const version = (fork as Record<string, unknown>).v;
    return typeof version === 'number' ? version : null;
}

function hasForkV1Metadata(sessionId: string): boolean {
    const session = storage.getState().sessions[sessionId];
    return readForkMetadataVersion(session?.metadata as Metadata | null | undefined) === 1;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForForkChildHydration(params: Readonly<{
    childSessionId: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
}>): Promise<ForkChildHydrationResult> {
    await sync.ensureSessionVisibleForMessageRoute(params.childSessionId, { forceRefresh: true });

    if (hasForkV1Metadata(params.childSessionId)) {
        return { hydrated: true, timedOut: false };
    }

    const timeoutMs = params.timeoutMs ?? DEFAULT_FORK_HYDRATION_TIMEOUT_MS;
    const pollIntervalMs = params.pollIntervalMs ?? DEFAULT_FORK_HYDRATION_POLL_INTERVAL_MS;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        await delay(pollIntervalMs);
        if (hasForkV1Metadata(params.childSessionId)) {
            return { hydrated: true, timedOut: false };
        }
    }

    return { hydrated: false, timedOut: true };
}
