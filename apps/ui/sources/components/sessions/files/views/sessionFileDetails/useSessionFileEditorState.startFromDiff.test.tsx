import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionFileDetailsCommonModuleMocks } from './sessionFileDetailsTestHelpers';
import type { SessionFileEditorState } from './useSessionFileEditorState';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

installSessionFileDetailsCommonModuleMocks();

const sessionWriteFileSpy = vi.hoisted(() => vi.fn(async () => ({ success: true, hash: 'saved-hash' })));

vi.mock('@/sync/ops', () => ({
    sessionWriteFile: (...args: any[]) => sessionWriteFileSpy(...args),
}));

vi.mock('@/utils/errors/daemonUnavailableAlert', () => ({
    showDaemonUnavailableAlert: vi.fn(),
    tryShowDaemonUnavailableAlertForRpcError: () => false,
}));

type HarnessProps = Readonly<{
    displayMode: 'file' | 'diff';
    fileText: string;
    fileHash?: string | null;
}>;

describe('useSessionFileEditorState (start from diff)', () => {
    it('enters edit mode after switching to file display mode', async () => {
        const { useSessionFileEditorState } = await import('./useSessionFileEditorState');

        let latest: any = null;

        function Harness(props: HarnessProps) {
            latest = useSessionFileEditorState({
                sessionId: 's1',
                sessionPath: '/repo',
                filePath: 'src/a.ts',
                displayMode: props.displayMode,
                fileText: props.fileText,
                fileHash: props.fileHash ?? null,
                fileWriteSupported: true,
                setFileWriteSupported: vi.fn(),
                fileEditorFeatureEnabled: true,
                filesEditorWebMonacoEnabled: true,
                filesEditorNativeCodeMirrorEnabled: true,
                filesEditorAutoSave: false,
                filesEditorChangeDebounceMs: 10,
                filesEditorMaxFileBytes: 10_000,
                filesEditorBridgeMaxChunkBytes: 10_000,
                mountedRef: { current: true },
                refreshAll: vi.fn(async () => undefined),
            });
            return null;
        }

        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(<Harness displayMode="diff" fileText={'console.log(1);'} />)).tree;

        expect(latest).not.toBeNull();

        await act(async () => {
            latest.startEditingFile();
        });

        expect(latest.isEditingFile).toBe(false);

        await act(async () => {
            tree.update(<Harness displayMode="file" fileText={'console.log(1);'} />);
        });

        expect(latest.isEditingFile).toBe(true);
    });

    it('does not clobber dirty edits when fileText refreshes', async () => {
        const { useSessionFileEditorState } = await import('./useSessionFileEditorState');

        let latest: any = null;

        function Harness(props: HarnessProps) {
            latest = useSessionFileEditorState({
                sessionId: 's1',
                sessionPath: '/repo',
                filePath: 'src/a.ts',
                displayMode: 'file',
                fileText: props.fileText,
                fileHash: props.fileHash ?? null,
                fileWriteSupported: true,
                setFileWriteSupported: vi.fn(),
                fileEditorFeatureEnabled: true,
                filesEditorWebMonacoEnabled: true,
                filesEditorNativeCodeMirrorEnabled: true,
                filesEditorAutoSave: false,
                filesEditorChangeDebounceMs: 10,
                filesEditorMaxFileBytes: 10_000,
                filesEditorBridgeMaxChunkBytes: 10_000,
                mountedRef: { current: true },
                refreshAll: vi.fn(async () => undefined),
            });
            return null;
        }

        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(<Harness displayMode="file" fileText={'console.log(1);'} fileHash="hash-1" />)).tree;

        await act(async () => {
            latest.startEditingFile();
        });

        await act(async () => {
            latest.onEditorChange('console.log(2);');
        });

        expect(latest.editorDirty).toBe(true);

        await act(async () => {
            tree.update(<Harness displayMode="file" fileText={'console.log(1);\\n// refreshed'} fileHash="hash-2" />);
        });

        expect(latest.getEditorText()).toBe('console.log(2);');
        expect(latest.fileChangedExternally).toBe(true);
    });

    it('does not reset the editor while editing when fileText refreshes before dirty state changes', async () => {
        const { useSessionFileEditorState } = await import('./useSessionFileEditorState');

        let latest: SessionFileEditorState | null = null;
        const getLatest = () => {
            if (!latest) throw new Error('editor state was not captured');
            return latest;
        };

        function Harness(props: HarnessProps) {
            latest = useSessionFileEditorState({
                sessionId: 's1',
                sessionPath: '/repo',
                filePath: 'src/a.ts',
                displayMode: 'file',
                fileText: props.fileText,
                fileHash: props.fileHash ?? null,
                fileWriteSupported: true,
                setFileWriteSupported: vi.fn(),
                fileEditorFeatureEnabled: true,
                filesEditorWebMonacoEnabled: true,
                filesEditorNativeCodeMirrorEnabled: true,
                filesEditorAutoSave: false,
                filesEditorChangeDebounceMs: 10,
                filesEditorMaxFileBytes: 10_000,
                filesEditorBridgeMaxChunkBytes: 10_000,
                mountedRef: { current: true },
                refreshAll: vi.fn(async () => undefined),
            });
            return null;
        }

        const tree = (await renderScreen(<Harness displayMode="file" fileText={'console.log(1);'} fileHash="hash-1" />)).tree;

        await act(async () => {
            getLatest().startEditingFile();
        });

        const resetKeyBeforeRefresh = getLatest().editorResetKey;
        const seedBeforeRefresh = getLatest().editorSeedText;

        await act(async () => {
            tree.update(<Harness displayMode="file" fileText={'console.log(1);\n// refreshed'} fileHash="hash-2" />);
        });

        expect(getLatest().editorResetKey).toBe(resetKeyBeforeRefresh);
        expect(getLatest().editorSeedText).toBe(seedBeforeRefresh);
        expect(getLatest().getEditorText()).toBe(seedBeforeRefresh);
        expect(getLatest().fileChangedExternally).toBe(true);
    });

    it('guards saves with the hash from the loaded file content', async () => {
        const { useSessionFileEditorState } = await import('./useSessionFileEditorState');

        let latest: SessionFileEditorState | null = null;
        const getLatest = () => {
            if (!latest) throw new Error('editor state was not captured');
            return latest;
        };

        function Harness(props: HarnessProps) {
            latest = useSessionFileEditorState({
                sessionId: 's1',
                sessionPath: '/repo',
                filePath: 'src/a.ts',
                displayMode: 'file',
                fileText: props.fileText,
                fileHash: props.fileHash ?? null,
                fileWriteSupported: true,
                setFileWriteSupported: vi.fn(),
                fileEditorFeatureEnabled: true,
                filesEditorWebMonacoEnabled: true,
                filesEditorNativeCodeMirrorEnabled: true,
                filesEditorAutoSave: false,
                filesEditorChangeDebounceMs: 10,
                filesEditorMaxFileBytes: 10_000,
                filesEditorBridgeMaxChunkBytes: 10_000,
                mountedRef: { current: true },
                refreshAll: vi.fn(async () => undefined),
            });
            return null;
        }

        sessionWriteFileSpy.mockClear();
        await renderScreen(<Harness displayMode="file" fileText={'console.log(1);'} fileHash="loaded-hash" />);

        await act(async () => {
            getLatest().startEditingFile();
        });

        await act(async () => {
            getLatest().onEditorChange('console.log(2);');
        });

        await act(async () => {
            getLatest().saveFileEdits();
        });

        expect(sessionWriteFileSpy).toHaveBeenCalledWith('s1', 'src/a.ts', 'console.log(2);', 'loaded-hash');
    });

    it('keeps save callback stable across equivalent input rerenders', async () => {
        const { useSessionFileEditorState } = await import('./useSessionFileEditorState');

        let latest: any = null;
        const mountedRef = { current: true };
        const setFileWriteSupported = vi.fn();
        const refreshAll = vi.fn(async () => undefined);

        function Harness(props: HarnessProps) {
            latest = useSessionFileEditorState({
                sessionId: 's1',
                sessionPath: '/repo',
                filePath: 'src/a.ts',
                displayMode: props.displayMode,
                fileText: props.fileText,
                fileHash: props.fileHash ?? null,
                fileWriteSupported: true,
                setFileWriteSupported,
                fileEditorFeatureEnabled: true,
                filesEditorWebMonacoEnabled: true,
                filesEditorNativeCodeMirrorEnabled: true,
                filesEditorAutoSave: false,
                filesEditorChangeDebounceMs: 10,
                filesEditorMaxFileBytes: 10_000,
                filesEditorBridgeMaxChunkBytes: 10_000,
                mountedRef,
                refreshAll,
            });
            return null;
        }

        const tree = (await renderScreen(<Harness displayMode="file" fileText={'console.log(1);'} />)).tree;
        await act(async () => {});

        const firstSaveFileEdits = latest.saveFileEdits;

        await act(async () => {
            tree.update(<Harness displayMode="file" fileText={'console.log(1);'} />);
        });

        expect(latest.saveFileEdits).toBe(firstSaveFileEdits);
    });

    it('keeps cancel callback stable when loaded file text hydrates editor state', async () => {
        const { useSessionFileEditorState } = await import('./useSessionFileEditorState');

        let latest: any = null;

        function Harness(props: HarnessProps) {
            latest = useSessionFileEditorState({
                sessionId: 's1',
                sessionPath: '/repo',
                filePath: 'src/a.ts',
                displayMode: props.displayMode,
                fileText: props.fileText,
                fileHash: props.fileHash ?? null,
                fileWriteSupported: true,
                setFileWriteSupported: vi.fn(),
                fileEditorFeatureEnabled: true,
                filesEditorWebMonacoEnabled: true,
                filesEditorNativeCodeMirrorEnabled: true,
                filesEditorAutoSave: false,
                filesEditorChangeDebounceMs: 10,
                filesEditorMaxFileBytes: 10_000,
                filesEditorBridgeMaxChunkBytes: 10_000,
                mountedRef: { current: true },
                refreshAll: vi.fn(async () => undefined),
            });
            return null;
        }

        await renderScreen(<Harness displayMode="file" fileText={'console.log(1);'} />);
        const firstCancelEditingFile = latest.cancelEditingFile;

        await act(async () => {});

        expect(latest.cancelEditingFile).toBe(firstCancelEditingFile);
    });

});
