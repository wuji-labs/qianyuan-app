import { describe, expect, it } from 'vitest';

import { buildTranscriptHotColdSegments } from './buildTranscriptHotColdSegments';

describe('buildTranscriptHotColdSegments', () => {
    it('keeps the newest tail items hot and older items cold', () => {
        const result = buildTranscriptHotColdSegments({
            enabled: true,
            hotTailItemCount: 2,
            items: [
                { kind: 'message', id: 'm1', messageId: 'm1' },
                { kind: 'message', id: 'm2', messageId: 'm2' },
                { kind: 'message', id: 'm3', messageId: 'm3' },
                { kind: 'message', id: 'm4', messageId: 'm4' },
            ],
            activeThinkingMessageId: null,
            expandedToolCallsAnchorMessageIds: new Set<string>(),
        });

        expect(result.coldItems.map((item) => item.id)).toEqual(['m1', 'm2']);
        expect(result.hotItems.map((item) => item.id)).toEqual(['m3', 'm4']);
    });

    it('widens the hot segment to keep an active thinking row in the live tail', () => {
        const result = buildTranscriptHotColdSegments({
            enabled: true,
            hotTailItemCount: 1,
            items: [
                { kind: 'message', id: 'm1', messageId: 'm1' },
                { kind: 'message', id: 'm2', messageId: 'm2' },
                { kind: 'message', id: 'm3', messageId: 'm3' },
            ],
            activeThinkingMessageId: 'm2',
            expandedToolCallsAnchorMessageIds: new Set<string>(),
        });

        expect(result.coldItems.map((item) => item.id)).toEqual(['m1']);
        expect(result.hotItems.map((item) => item.id)).toEqual(['m2', 'm3']);
    });

    it('widens the hot segment to keep expanded tool groups in the live tail', () => {
        const result = buildTranscriptHotColdSegments({
            enabled: true,
            hotTailItemCount: 1,
            items: [
                { kind: 'message', id: 'm1', messageId: 'm1' },
                { kind: 'tool-calls-group', id: 'tools-1', toolMessageIds: ['tool-1', 'tool-2'] },
                { kind: 'message', id: 'm2', messageId: 'm2' },
            ],
            activeThinkingMessageId: null,
            expandedToolCallsAnchorMessageIds: new Set<string>(['tool-2']),
        });

        expect(result.coldItems.map((item) => item.id)).toEqual(['m1']);
        expect(result.hotItems.map((item) => item.id)).toEqual(['tools-1', 'm2']);
    });

    it('widens the hot segment to keep expanded tool-group unit rows in the live tail (N2c)', () => {
        const groupId = 'toolCalls:turn:x:tool-1';
        const toolMessageIds = ['tool-1', 'tool-2'];
        const result = buildTranscriptHotColdSegments({
            enabled: true,
            hotTailItemCount: 1,
            items: [
                { kind: 'message', id: 'm1', messageId: 'm1' },
                { kind: 'tool-group-header', id: `${groupId}#header`, toolMessageIds },
                { kind: 'tool-group-tool', id: `${groupId}#tool:tool-1`, toolMessageId: 'tool-1', toolMessageIds },
                { kind: 'tool-group-tool', id: `${groupId}#tool:tool-2`, toolMessageId: 'tool-2', toolMessageIds },
                { kind: 'tool-group-footer', id: `${groupId}#footer`, toolMessageIds },
                { kind: 'message', id: 'm2', messageId: 'm2' },
            ],
            activeThinkingMessageId: null,
            expandedToolCallsAnchorMessageIds: new Set<string>(['tool-2']),
        });

        expect(result.coldItems.map((item) => item.id)).toEqual(['m1']);
        expect(result.hotItems.map((item) => item.id)).toEqual([
            `${groupId}#header`,
            `${groupId}#tool:tool-1`,
            `${groupId}#tool:tool-2`,
            `${groupId}#footer`,
            'm2',
        ]);
    });

    it('leaves collapsed tool-group unit rows in the cold segment (N2c)', () => {
        const groupId = 'toolCalls:turn:x:tool-1';
        const toolMessageIds = ['tool-1', 'tool-2'];
        const result = buildTranscriptHotColdSegments({
            enabled: true,
            hotTailItemCount: 1,
            items: [
                { kind: 'tool-group-header', id: `${groupId}#header`, toolMessageIds },
                { kind: 'tool-group-expand', id: `${groupId}#expand`, toolMessageIds },
                { kind: 'tool-group-tool', id: `${groupId}#tool:tool-2`, toolMessageId: 'tool-2', toolMessageIds },
                { kind: 'tool-group-footer', id: `${groupId}#footer`, toolMessageIds },
                { kind: 'message', id: 'm2', messageId: 'm2' },
            ],
            activeThinkingMessageId: null,
            expandedToolCallsAnchorMessageIds: new Set<string>(),
        });

        expect(result.hotItems.map((item) => item.id)).toEqual(['m2']);
    });

    it('keeps pending queues and action drafts in the hot tail even when the tail window is small', () => {
        const result = buildTranscriptHotColdSegments({
            enabled: true,
            hotTailItemCount: 1,
            items: [
                { kind: 'message', id: 'm1', messageId: 'm1' },
                { kind: 'pending-queue', id: 'pending-queue' },
                { kind: 'action-draft', id: 'draft:1' },
            ],
            activeThinkingMessageId: null,
            expandedToolCallsAnchorMessageIds: new Set<string>(),
        });

        expect(result.coldItems.map((item) => item.id)).toEqual(['m1']);
        expect(result.hotItems.map((item) => item.id)).toEqual(['pending-queue', 'draft:1']);
    });

    it('keeps fork dividers with the hot child transcript items', () => {
        const result = buildTranscriptHotColdSegments({
            enabled: true,
            hotTailItemCount: 1,
            items: [
                { kind: 'message', id: 'parent-message', messageId: 'parent-message' },
                { kind: 'fork-divider', id: 'fork-divider:parent:child' },
                { kind: 'message', id: 'child-message', messageId: 'child-message' },
            ],
            activeThinkingMessageId: null,
            expandedToolCallsAnchorMessageIds: new Set<string>(),
        });

        expect(result.coldItems.map((item) => item.id)).toEqual(['parent-message']);
        expect(result.hotItems.map((item) => item.id)).toEqual(['fork-divider:parent:child', 'child-message']);
    });

    it('leaves the transcript unsplit when disabled', () => {
        const result = buildTranscriptHotColdSegments({
            enabled: false,
            hotTailItemCount: 2,
            items: [
                { kind: 'message', id: 'm1', messageId: 'm1' },
                { kind: 'message', id: 'm2', messageId: 'm2' },
            ],
            activeThinkingMessageId: null,
            expandedToolCallsAnchorMessageIds: new Set<string>(),
        });

        expect(result.coldItems.map((item) => item.id)).toEqual(['m1', 'm2']);
        expect(result.hotItems).toEqual([]);
    });

    it('keeps at least one item cold when segmentation is enabled', () => {
        const result = buildTranscriptHotColdSegments({
            enabled: true,
            hotTailItemCount: 999,
            items: [
                { kind: 'message', id: 'm1', messageId: 'm1' },
                { kind: 'message', id: 'm2', messageId: 'm2' },
            ],
            activeThinkingMessageId: null,
            expandedToolCallsAnchorMessageIds: new Set<string>(),
        });

        expect(result.coldItems.length).toBe(1);
        expect(result.hotItems.map((item) => item.id)).toEqual(['m2']);
    });
});
