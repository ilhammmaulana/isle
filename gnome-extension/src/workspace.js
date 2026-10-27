// SPDX-License-Identifier: GPL-3.0-or-later
// Workspace detection, directory switching, and @file autocomplete indexing for Antigravity

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const CACHE_MS = 15000;
const cachedFiles = new Map(); // workspacePath -> {files: string[], time: number}

/** Finds the currently active workspace directory */
export function findActiveWorkspace(fallbackUri = null) {
    // 1. Try focused window's working directory
    try {
        const focused = global.display.focus_window;
        if (focused) {
            const pid = focused.get_pid();
            if (pid > 0) {
                const cwdPath = GLib.file_read_link(`/proc/${pid}/cwd`);
                if (cwdPath && GLib.file_test(cwdPath, GLib.FileTest.IS_DIR)) {
                    const gitRoot = findGitRoot(cwdPath);
                    if (gitRoot)
                        return gitRoot;
                    return cwdPath;
                }
            }
        }
    } catch (_) {}

    // 2. Try fallback URI from active Antigravity conversation
    if (fallbackUri) {
        try {
            const path = fallbackUri.replace(/^file:\/\//, '');
            if (GLib.file_test(path, GLib.FileTest.IS_DIR))
                return path;
        } catch (_) {}
    }

    // 3. Fallback to default user projects or home directory
    const candidates = [
        `${GLib.get_home_dir()}/Documents/Anihost/ticketing-bun`,
        `${GLib.get_home_dir()}/Documents/Anihost/ticketing`,
        GLib.get_home_dir(),
    ];
    for (const cand of candidates) {
        if (GLib.file_test(cand, GLib.FileTest.IS_DIR))
            return cand;
    }
    return GLib.get_home_dir();
}

/** Crawls parent directories looking for a .git directory */
export function findGitRoot(startPath) {
    let current = startPath;
    while (current && current !== '/' && current.length > 1) {
        const gitDir = `${current}/.git`;
        if (GLib.file_test(gitDir, GLib.FileTest.EXISTS))
            return current;
        const parent = GLib.path_get_dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    return null;
}

/** Asynchronously retrieves recent project workspaces from Antigravity SQLite database */
export async function getRecentWorkspaces() {
    const dbPath = `${GLib.get_home_dir()}/.gemini/antigravity-cli/conversation_summaries.db`;
    if (!GLib.file_test(dbPath, GLib.FileTest.EXISTS))
        return [];

    return new Promise(resolve => {
        try {
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
            });
            const proc = launcher.spawnv([
                'sqlite3',
                dbPath,
                'SELECT DISTINCT workspace_uris FROM conversation_summaries WHERE workspace_uris IS NOT NULL AND workspace_uris != "" ORDER BY last_modified_time DESC LIMIT 35;',
            ]);

            proc.communicate_utf8_async(null, null, (_p, res) => {
                try {
                    const [, stdout] = proc.communicate_utf8_finish(res);
                    if (stdout) {
                        const lines = stdout.split('\n').filter(Boolean);
                        const paths = new Set();
                        for (const line of lines) {
                            try {
                                const parsed = JSON.parse(line);
                                if (Array.isArray(parsed) && parsed[0]) {
                                    let p = parsed[0].replace(/^file:\/\//, '');
                                    if (GLib.file_test(p, GLib.FileTest.IS_DIR) && p !== GLib.get_home_dir())
                                        paths.add(p);
                                }
                            } catch (_) {}
                        }
                        resolve([...paths]);
                        return;
                    }
                } catch (_) {}
                resolve([]);
            });
        } catch (_) {
            resolve([]);
        }
    });
}

/** Opens native Zenity directory chooser asynchronously */
export async function browseDirectoryAsync() {
    return new Promise(resolve => {
        try {
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
            });
            const proc = launcher.spawnv([
                'zenity',
                '--file-selection',
                '--directory',
                '--title=Pilih Direktori Workspace Antigravity',
            ]);

            proc.communicate_utf8_async(null, null, (_p, res) => {
                try {
                    const [, stdout] = proc.communicate_utf8_finish(res);
                    const path = stdout?.trim();
                    if (path && GLib.file_test(path, GLib.FileTest.IS_DIR)) {
                        resolve(path);
                        return;
                    }
                } catch (_) {}
                resolve(null);
            });
        } catch (_) {
            resolve(null);
        }
    });
}

/** Asynchronously lists files in workspace for autocomplete */
export async function getWorkspaceFiles(workspacePath) {
    if (!workspacePath)
        return [];

    const now = Date.now();
    const cached = cachedFiles.get(workspacePath);
    if (cached && now - cached.time < CACHE_MS)
        return cached.files;

    return new Promise(resolve => {
        let proc;
        try {
            const isGit = GLib.file_test(`${workspacePath}/.git`, GLib.FileTest.EXISTS);
            const cmd = isGit
                ? ['git', 'ls-files', '--cached', '--others', '--exclude-standard']
                : ['find', '.', '-maxdepth', '5', '-not', '-path', '*/.*', '-type', 'f'];

            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
            });
            launcher.set_cwd(workspacePath);
            proc = launcher.spawnv(cmd);
        } catch (e) {
            resolve(cached?.files ?? []);
            return;
        }

        proc.communicate_utf8_async(null, null, (_p, res) => {
            try {
                const [, stdout] = proc.communicate_utf8_finish(res);
                if (stdout) {
                    const lines = stdout
                        .split('\n')
                        .map(l => l.replace(/^\.\//, '').trim())
                        .filter(l => l.length > 0 && !l.includes('node_modules/') && !l.includes('.git/'));
                    cachedFiles.set(workspacePath, {files: lines, time: Date.now()});
                    resolve(lines);
                    return;
                }
            } catch (_) {}
            resolve(cached?.files ?? []);
        });
    });
}

/** Filters files matching a query after the @ symbol, returning structured info */
export async function filterMentionFiles(query, workspacePath, limit = 6) {
    const files = await getWorkspaceFiles(workspacePath);
    if (!files || files.length === 0)
        return [];

    const mapItem = file => {
        const basename = GLib.path_get_basename(file);
        let dir = GLib.path_get_dirname(file);
        if (dir === '.')
            dir = '';
        return {
            path: file,
            basename,
            dir,
        };
    };

    if (!query)
        return files.slice(0, limit).map(mapItem);

    const q = query.toLowerCase();
    const exactBase = [];
    const startsBase = [];
    const containsBase = [];
    const containsPath = [];

    for (const file of files) {
        const base = GLib.path_get_basename(file).toLowerCase();
        const full = file.toLowerCase();

        if (base === q)
            exactBase.push(file);
        else if (base.startsWith(q))
            startsBase.push(file);
        else if (base.includes(q))
            containsBase.push(file);
        else if (full.includes(q))
            containsPath.push(file);

        if (exactBase.length + startsBase.length + containsBase.length + containsPath.length >= limit * 3)
            break;
    }

    const merged = [...exactBase, ...startsBase, ...containsBase, ...containsPath];
    const unique = [...new Set(merged)].slice(0, limit);
    return unique.map(mapItem);
}
