import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { materializeClaudeWorkspaceTrust } from './materializeClaudeWorkspaceTrust';

describe('materializeClaudeWorkspaceTrust', () => {
  it('does not treat the isolated target config root as a trust source', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-home-'));
    const targetDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-target-'));
    const sessionDirectory = await mkdtemp(join(tmpdir(), 'happier-claude-trust-project-'));
    const existingTargetConfig = {
      oauthAccount: { accessToken: 'target-root-token-must-not-influence-trust' },
      projects: {
        [sessionDirectory]: {
          hasTrustDialogAccepted: true,
          hasCompletedProjectOnboarding: true,
          allowedTools: ['Bash(*)'],
        },
      },
    };
    const targetConfigPath = join(targetDir, '.claude.json');
    await writeFile(targetConfigPath, `${JSON.stringify(existingTargetConfig)}\n`);

    await materializeClaudeWorkspaceTrust({
      sourceEnv: {
        CLAUDE_CONFIG_DIR: targetDir,
        HOME: homeDir,
      },
      targetDir,
      sessionDirectory,
    });

    await expect(readFile(targetConfigPath, 'utf8')).resolves.toBe(`${JSON.stringify(existingTargetConfig)}\n`);
  });

  it('preserves sanitized oauth account metadata from the selected Claude root while projecting trust', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-home-'));
    const sourceDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-source-'));
    const targetDir = await mkdtemp(join(tmpdir(), 'happier-claude-trust-target-'));
    const sessionDirectory = await mkdtemp(join(tmpdir(), 'happier-claude-trust-project-'));

    await writeFile(
      join(sourceDir, '.claude.json'),
      `${JSON.stringify({
        oauthAccount: {
          emailAddress: 'selected@example.test',
          displayName: 'Selected User',
          accessToken: 'must-not-copy',
          refreshToken: 'must-not-copy',
        },
        projects: {
          [sessionDirectory]: {
            hasTrustDialogAccepted: true,
            hasCompletedProjectOnboarding: true,
          },
        },
      })}\n`,
    );

    await materializeClaudeWorkspaceTrust({
      sourceEnv: {
        CLAUDE_CONFIG_DIR: sourceDir,
        HOME: homeDir,
      },
      targetDir,
      sessionDirectory,
    });

    const written = JSON.parse(await readFile(join(targetDir, '.claude.json'), 'utf8')) as Record<string, unknown>;
    expect(written.oauthAccount).toEqual({
      emailAddress: 'selected@example.test',
      displayName: 'Selected User',
    });
    expect(written.projects).toEqual({
      [sessionDirectory]: {
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
      },
    });
  });
});
