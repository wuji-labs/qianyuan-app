import type { DirectSessionsSource, DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { resolveCodexHomesForDirectSessionsSource } from './resolveCodexHomesForDirectSessionsSource';
import { decodeCodexDirectForwardCursor, encodeCodexDirectForwardCursor } from './codexDirectForwardCursor';
import { collectCodexSessionRolloutFiles } from './collectCodexSessionRolloutFiles';
import { readAfterCodexRolloutStreams } from './codexDirectTranscriptStreamPaging';
import {
  mapCodexDirectSessionAppServerPreviewToMessage,
  resolveCodexDirectSessionAppServerMetadata,
} from './resolveCodexDirectSessionAppServerMetadata';

function selectBestCodexHomeWithFiles(homes: readonly string[], perHomeFiles: readonly (readonly unknown[])[]): string | null {
  let bestHome: string | null = null;
  let bestLatestMtimeMs = -1;
  for (let index = 0; index < homes.length; index += 1) {
    const home = homes[index]!;
    const files = perHomeFiles[index] ?? [];
    if (files.length === 0) continue;
    const latestMtimeMs = Math.max(...(files as { mtimeMs: number }[]).map((file) => file.mtimeMs));
    if (latestMtimeMs > bestLatestMtimeMs) {
      bestLatestMtimeMs = latestMtimeMs;
      bestHome = home;
    }
  }
  return bestHome;
}

export async function readAfterCodexTranscript(params: Readonly<{
  source: DirectSessionsSource;
  activeServerDir: string;
  env?: NodeJS.ProcessEnv;
  remoteSessionId: string;
  cursor: string;
  maxBytes: number;
  maxItems: number;
}>): Promise<Readonly<{ items: DirectTranscriptRawMessageV1[]; nextCursor: string | null; truncated: boolean }>> {
  const env = params.env ?? process.env;
  const homes = await resolveCodexHomesForDirectSessionsSource({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env,
  });

  const perHomeFiles = await Promise.all(homes.map((home) => collectCodexSessionRolloutFiles({ codexHome: home, remoteSessionId: params.remoteSessionId })));
  const bestHome = selectBestCodexHomeWithFiles(homes, perHomeFiles);
  const appServerMetadata = bestHome === null || params.cursor === 'tail'
    ? await resolveCodexDirectSessionAppServerMetadata({
      source: params.source,
      activeServerDir: params.activeServerDir,
      remoteSessionId: params.remoteSessionId,
      env,
    })
    : null;

  if (bestHome === null) {
    if (params.cursor === 'tail' && appServerMetadata) {
      return {
        items: [],
        nextCursor: encodeCodexDirectForwardCursor({
          v: 2,
          kind: 'codexForwardAppServer',
          updatedAtMs: appServerMetadata.updatedAtMs,
          previewText: appServerMetadata.previewText,
        }),
        truncated: false,
      };
    }

    const decodedEmpty = params.cursor === 'tail' ? null : decodeCodexDirectForwardCursor(params.cursor);
    if (decodedEmpty?.kind === 'codexForwardAppServer') {
      const nextMetadata = appServerMetadata;
      const changed = nextMetadata
        ? nextMetadata.updatedAtMs !== decodedEmpty.updatedAtMs || nextMetadata.previewText !== decodedEmpty.previewText
        : false;
      const previewItem = changed && nextMetadata
        ? mapCodexDirectSessionAppServerPreviewToMessage({ remoteSessionId: params.remoteSessionId, metadata: nextMetadata })
        : null;
      const nextCursor = encodeCodexDirectForwardCursor({
        v: 2,
        kind: 'codexForwardAppServer',
        updatedAtMs: appServerMetadata?.updatedAtMs ?? decodedEmpty.updatedAtMs,
        previewText: appServerMetadata?.previewText ?? decodedEmpty.previewText,
      });
      return { items: previewItem ? [previewItem] : [], nextCursor, truncated: false };
    }

    return { items: [], nextCursor: null, truncated: false };
  }

  return readAfterCodexRolloutStreams({
    codexHome: bestHome,
    remoteSessionId: params.remoteSessionId,
    cursor: params.cursor,
    maxBytes: params.maxBytes,
    maxItems: params.maxItems,
  });
}
