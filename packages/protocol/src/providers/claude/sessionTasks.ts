import { z } from 'zod';

import {
  buildDeterministicSessionWorkStateItemId,
  buildVendorSessionWorkStateItemId,
} from '../../sessionWorkState/sessionWorkStateItemIds.js';
import type { SessionWorkStateItemV1, SessionWorkStateStatusV1 } from '../../sessionWorkState/sessionWorkStateV1.js';

export const ClaudeTaskEventSchema = z
  .object({
    type: z.string().min(1),
    task_id: z.string().min(1),
    description: z.string().trim().min(1).optional(),
    summary: z.string().trim().min(1).optional(),
    status: z.string().min(1).optional(),
    start_time: z.union([z.string(), z.number()]).optional(),
    end_time: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();
export type ClaudeTaskEvent = z.infer<typeof ClaudeTaskEventSchema>;

export const ClaudeTodoWriteTodoSchema = z
  .object({
    content: z.string().trim().min(1),
    status: z.string().min(1),
    activeForm: z.string().trim().min(1).optional(),
  })
  .passthrough();
export type ClaudeTodoWriteTodo = z.infer<typeof ClaudeTodoWriteTodoSchema>;

function normalizeTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeClaudeTaskStatus(status: unknown, type: string): SessionWorkStateStatusV1 {
  if (status === 'completed') return 'complete';
  if (status === 'stopped') return 'cancelled';
  if (status === 'failed' || status === 'error') return 'blocked';
  if (status === 'pending') return 'pending';
  if (status === 'running' || status === 'active' || type === 'task_started' || type === 'task_progress') return 'active';
  return 'unknown';
}

function normalizeClaudeTodoStatus(status: string): SessionWorkStateStatusV1 {
  if (status === 'pending') return 'pending';
  if (status === 'in_progress') return 'active';
  if (status === 'completed') return 'complete';
  return 'unknown';
}

export function normalizeClaudeTaskEventToWorkStateItem(params: Readonly<{
  backendId: string;
  agentId?: string;
  updatedAt: number;
  event: unknown;
}>): SessionWorkStateItemV1 | null {
  const parsed = ClaudeTaskEventSchema.safeParse(params.event);
  if (!parsed.success) return null;
  const completedAt = normalizeTimestampMs(parsed.data.end_time);
  const startedAt = normalizeTimestampMs(parsed.data.start_time);
  return {
    id: buildVendorSessionWorkStateItemId('task', parsed.data.task_id),
    kind: 'task',
    origin: 'vendor',
    status: normalizeClaudeTaskStatus(parsed.data.status, parsed.data.type),
    title: parsed.data.description ?? parsed.data.summary ?? parsed.data.task_id,
    ...(parsed.data.summary ? { summary: parsed.data.summary } : {}),
    backendId: params.backendId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    vendorRef: parsed.data.task_id,
    ...(startedAt !== null ? { startedAt } : {}),
    ...(completedAt !== null ? { completedAt } : {}),
    updatedAt: params.updatedAt,
  };
}

export function normalizeClaudeTodoWriteTodosToWorkStateItems(params: Readonly<{
  backendId: string;
  agentId?: string;
  updatedAt: number;
  todos: unknown;
}>): SessionWorkStateItemV1[] {
  const todos = Array.isArray(params.todos) ? params.todos : [];
  return todos.flatMap((todo, index): SessionWorkStateItemV1[] => {
    const parsed = ClaudeTodoWriteTodoSchema.safeParse(todo);
    if (!parsed.success) return [];
    return [{
      id: buildDeterministicSessionWorkStateItemId({
        kind: 'todo',
        sourceFamily: 'claude.todo',
        stableParts: [parsed.data.content, index],
      }),
      kind: 'todo',
      origin: 'vendor',
      status: normalizeClaudeTodoStatus(parsed.data.status),
      title: parsed.data.content,
      ...(parsed.data.activeForm ? { summary: parsed.data.activeForm } : {}),
      backendId: params.backendId,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      order: index,
      updatedAt: params.updatedAt,
    }];
  });
}
