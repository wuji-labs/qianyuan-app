import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { compileBunBinary, resolveBunCommand } from './commands.js';

describe('resolveBunCommand', () => {
    it('expands ~/ explicit bun overrides against HOME', () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'cli-common-bun-override-'));
        try {
            const homeDir = join(tempRoot, 'home');
            const bunPath = join(homeDir, 'custom-tools', 'bun', process.platform === 'win32' ? 'bun.exe' : 'bun');
            mkdirSync(join(homeDir, 'custom-tools', 'bun'), { recursive: true });
            writeFileSync(bunPath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', {
                mode: 0o755,
            });

            expect(resolveBunCommand({
                processEnv: {
                    HOME: homeDir,
                    USERPROFILE: homeDir,
                    HAPPIER_BUN_PATH: `~/custom-tools/bun/${process.platform === 'win32' ? 'bun.exe' : 'bun'}`,
                },
                commandProbe: () => false,
            })).toBe(bunPath);
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('resolves bun from BUN_INSTALL when bun is not on PATH', () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'cli-common-bun-install-'));
        try {
            const bunInstallDir = join(tempRoot, '.bun');
            const bunBinDir = join(bunInstallDir, 'bin');
            const bunPath = join(bunBinDir, process.platform === 'win32' ? 'bun.exe' : 'bun');
            mkdirSync(bunBinDir, { recursive: true });
            writeFileSync(bunPath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', {
                mode: 0o755,
            });

            expect(resolveBunCommand({
                processEnv: {
                    BUN_INSTALL: bunInstallDir,
                },
                commandProbe: () => false,
            })).toBe(bunPath);
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });
});

describe('compileBunBinary', () => {
    it('passes --no-cache for release binary compilation', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'cli-common-bun-compile-'));
        try {
            const entrypoint = join(tempRoot, 'index.mjs');
            const outfile = join(tempRoot, 'happier.exe');
            writeFileSync(entrypoint, 'console.log("ok");\n', 'utf8');

            const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
            await compileBunBinary({
                entrypoint,
                bunTarget: 'bun-windows-x64',
                outfile,
                bunCommand: 'bun',
                runCommand: async (cmd, args, options) => {
                    calls.push({ cmd, args, cwd: options?.cwd });
                    writeFileSync(outfile, 'compiled', 'utf8');
                },
            });

            expect(calls).toEqual([
                {
                    cmd: 'bun',
                    args: ['build', '--compile', '--no-cache', '--target=bun-windows-x64', entrypoint, '--outfile', outfile],
                    cwd: process.cwd(),
                },
            ]);
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });
});
