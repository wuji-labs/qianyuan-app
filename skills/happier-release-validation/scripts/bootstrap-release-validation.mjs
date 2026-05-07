#!/usr/bin/env node
// @ts-check
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_CUSTOM_CHECKS = [
  'ui_e2e',
  'e2e_core',
  'e2e_core_slow',
  'server_db_contract',
  'build_website',
  'build_docs',
  'cli_smoke_linux',
  'release_assets_e2e',
];

const DEFAULT_LANES = [
  ['L01', 'baseline-diff-risk-map', 'Read origin/preview..HEAD, classify changed surfaces, seed the risk map.'],
  ['L02', 'pre-mortem', 'Write the top release-break hypotheses and map each to validation lanes.'],
  ['L03', 'environment-prep', 'Prepare Lima snapshots, Windows reachability, Docker, ports, and browser auth state.'],
  ['L04', 'baseline-ci-typecheck', 'Run unit, integration, typecheck, release contracts, installer sync.'],
  ['L05', 'core-e2e', 'Run core fast and slow E2E and own root-cause fixes in narrow domains.'],
  ['L06', 'ui-web-e2e', 'Run Playwright UI E2E; verify web session/auth/session-management flows.'],
  ['L07', 'server-db-website-docs', 'Run DB contract Docker lanes and website/docs builds.'],
  ['L08', 'cli-smoke-linux', 'Run Linux CLI smoke validation in Linux/Lima context.'],
  ['L09', 'release-assets-linux', 'Run docker-release-assets local-build validation.'],
  ['L10', 'cli-update-continuity', 'Validate preview-channel CLI update to local candidate.'],
  ['L11', 'daemon-continuity', 'Validate daemon continuity local-build suite.'],
  ['L12', 'session-continuity', 'Validate session continuity local-build suite.'],
  ['L13', 'installer-smoke-linux', 'Run local-build installer smoke on Linux.'],
  ['L14', 'installer-smoke-darwin', 'Run local-build installer smoke on macOS host.'],
  ['L15', 'installer-smoke-win32', 'Run local-build installer smoke on Windows through ~/connect_windows.sh.'],
  ['L16', 'manual-linux-lima-qa', 'Deep manual QA on Linux Lima relay + daemon + CLI + web UI.'],
  ['L17', 'manual-macos-qa', 'Deep manual QA on macOS host install/upgrade/session flows.'],
  ['L18', 'manual-windows-qa', 'Deep manual QA on Windows install/upgrade/session flows.'],
  ['L19', 'mobile-eas-validate-only', 'Validate native Android/iOS preview flows without store submission.'],
  ['L20', 'provider-contracts', 'Run configured provider smoke lanes, defaulting to all provider smoke when prerequisites exist.'],
  ['L21', 'daemon-ownership-matrix', 'Exercise daemon ownership/service conflict and migration state matrix.'],
  ['L22', 'conditional-stress', 'Run stress only if daemon/session concurrency risks surface.'],
  ['L23', 'reviewer-daemon-ownership', 'Independent review of daemon ownership evidence and fixes.'],
  ['L24', 'reviewer-installer-update', 'Independent review of installer/update evidence and fixes.'],
  ['L25', 'reviewer-session-continuity', 'Independent review of session continuity evidence and fixes.'],
  ['L26', 'release-dry-run', 'Run local release dry-run only; never promote.'],
  ['L27', 'reviewer-final-cross-cutting', 'Final fresh-context review of all evidence, diffs, and exit criteria.'],
];

const PACKAGE_VERSION_PATHS = [
  'apps/cli',
  'apps/server',
  'packages/relay-server',
  'apps/ui',
  'apps/stack',
  'apps/website',
];

/**
 * @param {string} raw
 */
function normalizeVersion(raw) {
  const value = String(raw ?? '').trim().replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`Invalid release version: ${raw}`);
  }
  return value;
}

/**
 * @param {string} version
 */
function createVersionSlug(version) {
  const [major, minor, patch] = version.split('.');
  return `v${major}${minor}${patch.replace(/\D.*$/, '')}`;
}

/**
 * @param {{ repoRoot: string; version: string; date?: string; sourceBranch?: string; worktreePath?: string; reviewSlug?: string; customChecks?: string[] }} input
 */
export function createReleaseValidationWorkspacePlan(input) {
  const repoRoot = path.resolve(input.repoRoot);
  const normalizedVersion = normalizeVersion(input.version);
  const versionSlug = createVersionSlug(normalizedVersion);
  const branchName = `release/v${normalizedVersion}/upstream-dev`;
  const date = input.date ?? new Date().toISOString().slice(0, 10);
  const sourceBranch = input.sourceBranch ?? 'dev';
  const worktreePath = path.resolve(input.worktreePath ?? path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-${versionSlug}`));
  const reviewSlug = input.reviewSlug ?? `${date}-${versionSlug}-release-validation`;
  const reviewDir = path.join(worktreePath, '.project', 'reviews', reviewSlug);
  const customChecks = input.customChecks ?? DEFAULT_CUSTOM_CHECKS;
  const customChecksCommand = `node scripts/pipeline/run.mjs checks --profile custom --custom-checks ${customChecks.join(',')}`;

  return {
    repoRoot,
    normalizedVersion,
    versionWithPrefix: `v${normalizedVersion}`,
    versionSlug,
    date,
    branchName,
    sourceBranch,
    worktreePath,
    reviewSlug,
    reviewDir,
    customChecks,
    customChecksCommand,
    lanes: DEFAULT_LANES.map(([id, slug, scope]) => ({ id, slug, scope })),
    worktreeCommand: ['git', '-C', repoRoot, 'worktree', 'add', '-b', branchName, worktreePath, sourceBranch],
  };
}

/**
 * @param {string} repoRoot
 * @param {string[]} args
 */
function runGitOptional(repoRoot, args) {
  const result = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : 'unavailable';
}

/**
 * @param {ReturnType<typeof createReleaseValidationWorkspacePlan>} plan
 */
export function collectBaselineMetadata(plan) {
  const previewBase = runGitOptional(plan.repoRoot, ['rev-parse', 'origin/preview']);
  const driftCount = runGitOptional(plan.repoRoot, ['rev-list', '--count', 'origin/preview..HEAD']);
  const packageVersions = PACKAGE_VERSION_PATHS.map((packageDir) => {
    const packageJsonPath = path.join(plan.repoRoot, packageDir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      return `  - ${packageDir}: missing package.json`;
    }
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    return `  - ${packageJson.name ?? packageDir}@${packageJson.version ?? 'unknown'}`;
  }).join('\n');
  return {
    previewBase,
    driftCount,
    packageVersions,
  };
}

/**
 * @param {ReturnType<typeof createReleaseValidationWorkspacePlan>} plan
 */
function createLaneRoster(plan) {
  return plan.lanes.map((lane) => `- [ ] ${lane.id} ${lane.slug}: ${lane.scope}`).join('\n');
}

/**
 * @param {ReturnType<typeof createReleaseValidationWorkspacePlan>} plan
 */
function createLaneTable(plan) {
  return [
    '| Lane | Status | Owner | Scope | Evidence |',
    '|---|---|---|---|---|',
    ...plan.lanes.map((lane) => `| ${lane.id} ${lane.slug} | TODO | unassigned | ${lane.scope} | lanes/${lane.id}-${lane.slug}.md |`),
  ].join('\n');
}

/**
 * @param {ReturnType<typeof createReleaseValidationWorkspacePlan>} plan
 */
function createManualQaMatrix() {
  const flows = [
    'Fresh preview install',
    'Current preview daemon login then local candidate upgrade with the same browser account and server URL',
    'Duplicate or legacy service conflict: manual plus service, old preview plus dev, same relay and different relay',
    'Create new sessions after upgrade for Claude, Codex, and OpenCode',
    'Continue existing sessions across server restart, daemon restart, CLI update, and UI reload',
    'Auth and account isolation: same account reuse, account switch, wrong account guard',
    'Storage and encryption: E2EE readable, plaintext readable if enabled, pending queue drains once',
    'Direct session, tail, attach, and takeover for Claude, Codex, and OpenCode',
    'Installer/update rollback: failed update does not break daemon and status gives correct guidance',
    'Native mobile preview install, launch, login, and session creation on Android and iOS',
  ];
  const oses = ['linux-lima', 'macos-host', 'windows-ssh'];
  return [
    '| Code | Flow | OS | Status | Evidence |',
    '|---|---|---|---|---|',
    ...flows.flatMap((flow, flowIndex) => oses.map((os) => `| QA-${String(flowIndex + 1).padStart(2, '0')}-${os} | ${flow} | ${os} | TODO | |`)),
  ].join('\n');
}

/**
 * @param {string} template
 * @param {ReturnType<typeof createReleaseValidationWorkspacePlan>} plan
 */
export function renderTemplate(template, plan) {
  const metadata = plan.metadata ?? {};
  const replacements = new Map([
    ['VERSION', plan.normalizedVersion],
    ['VERSION_WITH_PREFIX', plan.versionWithPrefix],
    ['VERSION_SLUG', plan.versionSlug],
    ['DATE', plan.date],
    ['BRANCH_NAME', plan.branchName],
    ['SOURCE_BRANCH', plan.sourceBranch],
    ['REPO_ROOT', plan.repoRoot],
    ['WORKTREE_PATH', plan.worktreePath],
    ['REVIEW_DIR', plan.reviewDir],
    ['CUSTOM_CHECKS', plan.customChecks.join(',')],
    ['CUSTOM_CHECKS_COMMAND', plan.customChecksCommand],
    ['PREVIEW_BASE', metadata.previewBase ?? 'TODO'],
    ['DRIFT_COUNT', metadata.driftCount ?? 'TODO'],
    ['PACKAGE_VERSIONS', metadata.packageVersions ?? 'TODO'],
    ['LANE_ID', plan.laneId ?? ''],
    ['LANE_SLUG', plan.laneSlug ?? ''],
    ['LANE_SCOPE', plan.laneScope ?? ''],
    ['DAEMON_OWNERSHIP_SCENARIOS', plan.daemonOwnershipScenarios ?? ''],
    ['LANE_ROSTER', createLaneRoster(plan)],
    ['LANE_TABLE', createLaneTable(plan)],
    ['MANUAL_QA_MATRIX', createManualQaMatrix()],
  ]);
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) => replacements.get(key) ?? match);
}

/**
 * @param {ReturnType<typeof createReleaseValidationWorkspacePlan> & { metadata?: ReturnType<typeof collectBaselineMetadata> }} plan
 * @param {{ id: string; slug: string; scope: string }} lane
 */
export function renderLaneDocument(plan, lane) {
  const scriptPath = fileURLToPath(import.meta.url);
  const skillRoot = path.resolve(path.dirname(scriptPath), '..');
  const templatePath = lane.id === 'L21'
    ? path.join(skillRoot, 'assets', 'templates', 'daemon-ownership-lane.md')
    : path.join(skillRoot, 'assets', 'templates', 'lane-template.md');
  const daemonScenariosPath = path.join(skillRoot, 'references', 'daemon-ownership-scenarios.md');
  const template = fs.readFileSync(templatePath, 'utf8');
  const lanePlan = {
    ...plan,
    laneId: lane.id,
    laneSlug: lane.slug,
    laneScope: lane.scope,
    daemonOwnershipScenarios: fs.existsSync(daemonScenariosPath) ? fs.readFileSync(daemonScenariosPath, 'utf8') : '',
  };
  return renderTemplate(template, lanePlan);
}

/**
 * @param {ReturnType<typeof createReleaseValidationWorkspacePlan>} plan
 */
export function assertSafeToCreate(plan) {
  if (!fs.existsSync(plan.repoRoot)) {
    throw new Error(`Repo root does not exist: ${plan.repoRoot}`);
  }
  if (fs.existsSync(plan.worktreePath)) {
    throw new Error(`Worktree path already exists; refusing to overwrite: ${plan.worktreePath}`);
  }
  const branchCheck = spawnSync('git', ['-C', plan.repoRoot, 'show-ref', '--verify', '--quiet', `refs/heads/${plan.branchName}`], { encoding: 'utf8' });
  if (branchCheck.status === 0) {
    throw new Error(`Branch already exists; refusing to recreate: ${plan.branchName}`);
  }
}

/**
 * @param {ReturnType<typeof createReleaseValidationWorkspacePlan> & { metadata?: ReturnType<typeof collectBaselineMetadata> }} plan
 */
export function writeTrackingWorkspace(plan, options = {}) {
  const overwrite = options.overwrite ?? true;
  const scriptPath = fileURLToPath(import.meta.url);
  const skillRoot = path.resolve(path.dirname(scriptPath), '..');
  const templateDir = path.join(skillRoot, 'assets', 'templates');
  const lanesDir = path.join(plan.reviewDir, 'lanes');
  const dirs = [plan.reviewDir, lanesDir, path.join(plan.reviewDir, 'evidence'), path.join(plan.reviewDir, 'credentials'), path.join(plan.reviewDir, 'vm-snapshots'), path.join(plan.reviewDir, 'prompts')];
  for (const dir of dirs) fs.mkdirSync(dir, { recursive: true });

  for (const name of ['PLAN.md', 'LEDGER.md', 'TRACKING.md']) {
    const source = path.join(templateDir, name);
    const rendered = renderTemplate(fs.readFileSync(source, 'utf8'), plan);
    const target = path.join(plan.reviewDir, name);
    if (overwrite || !fs.existsSync(target)) {
      fs.writeFileSync(target, rendered);
    }
  }

  for (const lane of plan.lanes) {
    const target = path.join(lanesDir, `${lane.id}-${lane.slug}.md`);
    if (overwrite || !fs.existsSync(target)) {
      fs.writeFileSync(target, renderLaneDocument(plan, lane));
    }
  }
}

/**
 * @param {ReturnType<typeof createReleaseValidationWorkspacePlan>} plan
 */
export function assertSafeToResume(plan) {
  if (!fs.existsSync(plan.worktreePath)) {
    throw new Error(`Cannot resume because worktree path does not exist: ${plan.worktreePath}`);
  }
  const branchCheck = spawnSync('git', ['-C', plan.repoRoot, 'show-ref', '--verify', '--quiet', `refs/heads/${plan.branchName}`], { encoding: 'utf8' });
  if (branchCheck.status !== 0) {
    throw new Error(`Cannot resume because branch does not exist: ${plan.branchName}`);
  }
}

function parseArgs(argv) {
  const args = { version: '', repoRoot: process.cwd(), date: undefined, dryRun: false, resume: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--version') args.version = argv[++i];
    else if (arg === '--repo-root') args.repoRoot = argv[++i];
    else if (arg === '--date') args.date = argv[++i];
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--resume') args.resume = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node skills/happier-release-validation/scripts/bootstrap-release-validation.mjs --version 0.2.6 [--repo-root /path/to/remote-dev] [--date YYYY-MM-DD] [--dry-run] [--resume]\n\nCreates a release validation worktree and ignored .project/reviews tracking workspace. It never releases or promotes.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.version) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }
  const plan = createReleaseValidationWorkspacePlan({ repoRoot: args.repoRoot, version: args.version, date: args.date });
  const hydratedPlan = {
    ...plan,
    metadata: collectBaselineMetadata(plan),
  };
  if (args.dryRun) {
    console.log(JSON.stringify(hydratedPlan, null, 2));
    return;
  }
  if (args.resume) {
    assertSafeToResume(plan);
  } else {
    assertSafeToCreate(plan);
    const created = spawnSync(plan.worktreeCommand[0], plan.worktreeCommand.slice(1), { stdio: 'inherit' });
    if (created.status !== 0) {
      throw new Error(`git worktree add failed with status ${created.status}`);
    }
  }
  writeTrackingWorkspace(hydratedPlan, { overwrite: !args.resume });
  console.log(`${args.resume ? 'Resumed' : 'Created'} release validation workspace: ${plan.reviewDir}`);
  console.log('Next: cd into the worktree and start from TRACKING.md Read First After Any Compact.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
