import {
    loadPersistedSessionDraftValues,
    savePersistedSessionDraftValues,
    type PersistedSessionDraftValueEnvelope,
    type PersistedSessionDraftValuesBySessionId,
} from '@/sync/domains/state/sessionDraftValuesPersistence';
import { sessionDraftValuesStorageKey } from '@/sync/domains/state/sessionLocalStateKeys';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    getSessionDraftValueFieldDefinition,
    isSessionDraftValueFieldId,
    SESSION_DRAFT_VALUE_FIELD_IDS,
} from './sessionDraftValueFieldCatalog';
import type {
    SessionDraftValueByFieldId,
    SessionDraftValueFieldId,
    SessionDraftValueLifecycle,
} from './sessionDraftValueTypes';

export { SESSION_DRAFT_VALUE_FIELD_IDS };
export type {
    ComposerSkillMention,
    ComposerStructuredInputMention,
    ComposerVendorPluginMention,
    SessionComposerExecutionRunDeliveryMode,
    SessionDraftValueByFieldId,
    SessionDraftValueFieldId,
    SessionDraftValueLifecycle,
} from './sessionDraftValueTypes';

type ScopeCache = {
    values: PersistedSessionDraftValuesBySessionId;
    dirty: boolean;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const cachesByScopeKey = new Map<string, ScopeCache>();

function areJsonValuesEqual(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

function sanitizeSessionId(sessionId: string): string | null {
    const trimmed = sessionId.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function getCacheKey(scope?: ServerAccountScope | null): string {
    return sessionDraftValuesStorageKey(scope);
}

function shouldClearForLifecycle(fieldId: SessionDraftValueFieldId, lifecycle: SessionDraftValueLifecycle): boolean {
    const clearOn = getSessionDraftValueFieldDefinition(fieldId).clearOn;
    if (lifecycle === 'outboundHandoff') return clearOn.send === 'outboundHandoff';
    if (lifecycle === 'composerCleared') return clearOn.composerClear === true;
    if (lifecycle === 'sessionDeleted') return clearOn.sessionDelete !== false;
    return clearOn.abort === true;
}

function parseEnvelopeForField<TFieldId extends SessionDraftValueFieldId>(
    fieldId: TFieldId,
    envelope: PersistedSessionDraftValueEnvelope,
): PersistedSessionDraftValueEnvelope | null {
    const definition = getSessionDraftValueFieldDefinition(fieldId);
    if (envelope.v !== definition.version) return null;
    const parsed = definition.schema.safeParse(envelope.value);
    if (!parsed.success) return null;
    if (areJsonValuesEqual(parsed.data, envelope.value)) return envelope;
    return {
        v: envelope.v,
        lastEditedAt: envelope.lastEditedAt,
        value: parsed.data,
    };
}

function sanitizeWithCatalog(values: PersistedSessionDraftValuesBySessionId): {
    values: PersistedSessionDraftValuesBySessionId;
    changed: boolean;
} {
    const sanitized: PersistedSessionDraftValuesBySessionId = {};
    let changed = false;

    for (const [sessionId, fields] of Object.entries(values)) {
        const nextFields: Record<string, PersistedSessionDraftValueEnvelope> = {};
        for (const [fieldId, envelope] of Object.entries(fields)) {
            if (!isSessionDraftValueFieldId(fieldId)) {
                changed = true;
                continue;
            }
            const parsed = parseEnvelopeForField(fieldId, envelope);
            if (!parsed) {
                changed = true;
                continue;
            }
            nextFields[fieldId] = parsed;
            if (parsed !== envelope) changed = true;
        }
        if (Object.keys(nextFields).length > 0) {
            sanitized[sessionId] = nextFields;
        } else if (Object.keys(fields).length > 0) {
            changed = true;
        }
    }
    return { values: sanitized, changed };
}

function getScopeCache(scope?: ServerAccountScope | null): ScopeCache {
    const key = getCacheKey(scope);
    const existing = cachesByScopeKey.get(key);
    if (existing) return existing;
    const sanitized = sanitizeWithCatalog(loadPersistedSessionDraftValues(scope));
    const cache = {
        values: sanitized.values,
        dirty: sanitized.changed,
    };
    cachesByScopeKey.set(key, cache);
    return cache;
}

function pruneSessionIfEmpty(values: PersistedSessionDraftValuesBySessionId, sessionId: string): void {
    if (values[sessionId] && Object.keys(values[sessionId]).length === 0) {
        delete values[sessionId];
    }
}

export function readSessionDraftValue<TFieldId extends SessionDraftValueFieldId>(
    scope: ServerAccountScope | null | undefined,
    sessionId: string,
    fieldId: TFieldId,
): SessionDraftValueByFieldId[TFieldId] | undefined {
    const normalizedSessionId = sanitizeSessionId(sessionId);
    if (!normalizedSessionId) return undefined;
    const envelope = getScopeCache(scope).values[normalizedSessionId]?.[fieldId];
    if (!envelope) return undefined;
    const parsed = parseEnvelopeForField(fieldId, envelope);
    return parsed?.value as SessionDraftValueByFieldId[TFieldId] | undefined;
}

export function writeSessionDraftValue<TFieldId extends SessionDraftValueFieldId>(
    scope: ServerAccountScope | null | undefined,
    sessionId: string,
    fieldId: TFieldId,
    value: SessionDraftValueByFieldId[TFieldId],
    options: Readonly<{ now?: number; flush?: boolean }> = {},
): void {
    const normalizedSessionId = sanitizeSessionId(sessionId);
    if (!normalizedSessionId) return;
    const definition = getSessionDraftValueFieldDefinition(fieldId);
    const parsed = definition.schema.safeParse(value);
    if (!parsed.success) return;

    const cache = getScopeCache(scope);
    const sessionValues = cache.values[normalizedSessionId] ?? {};
    const nextEnvelope: PersistedSessionDraftValueEnvelope = {
        v: definition.version,
        lastEditedAt: options.now ?? Date.now(),
        value: parsed.data,
    };
    const previous = sessionValues[fieldId];
    if (previous && previous.v === nextEnvelope.v && areJsonValuesEqual(previous.value, nextEnvelope.value)) {
        return;
    }
    cache.values[normalizedSessionId] = {
        ...sessionValues,
        [fieldId]: nextEnvelope,
    };
    cache.dirty = true;
    if (options.flush !== false) {
        flushSessionDraftValues(scope);
    }
}

export function clearSessionDraftValue(
    scope: ServerAccountScope | null | undefined,
    sessionId: string,
    fieldId: SessionDraftValueFieldId,
    options: Readonly<{ flush?: boolean }> = {},
): void {
    const normalizedSessionId = sanitizeSessionId(sessionId);
    if (!normalizedSessionId) return;
    const cache = getScopeCache(scope);
    const sessionValues = cache.values[normalizedSessionId];
    if (!sessionValues || !Object.prototype.hasOwnProperty.call(sessionValues, fieldId)) return;
    delete sessionValues[fieldId];
    pruneSessionIfEmpty(cache.values, normalizedSessionId);
    cache.dirty = true;
    if (options.flush !== false) {
        flushSessionDraftValues(scope);
    }
}

export function clearSessionDraftValues(
    scope: ServerAccountScope | null | undefined,
    sessionId: string,
    options: Readonly<{ lifecycle: SessionDraftValueLifecycle; flush?: boolean }>,
): void {
    const normalizedSessionId = sanitizeSessionId(sessionId);
    if (!normalizedSessionId) return;
    const cache = getScopeCache(scope);
    const sessionValues = cache.values[normalizedSessionId];
    if (!sessionValues) return;

    let changed = false;
    for (const fieldId of SESSION_DRAFT_VALUE_FIELD_IDS) {
        if (Object.prototype.hasOwnProperty.call(sessionValues, fieldId) && shouldClearForLifecycle(fieldId, options.lifecycle)) {
            delete sessionValues[fieldId];
            changed = true;
        }
    }
    if (!changed) return;
    pruneSessionIfEmpty(cache.values, normalizedSessionId);
    cache.dirty = true;
    if (options.flush !== false) {
        flushSessionDraftValues(scope);
    }
}

export function garbageCollectSessionDraftValues(
    scope: ServerAccountScope | null | undefined,
    options: Readonly<{ now: number; reason: 'scopeActivated' | 'foreground' | 'idle'; flush?: boolean }>,
): void {
    const cache = getScopeCache(scope);
    let changed = false;

    for (const [sessionId, fields] of Object.entries(cache.values)) {
        for (const fieldId of SESSION_DRAFT_VALUE_FIELD_IDS) {
            const envelope = fields[fieldId];
            if (!envelope) continue;
            const ttlDays = getSessionDraftValueFieldDefinition(fieldId).clearOn.ttlDays;
            if (typeof ttlDays !== 'number') continue;
            if (options.now - envelope.lastEditedAt > ttlDays * MS_PER_DAY) {
                delete fields[fieldId];
                changed = true;
            }
        }
        pruneSessionIfEmpty(cache.values, sessionId);
    }

    if (!changed) return;
    cache.dirty = true;
    if (options.flush !== false) {
        flushSessionDraftValues(scope);
    }
}

export function flushSessionDraftValues(scope?: ServerAccountScope | null): void {
    const cache = getScopeCache(scope);
    if (!cache.dirty) return;
    savePersistedSessionDraftValues(cache.values, scope);
    cache.dirty = false;
}

export function invalidateSessionDraftValuesCache(scope?: ServerAccountScope | null): void {
    cachesByScopeKey.delete(getCacheKey(scope));
}

export function resetSessionDraftValuesCachesForTests(): void {
    cachesByScopeKey.clear();
}
