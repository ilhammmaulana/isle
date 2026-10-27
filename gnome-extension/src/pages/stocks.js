// SPDX-License-Identifier: GPL-3.0-or-later
// StocksPage: On-demand stock monitoring page using scanner.tradingview.com

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {VERTICAL, onUiScale, px, uiScale} from '../compat.js';
import * as Format from '../format.js';
import {icon, iconButton, label} from '../widgets.js';
import {Page} from './page.js';
import {StocksClient} from '../stocksClient.js';

function formatPrice(price, currency = 'IDR') {
    if (typeof price !== 'number' || isNaN(price))
        return '0';
    if (currency === 'IDR')
        return `Rp ${Math.round(price).toLocaleString('id-ID')}`;
    if (currency === 'USD')
        return `$ ${price.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    return `${price.toLocaleString()} ${currency}`;
}

function formatDelta(points, percent, currency = 'IDR') {
    if (typeof percent !== 'number' || isNaN(percent))
        return {text: '0 (0.00%)', kind: 'flat'};

    const pointsSign = points > 0 ? '+' : '';
    let pointsStr = '';
    if (currency === 'IDR')
        pointsStr = `${pointsSign}${Math.round(points).toLocaleString('id-ID')}`;
    else
        pointsStr = `${pointsSign}${points.toFixed(2)}`;

    const percentSign = percent > 0 ? '+' : '';
    const percentStr = `${percentSign}${percent.toFixed(2)}%`;

    if (percent > 0)
        return {text: `▲ ${pointsStr} (${percentStr})`, kind: 'up'};
    if (percent < 0)
        return {text: `▼ ${pointsStr} (${percentStr})`, kind: 'down'};
    return {text: `0 (0.00%)`, kind: 'flat'};
}

export const StocksPage = GObject.registerClass(
class StocksPage extends Page {
    _init(daemon, {height: _height}) {
        const monitor = Main.layoutManager?.primaryMonitor;
        const screenHeight = monitor ? monitor.height : 1080;
        const antigravityHeight = Math.floor(screenHeight / 3);

        super._init(daemon, {
            style_class: 'isle-page isle-stocks',
            layout_manager: new Clutter.BinLayout(),
            height: antigravityHeight,
            reactive: true,
        });

        this.name = 'stocks';
        this._client = new StocksClient();
        this._rowActors = new Map(); // symbol -> { row, logoBox, stock }

        const column = new St.BoxLayout({...VERTICAL, style_class: 'isle-stocks-box', x_expand: true, y_expand: true});

        // 1. Header
        column.add_child(this._buildHeader());

        // 2. Add Stock Box (Hidden by default)
        this._addBox = this._buildAddBox();
        column.add_child(this._addBox);

        // 3. Scrollable List of Stocks
        this._list = new St.BoxLayout({...VERTICAL, style_class: 'isle-stocks-list'});
        this._scroll = new St.ScrollView({
            style_class: 'isle-stocks-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            x_expand: true,
            y_expand: true,
        });
        this._scroll.set_child(this._list);

        this._emptyLabel = label('Belum ada saham yang dipantau.\nKlik + untuk menambahkan.', 'isle-stocks-empty', {
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        this._emptyLabel.clutter_text.line_wrap = true;
        this._emptyLabel.clutter_text.text_align = Pango.Alignment.CENTER;

        const contentStack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        contentStack.add_child(this._scroll);
        contentStack.add_child(this._emptyLabel);
        column.add_child(contentStack);

        this.add_child(column);

        // Wire client signals
        this._client.connect('updated', () => this._renderStocks());
        this._client.connect('loading-changed', (_c, loading) => this._onLoadingChanged(loading));
        this._client.connect('logo-downloaded', (_c, logoId, filePath) => this._onLogoDownloaded(logoId, filePath));

        // Initial render with saved stocks
        this._renderStocks();
    }

    _buildHeader() {
        const header = new St.BoxLayout({style_class: 'isle-stocks-header', y_align: Clutter.ActorAlign.CENTER});

        const titleBox = new St.BoxLayout({style_class: 'isle-stocks-title-box', y_align: Clutter.ActorAlign.CENTER});
        titleBox.add_child(label('Saham', 'isle-stocks-title'));

        this._lastUpdatedLabel = label('-', 'isle-stocks-last-updated');
        titleBox.add_child(this._lastUpdatedLabel);
        header.add_child(titleBox);

        const spacer = new St.Widget({x_expand: true});
        header.add_child(spacer);

        const actions = new St.BoxLayout({style_class: 'isle-stocks-actions', y_align: Clutter.ActorAlign.CENTER});

        this._refreshBtn = iconButton('isle-reset', 'isle-button-flat isle-stocks-action-btn', () => {
            this._client.refresh();
        }, {size: 13, accessibleName: 'Perbarui Data'});

        this._addBtn = iconButton('isle-plus-symbolic', 'isle-button-flat isle-stocks-action-btn', () => {
            this._toggleAddBox();
        }, {size: 12, accessibleName: 'Tambah Saham'});

        actions.add_child(this._refreshBtn);
        actions.add_child(this._addBtn);
        header.add_child(actions);

        return header;
    }

    _buildAddBox() {
        const box = new St.BoxLayout({...VERTICAL, style_class: 'isle-stocks-add-box', visible: false});

        const inputRow = new St.BoxLayout({style_class: 'isle-stocks-add-row', y_align: Clutter.ActorAlign.CENTER});

        this._entry = new St.Entry({
            style_class: 'isle-stocks-entry',
            hint_text: 'Ticker (cth: BBCA, ASII, AAPL, NVDA)',
            can_focus: true,
            x_expand: true,
        });

        const entryText = this._entry.clutter_text;
        entryText.connect('activate', () => this._submitAdd());
        entryText.connect('button-press-event', () => {
            this.emit('request-keyboard', true);
            return Clutter.EVENT_PROPAGATE;
        });
        entryText.connect('key-press-event', (_text, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this._toggleAddBox(false);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        inputRow.add_child(this._entry);

        const submitBtn = new St.Button({
            label: 'Tambah',
            style_class: 'isle-stocks-submit-btn',
            can_focus: true,
        });
        submitBtn.connect('clicked', () => this._submitAdd());
        inputRow.add_child(submitBtn);

        const cancelBtn = iconButton('isle-close-symbolic', 'isle-button-flat isle-stocks-cancel-btn', () => {
            this._toggleAddBox(false);
        }, {size: 11, accessibleName: 'Batal'});
        inputRow.add_child(cancelBtn);

        box.add_child(inputRow);

        this._statusLabel = label('', 'isle-stocks-status', {visible: false});
        box.add_child(this._statusLabel);

        return box;
    }

    _toggleAddBox(open) {
        const show = open ?? !this._addBox.visible;
        this._addBox.visible = show;
        this._statusLabel.visible = false;
        if (show) {
            this.emit('request-keyboard', true);
            this._entry.text = '';
            this._entry.grab_key_focus();
        } else {
            this.emit('request-keyboard', false);
        }
    }

    async _submitAdd() {
        const ticker = this._entry.text.trim();
        if (!ticker)
            return;

        this._statusLabel.text = `Mencari ${ticker.toUpperCase()} di TradingView...`;
        this._statusLabel.style_class = 'isle-stocks-status loading';
        this._statusLabel.visible = true;

        const result = await this._client.addTicker(ticker);
        if (result.success) {
            this._statusLabel.text = `Berhasil menambahkan ${result.symbol}`;
            this._statusLabel.style_class = 'isle-stocks-status success';
            this.later('hide-add-box', 700, () => {
                this._toggleAddBox(false);
            });
        } else {
            this._statusLabel.text = result.error || 'Gagal menambahkan saham';
            this._statusLabel.style_class = 'isle-stocks-status error';
        }
    }

    _onLoadingChanged(loading) {
        if (loading) {
            this._refreshBtn.ease({opacity: 120, duration: 150});
        } else {
            this._refreshBtn.ease({opacity: 255, duration: 150});
        }
    }

    _renderStocks() {
        this._list.destroy_all_children();
        this._rowActors.clear();

        const stocks = this._client.stocks;
        const watchlist = this._client.watchlist;

        if (this._client.lastUpdated) {
            const timeStr = this._client.lastUpdated.format('%H:%M:%S');
            this._lastUpdatedLabel.text = `· ${timeStr}`;
        } else {
            this._lastUpdatedLabel.text = '';
        }

        if (watchlist.length === 0) {
            this._emptyLabel.visible = true;
            this._scroll.visible = false;
            return;
        }

        this._emptyLabel.visible = false;
        this._scroll.visible = true;

        // If stocks data hasn't arrived yet, show placeholders for watchlist items
        const items = stocks.length > 0 ? stocks : watchlist.map(sym => ({
            symbol: sym,
            name: sym.includes(':') ? sym.split(':')[1] : sym,
            description: 'Memuat...',
            close: 0,
            changePercent: 0,
            changePoints: 0,
            currency: 'IDR',
            logoId: '',
            logoPath: null,
        }));

        for (const stock of items) {
            const row = this._buildStockRow(stock);
            this._list.add_child(row);
        }
    }

    _buildStockRow(stock) {
        const row = new St.BoxLayout({
            style_class: 'isle-stock-row',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });

        // 1. Logo Container (24x24 px)
        const logoBox = new St.Widget({
            style_class: 'isle-stock-logo-box',
            layout_manager: new Clutter.BinLayout(),
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._populateLogo(logoBox, stock);
        row.add_child(logoBox);

        // 2. Info Box (Symbol + Description)
        const info = new St.BoxLayout({...VERTICAL, style_class: 'isle-stock-info', x_expand: true});
        const nameRow = new St.BoxLayout({style_class: 'isle-stock-name-row'});

        const tickerLabel = label(stock.name, 'isle-stock-ticker');
        nameRow.add_child(tickerLabel);

        if (stock.symbol.includes(':')) {
            const exchange = stock.symbol.split(':')[0];
            nameRow.add_child(label(exchange, 'isle-stock-exchange'));
        }
        info.add_child(nameRow);

        const descLabel = label(stock.description || stock.symbol, 'isle-stock-desc');
        descLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        info.add_child(descLabel);

        row.add_child(info);

        // 3. Price & Delta Badge Box
        const pricing = new St.BoxLayout({...VERTICAL, style_class: 'isle-stock-pricing', x_align: Clutter.ActorAlign.END});

        const priceLabel = label(formatPrice(stock.close, stock.currency), 'isle-stock-price');
        pricing.add_child(priceLabel);

        const delta = formatDelta(stock.changePoints, stock.changePercent, stock.currency);
        const deltaBadge = label(delta.text, `isle-stock-delta ${delta.kind}`);
        pricing.add_child(deltaBadge);

        row.add_child(pricing);

        // 4. Delete / Remove Button
        const removeBtn = iconButton('isle-trash', 'isle-button-flat isle-stock-remove', () => {
            this._client.removeTicker(stock.symbol);
        }, {size: 11, accessibleName: `Hapus ${stock.name}`});
        row.add_child(removeBtn);

        this._rowActors.set(stock.symbol, {row, logoBox, stock});
        return row;
    }

    _populateLogo(logoBox, stock) {
        logoBox.destroy_all_children();

        if (stock.logoPath && GLib.file_test(stock.logoPath, GLib.FileTest.EXISTS)) {
            const file = Gio.File.new_for_path(stock.logoPath);
            const gicon = Gio.FileIcon.new(file);
            const iconActor = new St.Icon({gicon, icon_size: 20});
            logoBox.add_child(iconActor);
        } else {
            // Stylized initial letters fallback
            const cleanName = (stock.name || '').replace(/[^a-zA-Z0-9]/g, '');
            const initials = cleanName.slice(0, 3).toUpperCase() || 'STK';
            const initialsLabel = label(initials, 'isle-stock-initials', {
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            logoBox.add_child(initialsLabel);
        }
    }

    _onLogoDownloaded(logoId, filePath) {
        for (const [, item] of this._rowActors) {
            if (item.stock.logoId === logoId) {
                item.stock.logoPath = filePath;
                this._populateLogo(item.logoBox, item.stock);
            }
        }
    }

    /** Matches Antigravity's expanded height: 1/3 of the primary monitor height */
    get preferredHeight() {
        const monitor = Main.layoutManager?.primaryMonitor;
        const screenHeight = monitor ? monitor.height : 1080;
        return Math.floor(screenHeight / 3);
    }

    /**
     * Called when user switches to Stocks tab.
     * Strictly on-demand: fetches only if not yet loaded.
     */
    onActivate() {
        this.emit('height-changed');
        if (!this._client.lastUpdated) {
            this._client.refresh();
        }
    }

    onDeactivate() {
        this._toggleAddBox(false);
    }
});
