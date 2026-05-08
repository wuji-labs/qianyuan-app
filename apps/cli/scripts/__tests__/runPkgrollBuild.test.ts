import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createTempDirSync } from '../../src/testkit/fs/tempDir';
import { runPkgrollBuild } from '../runPkgrollBuild.mjs';

describe('runPkgrollBuild', () => {
  it('runs pkgroll with a package.json entrypoint filter without mutating the package manifest', () => {
    const dir = createTempDirSync('happier-cli-pkgroll-manifest-');
    const packageJsonPath = join(dir, 'package.json');
    const original = {
      main: './dist/index.cjs',
      bin: {
        happier: './bin/happier.mjs',
      },
      exports: {
        '.': {
          import: {
            default: './package-dist/index.mjs',
          },
        },
      },
    };
    writeFileSync(packageJsonPath, `${JSON.stringify(original, null, 2)}\n`, 'utf8');

    let manifestObservedByPkgroll: any = null;
    const spawn = vi.fn(() => {
      manifestObservedByPkgroll = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      return { status: 0 };
    });

    runPkgrollBuild({ cwd: dir, spawn });

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringContaining('pkgroll/dist/cli.mjs'), '--packagejson', 'dist/**'],
      expect.objectContaining({ cwd: dir, stdio: 'inherit' }),
    );
    expect(manifestObservedByPkgroll).toEqual(original);
    expect(JSON.parse(readFileSync(packageJsonPath, 'utf8'))).toEqual(original);
  });
});
