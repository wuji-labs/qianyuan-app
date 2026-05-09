import { constants } from 'node:fs';
import { copyFile, link } from 'node:fs/promises';

export async function adoptSessionMediaSourceFile(input: Readonly<{
    sourcePath: string;
    destinationPath: string;
}>): Promise<void> {
    try {
        await copyFile(input.sourcePath, input.destinationPath, constants.COPYFILE_FICLONE);
        return;
    } catch {
        // Reflink is opportunistic; fall through to other byte-preserving strategies.
    }

    try {
        await link(input.sourcePath, input.destinationPath);
        return;
    } catch {
        // Hard links are not always supported across filesystems.
    }

    await copyFile(input.sourcePath, input.destinationPath);
}
