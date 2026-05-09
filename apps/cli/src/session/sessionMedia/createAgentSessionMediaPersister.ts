import type { AgentMessage, SessionMediaSource, SessionMediaSourceOrigin } from '@/agent/core';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import {
  createTransferPathAllowanceRegistry,
  type TransferPathAllowanceRegistry,
} from '@/transfers/targets/createTransferPathAllowanceRegistry';
import { SessionMediaItemV1Schema, type SessionMediaItemV1 } from '@happier-dev/protocol';

import {
  persistSessionMediaItem,
  type PersistSessionMediaInput,
} from './persistSessionMediaItem';
import type {
  SessionMediaIngestionSource,
  SessionMediaOrigin,
} from './sessionMediaIngestionSource';

type RuntimeSessionMediaMessage = Extract<AgentMessage, { type: 'session-media' }>;

type AgentSessionMediaPersisterParams = Readonly<{
  workingDirectory: string;
  sessionId: string;
  accessPolicy?: FilesystemAccessPolicy;
  pathAllowanceRegistry?: TransferPathAllowanceRegistry;
  maxBytes?: number;
  sessionRpcTransferMaxBytes?: number | null;
}>;

function mapMediaCategory(origin: SessionMediaSourceOrigin): PersistSessionMediaInput['category'] {
  return origin.source === 'tool-output' ? 'tool-artifact' : 'generated';
}

function mapOrigin(origin: SessionMediaSourceOrigin): SessionMediaOrigin {
  return {
    source: origin.source,
    ...(typeof origin.agentId === 'string' ? { agentId: origin.agentId } : {}),
    ...(typeof origin.toolCallId === 'string' ? { toolCallId: origin.toolCallId } : {}),
    ...(typeof origin.generationId === 'string' ? { generationId: origin.generationId } : {}),
    ...(typeof origin.providerEventId === 'string' ? { providerEventId: origin.providerEventId } : {}),
    ...(typeof origin.providerFileId === 'string' ? { providerFileId: origin.providerFileId } : {}),
  };
}

function mapSource(source: SessionMediaSource): SessionMediaIngestionSource {
  if (source.kind === 'base64') {
    return {
      kind: 'base64',
      data: source.data,
      mimeType: source.mimeType,
      ...(source.suggestedName ? { suggestedName: source.suggestedName } : {}),
    };
  }
  if (source.kind === 'local-file') {
    return {
      kind: 'local-file',
      path: source.path,
      ...(source.mimeType ? { mimeType: source.mimeType } : {}),
      ...(source.suggestedName ? { suggestedName: source.suggestedName } : {}),
    };
  }
  return {
    kind: 'local-uri',
    uri: source.uri,
    ...(source.mimeType ? { mimeType: source.mimeType } : {}),
    ...(source.suggestedName ? { suggestedName: source.suggestedName } : {}),
  };
}

function buildMessageLocalId(message: RuntimeSessionMediaMessage, index: number): string {
  const source = message.media[index]?.origin;
  const stableId =
    source?.providerEventId ??
    source?.generationId ??
    source?.toolCallId ??
    source?.providerFileId ??
    message.source;
  const safeStableId = stableId.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'media';
  return `session-media-${safeStableId}-${index}`;
}

export function createAgentSessionMediaPersister(
  params: AgentSessionMediaPersisterParams,
): { persist: (message: RuntimeSessionMediaMessage) => Promise<SessionMediaItemV1[]> } {
  const pathAllowanceRegistry = params.pathAllowanceRegistry ?? createTransferPathAllowanceRegistry();

  return {
    async persist(message) {
      const items: SessionMediaItemV1[] = [];
      for (let index = 0; index < message.media.length; index += 1) {
        const media = message.media[index]!;
        const result = await persistSessionMediaItem({
          workingDirectory: params.workingDirectory,
          pathAllowanceRegistry,
          sessionRpcTransferMaxBytes: params.sessionRpcTransferMaxBytes ?? null,
          ...(params.accessPolicy ? { accessPolicy: params.accessPolicy } : {}),
          ...(typeof params.maxBytes === 'number' ? { maxBytes: params.maxBytes } : {}),
          input: {
            sessionId: params.sessionId,
            messageLocalId: buildMessageLocalId(message, index),
            role: 'output',
            category: mapMediaCategory(media.origin),
            source: mapSource(media),
            origin: mapOrigin(media.origin),
            ...(media.suggestedName ? { suggestedName: media.suggestedName } : {}),
            createdAtMs: Date.now(),
          },
        });
        if (result.success) {
          const parsed = SessionMediaItemV1Schema.safeParse(result.item);
          if (parsed.success) {
            items.push(parsed.data);
          }
        }
      }
      return items;
    },
  };
}
