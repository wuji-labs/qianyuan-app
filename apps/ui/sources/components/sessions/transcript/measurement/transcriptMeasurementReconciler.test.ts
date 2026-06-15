import { describe, expect, it } from 'vitest';

import { createTestTranscriptMeasurementReconciler } from './transcriptMeasurementReconciler';
import type { TranscriptItemHeightValiditySignature } from './transcriptItemHeightCache';

function streamingSignature(
    overrides: Partial<TranscriptItemHeightValiditySignature> = {},
): TranscriptItemHeightValiditySignature {
    return {
        itemId: 'message-1',
        kind: 'message:agent',
        structuralKey: 'message-1:content-v1',
        widthBucket: 'width:400',
        fontScaleKey: 'font:1',
        groupingMode: 'turn',
        forkContextKey: 'root',
        expansionKey: 'tools:none|thinking:none',
        rowState: 'streaming',
        ...overrides,
    };
}

function stableSignature(
    overrides: Partial<TranscriptItemHeightValiditySignature> = {},
): TranscriptItemHeightValiditySignature {
    return streamingSignature({ rowState: 'stable', ...overrides });
}

describe('transcriptMeasurementReconciler', () => {
    describe('resolveRecycleType is shape-stable across a stream (T2)', () => {
        it('returns the same recycle type for an agent message growing past the long-text threshold', () => {
            const reconciler = createTestTranscriptMeasurementReconciler();
            const short = streamingSignature({ structuralKey: 'message-1:a'.repeat(1) });
            const long = streamingSignature({ structuralKey: 'message-1:a'.repeat(4096) });

            expect(reconciler.resolveRecycleType(short)).toBe('message:agent');
            expect(reconciler.resolveRecycleType(long)).toBe('message:agent');
            expect(reconciler.resolveRecycleType(short)).toBe(reconciler.resolveRecycleType(long));
        });

        it('does not flip the recycle type as a streaming row transitions to stable', () => {
            const reconciler = createTestTranscriptMeasurementReconciler();
            const streaming = streamingSignature();
            const stable = stableSignature();

            expect(reconciler.resolveRecycleType(streaming)).toBe(reconciler.resolveRecycleType(stable));
        });
    });

    describe('streaming floor is monotonic and never over-reserves (T1)', () => {
        it('raises the floor with each larger measured height and never reports below the last height', () => {
            const reconciler = createTestTranscriptMeasurementReconciler();
            const signature = streamingSignature();

            for (const heightPx of [120, 180, 240]) {
                reconciler.recordMeasuredHeight({ signature, heightPx });
            }

            const reservation = reconciler.resolveReservation(signature);
            expect(reservation).toEqual({ kind: 'floor', minHeight: 240 });
        });

        it('keeps the floor at the peak when a later measurement is smaller within the same shape', () => {
            const reconciler = createTestTranscriptMeasurementReconciler();
            const signature = streamingSignature();

            reconciler.recordMeasuredHeight({ signature, heightPx: 240 });
            reconciler.recordMeasuredHeight({ signature, heightPx: 180 });

            expect(reconciler.resolveReservation(signature)).toEqual({ kind: 'floor', minHeight: 240 });
        });

        it('returns undefined for a streaming row that has never been measured and has no per-type sample', () => {
            const reconciler = createTestTranscriptMeasurementReconciler();
            expect(reconciler.resolveReservation(streamingSignature())).toBeUndefined();
        });
    });

    describe('the floor resets on structural change (collapse/shrink)', () => {
        it('drops the floor on a structural reset so a collapse leaves no persistent over-reservation', () => {
            const reconciler = createTestTranscriptMeasurementReconciler();
            const expanded = streamingSignature({ expansionKey: 'tools:expanded|thinking:none' });
            reconciler.recordMeasuredHeight({ signature: expanded, heightPx: 240 });
            expect(reconciler.resolveReservation(expanded)).toEqual({ kind: 'floor', minHeight: 240 });

            const collapsed = streamingSignature({ expansionKey: 'tools:collapsed|thinking:none' });
            reconciler.resetReservationForStructuralChange({ itemId: collapsed.itemId, signature: collapsed });

            const reservation = reconciler.resolveReservation(collapsed);
            expect(reservation === undefined || reservation.minHeight < 240).toBe(true);
        });
    });

    describe('the floor key is width/font scoped (T0 geometry)', () => {
        it('survives content-revision churn but misses on a width change', () => {
            const reconciler = createTestTranscriptMeasurementReconciler();
            const atWidth400 = streamingSignature({ widthBucket: 'width:400' });
            reconciler.recordMeasuredHeight({ signature: atWidth400, heightPx: 200 });

            const tokenChurn = streamingSignature({ widthBucket: 'width:400', structuralKey: 'message-1:content-v9' });
            expect(reconciler.resolveReservation(tokenChurn)).toEqual({ kind: 'floor', minHeight: 200 });

            const atWidth640 = streamingSignature({ widthBucket: 'width:640' });
            const reservationAtNewWidth = reconciler.resolveReservation(atWidth640);
            expect(reservationAtNewWidth === undefined || reservationAtNewWidth.minHeight !== 200).toBe(true);
        });
    });

    describe('first-seen rows reserve NOTHING — no per-type median over-reservation (C1 over-reservation fix)', () => {
        it('reserves undefined for a never-measured row even when other rows of the same shape-type were measured', () => {
            // Regression for the over-reservation bug: shape-only getItemType merges short+long agent
            // rows into one recycle type, so a per-type median would force-reserve a short first-seen
            // row too tall — and a content `minHeight` is self-fulfilling (onLayout measures the forced
            // height), so it never recovers. A first-seen row must reserve NOTHING and measure naturally.
            const reconciler = createTestTranscriptMeasurementReconciler();
            for (const itemId of ['agent-a', 'agent-b', 'agent-c']) {
                reconciler.recordMeasuredHeight({
                    signature: stableSignature({ itemId, kind: 'message:agent' }),
                    heightPx: 150,
                });
            }

            const newRow = streamingSignature({ itemId: 'agent-new', kind: 'message:agent', structuralKey: 'agent-new:v1' });
            expect(reconciler.resolveReservation(newRow)).toBeUndefined();
        });

        it('returns undefined for a never-measured row with no prior measurements', () => {
            const reconciler = createTestTranscriptMeasurementReconciler();
            const newRow = streamingSignature({ itemId: 'agent-new', kind: 'message:agent' });
            expect(reconciler.resolveReservation(newRow)).toBeUndefined();
        });
    });

    describe('exact reservation for stable rows (composes the height cache)', () => {
        it('returns an exact reservation equal to the last measured height for a stable row', () => {
            const reconciler = createTestTranscriptMeasurementReconciler();
            const signature = stableSignature();
            reconciler.recordMeasuredHeight({ signature, heightPx: 168 });

            expect(reconciler.resolveReservation(signature)).toEqual({ kind: 'exact', minHeight: 168 });
        });

        it('never serves a stale exact height when the stable content revision changes', () => {
            const reconciler = createTestTranscriptMeasurementReconciler();
            reconciler.recordMeasuredHeight({ signature: stableSignature({ structuralKey: 'v1' }), heightPx: 168 });

            const changed = stableSignature({ structuralKey: 'v2' });
            const reservation = reconciler.resolveReservation(changed);
            expect(reservation === undefined || reservation.kind === 'floor').toBe(true);
        });
    });

    describe('global layout invalidation is transaction-gated and coalesced per commit (R3)', () => {
        it('refuses to clear while a viewport transaction is open', () => {
            const reconciler = createTestTranscriptMeasurementReconciler();
            const decision = reconciler.requestGlobalLayoutInvalidation({
                previous: stableSignature({ expansionKey: 'tools:collapsed|thinking:none' }),
                next: stableSignature({ expansionKey: 'tools:expanded|thinking:none' }),
                viewportTransactionOpen: true,
                commitToken: 1,
            });
            expect(decision.clear).toBe(false);
            expect(decision.reason).toBe('viewport-transaction-open');
        });

        it('clears on a structural delta when no transaction is open', () => {
            const reconciler = createTestTranscriptMeasurementReconciler();
            const decision = reconciler.requestGlobalLayoutInvalidation({
                previous: stableSignature({ expansionKey: 'tools:collapsed|thinking:none' }),
                next: stableSignature({ expansionKey: 'tools:expanded|thinking:none' }),
                viewportTransactionOpen: false,
                commitToken: 1,
            });
            expect(decision.clear).toBe(true);
        });

        it('clears at most once per commit token', () => {
            const reconciler = createTestTranscriptMeasurementReconciler();
            const input = {
                previous: stableSignature({ expansionKey: 'tools:collapsed|thinking:none' }),
                next: stableSignature({ expansionKey: 'tools:expanded|thinking:none' }),
                viewportTransactionOpen: false,
                commitToken: 7,
            } as const;
            expect(reconciler.requestGlobalLayoutInvalidation(input).clear).toBe(true);
            const second = reconciler.requestGlobalLayoutInvalidation(input);
            expect(second.clear).toBe(false);
            expect(second.reason).toBe('already-cleared-this-commit');
        });

        it('clears for an explicit structural request (a discrete expand/collapse with no signature pair)', () => {
            const reconciler = createTestTranscriptMeasurementReconciler();
            expect(reconciler.requestGlobalLayoutInvalidation({
                structural: true,
                viewportTransactionOpen: false,
                commitToken: 1,
            }).clear).toBe(true);
        });

        it('does not clear for a non-structural explicit request', () => {
            const reconciler = createTestTranscriptMeasurementReconciler();
            const decision = reconciler.requestGlobalLayoutInvalidation({
                structural: false,
                viewportTransactionOpen: false,
                commitToken: 1,
            });
            expect(decision.clear).toBe(false);
            expect(decision.reason).toBe('append-no-structural-delta');
        });

        it('gates an explicit structural request while a transaction is open', () => {
            const reconciler = createTestTranscriptMeasurementReconciler();
            const decision = reconciler.requestGlobalLayoutInvalidation({
                structural: true,
                viewportTransactionOpen: true,
                commitToken: 1,
            });
            expect(decision.clear).toBe(false);
            expect(decision.reason).toBe('viewport-transaction-open');
        });

        it('never clears for a pure streaming append delta', () => {
            const reconciler = createTestTranscriptMeasurementReconciler();
            const decision = reconciler.requestGlobalLayoutInvalidation({
                previous: streamingSignature({ structuralKey: 'v1' }),
                next: streamingSignature({ structuralKey: 'v2' }),
                viewportTransactionOpen: false,
                commitToken: 1,
            });
            expect(decision.clear).toBe(false);
            expect(decision.reason).toBe('append-no-structural-delta');
        });

        it('never clears on a stream-finalize (streaming -> stable) so the bottom-pin is not dropped', () => {
            // Regression: a message finalizing (or a tool arriving, which flips row state) must NOT
            // trigger a whole-list clearLayoutCacheOnUpdate — that resets FlashList bottom-maintenance
            // and appends the next content below the viewport. The per-row onLayout already holds the
            // finalized height; the global clear is reserved for re-stacks between two settled rows.
            const reconciler = createTestTranscriptMeasurementReconciler();
            const decision = reconciler.requestGlobalLayoutInvalidation({
                previous: streamingSignature(),
                next: stableSignature(),
                viewportTransactionOpen: false,
                commitToken: 1,
            });
            expect(decision.clear).toBe(false);
            expect(decision.reason).toBe('append-no-structural-delta');
        });
    });

    describe('session lifecycle reset', () => {
        it('drops floors on resetForSession', () => {
            const reconciler = createTestTranscriptMeasurementReconciler();
            const signature = streamingSignature();
            reconciler.recordMeasuredHeight({ signature, heightPx: 240 });
            expect(reconciler.resolveReservation(signature)).toEqual({ kind: 'floor', minHeight: 240 });

            reconciler.resetForSession('next-session');

            expect(reconciler.resolveReservation(signature)).toBeUndefined();
        });
    });

    describe('fail-safe reservation', () => {
        it('ignores non-finite or non-positive measured heights', () => {
            const reconciler = createTestTranscriptMeasurementReconciler();
            const signature = streamingSignature();
            reconciler.recordMeasuredHeight({ signature, heightPx: Number.NaN });
            reconciler.recordMeasuredHeight({ signature, heightPx: 0 });
            reconciler.recordMeasuredHeight({ signature, heightPx: -10 });

            expect(reconciler.resolveReservation(signature)).toBeUndefined();
        });
    });
});
