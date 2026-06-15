import { describe, expect, it, vi } from 'vitest';

import { pushMessageToQueueWithSpecialCommands } from './queueSpecialCommands';

describe('pushMessageToQueueWithSpecialCommands', () => {
  it('pushes clear commands via isolate+clear', () => {
    const queue = {
      push: vi.fn(),
      pushIsolateAndClear: vi.fn(),
    };

    pushMessageToQueueWithSpecialCommands({
      queue,
      message: '/clear',
      text: '/clear',
      mode: { permissionMode: 'default' },
    });

    expect(queue.push).not.toHaveBeenCalled();
    expect(queue.pushIsolateAndClear).toHaveBeenCalledWith('/clear', { permissionMode: 'default' }, { userMessageSeq: null });
  });

  it('pushes non-special text normally', () => {
    const queue = {
      push: vi.fn(),
      pushIsolateAndClear: vi.fn(),
    };

    pushMessageToQueueWithSpecialCommands({
      queue,
      message: 'hello',
      text: 'hello',
      mode: { permissionMode: 'default' },
    });

    expect(queue.pushIsolateAndClear).not.toHaveBeenCalled();
    expect(queue.push).toHaveBeenCalledWith('hello', { permissionMode: 'default' }, { userMessageSeq: null });
  });

  it('preserves user message seq attribution for normal and clear commands', () => {
    const queue = {
      push: vi.fn(),
      pushIsolateAndClear: vi.fn(),
    };

    pushMessageToQueueWithSpecialCommands({
      queue,
      message: 'hello',
      text: 'hello',
      mode: { permissionMode: 'default' },
      userMessageSeq: 41,
    });
    pushMessageToQueueWithSpecialCommands({
      queue,
      message: '/clear',
      text: '/clear',
      mode: { permissionMode: 'default' },
      userMessageSeq: 42,
    });

    expect(queue.push).toHaveBeenCalledWith('hello', { permissionMode: 'default' }, { userMessageSeq: 41 });
    expect(queue.pushIsolateAndClear).toHaveBeenCalledWith('/clear', { permissionMode: 'default' }, { userMessageSeq: 42 });
  });
});
