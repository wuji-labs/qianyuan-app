import type { DirectSessionsSource, DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { resolveCodexHomesForDirectSessionsSource } from './resolveCodexHomesForDirectSessionsSource';
import { encodeCodexDirectForwardCursor } from './codexDirectForwardCursor';
import { collectCodexSessionRolloutFiles } from './collectCodexSessionRolloutFiles';
import { pageCodexRolloutStreams } from './codexDirectTranscriptStreamPaging';
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

export async function pageCodexTranscript(params: Readonly<{
  source: DirectSessionsSource;
  activeServerDir: string;
  env?: NodeJS.ProcessEnv;
  remoteSessionId: string;
  direction: 'older' | 'newer';
  cursor?: string;
  maxBytes: number;
  maxItems: number;
}>): Promise<Readonly<{ items: DirectTranscriptRawMessageV1[]; nextCursor: string | null; tailCursor: string | null; hasMore: boolean; truncated?: boolean }>> {
  const env = params.env ?? process.env;
  const homes = await resolveCodexHomesForDirectSessionsSource({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env,
  });

  const perHomeFiles = await Promise.all(homes.map((home) => collectCodexSessionRolloutFiles({ codexHome: home, remoteSessionId: params.remoteSessionId })));
  const bestHome = selectBestCodexHomeWithFiles(homes, perHomeFiles);

  const appServerMetadata = await resolveCodexDirectSessionAppServerMetadata({
    source: params.source,
    activeServerDir: params.activeServerDir,
    remoteSessionId: params.remoteSessionId,
    env,
  });

  if (bestHome === null) {
    const previewItem = appServerMetadata
      ? mapCodexDirectSessionAppServerPreviewToMessage({ remoteSessionId: params.remoteSessionId, metadata: appServerMetadata })
      : null;
    const tailCursor = appServerMetadata
      ? encodeCodexDirectForwardCursor({
        v: 2,
        kind: 'codexForwardAppServer',
        updatedAtMs: appServerMetadata.updatedAtMs,
        previewText: appServerMetadata.previewText,
      })
      : null;
    return { items: previewItem ? [previewItem] : [], nextCursor: null, tailCursor, hasMore: false };
  }

  return pageCodexRolloutStreams({
    codexHome: bestHome,
    remoteSessionId: params.remoteSessionId,
    direction: params.direction,
    cursor: params.cursor,
    maxBytes: params.maxBytes,
    maxItems: params.maxItems,
  });
}
