import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';

import { getClaudeCliPath } from '../scripts/claude_launcher_runtime.cjs';

describe('claude_launcher_runtime getClaudeCliPath', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.restoreAllMocks();
  });

  it('returns claude when no override is set', () => {
    delete process.env.HAPPIER_CLAUDE_PATH;
    delete process.env.HAPPY_CLAUDE_PATH;
    delete process.env.DEBUG;
    delete process.env.HAPPIER_DEBUG_CLAUDE_LAUNCHER;

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(getClaudeCliPath()).toBe('claude');
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('expands ~/ in HAPPIER_CLAUDE_PATH', () => {
    const homeDir = fs.mkdtempSync('/tmp/happier-claude-home-');
    const localBinDir = `${homeDir}/.local/bin`;
    fs.mkdirSync(localBinDir, { recursive: true });
    const homeClaudePath = `${localBinDir}/claude`;
    fs.writeFileSync(homeClaudePath, '#!/bin/bash\necho "mock"');
    fs.chmodSync(homeClaudePath, 0o755);
    const previousHome = process.env.HOME;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      process.env.HOME = homeDir;
      process.env.HAPPIER_CLAUDE_PATH = '~/.local/bin/claude';
      delete process.env.DEBUG;
      delete process.env.HAPPIER_DEBUG_CLAUDE_LAUNCHER;

      expect(fs.realpathSync(getClaudeCliPath())).toBe(fs.realpathSync(homeClaudePath));
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('exits when the override points to a missing file', () => {
    process.env.HAPPIER_CLAUDE_PATH = '/nonexistent/path/claude';

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code ?? ''}`);
    }) as never);

    expect(() => getClaudeCliPath()).toThrow('exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalled();
  });

  it('logs the resolved source when debug is enabled', () => {
    process.env.HAPPIER_CLAUDE_PATH = 'claude';
    process.env.DEBUG = '1';

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(getClaudeCliPath()).toBe('claude');
    expect(errSpy).toHaveBeenCalled();
  });
});
