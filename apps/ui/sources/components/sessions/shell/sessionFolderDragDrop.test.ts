import { describe, expect, it } from 'vitest';

import { measureSessionFolderDropTargetBounds } from './sessionFolderDragDrop';

describe('session folder drag/drop target measurement', () => {
    it('uses absolute window bounds when the row ref can be measured', async () => {
        const measured = await measureSessionFolderDropTargetBounds({
            ref: {
                measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => {
                    callback(40, 120, 260, 32);
                },
            },
            fallback: { x: 4, y: 8, width: 200, height: 24 },
        });

        expect(measured).toEqual({ x: 40, y: 120, width: 260, height: 32 });
    });

    it('falls back to local layout when native measurement is unavailable', async () => {
        const measured = await measureSessionFolderDropTargetBounds({
            ref: null,
            fallback: { x: 4, y: 8, width: 200, height: 24 },
        });

        expect(measured).toEqual({ x: 4, y: 8, width: 200, height: 24 });
    });
});
