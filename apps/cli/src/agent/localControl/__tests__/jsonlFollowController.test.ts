import { describe, expect, it, vi } from 'vitest';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJsonlFollowController, type JsonlFollowControllerWatchFile } from '../jsonlFollowController';

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(assertion: () => void, opts?: { timeoutMs?: number; intervalMs?: number }) {
    const timeoutMs = opts?.timeoutMs ?? 5000;
    const intervalMs = opts?.intervalMs ?? 10;
    const start = Date.now();

    // eslint-disable-next-line no-constant-condition
    while (true) {
        try {
            assertion();
            return;
        } catch (error) {
            if (Date.now() - start > timeoutMs) {
                throw error;
            }
            await delay(intervalMs);
        }
    }
}

describe('JsonlFollowController', () => {
    it('drains immediately when the watcher reports a file change', async () => {
        const root = await mkdtemp(join(tmpdir(), 'jsonl-follow-controller-watch-'));
        const filePath = join(root, 'rollout.jsonl');
        await writeFile(filePath, '');

        const watcherCallbackRef: { current?: (file: string) => void } = {};
        const stopWatcher = vi.fn();
        const watchFile: JsonlFollowControllerWatchFile = (file, callback) => {
            expect(file).toBe(filePath);
            watcherCallbackRef.current = callback;
            return stopWatcher;
        };

        const received: unknown[] = [];
        const controller = createJsonlFollowController({
            filePath,
            pollIntervalMs: 60_000,
            watchFile,
            onJson: (value) => {
                received.push(value);
            },
        });

        try {
            await controller.start();
            await appendFile(filePath, '{"a":1}\n');
            const onFileChange = watcherCallbackRef.current;
            if (!onFileChange) throw new Error('Expected watcher callback to be registered');
            onFileChange(filePath);

            await waitFor(() => {
                expect(received).toEqual([{ a: 1 }]);
            });
        } finally {
            await controller.stop();
            expect(stopWatcher).toHaveBeenCalledTimes(1);
            await rm(root, { recursive: true, force: true });
        }
    });

    it('final-drains and closes resources after completion grace', async () => {
        const root = await mkdtemp(join(tmpdir(), 'jsonl-follow-controller-complete-'));
        const filePath = join(root, 'rollout.jsonl');
        await writeFile(filePath, '{"a":1}\n');

        const stopWatcher = vi.fn();
        const onClosed = vi.fn();
        const received: unknown[] = [];
        const controller = createJsonlFollowController({
            filePath,
            pollIntervalMs: 60_000,
            pollPolicy: { sidechainCompletionGraceMs: 1 },
            watchFile: () => stopWatcher,
            onClosed,
            onJson: (value) => {
                received.push(value);
            },
        });

        try {
            await controller.start();
            expect(received).toEqual([{ a: 1 }]);

            await appendFile(filePath, '{"b":2}\n');
            controller.markCompleted();
            expect(controller.getState()).toBe('completed');

            await waitFor(() => {
                expect(received).toEqual([{ a: 1 }, { b: 2 }]);
                expect(controller.getState()).toBe('closed');
                expect(stopWatcher).toHaveBeenCalledTimes(1);
                expect(onClosed).toHaveBeenCalledTimes(1);
            });
        } finally {
            await controller.stop().catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    });
});
