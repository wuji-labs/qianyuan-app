import { describe, expect, it } from 'vitest';

import { CursorTransport } from './transport';

describe('CursorTransport', () => {
  const transport = new CursorTransport();

  it('disables the synthetic tool-call timeout (Cursor turns are not force-timed-out)', () => {
    expect(transport.getToolCallTimeout('id', 'execute')).toBeNull();
  });

  it('suppresses the standard ACP plan update (plans arrive via cursor/create_plan)', () => {
    expect(transport.suppressAcpPlanUpdate()).toBe(true);
  });

  it('repairs Cursor diff header noise via sanitizeToolUpdateContent', () => {
    const update = {
      content: [{ type: 'diff', path: '/x.py', oldText: '-- /dev/null\n', newText: '++ b/x.py\nprint(1)' }],
    };
    const out = transport.sanitizeToolUpdateContent(update);
    expect((out.content as any[])[0]).toMatchObject({ oldText: '', newText: 'print(1)' });
  });
});
