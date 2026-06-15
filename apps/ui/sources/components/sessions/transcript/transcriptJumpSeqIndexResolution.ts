type TranscriptJumpSeqTurnContent = Readonly<
    | {
        kind: 'message';
        messageId?: unknown;
    }
    | {
        kind: 'tool_calls';
        toolMessageIds?: unknown;
    }
>;

type TranscriptJumpSeqTurn = Readonly<{
    userMessageId?: unknown;
    content?: unknown;
}>;

export type TranscriptJumpSeqResolvableItem = Readonly<{
    kind?: unknown;
    messageId?: unknown;
    toolMessageId?: unknown;
    seq?: unknown;
    turn?: TranscriptJumpSeqTurn;
}>;

/**
 * Resolves the list index for a jump-to-seq target within the currently loaded
 * transcript window.
 *
 * Contract with `jumpToTranscriptSeq`: returning `null` means "not resolvable yet" and
 * drives its load-older materialization loop. A target seq that lies BEFORE the loaded
 * window must therefore stay `null` while older pages may still exist — the
 * nearest-loaded fallback only applies once materialization cannot surface the target
 * (no more older pages, an in-window gap, or a target beyond the newest item).
 *
 * Per-unit tool-group rows (N2c): a `tool-group-tool` unit resolves its OWN seq
 * (`item.seq`, falling back to the resolver on its `toolMessageId`); the
 * header/expand/footer cap units resolve NO seqs, so a jump targeting a tool hidden
 * behind the collapsed preview lands on the nearest loaded seq — an adjacent row of
 * the same group.
 */
export function resolveTranscriptJumpSeqIndex(params: Readonly<{
    targetSeq: number;
    items: readonly TranscriptJumpSeqResolvableItem[];
    resolveSeqForMessageId: (messageId: string) => number | null | undefined;
    hasMoreOlder: boolean;
}>): number | null {
    const target = params.targetSeq;
    if (typeof target !== 'number' || !Number.isFinite(target) || target < 0) return null;

    // Single mutable record (not narrowed `let`s): the loop mutates these through the
    // `considerSeq` closure, which TypeScript's control-flow analysis cannot track.
    const found: {
        exact: number | null;
        nextAfter: { idx: number; seq: number } | null;
        prevBefore: { idx: number; seq: number } | null;
    } = { exact: null, nextAfter: null, prevBefore: null };

    const resolveSeq = (messageId: unknown): number | null => {
        if (typeof messageId !== 'string' || messageId.length === 0) return null;
        const seq = params.resolveSeqForMessageId(messageId);
        return typeof seq === 'number' && Number.isFinite(seq) ? seq : null;
    };

    const considerSeq = (idx: number, seq: number) => {
        const normalizedSeq = Math.trunc(seq);
        if (normalizedSeq === target) {
            found.exact = idx;
            return;
        }
        if (normalizedSeq > target) {
            if (!found.nextAfter || normalizedSeq < found.nextAfter.seq) found.nextAfter = { idx, seq: normalizedSeq };
        } else if (normalizedSeq < target) {
            if (!found.prevBefore || normalizedSeq > found.prevBefore.seq) found.prevBefore = { idx, seq: normalizedSeq };
        }
    };

    for (let i = 0; i < params.items.length; i++) {
        const item = params.items[i]!;
        if (item.kind === 'message') {
            const seq = typeof item.seq === 'number' && Number.isFinite(item.seq)
                ? item.seq
                : resolveSeq(item.messageId);
            if (seq !== null) considerSeq(i, seq);
        } else if (item.kind === 'tool-group-tool') {
            const seq = typeof item.seq === 'number' && Number.isFinite(item.seq)
                ? item.seq
                : resolveSeq(item.toolMessageId);
            if (seq !== null) considerSeq(i, seq);
        } else if (item.kind === 'turn' && item.turn) {
            const userSeq = resolveSeq(item.turn.userMessageId);
            if (userSeq !== null) considerSeq(i, userSeq);
            const content = Array.isArray(item.turn.content) ? item.turn.content : [];
            for (const entry of content as readonly TranscriptJumpSeqTurnContent[]) {
                if (entry.kind === 'message') {
                    const seq = resolveSeq(entry.messageId);
                    if (seq !== null) considerSeq(i, seq);
                } else if (entry.kind === 'tool_calls' && Array.isArray(entry.toolMessageIds)) {
                    for (const toolMessageId of entry.toolMessageIds) {
                        const seq = resolveSeq(toolMessageId);
                        if (seq !== null) considerSeq(i, seq);
                    }
                }
                if (found.exact != null) break;
            }
        }
        if (found.exact != null) break;
    }

    if (found.exact != null) return found.exact;
    const nextAfter = found.nextAfter;
    const prevBefore = found.prevBefore;
    if (nextAfter && prevBefore === null && params.hasMoreOlder) {
        // Target precedes the loaded window and older pages may still exist: stay
        // unresolved so the jump materialization loop loads down to the target.
        return null;
    }
    if (nextAfter) return nextAfter.idx;
    if (prevBefore) return prevBefore.idx;
    return null;
}
