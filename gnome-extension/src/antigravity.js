// SPDX-License-Identifier: GPL-3.0-or-later
// AntigravityWatcher: monitors ~/.gemini/antigravity-cli/conversation_summaries.db
// tracks conversation statuses and notifies when an active conversation finishes.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

const POLL_ACTIVE_MS = 1000;
const POLL_IDLE_MS = 4000;
const DEBOUNCE_MS = 250;

/** Reads recent live steps and current action from transcript.jsonl */
export function readTranscriptLive(convId) {
    if (!convId)
        return null;
    const path = `${GLib.get_home_dir()}/.gemini/antigravity-cli/brain/${convId}/.system_generated/logs/transcript.jsonl`;
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null))
        return null;

    try {
        const stream = file.read(null);
        const info = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
        const size = info.get_size();
        const readSize = Math.min(size, 49152);
        if (size > readSize)
            stream.seek(size - readSize, GLib.SeekType.SET, null);
        const bytes = stream.read_bytes(readSize, null);
        stream.close(null);

        const text = new TextDecoder().decode(bytes.get_data());
        const lines = text.split('\n');
        const validLines = (size > readSize ? lines.slice(1) : lines).filter(Boolean);

        const steps = [];
        let userPrompt = '';
        let lastThinking = false;

        for (const line of validLines) {
            try {
                const item = JSON.parse(line);
                if (item.type === 'USER_INPUT') {
                    let content = item.content || '';
                    if (content.includes('<USER_REQUEST>')) {
                        const parts = content.split('<USER_REQUEST>');
                        if (parts[1]) {
                            const sub = parts[1].split('</USER_REQUEST>');
                            content = sub[0].trim();
                        }
                    }
                    userPrompt = content.replace(/\s+/g, ' ').trim();
                } else if (item.type === 'PLANNER_RESPONSE') {
                    lastThinking = Boolean(item.thinking && (!item.tool_calls || item.tool_calls.length === 0));
                    if (item.tool_calls) {
                        for (const call of item.tool_calls) {
                            let summary = (call.args?.toolSummary || call.name || '').trim();
                            summary = summary.replace(/^["']|["']$/g, '');
                            if (summary)
                                steps.push(summary);
                        }
                    }
                }
            } catch (_) {}
        }

        const currentAction = lastThinking ? 'Thinking…' : (steps.length ? steps[steps.length - 1] : 'Sedang memproses…');
        const doneSteps = steps.length > 1 ? steps.slice(Math.max(0, steps.length - 4), steps.length - 1) : [];

        return {
            userPrompt,
            currentAction,
            doneSteps,
            allStepsCount: steps.length,
        };
    } catch (_) {
        return null;
    }
}

/** Reads all completed user and assistant turns from a conversation transcript.jsonl */
export function readConversationTranscript(convId) {
    if (!convId)
        return [];
    const path = `${GLib.get_home_dir()}/.gemini/antigravity-cli/brain/${convId}/.system_generated/logs/transcript.jsonl`;
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null))
        return [];

    try {
        const [, bytes] = file.load_contents(null);
        const text = new TextDecoder().decode(bytes);
        const lines = text.split('\n').filter(Boolean);

        const turns = [];
        let currentPrompt = '';
        let currentSteps = [];
        let currentToolCalls = [];
        let currentThinking = '';
        let currentResponse = '';

        for (const line of lines) {
            try {
                const item = JSON.parse(line);
                if (item.type === 'USER_INPUT') {
                    if (currentPrompt) {
                        turns.push({
                            prompt: currentPrompt,
                            steps: currentSteps,
                            toolCalls: currentToolCalls,
                            thinking: currentThinking,
                            response: currentResponse || 'Selesai tanpa output teks.',
                        });
                        currentSteps = [];
                        currentToolCalls = [];
                        currentThinking = '';
                        currentResponse = '';
                    }
                    let content = item.content || '';
                    if (content.includes('<USER_REQUEST>')) {
                        const parts = content.split('<USER_REQUEST>');
                        if (parts[1]) {
                            const sub = parts[1].split('</USER_REQUEST>');
                            content = sub[0].trim();
                        }
                    }
                    currentPrompt = content.trim();
                } else if (item.type === 'PLANNER_RESPONSE') {
                    if (item.thinking)
                        currentThinking = (currentThinking ? `${currentThinking}\n` : '') + item.thinking;
                    if (item.tool_calls) {
                        for (const call of item.tool_calls) {
                            let summary = (call.args?.toolSummary || call.name || '').trim();
                            summary = summary.replace(/^["']|["']$/g, '');
                            if (summary)
                                currentSteps.push(summary);
                            currentToolCalls.push({
                                name: call.name,
                                args: call.args,
                                summary: summary || call.name,
                                status: 'done',
                            });
                        }
                    }
                    if (item.content) {
                        currentResponse = item.content;
                    }
                }
            } catch (_) {}
        }

        if (currentPrompt) {
            turns.push({
                prompt: currentPrompt,
                steps: currentSteps,
                toolCalls: currentToolCalls,
                thinking: currentThinking,
                response: currentResponse || (currentSteps.length ? 'Task selesai.' : ''),
            });
        }

        return turns.slice(-30);
    } catch (_) {
        return [];
    }
}

export class AntigravityWatcher extends Signals.EventEmitter {
    constructor() {
        super();
        this._conversations = [];
        this._runningCount = 0;
        this._knownStatus = new Map();
        this._initialLoaded = false;
        this._dbPath = `${GLib.get_home_dir()}/.gemini/antigravity-cli/conversation_summaries.db`;
        this._dbFile = Gio.File.new_for_path(this._dbPath);
        this._debounceId = 0;
        this._pollId = 0;
        this._inFlight = false;
        this._destroyed = false;

        this._setupMonitor();
        this._scheduleRefresh(50);
        this._schedulePoll();
    }

    get conversations() {
        return this._conversations;
    }

    get runningCount() {
        return this._runningCount;
    }

    get hasRunning() {
        return this._runningCount > 0;
    }

    get activeRunningConversation() {
        return this._conversations.find(c => c.not_fully_idle === 1 || c.status === 'CASCADE_RUN_STATUS_RUNNING') || null;
    }

    get isAvailable() {
        return this._dbFile.query_exists(null);
    }

    _setupMonitor() {
        try {
            if (this._dbFile.query_exists(null)) {
                this._monitor = this._dbFile.monitor_file(Gio.FileMonitorFlags.NONE, null);
                this._monitorHandler = this._monitor.connect('changed', () => this._onFileChanged());
            } else {
                const dir = this._dbFile.get_parent();
                if (dir && dir.query_exists(null)) {
                    this._monitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
                    this._monitorHandler = this._monitor.connect('changed', (_m, file) => {
                        if (file.get_path() === this._dbPath || file.get_basename()?.startsWith('conversation_summaries'))
                            this._onFileChanged();
                    });
                }
            }
        } catch (e) {
            console.warn(`Isle: could not setup Antigravity file monitor: ${e.message}`);
        }
    }

    _onFileChanged() {
        if (this._destroyed)
            return;
        if (this._debounceId) {
            GLib.source_remove(this._debounceId);
            this._debounceId = 0;
        }
        this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
            this._debounceId = 0;
            this._queryDb();
            return GLib.SOURCE_REMOVE;
        });
    }

    _scheduleRefresh(delayMs) {
        if (this._destroyed)
            return;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._queryDb();
            return GLib.SOURCE_REMOVE;
        });
    }

    _schedulePoll() {
        if (this._destroyed)
            return;
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
        const interval = this.hasRunning ? POLL_ACTIVE_MS : POLL_IDLE_MS;
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, () => {
            this._queryDb();
            this._schedulePoll();
            return GLib.SOURCE_REMOVE;
        });
    }

    refresh() {
        this._queryDb();
    }

    _queryDb() {
        if (this._destroyed || this._inFlight)
            return;
        if (!this._dbFile.query_exists(null))
            return;

        this._inFlight = true;
        const query = 'SELECT conversation_id, title, preview, step_count, status, not_fully_idle, last_modified_time, workspace_uris FROM conversation_summaries WHERE killed = 0 ORDER BY not_fully_idle DESC, last_modified_time DESC LIMIT 25;';

        let proc;
        try {
            proc = Gio.Subprocess.new(
                ['sqlite3', '-json', this._dbPath, query],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
        } catch (e) {
            this._inFlight = false;
            return;
        }

        proc.communicate_utf8_async(null, null, (_proc, res) => {
            this._inFlight = false;
            if (this._destroyed)
                return;
            try {
                const [, stdout] = proc.communicate_utf8_finish(res);
                if (!stdout || !stdout.trim())
                    return;
                const rows = JSON.parse(stdout);
                this._processRows(rows);
            } catch (_) {
                // Ignore transient sqlite lock errors while db writes
            }
        });
    }

    _processRows(rows) {
        if (!Array.isArray(rows))
            return;

        const startedConversations = [];
        const finishedConversations = [];
        let runningCount = 0;

        for (const row of rows) {
            const id = row.conversation_id;
            const isRunning = row.not_fully_idle === 1 || row.status === 'CASCADE_RUN_STATUS_RUNNING';
            if (isRunning) {
                runningCount++;
                row.liveDetails = readTranscriptLive(id);
            }

            if (this._initialLoaded) {
                const prev = this._knownStatus.get(id);
                if (prev && !prev.isRunning && isRunning) {
                    startedConversations.push(row);
                } else if (prev && prev.isRunning && !isRunning) {
                    finishedConversations.push(row);
                }
            }

            this._knownStatus.set(id, {
                status: row.status,
                isRunning,
                title: row.title,
                lastModified: row.last_modified_time,
            });
        }

        const countChanged = this._runningCount !== runningCount;
        this._runningCount = runningCount;
        this._conversations = rows;

        if (!this._initialLoaded) {
            this._initialLoaded = true;
        }

        this.emit('updated', this._conversations);

        for (const conv of startedConversations) {
            this.emit('conversation-started', conv);
        }

        for (const conv of finishedConversations) {
            this.emit('conversation-finished', conv);
        }

        if (countChanged) {
            this._schedulePoll();
        }
    }

    destroy() {
        this._destroyed = true;
        if (this._debounceId) {
            GLib.source_remove(this._debounceId);
            this._debounceId = 0;
        }
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
        if (this._monitor && this._monitorHandler) {
            this._monitor.disconnect(this._monitorHandler);
            this._monitor.cancel();
            this._monitor = null;
        }
    }
}
