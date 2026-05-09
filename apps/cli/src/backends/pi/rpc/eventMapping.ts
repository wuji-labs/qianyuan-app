import type { AgentMessage } from '@/agent/core';
import { extractAcpMediaContentBlocks } from '@/agent/acp/media/extractAcpMediaContentBlocks';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isBoolean(value: unknown): value is boolean {
  return value === true || value === false;
}

function readPiCompactionTrigger(value: unknown): 'manual' | 'threshold' | 'overflow' | 'unknown' {
  return value === 'manual' || value === 'threshold' || value === 'overflow' ? value : 'unknown';
}

function readPiCompactionLifecycleId(record: Record<string, unknown>): string {
  return (
    asNonEmptyString(record.compactionId) ??
    asNonEmptyString(record.compaction_id) ??
    asNonEmptyString(record.id) ??
    asNonEmptyString(record.turnId) ??
    asNonEmptyString(record.turn_id) ??
    'pi:context-compaction'
  );
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readRetryAttempt(record: Record<string, unknown>, result: Record<string, unknown> | null): number | null {
  const raw = readFiniteNumber(record.retryAttempt) ?? readFiniteNumber(record.retry_attempt) ?? readFiniteNumber(result?.retryAttempt) ?? readFiniteNumber(result?.retry_attempt);
  return raw === null ? null : Math.max(0, Math.trunc(raw));
}

function readPiCompactionCancelled(record: Record<string, unknown>, result: Record<string, unknown> | null): boolean {
  return (
    record.cancelled === true ||
    record.canceled === true ||
    result?.cancelled === true ||
    result?.canceled === true ||
    asNonEmptyString(record.status)?.toLowerCase() === 'cancelled' ||
    asNonEmptyString(record.status)?.toLowerCase() === 'canceled'
  );
}

function extractAssistantText(message: unknown): string | null {
  const record = asRecord(message);
  if (!record) return null;
  if (record.role !== 'assistant') return null;
  const content = record.content;
  if (!Array.isArray(content)) return null;

  let text = '';
  for (const item of content) {
    const entry = asRecord(item);
    if (!entry) continue;
    if (entry.type !== 'text') continue;
    const chunk = asString(entry.text);
    if (chunk === null) continue;
    text += chunk;
  }

  return text;
}

function extractTextFromToolResult(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  const content = record.content;
  if (!Array.isArray(content)) return null;
  let text = '';
  for (const item of content) {
    const entry = asRecord(item);
    if (!entry) continue;
    if (entry.type !== 'text') continue;
    const chunk = asString(entry.text);
    if (chunk === null) continue;
    text += chunk;
  }
  return text;
}

export function mapPiRpcEventToAgentMessages(event: unknown): AgentMessage[] {
  const record = asRecord(event);
  if (!record) return [];

  const type = asNonEmptyString(record.type);
  if (!type) return [];

  if (type === 'agent_start' || type === 'turn_start') {
    return [{ type: 'status', status: 'running' }];
  }
  if (type === 'agent_end' || type === 'turn_end') {
    return [{ type: 'status', status: 'idle' }];
  }

  if (type === 'compaction_start') {
    const lifecycleId = readPiCompactionLifecycleId(record);
    return [{
      type: 'event',
      name: 'context_compaction',
      payload: {
        type: 'context-compaction',
        phase: 'started',
        provider: 'pi',
        lifecycleId,
        trigger: readPiCompactionTrigger(record.reason),
        source: 'provider-event',
      },
    }];
  }

  if (type === 'compaction_end') {
    const result = asRecord(record.result);
    const tokensBefore = result ? readFiniteNumber(result.tokensBefore) : null;
    const tokensAfter = result ? readFiniteNumber(result.tokensAfter) : null;
    const sanitizedErrorPreview = asNonEmptyString(record.errorMessage);
    const errorCode = asNonEmptyString(record.errorCode);
    const aborted = isBoolean(record.aborted) ? record.aborted : false;
    const retryAttempt = readRetryAttempt(record, result);
    const lifecycleId = readPiCompactionLifecycleId(record);
    const cancelled = readPiCompactionCancelled(record, result);
    const failed = !cancelled && Boolean(aborted || sanitizedErrorPreview);
    return [{
      type: 'event',
      name: 'context_compaction',
      payload: {
        type: 'context-compaction',
        phase: cancelled ? 'cancelled' : failed ? 'failed' : 'completed',
        provider: 'pi',
        lifecycleId,
        trigger: readPiCompactionTrigger(record.reason),
        source: 'provider-event',
        ...(tokensBefore !== null ? { tokenCountBefore: tokensBefore } : {}),
        ...(tokensAfter !== null ? { tokenCountAfter: tokensAfter } : {}),
        ...(retryAttempt !== null ? { retryAttempt } : {}),
        ...(errorCode ? { errorCode } : {}),
        ...(sanitizedErrorPreview ? { sanitizedErrorPreview } : {}),
      },
    }];
  }

  if (type === 'message_update') {
    const assistantMessageEvent = asRecord(record.assistantMessageEvent);
    if (!assistantMessageEvent) return [];
    const assistantType = asNonEmptyString(assistantMessageEvent.type);
    if (!assistantType) return [];
    if (assistantType === 'text_start' || assistantType === 'text_delta' || assistantType === 'text_end') {
      const fullText = extractAssistantText(record.message);
      if (fullText === null || fullText.length === 0) return [];
      return [{ type: 'model-output', fullText }];
    }
    return [];
  }

  if (type === 'message_end') {
    const fullText = extractAssistantText(record.message);
    if (fullText === null || fullText.length === 0) return [];
    return [{ type: 'model-output', fullText }];
  }

  if (type === 'tool_execution_start') {
    const callId = asNonEmptyString(record.toolCallId);
    const toolName = asNonEmptyString(record.toolName);
    const args = asRecord(record.args) ?? {};
    if (!callId || !toolName) return [];
    return [{ type: 'tool-call', callId, toolName, args }];
  }

  if (type === 'tool_execution_end') {
    const callId = asNonEmptyString(record.toolCallId);
    const toolName = asNonEmptyString(record.toolName);
    if (!callId || !toolName) return [];
    const isError = isBoolean(record.isError) ? record.isError : undefined;
    const messages: AgentMessage[] = [
      { type: 'tool-result', callId, toolName, result: record.result, ...(isError ? { isError: true } : {}) },
    ];
    const media = extractAcpMediaContentBlocks(record.result, {
      source: 'pi-tool-result',
      originSource: 'tool-output',
      toolCallId: callId,
      dedupePrefix: 'pi:tool-result',
    }).media;
    if (media.length > 0) {
      messages.push({ type: 'session-media', source: 'pi-tool-result', media });
    }
    return messages;
  }

  if (type === 'tool_execution_update') {
    const callId = asNonEmptyString(record.toolCallId);
    const toolName = asNonEmptyString(record.toolName);
    if (!callId || !toolName) return [];
    const chunk = extractTextFromToolResult(record.partialResult);
    if (chunk === null || chunk.length === 0) return [];
    return [{ type: 'tool-result', callId, toolName, result: { _stream: true, stdoutChunk: chunk } }];
  }

  return [];
}
