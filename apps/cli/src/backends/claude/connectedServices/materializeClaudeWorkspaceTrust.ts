import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { resolveHomeDirFromEnvironment } from '@happier-dev/cli-common/providers';

import { resolveConfiguredClaudeConfigDir } from '@/backends/claude/utils/resolveConfiguredClaudeConfigDir';
import { resolveClaudeConfigDirOverride } from '@/backends/claude/utils/resolveClaudeConfigDirOverride';

type JsonObject = Record<string, unknown>;

type ClaudeWorkspaceTrustProjection = Readonly<{
  hasTrustDialogAccepted: true;
  hasCompletedProjectOnboarding?: true;
}>;

type ClaudeRootConfigPathCandidate = Readonly<{
  rootDir: string;
  path: string;
}>;

function readObject(value: unknown): JsonObject | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

async function readJsonObjectFile(path: string): Promise<JsonObject | null> {
  try {
    return readObject(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return null;
  }
}

function dedupeRootConfigPathCandidates(
  candidates: readonly ClaudeRootConfigPathCandidate[],
): ClaudeRootConfigPathCandidate[] {
  const seen = new Set<string>();
  const result: ClaudeRootConfigPathCandidate[] = [];
  for (const candidate of candidates) {
    const key = resolve(candidate.path);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function resolveClaudeRootConfigPathCandidates(env: NodeJS.ProcessEnv): ClaudeRootConfigPathCandidate[] {
  const explicitConfigDir = resolveClaudeConfigDirOverride(env);
  const homeDir = resolveHomeDirFromEnvironment(env);
  const configuredConfigDir = resolveConfiguredClaudeConfigDir({ env });
  return dedupeRootConfigPathCandidates([
    ...(explicitConfigDir ? [{
      rootDir: explicitConfigDir,
      path: join(explicitConfigDir, '.claude.json'),
    }] : []),
    {
      rootDir: homeDir,
      path: join(homeDir, '.claude.json'),
    },
    {
      rootDir: configuredConfigDir,
      path: join(configuredConfigDir, '.claude.json'),
    },
  ]);
}

function readProjectTrustProjection(
  rootConfig: JsonObject,
  sessionDirectory: string,
): { hasExplicitTrustState: boolean; projection: ClaudeWorkspaceTrustProjection | null } {
  const projectConfig = readObject(readObject(rootConfig.projects)?.[sessionDirectory]);
  if (!projectConfig || typeof projectConfig.hasTrustDialogAccepted !== 'boolean') {
    return { hasExplicitTrustState: false, projection: null };
  }
  if (projectConfig.hasTrustDialogAccepted !== true) {
    return { hasExplicitTrustState: true, projection: null };
  }
  return {
    hasExplicitTrustState: true,
    projection: {
      hasTrustDialogAccepted: true,
      ...(projectConfig.hasCompletedProjectOnboarding === true ? { hasCompletedProjectOnboarding: true } : {}),
    },
  };
}

async function resolveWorkspaceTrustProjection(params: Readonly<{
  sourceEnv: NodeJS.ProcessEnv;
  sessionDirectory: string;
  targetDir: string;
}>): Promise<ClaudeWorkspaceTrustProjection | null> {
  const targetRoot = resolve(params.targetDir);
  const candidates = resolveClaudeRootConfigPathCandidates(params.sourceEnv)
    .filter((candidate) => resolve(candidate.rootDir) !== targetRoot);
  for (let index = 0; index < candidates.length; index += 1) {
    const rootConfig = await readJsonObjectFile(candidates[index].path);
    if (!rootConfig) continue;
    const result = readProjectTrustProjection(rootConfig, params.sessionDirectory);
    if (result.projection) return result.projection;
    if (result.hasExplicitTrustState && index === 0 && resolveClaudeConfigDirOverride(params.sourceEnv)) {
      return null;
    }
  }
  return null;
}

async function writeClaudeRootConfig(params: Readonly<{
  targetDir: string;
  rootConfig: JsonObject;
}>): Promise<void> {
  await mkdir(params.targetDir, { recursive: true });
  const targetPath = join(params.targetDir, '.claude.json');
  const tempPath = join(params.targetDir, `.claude.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(params.rootConfig)}\n`, { mode: 0o600 });
    if (process.platform !== 'win32') {
      await chmod(tempPath, 0o600);
    }
    await rename(tempPath, targetPath);
    if (process.platform !== 'win32') {
      await chmod(targetPath, 0o600);
    }
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function materializeClaudeWorkspaceTrust(params: Readonly<{
  sourceEnv: NodeJS.ProcessEnv;
  targetDir: string;
  sessionDirectory?: string | null;
}>): Promise<void> {
  const sessionDirectory = typeof params.sessionDirectory === 'string' && params.sessionDirectory.trim().length > 0
    ? resolve(params.sessionDirectory.trim())
    : null;
  if (!sessionDirectory) return;

  const projection = await resolveWorkspaceTrustProjection({
    sourceEnv: params.sourceEnv,
    sessionDirectory,
    targetDir: params.targetDir,
  });
  if (!projection) return;

  const existingRoot = await readJsonObjectFile(join(params.targetDir, '.claude.json')) ?? {};
  const existingProjects = readObject(existingRoot.projects) ?? {};
  await writeClaudeRootConfig({
    targetDir: params.targetDir,
    rootConfig: {
      projects: {
        ...existingProjects,
        [sessionDirectory]: projection,
      },
    },
  });
}
