import { join } from 'path';

import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { authorizeFilesystemPath } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemPathAuthorization';

export type AttachmentUploadLocation = 'workspace' | 'os_temp';
export type AttachmentVcsIgnoreStrategy = 'git_info_exclude' | 'gitignore' | 'none';

export type AttachmentTransferConfig = Readonly<{
  uploadLocation: AttachmentUploadLocation;
  workspaceRelativeDir: string;
  vcsIgnoreStrategy: AttachmentVcsIgnoreStrategy;
  vcsIgnoreWritesEnabled: boolean;
}>;

export type AttachmentTransferTarget = Readonly<{
  uploadBasePath: string;
  additionalAllowedReadDirs: readonly string[];
  additionalAllowedWriteDirs: readonly string[];
}>;

export type ConfiguredAttachmentTransferTargetResult =
  | Readonly<{
      success: true;
      target: AttachmentTransferTarget;
      uploadBasePath: string;
    }>
  | Readonly<{
      success: false;
      target: AttachmentTransferTarget;
      error: string;
    }>;

export const DEFAULT_ATTACHMENT_TRANSFER_CONFIG: AttachmentTransferConfig = {
  uploadLocation: 'workspace',
  workspaceRelativeDir: '.happier/uploads',
  vcsIgnoreStrategy: 'git_info_exclude',
  vcsIgnoreWritesEnabled: true,
};

export function normalizeAttachmentUploadLocation(value: unknown): AttachmentUploadLocation | null {
  if (value === 'workspace' || value === 'os_temp') return value;
  return null;
}

export function normalizeAttachmentVcsIgnoreStrategy(value: unknown): AttachmentVcsIgnoreStrategy | null {
  if (value === 'git_info_exclude' || value === 'gitignore' || value === 'none') return value;
  return null;
}

export function normalizeAttachmentWorkspaceRelativeDir(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) return null;
  const parts = trimmed.split(/[\\/]+/g).filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) return null;
  return parts.join('/');
}

export function resolveAttachmentTransferTarget(
  config: AttachmentTransferConfig,
  tempUploadRoot: string,
): AttachmentTransferTarget {
  if (config.uploadLocation === 'workspace') {
    return {
      uploadBasePath: join(config.workspaceRelativeDir, 'messages').replace(/[\\]+/g, '/'),
      additionalAllowedReadDirs: [],
      additionalAllowedWriteDirs: [],
    };
  }

  return {
    uploadBasePath: join(tempUploadRoot, 'messages'),
    additionalAllowedReadDirs: [tempUploadRoot],
    additionalAllowedWriteDirs: [tempUploadRoot],
  };
}

export function resolveConfiguredAttachmentTransferTarget(input: Readonly<{
  config: AttachmentTransferConfig;
  tempUploadRoot: string;
  workingDirectory: string;
  accessPolicy?: FilesystemAccessPolicy;
}>): ConfiguredAttachmentTransferTargetResult {
  const target = resolveAttachmentTransferTarget(input.config, input.tempUploadRoot);
  const authorization = authorizeFilesystemPath({
    targetPath: target.uploadBasePath,
    defaultDirectory: input.workingDirectory,
    accessPolicy: input.accessPolicy ?? { kind: 'osUser' },
    additionalAllowedDirs: target.additionalAllowedWriteDirs,
  });
  if (!authorization.valid) {
    return {
      success: false,
      target,
      error: authorization.error,
    };
  }

  return {
    success: true,
    target,
    uploadBasePath: target.uploadBasePath,
  };
}
