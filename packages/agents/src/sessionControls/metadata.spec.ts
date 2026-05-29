import { describe, expect, it } from 'vitest';

import {
    LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY,
    SESSION_MODE_OVERRIDE_KEY,
} from './metadataKeys.js';
import {
    resolveMetadataStringOverrideStateV1,
    resolveMetadataStringOverrideStateV1FromAliases,
    resolveMetadataStringOverrideV1,
} from './metadata.js';

describe('resolveMetadataStringOverrideStateV1', () => {
    it('returns a cleared state for explicit null tombstones', () => {
        expect(resolveMetadataStringOverrideStateV1(
            { sessionModeOverrideV1: { v: 1, updatedAt: 101, modeId: null } },
            SESSION_MODE_OVERRIDE_KEY,
            'modeId',
        )).toEqual({ state: 'cleared', updatedAt: 101 });
    });

    it('returns a cleared state for whitespace tombstones', () => {
        expect(resolveMetadataStringOverrideStateV1(
            { sessionModeOverrideV1: { v: 1, updatedAt: 102, modeId: '   ' } },
            SESSION_MODE_OVERRIDE_KEY,
            'modeId',
        )).toEqual({ state: 'cleared', updatedAt: 102 });
    });

    it('ignores malformed override objects that omit the value key', () => {
        expect(resolveMetadataStringOverrideStateV1(
            { sessionModeOverrideV1: { v: 1, updatedAt: 103 } },
            SESSION_MODE_OVERRIDE_KEY,
            'modeId',
        )).toBeNull();
    });

    it('keeps the legacy string override reader set-only', () => {
        expect(resolveMetadataStringOverrideV1(
            { sessionModeOverrideV1: { v: 1, updatedAt: 104, modeId: null } },
            SESSION_MODE_OVERRIDE_KEY,
            'modeId',
        )).toBeNull();
    });
});

describe('resolveMetadataStringOverrideStateV1FromAliases', () => {
    it('prefers a newer canonical clear over a stale legacy value', () => {
        expect(resolveMetadataStringOverrideStateV1FromAliases(
            {
                sessionModeOverrideV1: { v: 1, updatedAt: 101, modeId: null },
                acpSessionModeOverrideV1: { v: 1, updatedAt: 10, modeId: 'plan' },
            },
            [SESSION_MODE_OVERRIDE_KEY, LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY],
            'modeId',
        )).toEqual({ state: 'cleared', updatedAt: 101 });
    });

    it('prefers a newer legacy clear over a stale canonical value', () => {
        expect(resolveMetadataStringOverrideStateV1FromAliases(
            {
                sessionModeOverrideV1: { v: 1, updatedAt: 10, modeId: 'plan' },
                acpSessionModeOverrideV1: { v: 1, updatedAt: 101, modeId: null },
            },
            [SESSION_MODE_OVERRIDE_KEY, LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY],
            'modeId',
        )).toEqual({ state: 'cleared', updatedAt: 101 });
    });

    it('prefers the canonical state when alias timestamps tie', () => {
        expect(resolveMetadataStringOverrideStateV1FromAliases(
            {
                sessionModeOverrideV1: { v: 1, updatedAt: 101, modeId: 'plan' },
                acpSessionModeOverrideV1: { v: 1, updatedAt: 101, modeId: null },
            },
            [SESSION_MODE_OVERRIDE_KEY, LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY],
            'modeId',
        )).toEqual({ state: 'set', value: 'plan', updatedAt: 101 });
    });
});
