// SPDX-License-Identifier: GPL-3.0-or-later
// Antigravity slash commands catalog, filter, and metadata

export const SLASH_COMMANDS = [
    // Built-in CLI commands
    {
        command: '/help',
        name: 'help',
        description: 'Tampilkan panduan perintah dan bantuan',
        category: 'cli',
        icon: 'isle-info-symbolic',
    },
    {
        command: '/model',
        name: 'model',
        description: 'Ganti atau jalankan model tertentu (Gemini, Claude, GPT)',
        category: 'cli',
        icon: 'isle-sparkle-symbolic',
    },
    {
        command: '/skills',
        name: 'skills',
        description: 'Daftar semua skill dan kemampuan yang terpasang',
        category: 'cli',
        icon: 'isle-gauge',
    },
    {
        command: '/agents',
        name: 'agents',
        description: 'Daftar custom agent yang tersedia',
        category: 'cli',
        icon: 'isle-antigravity',
    },
    {
        command: '/usage',
        name: 'usage',
        description: 'Lihat ringkasan penggunaan token dan kuota model',
        category: 'cli',
        icon: 'isle-gauge',
    },
    {
        command: '/effort',
        name: 'effort',
        description: 'Atur reasoning effort model (low, medium, high, max)',
        category: 'cli',
        icon: 'isle-settings',
    },

    // AI Skill / Workflow Modes
    {
        command: '/plan',
        name: 'plan',
        description: 'Rancang analisis arsitektur & rencana bertahap sebelum coding',
        category: 'skill',
        icon: 'isle-tasks',
    },
    {
        command: '/goal',
        name: 'goal',
        description: 'Jalankan tugas otonom mendalam sampai tuntas sepenuhnya',
        category: 'skill',
        icon: 'isle-bolt',
    },
    {
        command: '/browser',
        name: 'browser',
        description: 'Jalankan penelusuran web & analisis halaman secara otomatis',
        category: 'skill',
        icon: 'isle-globe',
    },
    {
        command: '/compact',
        name: 'compact',
        description: 'Ringkas histori percakapan untuk menghemat context window',
        category: 'skill',
        icon: 'isle-reset',
    },
    {
        command: '/teamwork',
        name: 'teamwork',
        description: 'Kolaborasi beberapa agent spesialis yang bekerja bersamaan',
        category: 'skill',
        icon: 'isle-antigravity-symbolic',
    },
    {
        command: '/boost',
        name: 'boost',
        description: 'Mode boost dengan deep reasoning dan verifikasi ketat',
        category: 'skill',
        icon: 'isle-sparkle-symbolic',
    },
    {
        command: '/schedule',
        name: 'schedule',
        description: 'Jadwalkan instruksi berkala (cron) atau timer satu kali',
        category: 'skill',
        icon: 'isle-timer-symbolic',
    },

    // Local UI Commands (Instant action in Isle)
    {
        command: '/clear',
        name: 'clear',
        description: 'Bersihkan tampilan pesan obrolan saat ini',
        category: 'local',
        icon: 'isle-trash',
    },
    {
        command: '/new',
        name: 'new',
        description: 'Buka pemilih workspace dan mulai sesi baru',
        category: 'local',
        icon: 'isle-plus-symbolic',
    },
];

/**
 * Filters slash commands matching a query (e.g. "/" or "/sk")
 * @param {string} query 
 * @param {number} limit 
 * @returns {Array} List of matching command objects
 */
export function filterSlashCommands(query, limit = 8) {
    if (!query || query === '/')
        return SLASH_COMMANDS.slice(0, limit);

    const q = query.startsWith('/') ? query.slice(1).toLowerCase() : query.toLowerCase();

    const exact = [];
    const starts = [];
    const contains = [];

    for (const item of SLASH_COMMANDS) {
        const name = item.name.toLowerCase();
        const desc = item.description.toLowerCase();

        if (name === q)
            exact.push(item);
        else if (name.startsWith(q))
            starts.push(item);
        else if (name.includes(q) || desc.includes(q))
            contains.push(item);

        if (exact.length + starts.length + contains.length >= limit * 2)
            break;
    }

    const merged = [...exact, ...starts, ...contains];
    const unique = [...new Set(merged)].slice(0, limit);
    return unique;
}

/**
 * Checks if the prompt is an instant local Isle command
 * @param {string} prompt 
 * @returns {string|null} The command name ('clear' or 'new') or null
 */
export function getLocalCommand(prompt) {
    const trimmed = prompt.trim().toLowerCase();
    if (trimmed === '/clear' || trimmed === '/cls')
        return 'clear';
    if (trimmed === '/new' || trimmed === '/reset')
        return 'new';
    return null;
}
