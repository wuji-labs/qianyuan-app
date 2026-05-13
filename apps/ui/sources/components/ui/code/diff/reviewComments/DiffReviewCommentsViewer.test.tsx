import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installCodeDiffCommonModuleMocks } from '../codeDiffTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let thresholds = { lineThreshold: 50_000, byteThreshold: 120_000 };
let reviewCommentControls: any = null;

installCodeDiffCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Platform: {
                OS: 'ios',
                select: (options: any) => options?.ios ?? options?.default ?? options?.web ?? options?.android,
            },
            AppState: {
                addEventListener: () => ({ remove: () => {} }),
            },
        });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: (key: string) => {
                if (key === 'wrapLinesInDiffs') return true;
                if (key === 'showLineNumbers') return true;
                return null;
            },
        });
    },
});

vi.mock('@/components/ui/code/diff/DiffViewer', () => ({
    DiffViewer: (props: any) => React.createElement('DiffViewer', props),
}));

vi.mock('@/components/ui/code/diff/useInlineDiffVirtualizationThresholds', () => ({
    useInlineDiffVirtualizationThresholds: () => thresholds,
}));

vi.mock('@/components/sessions/reviews/comments/useCodeLinesReviewComments', () => ({
    useCodeLinesReviewComments: () => reviewCommentControls,
}));

describe('DiffReviewCommentsViewer', () => {
    beforeEach(() => {
        reviewCommentControls = null;
    });

    it('keeps non-virtual rendering for small diffs when review comments are enabled', async () => {
        thresholds = { lineThreshold: 50_000, byteThreshold: 120_000 };
        const { DiffReviewCommentsViewer } = await import('./DiffReviewCommentsViewer');

        const screen = await renderScreen(<DiffReviewCommentsViewer
                    filePath="src/a.ts"
                    unifiedDiff={'a\nb\n'}
                    reviewCommentsEnabled={true}
                    reviewCommentDrafts={[]}
                />);

        const view = screen.findByType('DiffViewer' as any);
        expect(view.props.virtualized).toBe(false);
    });

    it('enables virtualization for large diffs when review comments are enabled', async () => {
        thresholds = { lineThreshold: 50_000, byteThreshold: 100 };
        const { DiffReviewCommentsViewer } = await import('./DiffReviewCommentsViewer');

        const screen = await renderScreen(<DiffReviewCommentsViewer
                    filePath="src/a.ts"
                    unifiedDiff={'a'.repeat(2_000)}
                    reviewCommentsEnabled={true}
                    reviewCommentDrafts={[]}
                />);

        const view = screen.findByType('DiffViewer' as any);
        expect(view.props.virtualized).toBe(true);
    });

    it('plumbs display configuration into DiffViewer', async () => {
        thresholds = { lineThreshold: 50_000, byteThreshold: 120_000 };
        const { DiffReviewCommentsViewer } = await import('./DiffReviewCommentsViewer');

        const screen = await renderScreen(<DiffReviewCommentsViewer
                    filePath="src/a.ts"
                    unifiedDiff={'a\nb\n'}
                    reviewCommentsEnabled={true}
                    reviewCommentDrafts={[]}
                    wrapLines={false}
                    showLineNumbers={true}
                    showPrefix={true}
                />);

        const view = screen.findByType('DiffViewer' as any);
        expect(view.props.wrapLines).toBe(false);
        expect(view.props.showLineNumbers).toBe(true);
        expect(view.props.showPrefix).toBe(true);
    });

    it('uses the whole diff line and drag range as review comment targets when comments are enabled', async () => {
        thresholds = { lineThreshold: 50_000, byteThreshold: 120_000 };
        const onPressAddComment = vi.fn();
        const onPressAddCommentRange = vi.fn();
        reviewCommentControls = {
            onPressAddComment,
            onPressAddCommentRange,
            isCommentActive: () => false,
            renderAfterLine: () => null,
        };
        const { DiffReviewCommentsViewer } = await import('./DiffReviewCommentsViewer');

        const screen = await renderScreen(<DiffReviewCommentsViewer
                    filePath="src/a.ts"
                    unifiedDiff={'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n'}
                    reviewCommentsEnabled={true}
                    reviewCommentDrafts={[]}
                />);

        const view = screen.findByType('DiffViewer' as any);
        expect(view.props.onPressLine).toBe(onPressAddComment);
        expect(view.props.onPressLineRange).toBe(onPressAddCommentRange);
        expect(view.props.pressLineWhenNotSelectable).toBe(true);
    });
});
