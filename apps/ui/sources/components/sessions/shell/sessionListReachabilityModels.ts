import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import { resolveSessionWorkspacePresentation } from '@/sync/domains/session/listing/sessionWorkspacePresentation';
import type { SessionListViewItem } from '@/sync/domains/state/storage';
import { readDisplayMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { sessionTagKey } from './sessionTagUtils';

type SessionReachableDisplay = Readonly<{
    machineId: string | null;
    machineLabel: string;
    workspaceSubtitle: string;
    workspaceSubtitleEllipsizeMode: 'head' | 'tail';
}>;

export type SessionListReachabilityModels = Readonly<{
    reachableSessionDisplayByKey: Map<string, SessionReachableDisplay>;
    hasMultipleMachines: boolean;
}>;

type SessionListReachabilityCacheEntry = Readonly<{
    display: SessionReachableDisplay;
    machineKey: string;
    machinesById: Readonly<Record<string, MachineDisplayRenderable>>;
    session: Extract<SessionListViewItem, { type: 'session' }>['session'];
    workspaceLabelsV1: Readonly<Record<string, string>>;
}>;

export type SessionListReachabilityModelsCache = {
    entriesByKey: Map<string, SessionListReachabilityCacheEntry>;
    previousKeys: readonly string[];
    previousModels: SessionListReachabilityModels | null;
};

const EMPTY_REACHABILITY_MODELS: SessionListReachabilityModels = {
    reachableSessionDisplayByKey: new Map<string, SessionReachableDisplay>(),
    hasMultipleMachines: false,
};

export function createSessionListReachabilityModelsCache(): SessionListReachabilityModelsCache {
    return {
        entriesByKey: new Map<string, SessionListReachabilityCacheEntry>(),
        previousKeys: [],
        previousModels: null,
    };
}

function resolveReachableDisplayRowKey(item: Extract<SessionListViewItem, { type: 'session' }>): string {
    const serverId = typeof item.serverId === 'string' ? item.serverId.trim() : '';
    const sessionId = String(item.session.id);
    return serverId ? sessionTagKey(serverId, sessionId) : sessionId;
}

function resolveMachineKey(display: SessionReachableDisplay): string {
    return display.machineId ?? display.machineLabel ?? '';
}

function buildSessionReachableDisplay(input: Readonly<{
    item: Extract<SessionListViewItem, { type: 'session' }>;
    machinesById: Readonly<Record<string, MachineDisplayRenderable>>;
    workspaceLabelsV1: Readonly<Record<string, string>>;
}>): Readonly<{
    display: SessionReachableDisplay;
    machineKey: string;
}> {
    const target = readDisplayMachineTargetForSession({
        sessionId: input.item.session.id,
        metadata: input.item.session?.metadata ?? null,
    });
    const workspace = resolveSessionWorkspacePresentation({
        metadata: input.item.session?.metadata ?? null,
        machines: input.machinesById,
        target,
        workspaceLabelsV1: input.workspaceLabelsV1,
    });
    const display = {
        machineId: workspace.machineId,
        machineLabel: workspace.machineLabel,
        workspaceSubtitle: workspace.displayTitle,
        workspaceSubtitleEllipsizeMode: workspace.hasCustomLabel ? 'tail' : 'head',
    } satisfies SessionReachableDisplay;

    return {
        display,
        machineKey: resolveMachineKey(display),
    };
}

function canReuseReachabilityEntry(input: Readonly<{
    cached: SessionListReachabilityCacheEntry | undefined;
    item: Extract<SessionListViewItem, { type: 'session' }>;
    machinesById: Readonly<Record<string, MachineDisplayRenderable>>;
    workspaceLabelsV1: Readonly<Record<string, string>>;
}>): input is Readonly<{
    cached: SessionListReachabilityCacheEntry;
    item: Extract<SessionListViewItem, { type: 'session' }>;
    machinesById: Readonly<Record<string, MachineDisplayRenderable>>;
    workspaceLabelsV1: Readonly<Record<string, string>>;
}> {
    return input.cached != null
        && input.cached.session === input.item.session
        && input.cached.machinesById === input.machinesById
        && input.cached.workspaceLabelsV1 === input.workspaceLabelsV1;
}

function areReachabilityModelKeysAndDisplaysEqual(input: Readonly<{
    previousKeys: readonly string[];
    previousModels: SessionListReachabilityModels | null;
    nextKeys: readonly string[];
    nextDisplayByKey: ReadonlyMap<string, SessionReachableDisplay>;
}>): boolean {
    if (!input.previousModels) return false;
    if (input.previousKeys.length !== input.nextKeys.length) return false;
    for (let index = 0; index < input.nextKeys.length; index += 1) {
        const key = input.nextKeys[index];
        if (input.previousKeys[index] !== key) return false;
        if (input.previousModels.reachableSessionDisplayByKey.get(key) !== input.nextDisplayByKey.get(key)) {
            return false;
        }
    }
    return true;
}

export function buildSessionListReachabilityModels(input: Readonly<{
    items: ReadonlyArray<SessionListViewItem> | null | undefined;
    machinesById: Readonly<Record<string, MachineDisplayRenderable>>;
    workspaceLabelsV1: Readonly<Record<string, string>>;
    cache?: SessionListReachabilityModelsCache;
}>): SessionListReachabilityModels {
    const items = input.items;
    if (!items || items.length === 0) {
        if (input.cache) {
            input.cache.entriesByKey.clear();
            input.cache.previousKeys = [];
            input.cache.previousModels = EMPTY_REACHABILITY_MODELS;
        }
        return EMPTY_REACHABILITY_MODELS;
    }

    const reachableSessionDisplayByKey = new Map<string, SessionReachableDisplay>();
    const machineIds = new Set<string>();
    const nextCacheEntriesByKey = input.cache ? new Map<string, SessionListReachabilityCacheEntry>() : null;
    const nextKeys: string[] = [];

    for (const item of items) {
        if (item.type !== 'session') continue;
        const key = resolveReachableDisplayRowKey(item);
        const cached = input.cache?.entriesByKey.get(key);
        const canReuse = canReuseReachabilityEntry({
            cached,
            item,
            machinesById: input.machinesById,
            workspaceLabelsV1: input.workspaceLabelsV1,
        });
        const entry: SessionListReachabilityCacheEntry = canReuse && cached
            ? cached
            : (() => {
                const result = buildSessionReachableDisplay({
                    item,
                    machinesById: input.machinesById,
                    workspaceLabelsV1: input.workspaceLabelsV1,
                });
                return {
                    display: result.display,
                    machineKey: result.machineKey,
                    machinesById: input.machinesById,
                    session: item.session,
                    workspaceLabelsV1: input.workspaceLabelsV1,
                } satisfies SessionListReachabilityCacheEntry;
            })();

        reachableSessionDisplayByKey.set(key, entry.display);
        nextCacheEntriesByKey?.set(key, entry);
        nextKeys.push(key);
        if (entry.machineKey) machineIds.add(entry.machineKey);
    }

    if (reachableSessionDisplayByKey.size === 0) {
        if (input.cache) {
            input.cache.entriesByKey.clear();
            input.cache.previousKeys = [];
            input.cache.previousModels = EMPTY_REACHABILITY_MODELS;
        }
        return EMPTY_REACHABILITY_MODELS;
    }

    if (input.cache) {
        if (areReachabilityModelKeysAndDisplaysEqual({
            previousKeys: input.cache.previousKeys,
            previousModels: input.cache.previousModels,
            nextKeys,
            nextDisplayByKey: reachableSessionDisplayByKey,
        })) {
            if (nextCacheEntriesByKey) input.cache.entriesByKey = nextCacheEntriesByKey;
            return input.cache.previousModels as SessionListReachabilityModels;
        }
    }

    const models = {
        reachableSessionDisplayByKey,
        hasMultipleMachines: machineIds.size > 1,
    } satisfies SessionListReachabilityModels;

    if (input.cache) {
        if (nextCacheEntriesByKey) input.cache.entriesByKey = nextCacheEntriesByKey;
        input.cache.previousKeys = nextKeys;
        input.cache.previousModels = models;
    }

    return models;
}
