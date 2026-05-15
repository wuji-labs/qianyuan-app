import {
  normalizeClaudeTaskToolRecordsToWorkStateItems,
  normalizeClaudeTaskToolUseToWorkStateItem,
  normalizeClaudeTodoWriteTodosToWorkStateItems,
  type SessionWorkStateItemV1,
  type SessionWorkStateV1,
} from '@happier-dev/protocol';

type ClaudeWorkStateSnapshot = SessionWorkStateV1 & Readonly<{ ownedSourceFamilies?: readonly string[] }>;

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function choosePrimary(items: readonly SessionWorkStateItemV1[]): string | null {
  return (
    items.find((item) => item.status === 'active')?.id
    ?? items.find((item) => item.status === 'pending')?.id
    ?? items[0]?.id
    ?? null
  );
}

export function buildClaudeTaskLifecycleWorkState(params: Readonly<{
  backendId: string;
  agentId?: string;
  updatedAt: number;
  messages: readonly unknown[];
}>): SessionWorkStateV1 {
  return {
    v: 1,
    backendId: params.backendId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    updatedAt: params.updatedAt,
    items: [],
    primaryItemId: null,
  };
}

export function buildClaudeTodoWriteWorkState(params: Readonly<{
  backendId: string;
  agentId?: string;
  updatedAt: number;
  input: unknown;
}>): SessionWorkStateV1 {
  const input = readRecord(params.input);
  const items = normalizeClaudeTodoWriteTodosToWorkStateItems({
    backendId: params.backendId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    updatedAt: params.updatedAt,
    todos: input?.todos,
  });

  return {
    v: 1,
    backendId: params.backendId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    updatedAt: params.updatedAt,
    ownedSourceFamilies: ['todo'],
    items,
    primaryItemId: choosePrimary(items),
  } as ClaudeWorkStateSnapshot;
}

function readContentBlocks(message: unknown): readonly unknown[] {
  const record = readRecord(message);
  const payload = readRecord(record?.message);
  return Array.isArray(payload?.content) ? payload.content : [];
}

function readJsonValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first < 0 || last <= first) return null;
    try {
      return JSON.parse(text.slice(first, last + 1));
    } catch {
      return null;
    }
  }
}

function readToolResultPayloads(block: Record<string, unknown>): readonly unknown[] {
  const payloads: unknown[] = [];
  const appendContentPayloads = (content: unknown) => {
    if (typeof content === 'string') {
      payloads.push(...[readJsonValue(content), content].filter((value) => value !== null));
      return;
    }
    if (Array.isArray(content)) {
      payloads.push(...content.flatMap((entry): unknown[] => {
        const record = readRecord(entry);
        if (!record) return [entry];
        const text = record.text;
        if (typeof text === 'string') return [readJsonValue(text), text].filter((value) => value !== null);
        return [record];
      }));
      return;
    }
    if (content !== undefined) payloads.push(content);
  };

  if (block.tool_use_result !== undefined) payloads.push(block.tool_use_result);
  if (block.toolUseResult !== undefined) payloads.push(block.toolUseResult);
  appendContentPayloads(block.content);
  return payloads;
}

function readTaskRecordsFromPayload(payload: unknown): unknown[] {
  const record = readRecord(payload);
  if (!record) return [];
  const snakeResult = readRecord(record.tool_use_result);
  if (snakeResult) return readTaskRecordsFromPayload(snakeResult);
  const camelResult = readRecord(record.toolUseResult);
  if (camelResult) return readTaskRecordsFromPayload(camelResult);
  if (Array.isArray(record.tasks)) return record.tasks;
  const task = readRecord(record.task);
  return task ? [task] : [];
}

function mergeTaskItem(params: Readonly<{
  previous: SessionWorkStateItemV1 | undefined;
  next: SessionWorkStateItemV1;
}>): SessionWorkStateItemV1 {
  const previous = params.previous;
  const next = params.next;
  return {
    ...(previous ?? {}),
    ...next,
    status: next.status === 'unknown' && previous ? previous.status : next.status,
    title: next.title || previous?.title || next.vendorRef || next.id,
    summary: next.summary ?? previous?.summary,
  };
}

export function createClaudeTaskToolWorkStateTracker(params: Readonly<{
  backendId: string;
  agentId?: string;
}>): Readonly<{
  applyMessage: (message: unknown, updatedAt: number) => ClaudeWorkStateSnapshot | null;
}> {
  const itemsByVendorRef = new Map<string, SessionWorkStateItemV1>();
  const provisionalRefByToolUseId = new Map<string, string>();
  const pendingTaskListToolUseIds = new Set<string>();

  const buildSnapshot = (updatedAt: number): ClaudeWorkStateSnapshot => {
    const items = [...itemsByVendorRef.values()];
    return {
      v: 1,
      backendId: params.backendId,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      updatedAt,
      ownedSourceFamilies: ['task'],
      items,
      primaryItemId: choosePrimary(items),
    };
  };

  const applyTaskToolUse = (block: Record<string, unknown>, updatedAt: number): ClaudeWorkStateSnapshot | null => {
    const toolName = block.name;
    if (toolName === 'TaskList') {
      const toolUseId = readString(block.id);
      if (toolUseId) pendingTaskListToolUseIds.add(toolUseId);
      return null;
    }

    const item = normalizeClaudeTaskToolUseToWorkStateItem({
      backendId: params.backendId,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      updatedAt,
      toolName,
      toolUseId: block.id,
      input: block.input,
    });
    if (!item?.vendorRef) return null;

    if (toolName === 'TaskCreate') {
      const toolUseId = readString(block.id);
      if (toolUseId) provisionalRefByToolUseId.set(toolUseId, item.vendorRef);
    }

    itemsByVendorRef.set(item.vendorRef, mergeTaskItem({
      previous: itemsByVendorRef.get(item.vendorRef),
      next: item,
    }));
    return buildSnapshot(updatedAt);
  };

  const applyTaskToolResult = (block: Record<string, unknown>, updatedAt: number): ClaudeWorkStateSnapshot | null => {
    const toolUseId = readString(block.tool_use_id);
    if (!toolUseId) return null;

    const payloadRecords = readToolResultPayloads(block).flatMap(readTaskRecordsFromPayload);
    if (payloadRecords.length === 0) return null;

    const resultItems = normalizeClaudeTaskToolRecordsToWorkStateItems({
      backendId: params.backendId,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      updatedAt,
      tasks: payloadRecords,
    });
    if (resultItems.length === 0) return null;

    if (pendingTaskListToolUseIds.delete(toolUseId)) {
      itemsByVendorRef.clear();
    }

    const provisionalRef = provisionalRefByToolUseId.get(toolUseId);
    const provisionalItem = provisionalRef ? itemsByVendorRef.get(provisionalRef) : undefined;
    if (provisionalRef) {
      provisionalRefByToolUseId.delete(toolUseId);
      itemsByVendorRef.delete(provisionalRef);
    }

    for (const item of resultItems) {
      if (!item.vendorRef) continue;
      itemsByVendorRef.set(item.vendorRef, mergeTaskItem({
        previous: itemsByVendorRef.get(item.vendorRef) ?? provisionalItem,
        next: item,
      }));
    }

    return buildSnapshot(updatedAt);
  };

  return {
    applyMessage(message: unknown, updatedAt: number): ClaudeWorkStateSnapshot | null {
      let latestSnapshot: ClaudeWorkStateSnapshot | null = null;
      for (const rawBlock of readContentBlocks(message)) {
        const block = readRecord(rawBlock);
        if (!block) continue;
        if (block.type === 'tool_use') {
          latestSnapshot = applyTaskToolUse(block, updatedAt) ?? latestSnapshot;
        } else if (block.type === 'tool_result') {
          latestSnapshot = applyTaskToolResult(block, updatedAt) ?? latestSnapshot;
        }
      }
      return latestSnapshot;
    },
  };
}
