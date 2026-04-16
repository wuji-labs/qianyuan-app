import { randomUUID } from 'node:crypto';
import { copyFile, cp, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

function shouldSkipPayloadPath(pathLike: string): boolean {
    const segments = pathLike.split(/[\\/]/).filter(Boolean);
    for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index];
        if (segment.startsWith('._')) {
            return true;
        }
        if (segment === '.bin' && segments[index - 1] === 'node_modules') {
            return true;
        }
    }
    return false;
}

async function copyDirectoryContentsRecursively(sourceDir: string, destinationDir: string): Promise<void> {
    await mkdir(destinationDir, { recursive: true });
    const entries = await readdir(sourceDir, { withFileTypes: true });

    for (const entry of entries) {
        if (shouldSkipPayloadPath(entry.name)) {
            continue;
        }

        const sourcePath = join(sourceDir, entry.name);
        const destinationPath = join(destinationDir, entry.name);

        if (shouldSkipPayloadPath(sourcePath)) {
            continue;
        }

        if (entry.isDirectory()) {
            await copyDirectoryContentsRecursively(sourcePath, destinationPath);
            continue;
        }

        await mkdir(dirname(destinationPath), { recursive: true });
        await copyFile(sourcePath, destinationPath);
    }
}

export async function replaceRuntimePayloadTree(params: Readonly<{
    sourcePath: string;
    destinationPath: string;
}>): Promise<void> {
    const destinationPath = params.destinationPath;
    const destinationParent = dirname(destinationPath);
    const destinationBasename = basename(destinationPath);
    const tempPath = join(destinationParent, `.${destinationBasename}.tmp-${process.pid}-${randomUUID()}`);
    const backupPath = join(destinationParent, `.${destinationBasename}.bak-${process.pid}-${randomUUID()}`);
    const destinationExists = await lstat(destinationPath)
        .then(() => true)
        .catch(() => false);

    await rm(tempPath, { recursive: true, force: true });
    await rm(backupPath, { recursive: true, force: true });

    try {
        await mkdir(destinationParent, { recursive: true });

        if (process.platform === 'win32') {
            await copyDirectoryContentsRecursively(params.sourcePath, tempPath);
        } else {
            await cp(params.sourcePath, tempPath, {
                recursive: true,
                filter: (sourcePath) => !shouldSkipPayloadPath(sourcePath),
            });
        }

        if (destinationExists) {
            await rename(destinationPath, backupPath);
        }

        await rename(tempPath, destinationPath);

        if (destinationExists) {
            await rm(backupPath, { recursive: true, force: true });
        }
    } catch (error) {
        await rm(tempPath, { recursive: true, force: true }).catch(() => undefined);

        const backupExists = await lstat(backupPath)
            .then(() => true)
            .catch(() => false);
        if (backupExists) {
            const destinationStillExists = await lstat(destinationPath)
                .then(() => true)
                .catch(() => false);
            if (!destinationStillExists) {
                await rename(backupPath, destinationPath).catch(() => undefined);
            }
        }

        throw error;
    }
}
