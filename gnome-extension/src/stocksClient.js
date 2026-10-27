// SPDX-License-Identifier: GPL-3.0-or-later
// StocksClient: On-demand stock tracker using TradingView's Global Scanner API

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

const SCANNER_URL = 'https://scanner.tradingview.com/global/scan';
const LOGO_BASE_URL = 'https://s3-symbol-logo.tradingview.com/';
const DEFAULT_SYMBOLS = ['IDX:BBCA', 'IDX:BBRI', 'IDX:TLKM', 'NASDAQ:AAPL', 'NASDAQ:NVDA'];

export class StocksClient extends Signals.EventEmitter {
    constructor() {
        super();
        this._session = new Soup.Session();
        this._session.user_agent = 'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0';

        this._configDir = GLib.build_filenamev([GLib.get_user_config_dir(), 'isle']);
        this._configFile = GLib.build_filenamev([this._configDir, 'stocks.json']);
        this._cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'isle', 'logos']);

        this._ensureDirectories();

        this._watchlist = this._loadWatchlist();
        this._stocks = [];
        this._lastUpdated = null;
        this._loading = false;
        this._downloadingLogos = new Set();
    }

    get watchlist() {
        return [...this._watchlist];
    }

    get stocks() {
        return [...this._stocks];
    }

    get lastUpdated() {
        return this._lastUpdated;
    }

    get isLoading() {
        return this._loading;
    }

    _ensureDirectories() {
        try {
            GLib.mkdir_with_parents(this._configDir, 0o755);
            GLib.mkdir_with_parents(this._cacheDir, 0o755);
        } catch (e) {
            logError(e, 'Failed to create config/cache directory for stocks');
        }
    }

    _loadWatchlist() {
        const file = Gio.File.new_for_path(this._configFile);
        if (file.query_exists(null)) {
            try {
                const [, contents] = file.load_contents(null);
                const parsed = JSON.parse(new TextDecoder().decode(contents));
                if (Array.isArray(parsed) && parsed.length > 0)
                    return parsed;
            } catch (e) {
                logError(e, 'Error reading stocks.json, using defaults');
            }
        }
        this._saveWatchlist(DEFAULT_SYMBOLS);
        return [...DEFAULT_SYMBOLS];
    }

    _saveWatchlist(symbols) {
        try {
            const file = Gio.File.new_for_path(this._configFile);
            const data = new TextEncoder().encode(JSON.stringify(symbols, null, 2));
            file.replace_contents(data, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            logError(e, 'Error saving stocks.json');
        }
    }

    /** Path to cached SVG logo if it exists on disk. */
    getLogoPath(logoId) {
        if (!logoId)
            return null;
        const filePath = GLib.build_filenamev([this._cacheDir, `${logoId}.svg`]);
        if (GLib.file_test(filePath, GLib.FileTest.EXISTS))
            return filePath;

        this._downloadLogoAsync(logoId, filePath);
        return null;
    }

    _downloadLogoAsync(logoId, destinationPath) {
        if (this._downloadingLogos.has(logoId))
            return;
        this._downloadingLogos.add(logoId);

        const url = `${LOGO_BASE_URL}${logoId}--big.svg`;
        const uri = GLib.Uri.parse(url, GLib.UriFlags.NONE);
        const message = new Soup.Message({method: 'GET', uri});

        this._session.send_and_read_async(message, GLib.PRIORITY_LOW, null, (sess, res) => {
            this._downloadingLogos.delete(logoId);
            try {
                const bytes = sess.send_and_read_finish(res);
                if (message.get_status() === Soup.Status.OK && bytes) {
                    const file = Gio.File.new_for_path(destinationPath);
                    file.replace_contents(bytes.get_data(), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                    this.emit('logo-downloaded', logoId, destinationPath);
                }
            } catch (e) {
                // Ignore download errors quietly; fallback initials will be displayed
            }
        });
    }

    /**
     * Strictly on-demand refresh for current watchlist.
     * No background timer is run.
     */
    async refresh() {
        if (this._loading || this._watchlist.length === 0)
            return this._stocks;

        this._loading = true;
        this.emit('loading-changed', true);

        return new Promise(resolve => {
            const uri = GLib.Uri.parse(SCANNER_URL, GLib.UriFlags.NONE);
            const message = new Soup.Message({method: 'POST', uri});

            const payload = JSON.stringify({
                symbols: {tickers: this._watchlist},
                columns: ['name', 'description', 'close', 'change', 'change_abs', 'currency', 'logoid'],
            });

            message.set_request_body_from_bytes(
                'application/json',
                new GLib.Bytes(new TextEncoder().encode(payload))
            );

            this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (sess, res) => {
                this._loading = false;
                this.emit('loading-changed', false);

                try {
                    const bytes = sess.send_and_read_finish(res);
                    const text = new TextDecoder().decode(bytes.get_data());
                    const parsed = JSON.parse(text);

                    if (parsed && Array.isArray(parsed.data)) {
                        const lookup = new Map();
                        for (const item of parsed.data) {
                            const [name, description, close, changePercent, changePoints, currency, logoId] = item.d;
                            lookup.set(item.s, {
                                symbol: item.s,
                                name: name || item.s,
                                description: description || '',
                                close: typeof close === 'number' ? close : 0,
                                changePercent: typeof changePercent === 'number' ? changePercent : 0,
                                changePoints: typeof changePoints === 'number' ? changePoints : 0,
                                currency: currency || 'IDR',
                                logoId: logoId || '',
                                logoPath: this.getLogoPath(logoId),
                            });
                        }

                        // Preserve watchlist order
                        this._stocks = this._watchlist
                            .map(sym => lookup.get(sym))
                            .filter(Boolean);

                        this._lastUpdated = GLib.DateTime.new_now_local();
                        this.emit('updated', this._stocks);
                        resolve(this._stocks);
                        return;
                    }
                } catch (e) {
                    logError(e, 'Failed to parse TradingView stock data');
                    this.emit('error', 'Gagal memuat data saham');
                }
                resolve(this._stocks);
            });
        });
    }

    /**
     * Resolves and adds a ticker symbol to the watchlist.
     * Supports smart exchange prefix resolution (e.g. "BBCA" -> "IDX:BBCA").
     */
    async addTicker(input) {
        const clean = (input || '').trim().toUpperCase();
        if (!clean)
            return {success: false, error: 'Ticker tidak boleh kosong'};

        // Check if already in watchlist
        if (this._watchlist.includes(clean))
            return {success: false, error: `${clean} sudah ada dalam pantauan`};

        // Determine candidate ticker strings
        let candidates = [];
        if (clean.includes(':')) {
            candidates = [clean];
        } else {
            // Priority: IDX (Indonesian stock) first, then NASDAQ, NYSE, AMEX
            candidates = [
                `IDX:${clean}`,
                `NASDAQ:${clean}`,
                `NYSE:${clean}`,
                `AMEX:${clean}`,
                `BINANCE:${clean}USDT`,
                clean,
            ];
        }

        return new Promise(resolve => {
            const uri = GLib.Uri.parse(SCANNER_URL, GLib.UriFlags.NONE);
            const message = new Soup.Message({method: 'POST', uri});

            const payload = JSON.stringify({
                symbols: {tickers: candidates},
                columns: ['name', 'description'],
            });

            message.set_request_body_from_bytes(
                'application/json',
                new GLib.Bytes(new TextEncoder().encode(payload))
            );

            this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (sess, res) => {
                try {
                    const bytes = sess.send_and_read_finish(res);
                    const parsed = JSON.parse(new TextDecoder().decode(bytes.get_data()));

                    if (parsed && Array.isArray(parsed.data) && parsed.data.length > 0) {
                        // Find first matching candidate in priority order
                        let matchedSymbol = null;
                        for (const cand of candidates) {
                            if (parsed.data.some(d => d.s === cand)) {
                                matchedSymbol = cand;
                                break;
                            }
                        }
                        if (!matchedSymbol)
                            matchedSymbol = parsed.data[0].s;

                        if (this._watchlist.includes(matchedSymbol)) {
                            resolve({success: false, error: `${matchedSymbol} sudah ada dalam pantauan`});
                            return;
                        }

                        this._watchlist.push(matchedSymbol);
                        this._saveWatchlist(this._watchlist);
                        this.refresh();
                        resolve({success: true, symbol: matchedSymbol});
                        return;
                    }
                } catch (e) {
                    logError(e, 'Failed to resolve ticker symbol');
                }
                resolve({success: false, error: `Ticker "${clean}" tidak ditemukan di TradingView`});
            });
        });
    }

    /**
     * Removes a symbol from watchlist.
     */
    removeTicker(symbol) {
        const index = this._watchlist.indexOf(symbol);
        if (index === -1)
            return false;

        this._watchlist.splice(index, 1);
        this._saveWatchlist(this._watchlist);
        this._stocks = this._stocks.filter(s => s.symbol !== symbol);
        this.emit('updated', this._stocks);
        return true;
    }
}
