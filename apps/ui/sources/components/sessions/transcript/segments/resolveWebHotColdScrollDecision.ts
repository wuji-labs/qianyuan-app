export type WebHotColdScrollDecision =
    | Readonly<{ kind: 'cold'; index: number }>
    | Readonly<{ kind: 'pin_to_bottom' }>;

export type WebColdListScrollTargetReason =
    | 'jump-to-seq'
    | 'prepend-recovery'
    | 'restore-index';

export type WebColdListScrollTarget =
    | Readonly<{
        kind: 'cold';
        index: number;
        fullIndex: number;
        reason: WebColdListScrollTargetReason;
    }>
    | Readonly<{
        kind: 'pin_to_bottom';
        fullIndex: number;
        reason: WebColdListScrollTargetReason;
    }>;

export function resolveWebHotColdScrollDecision(params: Readonly<{ fullIndex: number; coldCount: number }>): WebHotColdScrollDecision {
    const fullIndex = Number.isFinite(params.fullIndex) ? Math.trunc(params.fullIndex) : -1;
    const coldCount = Number.isFinite(params.coldCount) ? Math.max(0, Math.trunc(params.coldCount)) : 0;

    if (coldCount <= 0) return { kind: 'pin_to_bottom' };
    if (fullIndex < 0) return { kind: 'cold', index: 0 };
    if (fullIndex < coldCount) return { kind: 'cold', index: fullIndex };

    // Hot-tail items render in a footer block; scroll to the last cold item to bring
    // the footer into view (and avoid out-of-bounds FlashList indices).
    return { kind: 'cold', index: Math.max(0, coldCount - 1) };
}

export function resolveWebColdListScrollTarget(params: Readonly<{
    fullIndex: number;
    coldCount: number;
    reason: WebColdListScrollTargetReason;
}>): WebColdListScrollTarget {
    const fullIndex = Number.isFinite(params.fullIndex) ? Math.trunc(params.fullIndex) : -1;
    const decision = resolveWebHotColdScrollDecision({
        fullIndex,
        coldCount: params.coldCount,
    });
    return decision.kind === 'cold'
        ? { ...decision, fullIndex, reason: params.reason }
        : { ...decision, fullIndex, reason: params.reason };
}
