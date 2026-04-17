import { mkdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, expect, it, vi } from 'vitest';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import { runScmRoute } from './dispatch';

type TestResponse = {
    success: boolean;
    error?: string;
    errorCode?: string;
};

describe('runScmRoute', () => {
    it('returns INVALID_PATH when restricted cwd fails validation', async () => {
        const suiteDir = mkdtempSync(join(tmpdir(), 'happier-scm-dispatch-'));
        const workspace = join(suiteDir, 'workspace');
        const outside = join(suiteDir, 'outside');
        mkdirSync(workspace, { recursive: true });
        mkdirSync(outside, { recursive: true });
        const runWithBackend = vi.fn();

        const response = await runScmRoute<{ cwd?: string }, TestResponse>({
            request: { cwd: outside },
            workingDirectory: workspace,
            accessPolicy: {
                kind: 'restrictedRoots',
                roots: [workspace],
            },
            onNonRepository: () => ({ success: false, errorCode: SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY }),
            runWithBackend,
        });

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.INVALID_PATH);
        expect(runWithBackend).not.toHaveBeenCalled();
    });

    it('allows an absolute cwd outside the default directory when no restricted policy is configured', async () => {
        const suiteDir = mkdtempSync(join(tmpdir(), 'happier-scm-dispatch-'));
        const defaultDirectory = join(suiteDir, 'default');
        const externalRepo = join(suiteDir, 'external-repo');
        mkdirSync(defaultDirectory, { recursive: true });
        mkdirSync(externalRepo, { recursive: true });
        const onNonRepository = vi.fn().mockResolvedValue({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY,
            error: 'Not a repository',
        } satisfies TestResponse);
        const runWithBackend = vi.fn();

        const response = await runScmRoute<{ cwd?: string }, TestResponse>({
            request: { cwd: externalRepo },
            workingDirectory: defaultDirectory,
            onNonRepository,
            runWithBackend,
        });

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY);
        expect(onNonRepository).toHaveBeenCalledTimes(1);
        expect(onNonRepository).toHaveBeenCalledWith(expect.objectContaining({ cwd: externalRepo }));
        expect(runWithBackend).not.toHaveBeenCalled();
    });

    it('returns INVALID_PATH for cwd outside every restricted root', async () => {
        const suiteDir = mkdtempSync(join(tmpdir(), 'happier-scm-dispatch-'));
        const defaultDirectory = join(suiteDir, 'default');
        const restrictedRoot = join(suiteDir, 'allowed');
        const outside = join(suiteDir, 'outside');
        mkdirSync(defaultDirectory, { recursive: true });
        mkdirSync(restrictedRoot, { recursive: true });
        mkdirSync(outside, { recursive: true });
        const onNonRepository = vi.fn();
        const runWithBackend = vi.fn();

        const response = await runScmRoute<{ cwd?: string }, TestResponse>({
            request: { cwd: outside },
            workingDirectory: defaultDirectory,
            accessPolicy: {
                kind: 'restrictedRoots',
                roots: [restrictedRoot],
            },
            onNonRepository,
            runWithBackend,
        });

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.INVALID_PATH);
        expect(onNonRepository).not.toHaveBeenCalled();
        expect(runWithBackend).not.toHaveBeenCalled();
    });

    it('calls onNonRepository when no backend matches the cwd', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-scm-dispatch-'));
        const onNonRepository = vi.fn().mockResolvedValue({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY,
            error: 'Not a repository',
        } satisfies TestResponse);
        const runWithBackend = vi.fn();

        const response = await runScmRoute<{ cwd?: string }, TestResponse>({
            request: { cwd: '.' },
            workingDirectory: workspace,
            onNonRepository,
            runWithBackend,
        });

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY);
        expect(onNonRepository).toHaveBeenCalledTimes(1);
        expect(runWithBackend).not.toHaveBeenCalled();
    });

    it('falls back to non-repository handler when no backend matches preference', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-scm-dispatch-'));
        const onNonRepository = vi.fn().mockResolvedValue({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY,
            error: 'Not a repository',
        } satisfies TestResponse);
        const runWithBackend = vi.fn();

        const response = await runScmRoute<{
            cwd?: string;
            backendPreference?: { kind: 'prefer'; backendId: 'git' | 'sapling' };
        }, TestResponse>({
            request: {
                cwd: '.',
                backendPreference: { kind: 'prefer', backendId: 'git' },
            },
            workingDirectory: workspace,
            onNonRepository,
            runWithBackend,
        });

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY);
        expect(onNonRepository).toHaveBeenCalledTimes(1);
        expect(runWithBackend).not.toHaveBeenCalled();
    });
});
