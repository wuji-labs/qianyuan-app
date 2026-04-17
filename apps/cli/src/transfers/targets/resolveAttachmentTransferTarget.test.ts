import { describe, expect, it } from 'vitest';

import {
  resolveAttachmentTransferTarget,
  resolveConfiguredAttachmentTransferTarget,
} from './resolveAttachmentTransferTarget';

describe('resolveAttachmentTransferTarget', () => {
  it('keeps workspace uploads inside the workspace transfer substrate', () => {
    expect(resolveConfiguredAttachmentTransferTarget({
      config: {
        uploadLocation: 'workspace',
        workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'git_info_exclude',
        vcsIgnoreWritesEnabled: true,
      },
      tempUploadRoot: '/tmp/happier/uploads/session-1',
      workingDirectory: '/repo',
    })).toEqual({
      success: true,
      target: resolveAttachmentTransferTarget({
        uploadLocation: 'workspace',
        workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'git_info_exclude',
        vcsIgnoreWritesEnabled: true,
      }, '/tmp/happier/uploads/session-1'),
      uploadBasePath: '.happier/uploads/messages',
    });
  });

  it('rejects workspace uploads outside restricted filesystem roots', () => {
    const result = resolveConfiguredAttachmentTransferTarget({
      config: {
        uploadLocation: 'workspace',
        workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'git_info_exclude',
        vcsIgnoreWritesEnabled: true,
      },
      tempUploadRoot: '/tmp/happier/uploads/session-1',
      workingDirectory: '/repo',
      accessPolicy: { kind: 'restrictedRoots', roots: ['/allowed'] },
    });

    expect(result).toEqual({
      success: false,
      target: resolveAttachmentTransferTarget({
        uploadLocation: 'workspace',
        workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'git_info_exclude',
        vcsIgnoreWritesEnabled: true,
      }, '/tmp/happier/uploads/session-1'),
      error: expect.stringContaining('Access denied'),
    });
  });

  it('keeps os_temp uploads inside the configured temp transfer root', () => {
    const result = resolveConfiguredAttachmentTransferTarget({
      config: {
        uploadLocation: 'os_temp',
        workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'none',
        vcsIgnoreWritesEnabled: false,
      },
      tempUploadRoot: '/tmp/happier/uploads/session-2',
      workingDirectory: '/repo',
    });

    expect(result).toEqual({
      success: true,
      target: {
        uploadBasePath: '/tmp/happier/uploads/session-2/messages',
        additionalAllowedReadDirs: ['/tmp/happier/uploads/session-2'],
        additionalAllowedWriteDirs: ['/tmp/happier/uploads/session-2'],
      },
      uploadBasePath: '/tmp/happier/uploads/session-2/messages',
    });
  });
});
