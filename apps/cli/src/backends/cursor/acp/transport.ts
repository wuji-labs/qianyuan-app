import { DefaultTransport } from '@/agent/transport';

import { sanitizeCursorDiffContent } from '../utils/sanitizeCursorDiffContent';

export class CursorTransport extends DefaultTransport {
  constructor() {
    super('cursor');
  }

  override getToolCallTimeout(_toolCallId?: string, _toolKind?: string): number | null {
    return null;
  }

  override sanitizeToolUpdateContent<T extends { content?: unknown }>(update: T): T {
    return sanitizeCursorDiffContent(update);
  }

  // Cursor delivers plans/todos via the cursor/create_plan + cursor/update_todos extension methods
  // (markdown + structured todos + phases), so the redundant standard ACP `plan` update is dropped
  // to avoid rendering a duplicate checklist.
  override suppressAcpPlanUpdate(): boolean {
    return true;
  }
}

export const cursorTransport = new CursorTransport();
