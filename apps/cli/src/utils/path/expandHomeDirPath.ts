import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

function pathApi(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32 : posix;
}

export function resolveHomeDirFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const envHome =
    platform === 'win32'
      ? (env.USERPROFILE || env.HOME)
      : env.HOME;
  const trimmed = typeof envHome === 'string' ? envHome.trim() : '';
  return trimmed.length > 0 ? trimmed : homedir();
}

export function expandHomeDirPath(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (value === '~') return resolveHomeDirFromEnvironment(env, platform);
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    const api = pathApi(platform);
    const normalizedRelativePath = value
      .slice(2)
      .split(/[\\/]+/)
      .filter(Boolean)
      .join(api.sep);
    return api.join(resolveHomeDirFromEnvironment(env, platform), normalizedRelativePath);
  }
  return value;
}
