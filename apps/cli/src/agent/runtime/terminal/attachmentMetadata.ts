import type { Metadata } from '@/api/types';
import type { TerminalHostHandle } from '@/integrations/terminalHost/_types';

export function buildTerminalAttachmentMetadataFromHostHandle(
  handle: TerminalHostHandle,
): NonNullable<Metadata['terminal']> | null {
  const sessionName = handle.sessionName.trim();
  if (!sessionName) return null;

  if (handle.kind === 'zellij') {
    const paneId = typeof handle.paneId === 'string' ? handle.paneId.trim() : '';
    return {
      mode: 'zellij',
      zellij: {
        sessionName,
        ...(paneId ? { paneId } : {}),
      },
    };
  }

  if (handle.kind === 'tmux') {
    const windowName = typeof handle.paneId === 'string' ? handle.paneId.trim() : '';
    const target = windowName ? `${sessionName}:${windowName}` : sessionName;

    return {
      mode: 'tmux',
      tmux: {
        target,
      },
    };
  }

  return null;
}
