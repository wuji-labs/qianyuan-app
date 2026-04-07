import { accessSync, constants as fsConstants, existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

import {
  getProviderCliRuntimeSpec,
  type AgentId,
  type ProviderCliKnownCommandCandidate,
  type ProviderCliManagedInstallSpec,
  type ProviderCliSourcePreference,
} from '@happier-dev/agents';
import { buildBackendTargetKey } from '@happier-dev/protocol';

import { resolveWindowsCommandOnPath, resolveWindowsCommandPath } from '../process/index.js';
import { resolveJavaScriptRuntimeCommand } from './managedJavaScriptRuntime.js';
import { resolveHappyHomeDirFromEnvironment } from './resolveHappyHomeDir.js';

export type ProviderCliResolutionSource = 'override' | 'system' | 'managed';

export type ProviderCliCommandResolution = Readonly<{
  source: ProviderCliResolutionSource;
  command: string;
}>;

type RuntimeResolutionOptions = Readonly<{
  isBunRuntime?: boolean;
  currentExecPath?: string | null;
}>;

function readBackendCliSourcePreferenceMap(processEnv: NodeJS.ProcessEnv): Partial<Record<AgentId, ProviderCliSourcePreference>> {
  const raw = typeof processEnv.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON === 'string'
    ? processEnv.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON.trim()
    : '';
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => value === 'system-first' || value === 'managed-first'),
    ) as Partial<Record<AgentId, ProviderCliSourcePreference>>;
  } catch {
    return {};
  }
}

export function readBackendCliSourcePreference(
  agentId: AgentId,
  processEnv: NodeJS.ProcessEnv = process.env,
): ProviderCliSourcePreference {
  const preferences = readBackendCliSourcePreferenceMap(processEnv);
  const targetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId });
  return preferences[targetKey as AgentId] ?? preferences[agentId] ?? getProviderCliRuntimeSpec(agentId).sourcePreferenceDefault;
}

function resolveManagedCommandBasename(spec: ProviderCliManagedInstallSpec): string {
  if (process.platform !== 'win32') return spec.binaryName;
  return spec.kind === 'github_release_binary' ? `${spec.binaryName}.exe` : `${spec.binaryName}.cmd`;
}

export function readProviderCliOverride(agentId: AgentId, processEnv: NodeJS.ProcessEnv = process.env): string | null {
  const envKey = `HAPPIER_${agentId.toUpperCase()}_PATH`;
  const override = expandHomeDirPath(
    typeof processEnv[envKey] === 'string' ? String(processEnv[envKey]).trim() : '',
    processEnv,
  );
  return override || null;
}

export function resolveHomeDirFromEnvironment(processEnv: NodeJS.ProcessEnv = process.env): string {
  const envHome =
    process.platform === 'win32'
      ? (processEnv.USERPROFILE || processEnv.HOME)
      : processEnv.HOME;
  const trimmed = typeof envHome === 'string' ? envHome.trim() : '';
  return trimmed.length > 0 ? trimmed : homedir();
}

export function expandHomeDirPath(value: string, processEnv: NodeJS.ProcessEnv = process.env): string {
  if (value === '~') return resolveHomeDirFromEnvironment(processEnv);
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return join(resolveHomeDirFromEnvironment(processEnv), value.slice(2));
  }
  return value;
}

function providerCliCandidatePathExists(agentId: AgentId, candidatePath: string): boolean {
  const runtimeSpec = getProviderCliRuntimeSpec(agentId);
  const accessMode = process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK;
  try {
    accessSync(candidatePath, accessMode);
    return true;
  } catch {
    if (!runtimeSpec.acceptsJavaScriptFileOverride || process.platform === 'win32') return false;
    if (!/\.(?:c?js|mjs)$/i.test(candidatePath)) return false;
    try {
      accessSync(candidatePath, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

function resolveProviderCliOverride(agentId: AgentId, processEnv: NodeJS.ProcessEnv): string | null {
  const override = readProviderCliOverride(agentId, processEnv);
  if (!override) return null;
  if (process.platform === 'win32') {
    const normalizedOverride =
      (override.includes('/') || override.includes('\\') || override.includes(':'))
        ? resolveWindowsCommandPath(override, processEnv)
        : resolveWindowsCommandOnPath(override, processEnv);
    if (normalizedOverride) return normalizedOverride;
  }
  return providerCliCandidatePathExists(agentId, override) ? override : null;
}

export function resolveProviderCliManagedCommandPath(
  agentId: AgentId,
  opts: Readonly<{ happyHomeDir?: string | null; processEnv?: NodeJS.ProcessEnv }> = {},
): string {
  const runtimeSpec = getProviderCliRuntimeSpec(agentId);
  const managedInstall = runtimeSpec.managedInstall;
  if (!managedInstall) {
    throw new Error(`Provider ${agentId} does not define a managed CLI install path`);
  }
  const processEnv = opts.processEnv ?? process.env;
  const happyHomeDir = typeof opts.happyHomeDir === 'string' && opts.happyHomeDir.trim().length > 0
    ? opts.happyHomeDir.trim()
    : resolveHappyHomeDirFromEnvironment(processEnv);
  return join(happyHomeDir, 'tools', 'providers', agentId, 'current', 'bin', resolveManagedCommandBasename(managedInstall));
}

function resolveCommandOnPath(command: string, processEnv: NodeJS.ProcessEnv): string | null {
  if (process.platform === 'win32') {
    return resolveWindowsCommandOnPath(command, processEnv) ?? null;
  }

  const pathDirs = String(processEnv.PATH ?? '')
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = join(dir, command);
    if (!existsSync(candidate)) continue;
    // On Unix, verify the file is executable
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // File exists but is not executable; continue searching
      continue;
    }
  }
  return null;
}

function readFileHeader(candidatePath: string): string | null {
  try {
    return readFileSync(candidatePath, 'utf8').slice(0, 512);
  } catch {
    return null;
  }
}

function unixScriptRequiresJavaScriptRuntime(candidatePath: string): boolean {
  const header = readFileHeader(candidatePath);
  if (!header?.startsWith('#!')) return false;
  const firstLine = header.split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!firstLine) return false;
  return /(?:^#!.*\b(?:env(?:\s+-S)?\s+)?)\b(?:node|bun)(?:\s|$)/i.test(firstLine);
}

export function providerCliPathRequiresJavaScriptRuntime(candidatePath: string): boolean {
  if (/\.(?:c?js|mjs)$/i.test(candidatePath)) {
    return true;
  }

  if (process.platform === 'win32') {
    return false;
  }

  return unixScriptRequiresJavaScriptRuntime(candidatePath);
}

function compareSemverLikeNamesDescending(a: string, b: string): number {
  const parse = (value: string): [number, number, number] | null => {
    const match = value.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
    if (!match) return null;
    const major = Number.parseInt(match[1]!, 10);
    const minor = Number.parseInt(match[2]!, 10);
    const patch = Number.parseInt(match[3]!, 10);
    if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null;
    return [major, minor, patch];
  };

  const parsedA = parse(a);
  const parsedB = parse(b);
  if (!parsedA && !parsedB) return b.localeCompare(a);
  if (!parsedA) return 1;
  if (!parsedB) return -1;
  for (let index = 0; index < 3; index += 1) {
    const diff = parsedB[index]! - parsedA[index]!;
    if (diff !== 0) return diff;
  }
  return b.localeCompare(a);
}

function resolveProviderCliInVersionedDir(agentId: AgentId, versionsDir: string): string | null {
  const runtimeSpec = getProviderCliRuntimeSpec(agentId);
  const commandNames = process.platform === 'win32'
    ? [`${runtimeSpec.binaryName}.exe`, runtimeSpec.binaryName]
    : [runtimeSpec.binaryName];
  const extraEntryNames = runtimeSpec.acceptsJavaScriptFileOverride ? ['cli.js', 'cli.cjs', 'cli.mjs'] : [];

  try {
    const entries = readdirSync(versionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareSemverLikeNamesDescending);

    for (const entry of entries) {
      for (const candidateName of [...commandNames, ...extraEntryNames]) {
        const directCandidate = join(versionsDir, entry, candidateName);
        if (providerCliCandidatePathExists(agentId, directCandidate)) {
          return directCandidate;
        }
        const nestedCandidate = join(versionsDir, entry, 'bin', candidateName);
        if (providerCliCandidatePathExists(agentId, nestedCandidate)) {
          return nestedCandidate;
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

function resolveKnownCommandCandidate(agentId: AgentId, candidate: ProviderCliKnownCommandCandidate, processEnv: NodeJS.ProcessEnv): string | null {
  const homeDir = resolveHomeDirFromEnvironment(processEnv);
  const runtimeSpec = getProviderCliRuntimeSpec(agentId);
  switch (candidate.kind) {
    case 'homeBinDir': {
      const commandPath = join(homeDir, candidate.relativeDir, runtimeSpec.binaryName);
      return providerCliCandidatePathExists(agentId, commandPath) ? commandPath : null;
    }
    case 'homePath': {
      const commandPath = join(homeDir, candidate.relativePath);
      return providerCliCandidatePathExists(agentId, commandPath) ? commandPath : null;
    }
    case 'absolutePath':
      return providerCliCandidatePathExists(agentId, candidate.path) ? candidate.path : null;
    case 'homeVersionedDir':
      return resolveProviderCliInVersionedDir(agentId, join(homeDir, candidate.relativeDir));
  }
  return null;
}

function resolveCommandInKnownLocations(agentId: AgentId, processEnv: NodeJS.ProcessEnv): string | null {
  const candidates = getProviderCliRuntimeSpec(agentId).knownCommandCandidates ?? [];
  for (const candidate of candidates) {
    const resolved = resolveKnownCommandCandidate(agentId, candidate, processEnv);
    if (resolved) return resolved;
  }
  return null;
}

function resolveProviderCliSystemCommand(agentId: AgentId, processEnv: NodeJS.ProcessEnv): string | null {
  const runtimeSpec = getProviderCliRuntimeSpec(agentId);
  return resolveCommandOnPath(runtimeSpec.binaryName, processEnv) ?? resolveCommandInKnownLocations(agentId, processEnv);
}

function resolveProviderCliManagedCommand(agentId: AgentId, processEnv: NodeJS.ProcessEnv): string | null {
  const runtimeSpec = getProviderCliRuntimeSpec(agentId);
  if (!runtimeSpec.managedInstall) return null;
  const managedPath = resolveProviderCliManagedCommandPath(agentId, { processEnv });
  const accessMode = process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK;
  try {
    accessSync(managedPath, accessMode);
    return managedPath;
  } catch {
    return null;
  }
}

export function isProviderCliPathRunnable(
  commandPath: string,
  processEnv: NodeJS.ProcessEnv,
  runtimeOptions: RuntimeResolutionOptions,
): boolean {
  if (!providerCliPathRequiresJavaScriptRuntime(commandPath)) {
    return true;
  }

  return Boolean(resolveJavaScriptRuntimeCommand({
    isBunRuntime: runtimeOptions.isBunRuntime ?? (typeof process.versions.bun === 'string'),
    processEnv,
    currentExecPath: runtimeOptions.currentExecPath,
  }));
}

export function resolveProviderCliCommand(
  agentId: AgentId,
  opts: Readonly<{ processEnv?: NodeJS.ProcessEnv } & RuntimeResolutionOptions> = {},
): ProviderCliCommandResolution | null {
  const processEnv = opts.processEnv ?? process.env;
  const rawOverride = readProviderCliOverride(agentId, processEnv);
  if (rawOverride) {
    const override = resolveProviderCliOverride(agentId, processEnv);
    if (!override) return null;
    if (!isProviderCliPathRunnable(override, processEnv, opts)) return null;
    return { source: 'override', command: override };
  }

  const systemCommand = resolveProviderCliSystemCommand(agentId, processEnv);
  const managedCommand = resolveProviderCliManagedCommand(agentId, processEnv);
  const sourcePreference = readBackendCliSourcePreference(agentId, processEnv);

  if (sourcePreference === 'managed-first') {
    if (managedCommand && isProviderCliPathRunnable(managedCommand, processEnv, opts)) {
      return { source: 'managed', command: managedCommand };
    }
    if (systemCommand && isProviderCliPathRunnable(systemCommand, processEnv, opts)) {
      return { source: 'system', command: systemCommand };
    }
    return null;
  }

  if (systemCommand && isProviderCliPathRunnable(systemCommand, processEnv, opts)) {
    return { source: 'system', command: systemCommand };
  }
  if (managedCommand && isProviderCliPathRunnable(managedCommand, processEnv, opts)) {
    return { source: 'managed', command: managedCommand };
  }
  return null;
}
