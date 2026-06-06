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
});
