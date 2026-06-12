import { describe, expect, it } from 'vitest';

import {
  clampAttachCursorToDeliveredUserMessageSeq,
  mergeDeliveredUserMessageSeqV1,
  readDeliveredUserMessageSeqV1,
} from './deliveredUserMessageSeq';

describe('readDeliveredUserMessageSeqV1', () => {
  it('reads a non-negative integer watermark from metadata', () => {
    expect(readDeliveredUserMessageSeqV1({ deliveredUserMessageSeqV1: 4 })).toBe(4);
    expect(readDeliveredUserMessageSeqV1({ deliveredUserMessageSeqV1: 0 })).toBe(0);
  });

  it('returns null for missing or malformed values (fail to legacy behavior)', () => {
    expect(readDeliveredUserMessageSeqV1(null)).toBeNull();
    expect(readDeliveredUserMessageSeqV1({})).toBeNull();
    expect(readDeliveredUserMessageSeqV1({ deliveredUserMessageSeqV1: -1 })).toBeNull();
    expect(readDeliveredUserMessageSeqV1({ deliveredUserMessageSeqV1: 1.5 })).toBeNull();
    expect(readDeliveredUserMessageSeqV1({ deliveredUserMessageSeqV1: '4' })).toBeNull();
  });
});

describe('mergeDeliveredUserMessageSeqV1', () => {
  it('advances the watermark', () => {
    expect(mergeDeliveredUserMessageSeqV1({ deliveredUserMessageSeqV1: 4 } as never, 7)).toEqual({
      changed: true,
      metadata: { deliveredUserMessageSeqV1: 7 },
    });
  });

  it('sets the watermark when absent', () => {
    const out = mergeDeliveredUserMessageSeqV1({} as never, 3);
    expect(out.changed).toBe(true);
    expect(out.metadata).toMatchObject({ deliveredUserMessageSeqV1: 3 });
  });

  it('never regresses the watermark', () => {
    const metadata = { deliveredUserMessageSeqV1: 9 } as never;
    expect(mergeDeliveredUserMessageSeqV1(metadata, 4)).toEqual({ changed: false, metadata });
  });
});

describe('clampAttachCursorToDeliveredUserMessageSeq', () => {
  it('clamps the attach cursor down to the delivered watermark (owed rows redelivered)', () => {
    expect(clampAttachCursorToDeliveredUserMessageSeq(42, 4)).toBe(4);
  });

  it('keeps the cursor when the watermark is not lower', () => {
    expect(clampAttachCursorToDeliveredUserMessageSeq(4, 42)).toBe(4);
    expect(clampAttachCursorToDeliveredUserMessageSeq(4, 4)).toBe(4);
  });

  it('keeps the cursor when no watermark exists (legacy sessions)', () => {
    expect(clampAttachCursorToDeliveredUserMessageSeq(42, null)).toBe(42);
    expect(clampAttachCursorToDeliveredUserMessageSeq(undefined, 4)).toBeUndefined();
  });
});
