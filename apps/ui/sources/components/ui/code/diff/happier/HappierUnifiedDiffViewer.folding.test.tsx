import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let lastCodeLinesViewProps: Record<string, any> | null = null;
let lastLines: any[] | null = null;
let foldingEnabled = true;

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    useSetting: (key: string) => {
        if (key === 'filesDiffFoldingEnabled') return foldingEnabled;
        if (key === 'filesDiffFoldingContextThreshold') return 6;
        if (key === 'filesDiffFoldingContextRadius') return 2;
        return undefined;
    },
});
});

vi.mock('@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting', () => ({
    useCodeLinesSyntaxHighlighting: () => ({
        mode: 'off',
        language: null,
        maxBytes: 1_000_000,
        maxLines: 10_000,
        maxLineLength: 10_000,
    }),
}));

vi.mock('@/components/ui/code/view/CodeLinesView', () => ({
    CodeLinesView: (props: any) => {
        lastCodeLinesViewProps = props;
        lastLines = props.lines;
        return React.createElement('CodeLinesView', props);
    },
}));

function buildDemoUnifiedDiff(): string {
    const lines: string[] = [];
    lines.push('@@ -1,15 +1,15 @@');
    for (let i = 1; i <= 10; i++) {
        lines.push(` line${i}`);
    }
    lines.push('-line11');
    lines.push('+line11changed');
    for (let i = 12; i <= 15; i++) {
        lines.push(` line${i}`);
    }
    lines.push('');
    return lines.join('\n');
}

describe('HappierUnifiedDiffViewer (folding)', () => {
    it('collapses long context blocks when folding is enabled', async () => {
        foldingEnabled = true;
        lastCodeLinesViewProps = null;
        lastLines = null;
        const { HappierUnifiedDiffViewer } = await import('./HappierUnifiedDiffViewer');

        await renderScreen(<HappierUnifiedDiffViewer
                    mode="unified"
                    unifiedDiff={buildDemoUnifiedDiff()}
                    filePath="src/demo.ts"
                />);

        if (!Array.isArray(lastLines)) throw new Error('Expected CodeLinesView lines');
        const lines = lastLines as unknown as unknown[];
        const texts = lines.map((line) => (line as any).renderCodeText);
        expect(texts).toContain('line1');
        expect(texts).toContain('line2');
        expect(texts).toContain('line9');
        expect(texts).toContain('line10');
        expect(texts).not.toContain('line3');
        expect(texts).not.toContain('line8');
    });

    it('reuses precomputed unified diff lines instead of reparsing the diff', async () => {
        foldingEnabled = false;
        lastCodeLinesViewProps = null;
        lastLines = null;
        const precomputedLines = [{
            id: 'precomputed-1',
            sourceIndex: 0,
            kind: 'context',
            oldLine: 1,
            newLine: 1,
            renderPrefixText: ' ',
            renderCodeText: 'from precomputed lines',
            renderIsHeaderLine: false,
            selectable: true,
        }] satisfies CodeLine[];
        const { HappierUnifiedDiffViewer } = await import('./HappierUnifiedDiffViewer');

        await renderScreen(<HappierUnifiedDiffViewer
                    mode="unified"
                    unifiedDiff={'@@ -1 +1 @@\n-from diff\n+from diff\n'}
                    filePath="src/demo.ts"
                    precomputedLines={precomputedLines}
                />);

        expect(lastLines).toBe(precomputedLines);
    });

    it('passes scroll instrumentation props to the code lines view', async () => {
        foldingEnabled = false;
        lastCodeLinesViewProps = null;
        const onScroll = vi.fn();
        const onLayout = vi.fn();
        const onContentSizeChange = vi.fn();
        const { HappierUnifiedDiffViewer } = await import('./HappierUnifiedDiffViewer');

        await renderScreen(<HappierUnifiedDiffViewer
                    mode="unified"
                    unifiedDiff={'@@ -1 +1 @@\n-const value = 1;\n+const value = 2;\n'}
                    filePath="src/demo.ts"
                    testID="diff-scroll"
                    onScroll={onScroll}
                    onLayout={onLayout}
                    onContentSizeChange={onContentSizeChange}
                    scrollEventThrottle={32}
                />);

        const codeLinesViewProps = lastCodeLinesViewProps as Record<string, unknown> | null;
        expect(codeLinesViewProps?.testID).toBe('diff-scroll');
        expect(codeLinesViewProps?.onScroll).toBe(onScroll);
        expect(codeLinesViewProps?.onLayout).toBe(onLayout);
        expect(codeLinesViewProps?.onContentSizeChange).toBe(onContentSizeChange);
        expect(codeLinesViewProps?.scrollEventThrottle).toBe(32);
    });

    it('passes inactive comment affordance visibility to the code lines view', async () => {
        foldingEnabled = false;
        lastCodeLinesViewProps = null;
        const { HappierUnifiedDiffViewer } = await import('./HappierUnifiedDiffViewer');

        await renderScreen(<HappierUnifiedDiffViewer
                    mode="unified"
                    unifiedDiff={'@@ -1 +1 @@\n-const value = 1;\n+const value = 2;\n'}
                    filePath="src/demo.ts"
                    showInactiveCommentAffordance={false}
                />);

        const codeLinesViewProps = lastCodeLinesViewProps as Record<string, unknown> | null;
        expect(codeLinesViewProps?.showInactiveCommentAffordance).toBe(false);
    });
});
