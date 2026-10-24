import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * Extracts a .zip into `dir`. Windows has no `unzip`, but ships bsdtar
 * (System32\tar.exe, Windows 10 1803+), which reads zips; named by its full
 * path so Git Bash's GNU tar (zip-blind) can't shadow it.
 */
export function unzip(zip, dir) {
    if (process.platform === 'win32') {
        const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
        execFileSync(tar, ['-xf', zip, '-C', dir]);
    } else {
        execFileSync('unzip', ['-q', '-o', zip, '-d', dir]);
    }
}
