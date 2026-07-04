// File: server-api.js
// WAJIB DI-INSTALL & DIJALANKAN DI SETIAP SERVER (Xray & Sing-box)
// API Key di-generate OTOMATIS saat pertama kali install.

const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const util = require('util');

const execAsync = util.promisify(exec);
const app = express();
app.use(express.json({ limit: '10mb' }));

// ==========================================
//          KONFIGURASI SERVER
// ==========================================
const PORT = 3030;
const KEY_FILE = path.join(__dirname, '.server.key');
const TIME_WINDOW_ONLINE_IPS = 5 * 60 * 1000;

// ==========================================
//     AUTO-GENERATE UUID KEY
// ==========================================
function getOrCreateKey() {
    // 1. Coba baca dari file (persist)
    if (fs.existsSync(KEY_FILE)) {
        const key = fs.readFileSync(KEY_FILE, 'utf8').trim();
        if (key && key.length > 10) return key;
    }
    // 2. Generate baru
    const newKey = crypto.randomUUID();
    fs.writeFileSync(KEY_FILE, newKey, 'utf8');
    return newKey;
}

const API_KEY = getOrCreateKey();

// ==========================================
//     TAMPILKAN KEY DI CONSOLE (PM2 LOG)
// ==========================================
console.log('');
console.log('╔══════════════════════════════════════════════╗');
console.log('║        🔑 SERVER API KEY (BARU/LAMA)        ║');
console.log('╠══════════════════════════════════════════════╣');
console.log(`║  API_KEY = ${API_KEY}  ║`);
console.log('║                                              ║');
console.log('║  Masukkan key ini ke panel bot:              ║');
console.log('║  Server → Edit → API Key                     ║');
console.log('╚══════════════════════════════════════════════╝');
console.log('');
console.log(`✅ Management API is live on port ${PORT}`);
console.log(`✅ Listening on 127.0.0.1 only`);
console.log('');

// Middleware Keamanan
const apiKeyAuth = (req, res, next) => {
    const providedKey = req.header('X-API-Key');
    if (!providedKey || providedKey !== API_KEY) {
        return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
    }
    next();
};
app.use(apiKeyAuth);

// --- ENDPOINT INTI ---

app.get('/api/ping', (req, res) => {
    res.json({ success: true, message: 'pong' });
});

// Endpoint untuk membaca file (config)
app.get('/api/file', async (req, res) => {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'File path is required' });
    try {
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
        const content = await fsp.readFile(filePath, 'utf8');
        res.send(content);
    } catch (error) {
        res.status(500).json({ error: `Failed to read file: ${error.message}` });
    }
});

// Endpoint untuk menulis file (config)
app.post('/api/file', async (req, res) => {
    const { path: filePath, content } = req.body;
    if (!filePath || content === undefined) return res.status(400).json({ error: 'File path and content are required' });
    try {
        if (fs.existsSync(filePath)) {
            await fsp.copyFile(filePath, `${filePath}.bak.${Date.now()}`);
        }
        await fsp.writeFile(filePath, content, 'utf8');
        res.json({ success: true, message: 'File written successfully.' });
    } catch (error) {
        res.status(500).json({ error: `Failed to write file: ${error.message}` });
    }
});

// Endpoint untuk manajemen service (restart/status)
app.post('/api/service', async (req, res) => {
    const { service, action } = req.body;
    if (!service || !action) return res.status(400).json({ error: 'Service and action are required' });

    try {
        if (action === 'restart') {
            await execAsync(`sudo systemctl restart ${service}`);
            res.json({ success: true, message: `${service} restarted successfully.` });
        } else if (action === 'status') {
            await execAsync(`systemctl is-active --quiet ${service}`);
            res.json({ status: 'active' });
        } else {
            res.status(400).json({ error: 'Invalid action' });
        }
    } catch (error) {
        if (action === 'status') {
            res.json({ status: error.code === 4 ? 'not-found' : 'inactive' });
        } else {
            res.status(500).json({ error: `Failed to ${action} ${service}: ${error.message}` });
        }
    }
});

// Endpoint untuk reboot
app.post('/api/system/reboot', (req, res) => {
    res.status(202).json({ success: true, message: 'Reboot command dispatched.' });
    setTimeout(() => { exec('sudo reboot'); }, 1000);
});


// Endpoint untuk mengambil IP online
app.post('/api/monitoring/online-ips', async (req, res) => {
    const { logPath, type } = req.body;
    const userIpMap = new Map();

    if (!logPath || !fs.existsSync(logPath)) {
        return res.json({});
    }

    try {
        const logs = await fsp.readFile(logPath, 'utf8');
        const lines = logs.trim().split('\n');
        const now = Date.now();
        
        const singboxSessions = {}; 

        const xrayRegex = /(\d{4})\/(\d{2})\/(\d{2})\s(\d{2}:\d{2}:\d{2})\.\d+\s+from\s+(?:tcp:|udp:)?(\d{1,3}(?:\.\d{1,3}){3}):\d+\s+accepted.*?email:\s+(\S+)/;

        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i];
            if (!line) continue;

            if (type === 'singbox') {
                const timeSessionMatch = line.match(/(20\d{2}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2})\s+INFO\s+\[(\d+)/);
                if (!timeSessionMatch) continue;

                const logTimestamp = new Date(timeSessionMatch[1].replace(' ', 'T')).getTime();
                const sessionId = timeSessionMatch[2];

                if (now - logTimestamp > TIME_WINDOW_ONLINE_IPS) break;

                if (!singboxSessions[sessionId]) singboxSessions[sessionId] = {};

                const ipMatch = line.match(/inbound connection from\s+([\d\.]+):\d+/);
                if (ipMatch) singboxSessions[sessionId].ip = ipMatch[1];

                const userMatch = line.match(/\]:\s+\[([^\]]+)\]\s+inbound/);
                if (userMatch) singboxSessions[sessionId].user = userMatch[1];

                const s = singboxSessions[sessionId];
                if (s.ip && s.user) {
                    if (s.ip !== '127.0.0.1' && s.ip !== '::1') {
                        if (!userIpMap.has(s.user)) userIpMap.set(s.user, new Set());
                        userIpMap.get(s.user).add(s.ip);
                    }
                    delete singboxSessions[sessionId]; 
                }
            } else {
                if (line.includes('[api -> api]') || line.includes('-> api]')) continue;

                const match = line.match(xrayRegex);
                if (match) {
                    const logTimestamp = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}`).getTime();
                    const ip = match[5];
                    const user = match[6];

                    if (now - logTimestamp > TIME_WINDOW_ONLINE_IPS) break;
                    if (ip === '127.0.0.1' || ip === '::1') continue;
                    if (!userIpMap.has(user)) userIpMap.set(user, new Set());
                    userIpMap.get(user).add(ip);
                }
            }
        }

        const result = Object.fromEntries(Array.from(userIpMap.entries(), ([k, v]) => [k, Array.from(v)]));
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: `Gagal membaca IP log: ${error.message}` });
    }
});


// Endpoint eksekusi perintah (untuk statistik)
app.post('/api/exec', async (req, res) => {
    const { command } = req.body;
    if (!command) {
        return res.status(400).json({ error: '`command` is required' });
    }

    const whitelist = ['xray api statsquery', 'grpcurl'];
    
    if (!whitelist.some(prefix => command.startsWith(prefix))) {
        return res.status(403).json({ error: 'Command not allowed' });
    }

    try {
        const { stdout } = await execAsync(command);
        res.json({ success: true, stdout: stdout });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message, stderr: e.stderr });
    }
});


// =================================================================
//          INISIALISASI SERVER API
// =================================================================
app.listen(PORT, '127.0.0.1', () => {
    // Message sudah di-print di atas
});
