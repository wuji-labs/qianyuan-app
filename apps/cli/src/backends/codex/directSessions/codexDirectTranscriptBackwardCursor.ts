type CodexBackwardStreamCursorV3 = Readonly<{
  v: 3;
  kind: 'codexBackwardStreamVector';
  streams: readonly Readonly<{
    fileRelPath: string;
    endOffsetBytes: number;
  }>[];
}>;

export function encodeCodexDirectBackwardCursor(value: CodexBackwardStreamCursorV3): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCodexDirectBackwardCursor(raw: string | undefined): CodexBackwardStreamCursorV3 | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (record.v !== 3 || record.kind !== 'codexBackwardStreamVector') return null;
    const rawStreams = Array.isArray(record.streams) ? record.streams : [];
    const streams = rawStreams
      .map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
        const streamRecord = entry as Record<string, unknown>;
        const fileRelPath = typeof streamRecord.fileRelPath === 'string' ? streamRecord.fileRelPath.trim() : '';
        const endOffsetBytes = typeof streamRecord.endOffsetBytes === 'number' && Number.isFinite(streamRecord.endOffsetBytes)
          ? Math.trunc(streamRecord.endOffsetBytes)
          : NaN;
        if (!fileRelPath || !Number.isFinite(endOffsetBytes) || endOffsetBytes < 0) return null;
        return { fileRelPath, endOffsetBytes };
      })
      .filter((entry): entry is { fileRelPath: string; endOffsetBytes: number } => entry !== null);
    return { v: 3, kind: 'codexBackwardStreamVector', streams };
  } catch {
    return null;
  }
}
