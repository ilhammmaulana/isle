// SPDX-License-Identifier: GPL-3.0-or-later
// AntigravityClient: Asynchronous NDJSON streaming client for agy CLI

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

export class AntigravityClient extends Signals.EventEmitter {
    constructor() {
        super();
        this._proc = null;
        this._dis = null;
        this._cancellable = null;
        this._running = false;
        this._activeConversationId = null;
        this._currentResponse = '';
        this._currentThinking = '';
        this._toolCalls = [];
        this._commandResult = null;
        this._currentSteps = [];
        this._currentAction = '';
        this._agyPath = this._findAgyPath();
    }

    get isRunning() {
        return this._running;
    }

    get activeConversationId() {
        return this._activeConversationId;
    }

    get currentResponse() {
        return this._currentResponse;
    }

    get currentThinking() {
        return this._currentThinking;
    }

    get toolCalls() {
        return this._toolCalls;
    }

    get commandResult() {
        return this._commandResult;
    }

    get currentSteps() {
        return this._currentSteps;
    }

    get currentAction() {
        return this._currentAction;
    }

    _findAgyPath() {
        const fromPath = GLib.find_program_in_path('agy');
        if (fromPath)
            return fromPath;
        const candidates = [
            `${GLib.get_home_dir()}/.local/bin/agy`,
            '/usr/local/bin/agy',
            '/usr/bin/agy',
        ];
        for (const p of candidates) {
            if (GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE))
                return p;
        }
        return 'agy';
    }

    /**
     * Starts a turn with prompt
     * @param {string} prompt
     * @param {Object} options
     * @param {string} [options.workspace] Working directory for the turn
     * @param {string} [options.conversationId] ID of an existing conversation to resume
     * @param {boolean} [options.continueRecent] Continue the most recent conversation
     * @param {string} [options.mode] Agent execution mode ('auto', 'plan', 'accept-edits')
     */
    startTurn(prompt, {workspace, conversationId, continueRecent = false, mode = 'auto'} = {}) {
        if (this._running)
            this.cancel();

        this._running = true;
        this._currentResponse = '';
        this._currentThinking = '';
        this._toolCalls = [];
        this._commandResult = null;
        this._currentSteps = [];
        this._currentAction = 'Getting ready…';
        this._cancellable = new Gio.Cancellable();
        this.emit('state-changed', true);

        const args = [
            this._agyPath,
            '-p', prompt,
            '--output-format', 'stream-json',
            '--dangerously-skip-permissions',
        ];

        if (conversationId)
            args.push('--conversation', conversationId);
        else if (continueRecent)
            args.push('--continue');

        if (mode)
            args.push('--mode', mode);

        try {
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });

            if (workspace && GLib.file_test(workspace, GLib.FileTest.IS_DIR))
                launcher.set_cwd(workspace);

            this._proc = launcher.spawnv(args);
            const stdout = this._proc.get_stdout_pipe();
            this._dis = new Gio.DataInputStream({base_stream: stdout});

            this._readNextLine();
            this._watchStderr();
            this._watchExit();
        } catch (e) {
            this._running = false;
            this.emit('state-changed', false);
            this.emit('error', `Failed to start agy: ${e.message}`);
        }
    }

    _readNextLine() {
        if (!this._dis || !this._running)
            return;

        this._dis.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable, (stream, res) => {
            try {
                const [line] = stream.read_line_finish_utf8(res);
                if (line !== null) {
                    this._parseLine(line);
                    this._readNextLine();
                }
            } catch (e) {
                // Operation cancelled or EOF
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    this._onFinish();
            }
        });
    }

    _watchStderr() {
        if (!this._proc)
            return;
        const stderr = this._proc.get_stderr_pipe();
        if (!stderr)
            return;
        const dis = new Gio.DataInputStream({base_stream: stderr});
        const readErr = () => {
            dis.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable, (s, r) => {
                try {
                    const [line] = s.read_line_finish_utf8(r);
                    if (line !== null)
                        readErr();
                } catch (_) {}
            });
        };
        readErr();
    }

    _watchExit() {
        if (!this._proc)
            return;
        this._proc.wait_async(this._cancellable, (_p, res) => {
            try {
                this._proc.wait_finish(res);
            } catch (_) {}
            this._onFinish();
        });
    }

    _parseLine(rawLine) {
        if (!rawLine || !rawLine.trim())
            return;

        let eventObj;
        try {
            eventObj = JSON.parse(rawLine);
        } catch (_) {
            return;
        }

        const eventType = eventObj.event;

        if (eventType === 'init') {
            this._activeConversationId = eventObj.conversation_id;
            this.emit('init', eventObj.conversation_id);
        } else if (eventType === 'command_result') {
            this._commandResult = eventObj.command;
            this.emit('command-result', eventObj.command);
        } else if (eventType === 'step_update') {
            const update = eventObj.step_update || {};
            if (update.conversation_id && !this._activeConversationId)
                this._activeConversationId = update.conversation_id;

            if (update.thinking_delta) {
                this._currentThinking += update.thinking_delta;
                this.emit('thinking-delta', update.thinking_delta);
            }

            if (update.text_delta) {
                this._currentResponse += update.text_delta;
                this.emit('text-delta', update.text_delta);
            }

            if (update.tool_calls && update.tool_calls.length) {
                for (const call of update.tool_calls) {
                    const summary = (call.args?.toolSummary || call.name || '').replace(/^["']|["']$/g, '');
                    const toolItem = {
                        id: call.id || `${Date.now()}-${Math.random()}`,
                        name: call.name,
                        args: call.args,
                        summary: summary || call.name,
                        status: 'running',
                    };
                    this._toolCalls.push(toolItem);
                    if (summary) {
                        this._currentAction = summary;
                        if (!this._currentSteps.includes(summary))
                            this._currentSteps.push(summary);
                    }
                    this.emit('tool-call', toolItem);
                }
            }

            if (update.state === 'DONE' && update.step_type === 'tool_call') {
                if (this._toolCalls.length > 0)
                    this._toolCalls[this._toolCalls.length - 1].status = 'done';
                this.emit('step-done', update);
            }
        } else if (eventType === 'result') {
            const res = eventObj.result || {};
            this.emit('turn-finished', {
                status: res.status,
                response: res.response || this._currentResponse,
                thinking: this._currentThinking,
                toolCalls: [...this._toolCalls],
                commandResult: this._commandResult,
                duration: res.duration_seconds,
            });
            this._onFinish();
        }
    }

    _onFinish() {
        if (!this._running)
            return;
        this._running = false;
        this._proc = null;
        this._dis = null;
        this._cancellable = null;
        this.emit('state-changed', false);
    }

    cancel() {
        if (!this._running)
            return;

        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }

        if (this._proc) {
            try {
                this._proc.send_signal(GLib.Signal.SIGINT);
            } catch (_) {
                try {
                    this._proc.force_exit();
                } catch (_) {}
            }
            this._proc = null;
        }

        this._running = false;
        this.emit('state-changed', false);
        this.emit('cancelled');
    }
}
