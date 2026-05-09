import { createHash } from 'node:crypto';

import type { SessionMediaSource } from '@/agent/core/AgentMessage';

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function resolveSessionMediaDedupeKey(media: SessionMediaSource): string {
  if (media.dedupeKey) return media.dedupeKey;

  const origin = media.origin;
  const originSource = typeof origin.source === 'string' ? origin.source : 'unknown';
  const stableId =
    (typeof origin.providerEventId === 'string' ? origin.providerEventId : null) ??
    (typeof origin.generationId === 'string' ? origin.generationId : null) ??
    (typeof origin.toolCallId === 'string' ? origin.toolCallId : null) ??
    (typeof origin.providerFileId === 'string' ? origin.providerFileId : null) ??
    'media';
  const contentIndex = typeof origin.contentIndex === 'number' ? origin.contentIndex : 'unknown';

  if (media.kind === 'base64') {
    return `${originSource}:${stableId}:${contentIndex}:${media.mimeType}:sha256:${sha256Text(media.data)}`;
  }
  if (media.kind === 'local-file') {
    return `${originSource}:${stableId}:${contentIndex}:local-file:${sha256Text(media.path)}`;
  }
  return `${originSource}:${stableId}:${contentIndex}:local-uri:${sha256Text(media.uri)}`;
}
