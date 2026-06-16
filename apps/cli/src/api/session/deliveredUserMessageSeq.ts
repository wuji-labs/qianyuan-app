import type { Metadata } from '@/api/types';

/**
 * Owed-delivery watermark (QA A-F2 / D15b): highest user-row seq that is no longer owed to the
 * runner. Most rows become unowed when handed to the runner's agent loop; provider-native rows
 * written from the terminal transcript become unowed when their local echo proves they already
 * reached provider custody. Resume paths previously synthesized the catch-up cursor from
 * `session.seq`, so user rows committed while the runner was down were never delivered on any
 * resume. The runner persists this watermark in session metadata; daemon attach paths clamp the
 * catch-up cursor to it so owed rows are redelivered (at-least-once, deduped by localId/echo
 * suppression).
 */
export function readDeliveredUserMessageSeqV1(metadata: Readonly<Record<string, unknown>> | null | undefined): number | null {
  const value = metadata?.deliveredUserMessageSeqV1;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

export function mergeDeliveredUserMessageSeqV1(
  metadata: Metadata,
  seq: number,
): Readonly<{ changed: boolean; metadata: Metadata }> {
  const normalized = Number.isInteger(seq) && seq >= 0 ? seq : null;
  if (normalized === null) return { changed: false, metadata };
  const existing = readDeliveredUserMessageSeqV1(metadata as unknown as Record<string, unknown>);
  if (existing !== null && existing >= normalized) return { changed: false, metadata };
  return { changed: true, metadata: { ...metadata, deliveredUserMessageSeqV1: normalized } };
}

export function clampAttachCursorToDeliveredUserMessageSeq(
  cursor: number | undefined,
  deliveredUserMessageSeq: number | null,
): number | undefined {
  if (cursor === undefined || deliveredUserMessageSeq === null) return cursor;
  return Math.min(cursor, deliveredUserMessageSeq);
}
