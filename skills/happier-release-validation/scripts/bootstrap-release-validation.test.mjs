import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

async function loadModule() {
  try {
    return await import('./bootstrap-release-validation.mjs');
  } catch (error) {
    assert.fail(`bootstrap-release-validation module should exist and export planner helpers: ${error.message}`);
  }
}

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'happier-release-validation-'));
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createMetadataRepo() {
  const repo = createTempDir();
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.test']);
  git(repo, ['config', 'user.name', 'Test User']);
  writeJson(path.join(repo, 'apps/cli/package.json'), { name: '@happier-dev/cli', version: '0.2.6' });
  writeJson(path.join(repo, 'apps/server/package.json'), { name: '@happier-dev/server', version: '0.2.6' });
  writeJson(path.join(repo, 'packages/relay-server/package.json'), { name: '@happier-dev/relay-server', version: '0.2.6' });
  writeJson(path.join(repo, 'apps/ui/package.json'), { name: '@happier-dev/app', version: '0.2.6' });
  writeJson(path.join(repo, 'apps/stack/package.json'), { name: '@happier-dev/stack', version: '0.2.2' });
  writeJson(path.join(repo, 'apps/website/package.json'), { name: '@happier-dev/website', version: '0.2.2' });
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'initial']);
  const previewBase = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['update-ref', 'refs/remotes/origin/preview', previewBase]);
  fs.writeFileSync(path.join(repo, 'candidate.txt'), 'candidate\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'candidate']);
  return { repo, previewBase };
}

describe('happier release validation bootstrap planner', () => {
  it('plans the v0.2.6 worktree branch and ignored tracking workspace deterministically', async () => {
    const { createReleaseValidationWorkspacePlan } = await loadModule();

    const plan = createReleaseValidationWorkspacePlan({
      repoRoot: '/repo/remote-dev',
      version: '0.2.6',
      date: '2026-05-07',
    });

    assert.equal(plan.normalizedVersion, '0.2.6');
    assert.equal(plan.versionSlug, 'v026');
    assert.equal(plan.branchName, 'release/v0.2.6/upstream-dev');
    assert.equal(plan.worktreePath, '/repo/remote-dev-v026');
    assert.equal(plan.reviewDir, '/repo/remote-dev-v026/.project/reviews/2026-05-07-v026-release-validation');
    assert.deepEqual(plan.worktreeCommand, [
      'git',
      '-C',
      '/repo/remote-dev',
      'worktree',
      'add',
      '-b',
      'release/v0.2.6/upstream-dev',
      '/repo/remote-dev-v026',
      'dev',
    ]);
  });

  it('renders tracking templates with the lane catalog and current check command', async () => {
    const { createReleaseValidationWorkspacePlan, renderTemplate } = await loadModule();

    const plan = createReleaseValidationWorkspacePlan({
      repoRoot: '/repo/remote-dev',
      version: '0.2.6',
      date: '2026-05-07',
    });

    const rendered = renderTemplate('Version {{VERSION}} runs {{CUSTOM_CHECKS_COMMAND}} from {{WORKTREE_PATH}}.', plan);

    assert.equal(
      rendered,
      'Version 0.2.6 runs node scripts/pipeline/run.mjs checks --profile custom --custom-checks ui_e2e,e2e_core,e2e_core_slow,server_db_contract,build_website,build_docs,cli_smoke_linux,release_assets_e2e from /repo/remote-dev-v026.',
    );
  });

  it('collects preview drift and package versions for tracking templates', async () => {
    const { collectBaselineMetadata, createReleaseValidationWorkspacePlan, renderTemplate } = await loadModule();
    const { repo, previewBase } = createMetadataRepo();
    const plan = createReleaseValidationWorkspacePlan({
      repoRoot: repo,
      version: '0.2.6',
      date: '2026-05-07',
    });

    const metadata = collectBaselineMetadata(plan);
    const rendered = renderTemplate('base={{PREVIEW_BASE}} drift={{DRIFT_COUNT}}\n{{PACKAGE_VERSIONS}}', {
      ...plan,
      metadata,
    });

    assert.equal(metadata.previewBase, previewBase);
    assert.equal(metadata.driftCount, '1');
    assert.match(rendered, /base=[0-9a-f]{40} drift=1/);
    assert.match(rendered, /\n  - @happier-dev\/cli@0\.2\.6/);
    assert.match(rendered, /\n  - @happier-dev\/stack@0\.2\.2/);
  });

  it('refuses to create a new workspace when the worktree path already exists', async () => {
    const { assertSafeToCreate, createReleaseValidationWorkspacePlan } = await loadModule();
    const repoRoot = createTempDir();
    const worktreePath = createTempDir();
    const plan = createReleaseValidationWorkspacePlan({
      repoRoot,
      version: '0.2.6',
      date: '2026-05-07',
      worktreePath,
    });

    assert.throws(() => assertSafeToCreate(plan), /Worktree path already exists/);
  });

  it('refuses to create a new workspace when the target branch already exists', async () => {
    const { assertSafeToCreate, createReleaseValidationWorkspacePlan } = await loadModule();
    const repoRoot = createMetadataRepo().repo;
    git(repoRoot, ['branch', 'release/v0.2.6/upstream-dev']);
    const plan = createReleaseValidationWorkspacePlan({
      repoRoot,
      version: '0.2.6',
      date: '2026-05-07',
      worktreePath: path.join(path.dirname(repoRoot), 'missing-worktree'),
    });

    assert.throws(() => assertSafeToCreate(plan), /Branch already exists/);
  });

  it('allows resume only when the worktree and branch already exist', async () => {
    const { assertSafeToResume, createReleaseValidationWorkspacePlan } = await loadModule();
    const repoRoot = createMetadataRepo().repo;
    git(repoRoot, ['branch', 'release/v0.2.6/upstream-dev']);
    const worktreePath = createTempDir();
    const plan = createReleaseValidationWorkspacePlan({
      repoRoot,
      version: '0.2.6',
      date: '2026-05-07',
      worktreePath,
    });

    assert.doesNotThrow(() => assertSafeToResume(plan));

    const missingBranchPlan = createReleaseValidationWorkspacePlan({
      repoRoot,
      version: '0.2.7',
      date: '2026-05-07',
      worktreePath,
    });
    assert.throws(() => assertSafeToResume(missingBranchPlan), /branch does not exist/);
  });

  it('preserves existing tracking documents when writing in resume mode', async () => {
    const { createReleaseValidationWorkspacePlan, writeTrackingWorkspace } = await loadModule();
    const worktreePath = createTempDir();
    const plan = {
      ...createReleaseValidationWorkspacePlan({
        repoRoot: '/repo/remote-dev',
        version: '0.2.6',
        date: '2026-05-07',
        worktreePath,
      }),
      metadata: {
        previewBase: 'abc123',
        driftCount: '7',
        packageVersions: '  - @happier-dev/cli@0.2.6',
      },
    };
    fs.mkdirSync(plan.reviewDir, { recursive: true });
    const trackingPath = path.join(plan.reviewDir, 'TRACKING.md');
    fs.writeFileSync(trackingPath, 'live state must survive\n');

    writeTrackingWorkspace(plan, { overwrite: false });

    assert.equal(fs.readFileSync(trackingPath, 'utf8'), 'live state must survive\n');
    assert.ok(fs.existsSync(path.join(plan.reviewDir, 'PLAN.md')));
    assert.ok(fs.existsSync(path.join(plan.reviewDir, 'lanes', 'L21-daemon-ownership-matrix.md')));
  });

  it('renders every generated tracking document and lane without unresolved placeholders', async () => {
    const { createReleaseValidationWorkspacePlan, writeTrackingWorkspace } = await loadModule();
    const worktreePath = createTempDir();
    const plan = {
      ...createReleaseValidationWorkspacePlan({
        repoRoot: '/repo/remote-dev',
        version: '0.2.6',
        date: '2026-05-07',
        worktreePath,
      }),
      metadata: {
        previewBase: 'abc123',
        driftCount: '7',
        packageVersions: '  - @happier-dev/cli@0.2.6',
      },
    };

    writeTrackingWorkspace(plan, { overwrite: true });

    const lanesDir = path.join(plan.reviewDir, 'lanes');
    const laneFiles = fs.readdirSync(lanesDir).filter((entry) => entry.endsWith('.md'));
    assert.equal(laneFiles.length, plan.lanes.length);

    const renderedFiles = [
      'PLAN.md',
      'LEDGER.md',
      'TRACKING.md',
      ...laneFiles.map((entry) => path.join('lanes', entry)),
    ];
    for (const relativePath of renderedFiles) {
      const content = fs.readFileSync(path.join(plan.reviewDir, relativePath), 'utf8');
      assert.equal(content.match(/\{\{[A-Z0-9_]+\}\}/g), null, `${relativePath} has unresolved placeholders`);
    }
  });

  it('renders the daemon ownership lane with concrete regression scenarios', async () => {
    const { createReleaseValidationWorkspacePlan, renderLaneDocument } = await loadModule();
    const plan = createReleaseValidationWorkspacePlan({
      repoRoot: '/repo/remote-dev',
      version: '0.2.6',
      date: '2026-05-07',
    });
    const lane = plan.lanes.find((candidate) => candidate.id === 'L21');

    const rendered = renderLaneDocument(plan, lane);

    assert.match(rendered, /DO-01/);
    assert.match(rendered, /Same-label launchctl bootstrap/);
    assert.match(rendered, /DO-10/);
    assert.match(rendered, /service install --takeover/);
  });
});
