import { describe, expect, it } from 'vitest';

import {
    resolveWebColdListScrollTarget,
    resolveWebHotColdScrollDecision,
} from './resolveWebHotColdScrollDecision';

describe('resolveWebHotColdScrollDecision', () => {
    it('scrolls to the cold index when the target is within cold items', () => {
        expect(resolveWebHotColdScrollDecision({ fullIndex: 3, coldCount: 10 })).toEqual({ kind: 'cold', index: 3 });
    });

    it('scrolls to the last cold index when the target is in the hot tail', () => {
        expect(resolveWebHotColdScrollDecision({ fullIndex: 10, coldCount: 10 })).toEqual({ kind: 'cold', index: 9 });
        expect(resolveWebHotColdScrollDecision({ fullIndex: 999, coldCount: 2 })).toEqual({ kind: 'cold', index: 1 });
    });

    it('pins to bottom when there are no cold items', () => {
        expect(resolveWebHotColdScrollDecision({ fullIndex: 0, coldCount: 0 })).toEqual({ kind: 'pin_to_bottom' });
    });

    it('maps every web scrollToIndex target through the cold-list data boundary', () => {
        expect(resolveWebColdListScrollTarget({
            fullIndex: 12,
            coldCount: 5,
            reason: 'prepend-recovery',
        })).toEqual({ kind: 'cold', index: 4, fullIndex: 12, reason: 'prepend-recovery' });

        expect(resolveWebColdListScrollTarget({
            fullIndex: 1,
            coldCount: 5,
            reason: 'jump-to-seq',
        })).toEqual({ kind: 'cold', index: 1, fullIndex: 1, reason: 'jump-to-seq' });

        expect(resolveWebColdListScrollTarget({
            fullIndex: 1,
            coldCount: 0,
            reason: 'prepend-recovery',
        })).toEqual({ kind: 'pin_to_bottom', fullIndex: 1, reason: 'prepend-recovery' });
    });
});
