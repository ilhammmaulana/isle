// SPDX-License-Identifier: GPL-3.0-or-later
// Antigravity Markdown & Code Block Renderer for GNOME Shell Clutter/St

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {icon, iconButton, label} from './widgets.js';

const VERTICAL = {vertical: true};

/**
 * Converts inline markdown into valid Pango markup.
 * Escapes characters safely before applying span tags.
 * @param {string} text 
 * @returns {string} Pango markup string
 */
export function inlineMarkup(text) {
    if (!text)
        return '';

    // Split by inline code spans first so code contents are never modified by bold/italic rules
    const parts = text.split(/(`[^`]+`)/);
    const formatted = parts.map((part, index) => {
        if (index % 2 === 1) {
            // Inline code span
            const codeRaw = part.slice(1, -1);
            const escaped = GLib.markup_escape_text(codeRaw, -1);
            return `<span font_family="monospace" background="#ffffff" bgalpha="14%" font_weight="500"> ${escaped} </span>`;
        }

        // Regular text
        let str = GLib.markup_escape_text(part, -1);

        // Mentions: @path/to/file or @symbol
        str = str.replace(/@([a-zA-Z0-9_\-\.\/]+)/g, '<span foreground="#64d2ff" weight="bold">@$1</span>');

        // Bold: **text** or __text__
        str = str.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
        str = str.replace(/__([^_]+)__/g, '<b>$1</b>');

        // Italic: *text* or _text_
        str = str.replace(/\*([^*]+)\*/g, '<i>$1</i>');
        str = str.replace(/_([^_]+)_/g, '<i>$1</i>');

        // Strikethrough: ~~text~~
        str = str.replace(/~~([^~]+)~~/g, '<s>$1</s>');

        // Links: [text](url) -> underlined text in macOS/iOS blue
        str = str.replace(/\[([^\]\n]+)\]\((?:https?:\/\/|www\.)[^)\s]+\)/g, '<span foreground="#0a84ff" underline="single">$1</span>');

        return str;
    }).join('');

    return formatted;
}

/**
 * Creates an interactive fenced Code Block widget
 * with language header and 1-click Copy button
 * @param {string} codeRaw 
 * @param {string} language 
 * @returns {St.Widget}
 */
export function createCodeBlock(codeRaw, language = '') {
    const box = new St.BoxLayout({
        ...VERTICAL,
        x_expand: true,
        style: 'background-color: rgba(14, 14, 20, 0.96); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 9px; margin: 6px 0; box-shadow: 0 2px 8px rgba(0,0,0,0.4);',
    });

    const langName = (language || 'code').toUpperCase();

    // Top Header Bar
    const header = new St.BoxLayout({
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
        style: 'background-color: rgba(255, 255, 255, 0.04); border-bottom: 1px solid rgba(255, 255, 255, 0.06); padding: 3px 6px 3px 10px; border-radius: 9px 9px 0 0;',
    });

    const langLabel = label(langName, '', {
        y_align: Clutter.ActorAlign.CENTER,
        style: 'font-family: monospace; font-size: 10px; font-weight: bold; color: rgba(255, 255, 255, 0.5); letter-spacing: 0.5px;',
    });
    header.add_child(langLabel);

    header.add_child(new St.Widget({x_expand: true}));

    // Copy Button
    let copyTimer = 0;
    const copyBtn = iconButton('isle-clipboard', 'isle-button-flat', () => {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, codeRaw);
        copyBtn.child.gicon = icon('isle-check-symbolic');
        copyBtn.style = 'color: #34c759;';
        if (copyTimer)
            GLib.source_remove(copyTimer);
        copyTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1600, () => {
            copyBtn.child.gicon = icon('isle-clipboard');
            copyBtn.style = '';
            copyTimer = 0;
            return GLib.SOURCE_REMOVE;
        });
    }, {size: 12, accessibleName: 'Salin Kode'});
    copyBtn.y_align = Clutter.ActorAlign.CENTER;
    header.add_child(copyBtn);

    box.add_child(header);

    // Code Content
    const codeEscaped = GLib.markup_escape_text(codeRaw, -1);
    const codeLabel = new St.Label({
        style: 'font-family: monospace; font-size: 11px; line-height: 1.4; color: #f2f2f7; padding: 8px 10px;',
        x_expand: true,
    });
    codeLabel.clutter_text.set({
        use_markup: true,
        line_wrap: true,
        line_wrap_mode: Pango.WrapMode.WORD_CHAR,
        selectable: true,
        reactive: true,
    });
    codeLabel.clutter_text.set_markup(codeEscaped);
    box.add_child(codeLabel);

    return box;
}

/**
 * Tokenizes markdown string and renders full block-based widgets
 * @param {string} markdown 
 * @returns {St.Widget[]} List of Clutter/St block actors
 */
export function parseMarkdownToActors(markdown) {
    if (!markdown)
        return [];

    const actors = [];
    const lines = markdown.split('\n');
    let inCode = false;
    let codeLang = '';
    let codeLines = [];
    let textBuffer = [];
    let quoteLines = [];

    const flushText = () => {
        if (textBuffer.length === 0)
            return;
        const text = textBuffer.join('\n').trim();
        textBuffer = [];
        if (!text)
            return;

        const markup = inlineMarkup(text);
        const l = new St.Label({
            x_expand: true,
            style: 'color: rgba(255, 255, 255, 0.95); font-size: 12px; margin-bottom: 4px;',
        });
        l.clutter_text.set({
            use_markup: true,
            line_wrap: true,
            line_wrap_mode: Pango.WrapMode.WORD_CHAR,
            selectable: true,
            reactive: true,
        });
        try {
            l.clutter_text.set_markup(markup);
        } catch (_) {
            l.clutter_text.set_text(text);
        }
        actors.push(l);
    };

    const flushQuote = () => {
        if (quoteLines.length === 0)
            return;
        const rawQuote = quoteLines.join('\n').trim();
        quoteLines = [];
        if (!rawQuote)
            return;

        const quoteBox = new St.BoxLayout({
            ...VERTICAL,
            x_expand: true,
            style: 'border-left: 3px solid rgba(0, 122, 255, 0.7); background-color: rgba(255, 255, 255, 0.04); border-radius: 0 6px 6px 0; padding: 4px 8px; margin: 4px 0 6px 0;',
        });
        const qMarkup = inlineMarkup(rawQuote);
        const qLabel = new St.Label({
            x_expand: true,
            style: 'color: rgba(255, 255, 255, 0.85); font-size: 11.5px; font-style: italic;',
        });
        qLabel.clutter_text.set({
            use_markup: true,
            line_wrap: true,
            line_wrap_mode: Pango.WrapMode.WORD_CHAR,
            selectable: true,
            reactive: true,
        });
        try {
            qLabel.clutter_text.set_markup(qMarkup);
        } catch (_) {
            qLabel.clutter_text.set_text(rawQuote);
        }
        quoteBox.add_child(qLabel);
        actors.push(quoteBox);
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Check fenced code block boundary (``` or ~~~)
        const codeFence = line.match(/^```([a-zA-Z0-9_\-\+]*)\s*$/);
        if (codeFence && !inCode) {
            flushText();
            flushQuote();
            inCode = true;
            codeLang = codeFence[1] || '';
            codeLines = [];
            continue;
        } else if (inCode && line.startsWith('```')) {
            inCode = false;
            actors.push(createCodeBlock(codeLines.join('\n'), codeLang));
            codeLines = [];
            codeLang = '';
            continue;
        }

        if (inCode) {
            codeLines.push(line);
            continue;
        }

        // Blockquotes
        if (line.startsWith('>')) {
            flushText();
            quoteLines.push(line.replace(/^>\s?/, ''));
            continue;
        } else if (quoteLines.length > 0) {
            flushQuote();
        }

        // Headings (# H1, ## H2, ### H3)
        const hMatch = line.match(/^(#{1,3})\s+(.+)$/);
        if (hMatch) {
            flushText();
            const level = hMatch[1].length;
            const hText = hMatch[2];
            const hMarkup = inlineMarkup(hText);

            let style = 'color: #ffffff; font-weight: bold; margin-top: 6px; margin-bottom: 2px;';
            if (level === 1)
                style += ' font-size: 14px;';
            else if (level === 2)
                style += ' font-size: 13px; font-weight: 600; color: #f2f2f7;';
            else
                style += ' font-size: 12px; font-weight: 600; color: #e5e5ea;';

            const hLabel = new St.Label({x_expand: true, style});
            hLabel.clutter_text.set({use_markup: true, selectable: true, reactive: true});
            try {
                hLabel.clutter_text.set_markup(hMarkup);
            } catch (_) {
                hLabel.clutter_text.set_text(hText);
            }
            actors.push(hLabel);
            continue;
        }

        // Lists (- item or 1. item)
        const listMatch = line.match(/^\s*([-*•]|\d+\.)\s+(.+)$/);
        if (listMatch) {
            flushText();
            const bullet = listMatch[1].includes('.') ? listMatch[1] : '•';
            const bodyMarkup = inlineMarkup(listMatch[2]);
            const itemBox = new St.BoxLayout({x_expand: true, style: 'margin-left: 6px; margin-bottom: 2px;'});
            const bLabel = label(bullet, '', {style: 'color: rgba(255, 255, 255, 0.5); font-size: 11px; margin-right: 6px; font-weight: bold;'});
            const tLabel = new St.Label({x_expand: true, style: 'color: rgba(255, 255, 255, 0.95); font-size: 12px;'});
            tLabel.clutter_text.set({
                use_markup: true,
                line_wrap: true,
                line_wrap_mode: Pango.WrapMode.WORD_CHAR,
                selectable: true,
                reactive: true,
            });
            try {
                tLabel.clutter_text.set_markup(bodyMarkup);
            } catch (_) {
                tLabel.clutter_text.set_text(listMatch[2]);
            }
            itemBox.add_child(bLabel);
            itemBox.add_child(tLabel);
            actors.push(itemBox);
            continue;
        }

        // Normal paragraph text line
        textBuffer.push(line);
    }

    // Flush any pending trailing lines
    flushText();
    flushQuote();
    if (inCode && codeLines.length > 0) {
        // Unclosed code block during active stream
        actors.push(createCodeBlock(codeLines.join('\n'), codeLang));
    }

    return actors;
}

/**
 * Creates a complete assistant message bubble containing rendered blocks
 * @param {string} markdown 
 * @returns {St.Widget}
 */
export function createAssistantCard(markdown) {
    const row = new St.BoxLayout({
        x_align: Clutter.ActorAlign.START,
        x_expand: true,
        style: 'margin-bottom: 8px;',
    });

    const card = new St.BoxLayout({
        ...VERTICAL,
        x_expand: true,
        style: 'background-color: rgba(255, 255, 255, 0.08); border-radius: 12px; padding: 10px 14px; max-width: 520px;',
    });

    const blocks = parseMarkdownToActors(markdown);
    for (const block of blocks)
        card.add_child(block);

    row.add_child(card);
    return row;
}
