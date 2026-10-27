// SPDX-License-Identifier: GPL-3.0-or-later
// AntigravityPage: Interactive Antigravity CLI Chat, Live Steps, @file Mentions, and Dynamic Height

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {readConversationTranscript} from '../antigravity.js';
import {AntigravityClient} from '../antigravityClient.js';
import {filterSlashCommands, getLocalCommand} from '../antigravityCommands.js';
import {createAssistantCard, inlineMarkup, parseMarkdownToActors} from '../antigravityMarkdown.js';
import {uiScale, VERTICAL} from '../compat.js';
import {icon, iconButton, label, pillButton} from '../widgets.js';
import {
    browseDirectoryAsync,
    filterMentionFiles,
    findActiveWorkspace,
    getRecentWorkspaces,
    getWorkspaceFiles,
} from '../workspace.js';
import {Page} from './page.js';

function timeAgo(dateStr) {
    if (!dateStr)
        return '';
    try {
        const at = new Date(dateStr.replace(' ', 'T')).getTime();
        const diffMs = Date.now() - at;
        const mins = Math.floor(diffMs / 60000);
        if (mins < 1)
            return 'Just now';
        if (mins < 60)
            return `${mins}m ago`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24)
            return `${hrs}h ago`;
        return `${Math.floor(hrs / 24)}d ago`;
    } catch (_) {
        return '';
    }
}

function projectName(workspaceUris) {
    if (!workspaceUris)
        return '';
    try {
        const uris = JSON.parse(workspaceUris);
        if (uris && uris[0]) {
            const parts = uris[0].split('/').filter(Boolean);
            return parts[parts.length - 1] || '';
        }
    } catch (_) {}
    return '';
}

function extractWorkspace(workspaceUris) {
    if (!workspaceUris)
        return null;
    try {
        const uris = JSON.parse(workspaceUris);
        if (uris && uris[0]) {
            let uri = uris[0];
            if (uri.startsWith('file://'))
                uri = uri.slice(7);
            if (GLib.file_test(uri, GLib.FileTest.IS_DIR))
                return uri;
        }
    } catch (_) {}
    return null;
}

export const AntigravityPage = GObject.registerClass(
class AntigravityPage extends Page {
    _init(daemon, watcher, {height}) {
        super._init(daemon, {
            style_class: 'isle-page isle-notifications',
            layout_manager: new Clutter.BoxLayout({orientation: Clutter.Orientation.VERTICAL}),
            height,
        });
        this.name = 'antigravity';
        this._watcher = watcher;
        this._client = new AntigravityClient();
        this._workspace = findActiveWorkspace();
        this._activeConversationId = null;
        this._viewMode = 'chat'; // 'chat', 'sessions', or 'picker'
        this._messages = [];
        this._activeTurnPrompt = '';
        this._activeTurnSteps = [];
        this._activeTurnToolCalls = [];
        this._activeTurnThinking = '';
        this._activeTurnResponse = '';
        this._activeCommandResult = null;
        this._autoScrollBottom = true;
        this._userScrolledAt = 0;
        this._lastScrollEventTime = 0;

        // Unified Autocomplete state (@file and /command)
        this._suggestionItems = [];
        this._suggestionType = 'none'; // 'mention' or 'command'
        this._suggestionToken = '';
        this._selectedSuggestionIndex = 0;

        this._activeBox = null;
        this._liveActionLabel = null;
        this._liveStepsContainer = null;
        this._liveThinkingBox = null;
        this._liveResponseCard = null;

        this.add_child(this._buildBar());
        this.add_child(this._buildContent());
        this.add_child(this._buildInputSection());

        this.connect('scroll-event', (_actor, event) => this._onScroll(event));

        this._wireClient();
        this._watcherHandler = watcher ? watcher.connect('updated', () => this._onWatcherUpdated()) : 0;
        this._stale = true;
        this.connect('destroy', () => this._onDestroy());
    }

    get available() {
        return this._watcher ? this._watcher.isAvailable : true;
    }

    get relevant() {
        return Boolean(this._watcher?.hasRunning || this._client.isRunning);
    }

    get hasNews() {
        return Boolean(this._watcher?.hasRunning || this._client.isRunning);
    }

    /** Dynamic height: fits natural content up to max 1/3 of the primary monitor height */
    get preferredHeight() {
        const monitor = Main.layoutManager?.primaryMonitor;
        const screenHeight = monitor ? monitor.height : 1080;
        const maxAllowed = Math.floor(screenHeight / 3);
        const scale = uiScale();

        // Calculate height wanted by bar + content + suggestions + input row
        const barH = 34 * scale;
        const inputH = 46 * scale;
        const suggH = this._suggestionBox.visible ? 120 * scale : 0;
        const [, contentNatH] = this._scrollContent.get_preferred_height(-1);
        const natural = Math.ceil(barH + inputH + suggH + contentNatH + 16 * scale);

        return Math.max(160 * scale, Math.min(natural, maxAllowed));
    }

    _checkHeightChanged() {
        this.later('throttle-height', 80, () => {
            const currentH = this.height;
            const preferredH = this.preferredHeight;
            if (Math.abs(currentH - preferredH) > 4)
                this.emit('height-changed');
        });
    }

    onActivate() {
        this.emit('request-keyboard', true);
        this._entry.grab_key_focus();
        if (this._stale)
            this._syncView();
        else if (this._autoScrollBottom)
            this.later('activate-scroll', 30, () => this._toEnd());
    }

    onDeactivate() {
        this.emit('request-keyboard', false);
        this._hideSuggestions();
    }

    _wireClient() {
        this._client.connect('init', (_c, id) => {
            if (id)
                this._activeConversationId = id;
        });

        this._client.connect('state-changed', (_c, running) => {
            this._sendButtonIcon.gicon = icon(running ? 'isle-stop-symbolic' : 'isle-send-symbolic');
            this._sendButton.accessible_name = running ? 'Stop' : 'Send';
            this._statusBadge.visible = running;
            if (!running)
                this._clearActiveTurnBox();
            this._syncView();
            this._checkHeightChanged();
        });

        this._client.connect('thinking-delta', (_c, _delta) => {
            this._activeTurnThinking = this._client.currentThinking;
            this._initActiveTurnBox(this._activeTurnPrompt);
            this._updateLiveThinking(this._activeTurnThinking);
            if (this._autoScrollBottom && Date.now() - this._userScrolledAt > 1500)
                this._toEnd();
            this._checkHeightChanged();
        });

        this._client.connect('text-delta', (_c, _delta) => {
            this._activeTurnResponse = this._client.currentResponse;
            this._initActiveTurnBox(this._activeTurnPrompt);
            this._updateLiveResponse(this._activeTurnResponse);
            if (this._autoScrollBottom && Date.now() - this._userScrolledAt > 1500)
                this._toEnd();
            this._checkHeightChanged();
        });

        this._client.connect('tool-call', (_c, _call) => {
            this._activeTurnSteps = [...this._client.currentSteps];
            this._activeTurnToolCalls = [...this._client.toolCalls];
            this._initActiveTurnBox(this._activeTurnPrompt);
            if (this._liveActionLabel)
                this._liveActionLabel.text = this._client.currentAction || 'Memproses…';
            this._updateLiveToolCards(this._activeTurnToolCalls);
            if (this._autoScrollBottom && Date.now() - this._userScrolledAt > 1500)
                this._toEnd();
            this._checkHeightChanged();
        });

        this._client.connect('command-result', (_c, cmd) => {
            this._activeCommandResult = cmd;
        });

        this._client.connect('turn-finished', (_c, res) => {
            if (this._activeTurnPrompt) {
                this._messages.push({
                    prompt: this._activeTurnPrompt,
                    response: res.response || this._activeTurnResponse,
                    steps: [...this._activeTurnSteps],
                    toolCalls: res.toolCalls || [...this._activeTurnToolCalls],
                    thinking: res.thinking || this._activeTurnThinking,
                    commandResult: res.commandResult || this._activeCommandResult,
                });
            }
            this._activeTurnPrompt = '';
            this._activeTurnSteps = [];
            this._activeTurnToolCalls = [];
            this._activeTurnThinking = '';
            this._activeTurnResponse = '';
            this._activeCommandResult = null;
            this._clearActiveTurnBox();
            this._syncView();
            this._checkHeightChanged();
        });

        this._client.connect('error', (_c, err) => {
            this._messages.push({
                prompt: this._activeTurnPrompt || 'Prompt',
                response: `Error: ${err}`,
                steps: [],
                toolCalls: [],
                thinking: '',
            });
            this._activeTurnPrompt = '';
            this._activeTurnSteps = [];
            this._activeTurnToolCalls = [];
            this._activeTurnThinking = '';
            this._activeTurnResponse = '';
            this._activeCommandResult = null;
            this._clearActiveTurnBox();
            this._syncView();
            this._checkHeightChanged();
        });
    }

    _buildBar() {
        const bar = new St.BoxLayout({style_class: 'isle-notifications-bar', y_align: Clutter.ActorAlign.CENTER});

        // Antigravity logo
        const iconBox = new St.Bin({
            child: new St.Icon({gicon: icon('isle-antigravity'), icon_size: 16}),
            y_align: Clutter.ActorAlign.CENTER,
            style: 'margin-right: 6px;',
        });
        bar.add_child(iconBox);

        // Title
        const heading = label('Antigravity', 'isle-notifications-heading', {y_align: Clutter.ActorAlign.CENTER});
        bar.add_child(heading);

        // Active project pill (clickable to pick workspace)
        const projName = GLib.path_get_basename(this._workspace) || 'workspace';
        this._projButton = pillButton(`${projName} ▾`, 'isle-pill-small', () => this._toggleWorkspacePicker());
        this._projButton.style = 'background-color: rgba(255, 255, 255, 0.1); color: rgba(255, 255, 255, 0.85); margin-left: 8px;';
        this._projButton.y_align = Clutter.ActorAlign.CENTER;
        bar.add_child(this._projButton);

        // Working badge
        this._statusBadge = pillButton('Working', 'isle-pill-small', () => {});
        this._statusBadge.style = 'background-color: #34c759; color: #000000; font-weight: bold; margin-left: 6px;';
        this._statusBadge.visible = false;
        bar.add_child(this._statusBadge);

        // Spacer
        const spacer = new St.Widget({x_expand: true});
        bar.add_child(spacer);

        // View mode toggle button (Chat vs Sessions list)
        this._modeToggleBtn = iconButton('isle-tasks', 'isle-button-flat', () => {
            this._viewMode = this._viewMode === 'chat' ? 'sessions' : 'chat';
            this._modeToggleBtn.child.gicon = icon(this._viewMode === 'chat' ? 'isle-tasks' : 'isle-sparkle-symbolic');
            this._syncView();
            this._checkHeightChanged();
        }, {size: 12, accessibleName: 'Toggle Sessions'});
        this._modeToggleBtn.y_align = Clutter.ActorAlign.CENTER;
        bar.add_child(this._modeToggleBtn);

        // New session button (+)
        const newBtn = iconButton('isle-plus-symbolic', 'isle-button-flat', () => {
            this._newSession();
        }, {size: 12, accessibleName: 'New Session'});
        newBtn.y_align = Clutter.ActorAlign.CENTER;
        bar.add_child(newBtn);

        return bar;
    }

    _updateProjectPill() {
        if (!this._projButton)
            return;
        const projName = GLib.path_get_basename(this._workspace) || 'workspace';
        this._projButton.label = `${projName} ▾`;
    }

    _toggleWorkspacePicker() {
        this._viewMode = this._viewMode === 'picker' ? 'chat' : 'picker';
        this._syncView();
        this._checkHeightChanged();
    }

    _buildContent() {
        this._scrollContent = new St.BoxLayout({...VERTICAL, style_class: 'isle-chat-list', x_expand: true});

        this._scroll = new St.ScrollView({
            style_class: 'isle-chat-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            x_expand: true,
            y_expand: true,
            reactive: true,
        });
        this._scroll.set_child(this._scrollContent);

        // Remove PanGesture if present (prevents click/drag conflicts in GNOME Shell)
        for (const action of this._scroll.get_actions?.() ?? []) {
            if (Clutter.PanGesture && action instanceof Clutter.PanGesture)
                this._scroll.remove_action(action);
        }

        // Connect scroll on the scroll view directly
        this._scroll.connect('scroll-event', (_actor, event) => this._onScroll(event));

        // Automatic scroll following
        const adjustment = this._scroll.vadjustment;
        let last = {value: 0, upper: 0, page: 0};
        const remember = () => (last = {value: adjustment.value, upper: adjustment.upper, page: adjustment.page_size});

        adjustment.connect('notify::upper', () => {
            if (this._autoScrollBottom)
                this._toEnd();
            remember();
        });
        adjustment.connect('notify::page-size', () => {
            if (last.value >= last.upper - last.page - 4)
                this._toEnd();
            remember();
        });
        adjustment.connect('notify::value', () => {
            if (adjustment.page_size === last.page) {
                const distFromBottom = (adjustment.upper - adjustment.page_size) - adjustment.value;
                this._autoScrollBottom = distFromBottom < 40;
                remember();
            }
        });

        return this._scroll;
    }

    _toEnd() {
        const adj = this._scroll?.vadjustment;
        if (!adj)
            return;
        adj.remove_transition('value');
        adj.value = Math.max(adj.lower, adj.upper - adj.page_size);
    }

    _scrollToBottom({smooth = false} = {}) {
        this.later('scroll-bottom', 30, () => {
            const adj = this._scroll?.vadjustment;
            if (!adj)
                return;
            const target = Math.max(adj.lower, adj.upper - adj.page_size);
            if (smooth) {
                adj.ease(target, {duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            } else {
                adj.remove_transition('value');
                adj.value = target;
            }
        });
    }

    _onScroll(event) {
        const direction = event.get_scroll_direction();
        // Sideways / horizontal scrolls propagate to let the user switch tabs by swiping left/right
        if (direction === Clutter.ScrollDirection.LEFT || direction === Clutter.ScrollDirection.RIGHT)
            return Clutter.EVENT_PROPAGATE;

        if (direction === Clutter.ScrollDirection.SMOOTH) {
            const [dx, dy] = event.get_scroll_delta();
            if (Math.abs(dx) > Math.abs(dy))
                return Clutter.EVENT_PROPAGATE;
        }

        const eventTime = event.get_time();
        if (this._lastScrollEventTime === eventTime)
            return Clutter.EVENT_STOP;
        this._lastScrollEventTime = eventTime;

        const adj = this._scroll?.vadjustment;
        if (!adj)
            return Clutter.EVENT_STOP;

        // Cancel any programmatic scroll ease so user scroll takes immediate effect
        adj.remove_transition('value');

        let delta = 0;
        if (direction === Clutter.ScrollDirection.UP) {
            delta = -1;
        } else if (direction === Clutter.ScrollDirection.DOWN) {
            delta = 1;
        } else if (direction === Clutter.ScrollDirection.SMOOTH) {
            const [, dy] = event.get_scroll_delta();
            delta = dy;
        }

        const scale = uiScale();
        const step = (adj.step_increment && adj.step_increment > 10) ? adj.step_increment : (36 * scale);
        const maxVal = Math.max(adj.lower, adj.upper - adj.page_size);
        adj.value = Math.max(adj.lower, Math.min(maxVal, adj.value + delta * step));

        const distFromBottom = maxVal - adj.value;
        this._autoScrollBottom = distFromBottom < 40;
        this._userScrolledAt = Date.now();

        return Clutter.EVENT_STOP;
    }

    _buildInputSection() {
        const container = new St.BoxLayout({...VERTICAL, x_expand: true, style: 'margin-top: 4px;'});

        // @file mention suggestions vertical popup (Antigravity CLI style)
        this._suggestionBox = new St.BoxLayout({
            ...VERTICAL,
            style_class: 'isle-voice-ideas',
            visible: false,
            style: 'padding: 4px; margin-bottom: 6px; background-color: rgba(22, 22, 28, 0.96); border: 1px solid rgba(255, 255, 255, 0.16); border-radius: 12px; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.6);',
        });
        container.add_child(this._suggestionBox);

        // Input row: St.Entry + Send/Stop button
        const row = new St.BoxLayout({style_class: 'isle-reminder-row', x_expand: true, y_align: Clutter.ActorAlign.CENTER});

        this._entry = new St.Entry({
            hint_text: 'Tanya Antigravity, sebut @file, atau ketik /command…',
            style_class: 'isle-voice-entry',
            x_expand: true,
            can_focus: true,
        });
        const text = this._entry.clutter_text;
        text.connect('activate', () => this._send());
        text.connect('button-press-event', () => {
            this.emit('request-keyboard', true);
            return Clutter.EVENT_PROPAGATE;
        });
        text.connect('key-press-event', (_t, event) => {
            const sym = event.get_key_symbol();

            // Keyboard navigation for autocomplete (@file or /command)
            if (this._suggestionBox.visible && this._suggestionItems.length > 0) {
                if (sym === Clutter.KEY_Down) {
                    this._selectedSuggestionIndex = (this._selectedSuggestionIndex + 1) % this._suggestionItems.length;
                    this._updateSuggestionHighlight();
                    return Clutter.EVENT_STOP;
                } else if (sym === Clutter.KEY_Up) {
                    this._selectedSuggestionIndex = (this._selectedSuggestionIndex - 1 + this._suggestionItems.length) % this._suggestionItems.length;
                    this._updateSuggestionHighlight();
                    return Clutter.EVENT_STOP;
                } else if (sym === Clutter.KEY_Tab || sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
                    const selected = this._suggestionItems[this._selectedSuggestionIndex];
                    if (selected) {
                        this._applySuggestion(selected);
                        return Clutter.EVENT_STOP;
                    }
                } else if (sym === Clutter.KEY_Escape) {
                    this._hideSuggestions();
                    return Clutter.EVENT_STOP;
                }
            }

            if (sym === Clutter.KEY_Escape) {
                this.emit('request-keyboard', false);
                this.emit('request-close');
                return Clutter.EVENT_STOP;
            } else if (sym === Clutter.KEY_Page_Up) {
                const adj = this._scroll?.vadjustment;
                if (adj) {
                    adj.remove_transition('value');
                    adj.value = Math.max(adj.lower, adj.value - adj.page_size * 0.8);
                    this._autoScrollBottom = false;
                    this._userScrolledAt = Date.now();
                }
                return Clutter.EVENT_STOP;
            } else if (sym === Clutter.KEY_Page_Down) {
                const adj = this._scroll?.vadjustment;
                if (adj) {
                    adj.remove_transition('value');
                    const maxVal = Math.max(adj.lower, adj.upper - adj.page_size);
                    adj.value = Math.min(maxVal, adj.value + adj.page_size * 0.8);
                    this._autoScrollBottom = (maxVal - adj.value) < 40;
                    this._userScrolledAt = Date.now();
                }
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        text.connect('text-changed', () => this._onTextChanged());
        row.add_child(this._entry);

        this._sendButtonIcon = new St.Icon({gicon: icon('isle-send-symbolic'), icon_size: 14});
        this._sendButton = new St.Button({
            style_class: 'isle-voice-send',
            child: this._sendButtonIcon,
            can_focus: true,
            accessible_name: 'Send',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'margin-left: 6px;',
        });
        this._sendButton.connect('clicked', () => {
            if (this._client.isRunning)
                this._client.cancel();
            else
                this._send();
        });
        row.add_child(this._sendButton);

        container.add_child(row);
        return container;
    }

    _send() {
        const prompt = this._entry.get_text().trim();
        if (!prompt)
            return;

        this._entry.set_text('');
        this._hideSuggestions();

        // Local instant UI commands
        const localCmd = getLocalCommand(prompt);
        if (localCmd === 'clear') {
            this._messages = [];
            this._clearActiveTurnBox();
            this._activeTurnPrompt = '';
            this._activeTurnSteps = [];
            this._activeTurnToolCalls = [];
            this._activeTurnThinking = '';
            this._activeTurnResponse = '';
            this._activeCommandResult = null;
            this._syncView();
            this._checkHeightChanged();
            return;
        } else if (localCmd === 'new') {
            this._newSession();
            return;
        }

        this._viewMode = 'chat';
        this._modeToggleBtn.child.gicon = icon('isle-tasks');
        this._autoScrollBottom = true;
        this._userScrolledAt = 0;
        this._activeTurnPrompt = prompt;
        this._activeTurnSteps = [];
        this._activeTurnToolCalls = [];
        this._activeTurnThinking = '';
        this._activeTurnResponse = '';
        this._activeCommandResult = null;

        // Clean turn: continueRecent is explicitly false!
        // If continuing an active conversation, pass conversationId.
        // If creating a new conversation, pass neither --conversation nor --continue.
        this._client.startTurn(prompt, {
            workspace: this._workspace,
            conversationId: this._activeConversationId || undefined,
            continueRecent: false,
        });
        this._syncView();
        this._checkHeightChanged();
    }

    _newSession() {
        this._client.cancel();
        this._clearActiveTurnBox();
        this._activeConversationId = null;
        this._messages = [];
        this._activeTurnPrompt = '';
        this._activeTurnSteps = [];
        this._activeTurnToolCalls = [];
        this._activeTurnThinking = '';
        this._activeTurnResponse = '';
        this._activeCommandResult = null;
        this._entry.set_text('');
        // Open the workspace picker so user can choose or confirm directory
        this._viewMode = 'picker';
        this._syncView();
        this._checkHeightChanged();
    }

    _cycleWorkspace() {
        this._toggleWorkspacePicker();
    }

    _selectWorkspace(path) {
        if (!path || !GLib.file_test(path, GLib.FileTest.IS_DIR))
            return;
        this._workspace = path;
        this._activeConversationId = null;
        this._messages = [];
        this._activeTurnPrompt = '';
        this._activeTurnSteps = [];
        this._activeTurnToolCalls = [];
        this._activeTurnThinking = '';
        this._activeTurnResponse = '';
        this._activeCommandResult = null;
        this._entry.set_text('');
        this._viewMode = 'chat';
        this._modeToggleBtn.child.gicon = icon('isle-tasks');
        this._updateProjectPill();
        this._syncView();
        this._checkHeightChanged();
        this.emit('request-keyboard', true);
        this._entry.grab_key_focus();
        getWorkspaceFiles(path); // prime autocomplete cache
    }

    async _onTextChanged() {
        const text = this._entry.get_text();
        const cursor = this._entry.clutter_text.get_cursor_position();
        const before = text.slice(0, cursor);

        // 1. Slash command autocomplete (starts with / or token has /)
        const slashMatch = before.match(/(?:^|\s)\/([a-zA-Z0-9_\-]*)$/);
        if (slashMatch) {
            const query = slashMatch[1];
            const suggestions = filterSlashCommands(query, 6);
            if (suggestions.length > 0) {
                this._showSuggestions(suggestions, 'command', slashMatch[0].trim());
                return;
            }
        }

        // 2. Mention @file autocomplete
        const mentionMatch = before.match(/@([a-zA-Z0-9_\-\.\/]*)$/);
        if (mentionMatch) {
            const query = mentionMatch[1];
            const suggestions = await filterMentionFiles(query, this._workspace, 6);
            if (suggestions.length > 0) {
                this._showSuggestions(suggestions, 'mention', mentionMatch[0]);
                return;
            }
        }

        this._hideSuggestions();
    }

    _showSuggestions(items, type, token) {
        this._suggestionItems = items;
        this._suggestionType = type;
        this._suggestionToken = token;
        this._selectedSuggestionIndex = 0;
        this._suggestionBox.destroy_all_children();

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const isSelected = (i === this._selectedSuggestionIndex);
            const chip = new St.Button({
                style_class: 'isle-voice-idea',
                can_focus: true,
                x_expand: true,
                style: isSelected
                    ? 'background-color: rgba(255, 255, 255, 0.18); border-radius: 8px; padding: 4px 8px; margin: 1px 0;'
                    : 'border-radius: 8px; padding: 4px 8px; margin: 1px 0;',
            });

            const row = new St.BoxLayout({x_expand: true, y_align: Clutter.ActorAlign.CENTER});

            if (type === 'command') {
                row.add_child(new St.Icon({
                    gicon: icon(item.icon || 'isle-sparkle-symbolic'),
                    icon_size: 13,
                    style: 'margin-right: 6px; opacity: 190; color: #ff9f0a;',
                }));
                const nameBox = new St.BoxLayout({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
                const cmdLabel = label(item.command, '', {
                    style: 'font-family: monospace; font-size: 12px; font-weight: bold; color: #ffffff; margin-right: 6px;',
                });
                nameBox.add_child(cmdLabel);

                const catBadge = label(item.category.toUpperCase(), '', {
                    style: 'font-size: 9px; font-weight: bold; color: rgba(255, 255, 255, 0.45); background-color: rgba(255, 255, 255, 0.08); border-radius: 4px; padding: 1px 4px; margin-right: 6px;',
                });
                nameBox.add_child(catBadge);

                const descLabel = label(item.description, '', {
                    style: 'font-size: 11px; color: rgba(255, 255, 255, 0.6);',
                });
                descLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                nameBox.add_child(descLabel);
                row.add_child(nameBox);
            } else {
                row.add_child(new St.Icon({gicon: icon('isle-file'), icon_size: 13, style: 'margin-right: 6px; opacity: 180;'}));
                const nameBox = new St.BoxLayout({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
                const base = label(item.basename, '', {style: 'font-size: 12px; font-weight: 600; color: #ffffff; margin-right: 6px;'});
                nameBox.add_child(base);
                if (item.dir) {
                    const dir = label(item.dir, '', {style: 'font-size: 10px; color: rgba(255, 255, 255, 0.45);'});
                    dir.clutter_text.ellipsize = Pango.EllipsizeMode.START;
                    nameBox.add_child(dir);
                }
                row.add_child(nameBox);
            }

            chip.child = row;
            chip.connect('clicked', () => this._applySuggestion(item));
            this._suggestionBox.add_child(chip);
        }

        this._suggestionBox.visible = true;
        this._checkHeightChanged();
    }

    _updateSuggestionHighlight() {
        const children = this._suggestionBox.get_children();
        for (let i = 0; i < children.length; i++) {
            const isSelected = (i === this._selectedSuggestionIndex);
            children[i].style = isSelected
                ? 'background-color: rgba(255, 255, 255, 0.18); border-radius: 8px; padding: 4px 8px; margin: 1px 0;'
                : 'border-radius: 8px; padding: 4px 8px; margin: 1px 0;';
        }
    }

    _hideSuggestions() {
        if (!this._suggestionBox.visible)
            return;
        this._suggestionBox.visible = false;
        this._suggestionBox.destroy_all_children();
        this._suggestionItems = [];
        this._suggestionType = 'none';
        this._checkHeightChanged();
    }

    _applySuggestion(item) {
        const text = this._entry.get_text();
        const token = this._suggestionToken;
        const idx = text.lastIndexOf(token);
        if (idx !== -1) {
            let replacement = '';
            if (this._suggestionType === 'command') {
                replacement = `${item.command} `;
            } else {
                replacement = `@${item.path} `;
            }
            const newText = text.slice(0, idx) + replacement + text.slice(idx + token.length);
            this._entry.set_text(newText);
            this._entry.clutter_text.set_cursor_position(idx + replacement.length);
        }
        this._hideSuggestions();
        this.emit('request-keyboard', true);
        this._entry.grab_key_focus();
    }

    _onWatcherUpdated() {
        if (this._stale)
            return;
        // Do not interrupt active chat view with ongoing messages or running agent
        if (this._viewMode === 'chat' && (this._client.isRunning || this._messages.length > 0))
            return;
        this._syncView();
    }

    _syncView() {
        this._stale = false;
        this._clearActiveTurnBox();
        this._scrollContent.destroy_all_children();

        if (this._viewMode === 'sessions') {
            this._renderSessionsList();
        } else if (this._viewMode === 'picker') {
            this._renderWorkspacePicker();
        } else {
            this._renderChatView();
        }

        if (this._autoScrollBottom || Date.now() - this._userScrolledAt > 3000)
            this._scrollToBottom({smooth: false});
    }

    _renderChatView() {
        // Render completed turn bubbles
        for (const msg of this._messages) {
            this._scrollContent.add_child(this._userBubble(msg.prompt));
            if (msg.thinking)
                this._scrollContent.add_child(this._thinkingAccordion(msg.thinking, false));
            if (msg.toolCalls && msg.toolCalls.length)
                this._scrollContent.add_child(this._toolCardsBox(msg.toolCalls));
            else if (msg.steps && msg.steps.length)
                this._scrollContent.add_child(this._stepsBox(msg.steps));
            if (msg.commandResult)
                this._scrollContent.add_child(this._commandBadge(msg.commandResult));
            if (msg.response)
                this._scrollContent.add_child(this._assistantBubble(msg.response));
        }

        // Render active turn (live streaming)
        if (this._client.isRunning || this._activeTurnPrompt) {
            this._initActiveTurnBox(this._activeTurnPrompt);
            if (this._activeTurnThinking)
                this._updateLiveThinking(this._activeTurnThinking);
            if (this._activeTurnToolCalls && this._activeTurnToolCalls.length > 0)
                this._updateLiveToolCards(this._activeTurnToolCalls);
            else if (this._activeTurnSteps.length > 0)
                this._updateLiveSteps(this._activeTurnSteps);
            if (this._activeTurnResponse)
                this._updateLiveResponse(this._activeTurnResponse);
        } else if (this._messages.length === 0) {
            const runningTask = this._watcher?.activeRunningConversation;
            if (runningTask) {
                this._scrollContent.add_child(this._watcherRunningCard(runningTask));
            } else {
                this._renderEmptyState();
            }
        }
    }

    async _renderWorkspacePicker() {
        const box = new St.BoxLayout({...VERTICAL, x_expand: true, style: 'padding: 4px 2px;'});

        // Header
        const topRow = new St.BoxLayout({x_expand: true, y_align: Clutter.ActorAlign.CENTER, style: 'margin-bottom: 8px;'});
        topRow.add_child(new St.Icon({gicon: icon('isle-antigravity'), icon_size: 14, style: 'margin-right: 6px;'}));
        topRow.add_child(label('Pilih Workspace Project', 'isle-notification-title', {style: 'font-weight: bold; font-size: 12px;'}));
        topRow.add_child(new St.Widget({x_expand: true}));
        const closeBtn = iconButton('isle-close-symbolic', 'isle-button-flat', () => {
            this._viewMode = 'chat';
            this._syncView();
            this._checkHeightChanged();
        }, {size: 11, accessibleName: 'Tutup'});
        topRow.add_child(closeBtn);
        box.add_child(topRow);

        // Current Workspace Card
        const currentName = GLib.path_get_basename(this._workspace) || 'workspace';
        const curBtn = new St.Button({
            style_class: 'isle-notification-row',
            x_expand: true,
            can_focus: true,
            style: 'background-color: rgba(52, 199, 89, 0.14); border: 1px solid rgba(52, 199, 89, 0.4); border-radius: 10px; margin-bottom: 6px; padding: 6px 10px;',
        });
        const curContent = new St.BoxLayout({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        curContent.add_child(new St.Icon({gicon: icon('isle-check-symbolic'), icon_size: 14, style: 'color: #34c759; margin-right: 8px;'}));
        const curText = new St.BoxLayout({...VERTICAL, x_expand: true});
        curText.add_child(label(`Gunakan Saat Ini: ${currentName}`, 'isle-notification-title', {style: 'font-weight: 600; font-size: 12px; color: #ffffff;'}));
        const curSub = label(this._workspace, 'isle-notification-body', {style: 'font-size: 10px; color: rgba(255, 255, 255, 0.6);'});
        curSub.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
        curText.add_child(curSub);
        curContent.add_child(curText);
        curBtn.child = curContent;
        curBtn.connect('clicked', () => this._selectWorkspace(this._workspace));
        box.add_child(curBtn);

        // Browse native folder button
        const browseBtn = new St.Button({
            style_class: 'isle-notification-row',
            x_expand: true,
            can_focus: true,
            style: 'background-color: rgba(255, 255, 255, 0.08); border-radius: 10px; margin-bottom: 8px; padding: 6px 10px;',
        });
        const browseContent = new St.BoxLayout({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        browseContent.add_child(new St.Icon({gicon: icon('isle-open-symbolic'), icon_size: 14, style: 'margin-right: 8px;'}));
        const browseText = new St.BoxLayout({...VERTICAL, x_expand: true});
        browseText.add_child(label('Pilih Folder Lain… (Browse)', 'isle-notification-title', {style: 'font-weight: 600; font-size: 12px; color: #ffffff;'}));
        browseText.add_child(label('Buka dialog pemilih folder komputer Anda', 'isle-notification-body', {style: 'font-size: 10px; color: rgba(255, 255, 255, 0.5);'}));
        browseContent.add_child(browseText);
        browseBtn.child = browseContent;
        browseBtn.connect('clicked', async () => {
            const picked = await browseDirectoryAsync();
            if (picked)
                this._selectWorkspace(picked);
        });
        box.add_child(browseBtn);

        // Recent Workspaces section
        const recents = await getRecentWorkspaces();
        const otherRecents = recents.filter(p => p !== this._workspace);
        if (otherRecents.length > 0) {
            box.add_child(label('Proyek Terkini', 'isle-notification-heading', {style: 'font-size: 11px; margin-bottom: 4px; color: rgba(255, 255, 255, 0.5); font-weight: 600;'}));
            for (const rPath of otherRecents.slice(0, 10)) {
                const rName = GLib.path_get_basename(rPath) || rPath;
                const rBtn = new St.Button({
                    style_class: 'isle-notification-row',
                    x_expand: true,
                    can_focus: true,
                    style: 'margin-bottom: 3px; padding: 5px 8px; border-radius: 8px;',
                });
                const rContent = new St.BoxLayout({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
                rContent.add_child(new St.Icon({gicon: icon('isle-file'), icon_size: 13, style: 'margin-right: 8px; opacity: 160;'}));
                const rText = new St.BoxLayout({...VERTICAL, x_expand: true});
                rText.add_child(label(rName, 'isle-notification-title', {style: 'font-size: 12px; font-weight: 500;'}));
                const rSub = label(rPath, 'isle-notification-body', {style: 'font-size: 10px; color: rgba(255, 255, 255, 0.45);'});
                rSub.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
                rText.add_child(rSub);
                rContent.add_child(rText);
                rBtn.child = rContent;
                rBtn.connect('clicked', () => this._selectWorkspace(rPath));
                box.add_child(rBtn);
            }
        }

        this._scrollContent.add_child(box);
    }

    _clearActiveTurnBox() {
        if (this._activeBox) {
            this._activeBox.destroy();
            this._activeBox = null;
        }
        this._liveActionLabel = null;
        this._liveThinkingBox = null;
        this._liveStepsContainer = null;
        this._liveResponseRow = null;
        this._liveResponseCard = null;
    }

    _initActiveTurnBox(prompt) {
        if (this._activeBox)
            return;

        this._activeBox = new St.BoxLayout({...VERTICAL, x_expand: true, style: 'margin-bottom: 6px;'});

        if (prompt)
            this._activeBox.add_child(this._userBubble(prompt));

        // Live Action Indicator
        const liveRow = new St.BoxLayout({
            style_class: 'isle-voice-step',
            style: 'background-color: rgba(52, 199, 89, 0.12); border: 1px solid rgba(52, 199, 89, 0.3); border-radius: 8px; padding: 6px 10px; margin: 4px 0;',
        });
        liveRow.add_child(new St.Icon({
            gicon: icon('isle-bolt'),
            icon_size: 12,
            style: 'color: #34c759; margin-right: 6px;',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._liveActionLabel = label(this._client.currentAction || 'Memproses…', 'isle-voice-step-text', {
            style: 'font-size: 12px; font-weight: 600; color: #ffffff;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._liveActionLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        liveRow.add_child(this._liveActionLabel);
        this._activeBox.add_child(liveRow);

        this._liveThinkingBox = new St.BoxLayout({...VERTICAL, x_expand: true});
        this._activeBox.add_child(this._liveThinkingBox);

        this._liveStepsContainer = new St.BoxLayout({...VERTICAL, x_expand: true, style: 'margin-bottom: 4px;'});
        this._activeBox.add_child(this._liveStepsContainer);

        this._liveResponseRow = null;
        this._liveResponseCard = null;

        this._scrollContent.add_child(this._activeBox);
    }

    _updateLiveThinking(text) {
        if (!this._liveThinkingBox)
            return;
        this._liveThinkingBox.destroy_all_children();
        const widget = this._thinkingAccordion(text, true);
        if (widget)
            this._liveThinkingBox.add_child(widget);
    }

    _updateLiveToolCards(toolCalls) {
        if (!this._liveStepsContainer)
            return;
        this._liveStepsContainer.destroy_all_children();
        const cards = this._toolCardsBox(toolCalls);
        this._liveStepsContainer.add_child(cards);
    }

    _updateLiveSteps(steps) {
        if (!this._liveStepsContainer)
            return;
        this._liveStepsContainer.destroy_all_children();
        const recent = steps.slice(-4);
        for (const step of recent) {
            const r = new St.BoxLayout({style_class: 'isle-voice-step', style: 'margin-bottom: 2px;'});
            r.add_child(new St.Icon({
                gicon: icon('isle-check-symbolic'),
                icon_size: 11,
                style_class: 'isle-voice-step-tick',
                y_align: Clutter.ActorAlign.CENTER,
                style: 'color: rgba(255, 255, 255, 0.5); margin-right: 6px;',
            }));
            const l = label(step, 'isle-voice-step-text', {
                y_align: Clutter.ActorAlign.CENTER,
                style: 'font-size: 11px; color: rgba(255, 255, 255, 0.65);',
            });
            l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            r.add_child(l);
            this._liveStepsContainer.add_child(r);
        }
    }

    _updateLiveResponse(text) {
        if (!this._activeBox)
            return;
        if (!this._liveResponseCard) {
            this._liveResponseRow = new St.BoxLayout({
                x_align: Clutter.ActorAlign.START,
                x_expand: true,
                style: 'margin-bottom: 8px;',
            });
            this._liveResponseCard = new St.BoxLayout({
                ...VERTICAL,
                x_expand: true,
                style: 'background-color: rgba(255, 255, 255, 0.08); border-radius: 12px; padding: 10px 14px; max-width: 520px;',
            });
            this._liveResponseRow.add_child(this._liveResponseCard);
            this._activeBox.add_child(this._liveResponseRow);
        }
        this._liveResponseCard.destroy_all_children();
        const blocks = parseMarkdownToActors(text);
        for (const block of blocks)
            this._liveResponseCard.add_child(block);
    }

    _userBubble(text) {
        const row = new St.BoxLayout({x_align: Clutter.ActorAlign.END, x_expand: true, style: 'margin-bottom: 6px;'});
        const bubble = new St.BoxLayout({
            style: 'background-color: #007aff; border-radius: 12px; padding: 6px 12px; max-width: 480px;',
        });
        const l = new St.Label({style: 'color: #ffffff; font-size: 12px; font-weight: 500;'});
        l.clutter_text.set({
            use_markup: true,
            line_wrap: true,
            line_wrap_mode: Pango.WrapMode.WORD_CHAR,
        });
        const markup = inlineMarkup(text);
        try {
            l.clutter_text.set_markup(markup);
        } catch (_) {
            l.clutter_text.set_text(text);
        }
        bubble.add_child(l);
        row.add_child(bubble);
        return row;
    }

    _assistantBubble(text) {
        return createAssistantCard(text);
    }

    _thinkingAccordion(thinkingText, initiallyOpen = false) {
        if (!thinkingText || !thinkingText.trim())
            return null;

        const box = new St.BoxLayout({
            ...VERTICAL,
            x_expand: true,
            style: 'margin-bottom: 6px; background-color: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.06); border-radius: 8px; padding: 4px 8px;',
        });

        let isOpen = initiallyOpen;
        const lineCount = thinkingText.trim().split('\n').length;

        const toggleBtn = new St.Button({
            x_expand: true,
            can_focus: true,
            style: 'border-radius: 6px; padding: 2px 4px;',
        });
        const btnRow = new St.BoxLayout({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const arrowLabel = label(isOpen ? '▾' : '▸', '', {
            style: 'color: rgba(255, 255, 255, 0.5); font-size: 12px; margin-right: 6px;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const titleLabel = label(`Thinking (${lineCount} lines)`, '', {
            style: 'color: rgba(255, 255, 255, 0.6); font-size: 11px; font-style: italic;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        btnRow.add_child(arrowLabel);
        btnRow.add_child(titleLabel);
        toggleBtn.child = btnRow;

        const contentBox = new St.BoxLayout({
            ...VERTICAL,
            x_expand: true,
            visible: isOpen,
            style: 'margin-top: 4px; padding-top: 4px; border-top: 1px solid rgba(255, 255, 255, 0.06);',
        });
        const bodyLabel = new St.Label({
            x_expand: true,
            style: 'font-family: monospace; font-size: 10px; color: rgba(255, 255, 255, 0.5); line-height: 1.3;',
        });
        bodyLabel.clutter_text.set({
            line_wrap: true,
            line_wrap_mode: Pango.WrapMode.WORD_CHAR,
            selectable: true,
            reactive: true,
        });
        bodyLabel.clutter_text.set_text(thinkingText.trim());
        contentBox.add_child(bodyLabel);

        toggleBtn.connect('clicked', () => {
            isOpen = !isOpen;
            arrowLabel.text = isOpen ? '▾' : '▸';
            contentBox.visible = isOpen;
            this._checkHeightChanged();
        });

        box.add_child(toggleBtn);
        box.add_child(contentBox);
        return box;
    }

    _toolCard(tool) {
        const row = new St.BoxLayout({
            x_expand: true,
            style: 'background-color: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.09); border-radius: 8px; padding: 6px 10px; margin-bottom: 4px;',
            y_align: Clutter.ActorAlign.CENTER,
        });

        let iconName = 'isle-gauge';
        let color = '#64d2ff';
        if (tool.name === 'run_command' || tool.name?.includes('bash')) {
            iconName = 'isle-terminal-symbolic';
            color = '#30d158';
        } else if (tool.name?.includes('file')) {
            iconName = 'isle-file';
            color = '#0a84ff';
        } else if (tool.name?.includes('search') || tool.name?.includes('web')) {
            iconName = 'isle-globe';
            color = '#bf5af2';
        }

        row.add_child(new St.Icon({
            gicon: icon(iconName),
            icon_size: 13,
            style: `color: ${color}; margin-right: 8px;`,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const content = new St.BoxLayout({...VERTICAL, x_expand: true});
        const titleRow = new St.BoxLayout({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const nameLabel = label(tool.summary || tool.name, '', {
            style: 'font-size: 11.5px; font-weight: 600; color: #ffffff; margin-right: 6px;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        titleRow.add_child(nameLabel);
        content.add_child(titleRow);

        const snippet = tool.args?.CommandLine || tool.args?.Path || tool.args?.query || '';
        if (snippet && snippet !== tool.summary) {
            const snipLabel = label(snippet, '', {
                style: 'font-family: monospace; font-size: 10px; color: rgba(255, 255, 255, 0.55);',
            });
            snipLabel.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
            content.add_child(snipLabel);
        }

        row.add_child(content);

        const statusIcon = new St.Icon({
            gicon: icon(tool.status === 'running' ? 'isle-bolt' : 'isle-check-symbolic'),
            icon_size: 12,
            style: tool.status === 'running'
                ? 'color: #ff9f0a; margin-left: 6px;'
                : 'color: #34c759; margin-left: 6px;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(statusIcon);
        return row;
    }

    _toolCardsBox(toolCalls) {
        const box = new St.BoxLayout({...VERTICAL, x_expand: true, style: 'margin-bottom: 6px;'});
        const recent = toolCalls.slice(-5);
        for (const t of recent)
            box.add_child(this._toolCard(t));
        return box;
    }

    _commandBadge(cmd) {
        const row = new St.BoxLayout({x_align: Clutter.ActorAlign.START, x_expand: true, style: 'margin-bottom: 4px;'});
        const badge = new St.BoxLayout({
            style: 'background-color: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 6px; padding: 2px 8px;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        badge.add_child(new St.Icon({gicon: icon('isle-sparkle-symbolic'), icon_size: 11, style: 'color: #ff9f0a; margin-right: 5px;'}));
        badge.add_child(label(`/${cmd.name || 'command'}`, '', {style: 'font-family: monospace; font-size: 11px; font-weight: bold; color: #ffffff;'}));
        row.add_child(badge);
        return row;
    }

    _stepsBox(steps) {
        const box = new St.BoxLayout({...VERTICAL, style_class: 'isle-voice-steps', style: 'padding-left: 8px; margin-bottom: 6px;'});
        const recent = steps.slice(-4);
        for (const step of recent) {
            const r = new St.BoxLayout({style_class: 'isle-voice-step', style: 'margin-bottom: 2px;'});
            r.add_child(new St.Icon({
                gicon: icon('isle-check-symbolic'),
                icon_size: 11,
                style_class: 'isle-voice-step-tick',
                y_align: Clutter.ActorAlign.CENTER,
                style: 'color: rgba(255, 255, 255, 0.5); margin-right: 6px;',
            }));
            const l = label(step, 'isle-voice-step-text', {
                y_align: Clutter.ActorAlign.CENTER,
                style: 'font-size: 11px; color: rgba(255, 255, 255, 0.65);',
            });
            l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            r.add_child(l);
            box.add_child(r);
        }
        return box;
    }

    _renderEmptyState() {
        const empty = new St.BoxLayout({
            ...VERTICAL,
            style_class: 'isle-empty',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'padding: 16px 0;',
        });
        empty.add_child(new St.Icon({
            gicon: icon('isle-antigravity'),
            icon_size: 28,
            style_class: 'isle-empty-icon',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        const projName = GLib.path_get_basename(this._workspace) || 'workspace';
        empty.add_child(label(`Antigravity Ready (${projName})`, 'isle-empty-title', {x_align: Clutter.ActorAlign.CENTER}));
        empty.add_child(label('Ketik instruksi di bawah atau mention @file proyek', 'isle-empty-hint', {x_align: Clutter.ActorAlign.CENTER}));
        this._scrollContent.add_child(empty);
    }

    _renderSessionsList() {
        const items = this._watcher?.conversations ?? [];
        if (!items.length) {
            this._renderEmptyState();
            return;
        }

        for (const item of items) {
            const isRunning = item.not_fully_idle === 1 || item.status === 'CASCADE_RUN_STATUS_RUNNING';
            const rowBtn = new St.Button({
                style_class: 'isle-notification-row',
                x_expand: true,
                can_focus: true,
                style: isRunning ? 'background-color: rgba(52, 199, 89, 0.1); border-radius: 10px; margin-bottom: 4px;' : 'margin-bottom: 2px;',
            });

            const content = new St.BoxLayout({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            content.add_child(new St.Icon({
                gicon: icon(isRunning ? 'isle-antigravity' : 'isle-check-symbolic'),
                icon_size: 14,
                style: 'margin-right: 8px;',
            }));

            const textBox = new St.BoxLayout({...VERTICAL, x_expand: true});
            const t = label(item.title || 'Untitled Session', 'isle-notification-title', {style: 'font-size: 12px;'});
            t.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            textBox.add_child(t);

            const proj = projectName(item.workspace_uris);
            const time = timeAgo(item.last_modified_time);
            const sub = label([proj, time].filter(Boolean).join(' · '), 'isle-notification-body', {style: 'font-size: 10px;'});
            sub.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            textBox.add_child(sub);
            content.add_child(textBox);

            const status = label(isRunning ? 'Working' : 'Selesai', 'isle-notification-time', {
                style: isRunning ? 'color: #34c759; font-weight: bold;' : '',
            });
            content.add_child(status);

            rowBtn.child = content;
            rowBtn.connect('clicked', () => {
                this._client.cancel();
                this._clearActiveTurnBox();
                this._viewMode = 'chat';
                this._modeToggleBtn.child.gicon = icon('isle-tasks');
                this._activeConversationId = item.conversation_id;

                const ws = extractWorkspace(item.workspace_uris);
                if (ws) {
                    this._workspace = ws;
                    this._updateProjectPill();
                }

                this._messages = readConversationTranscript(item.conversation_id);
                this._activeTurnPrompt = '';
                this._activeTurnResponse = '';
                this._syncView();
                this._checkHeightChanged();
                this.later('session-scroll', 40, () => this._toEnd());
            });
            this._scrollContent.add_child(rowBtn);
        }
    }

    _watcherRunningCard(conv) {
        const card = new St.BoxLayout({...VERTICAL, style_class: 'isle-notification-row', x_expand: true});
        card.style = 'background-color: rgba(255, 255, 255, 0.06); border: 1px solid rgba(52, 199, 89, 0.4); border-radius: 12px; padding: 10px; margin-bottom: 6px;';

        const topRow = new St.BoxLayout({x_expand: true, y_align: Clutter.ActorAlign.CENTER, style: 'margin-bottom: 4px;'});
        topRow.add_child(new St.Icon({gicon: icon('isle-antigravity'), icon_size: 16, style: 'margin-right: 6px;'}));
        const tl = label(conv.title || 'Task in progress', 'isle-notification-title', {style: 'font-size: 12px; font-weight: bold;'});
        tl.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        topRow.add_child(tl);
        topRow.add_child(new St.Widget({x_expand: true}));
        const badge = pillButton('Working', 'isle-pill-small', () => {});
        badge.style = 'background-color: #34c759; color: #000000; font-weight: bold;';
        topRow.add_child(badge);
        card.add_child(topRow);

        const currentAction = conv.liveDetails?.currentAction || 'Sedang berjalan…';
        const actionRow = new St.BoxLayout({style_class: 'isle-voice-step'});
        actionRow.add_child(new St.Icon({gicon: icon('isle-bolt'), icon_size: 11, style: 'color: #34c759; margin-right: 4px;'}));
        actionRow.add_child(label(currentAction, 'isle-voice-step-text', {style: 'font-size: 11px; color: #ffffff; font-weight: 600;'}));
        card.add_child(actionRow);

        if (conv.liveDetails?.doneSteps?.length)
            card.add_child(this._stepsBox(conv.liveDetails.doneSteps));

        return card;
    }

    _onDestroy() {
        this._client.cancel();
        this._clearActiveTurnBox();
        if (this._watcher && this._watcherHandler) {
            this._watcher.disconnect(this._watcherHandler);
            this._watcherHandler = 0;
        }
    }
});
