const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const util = require('util');
const TelegramBot = require('node-telegram-bot-api');
const qrcode = require('qrcode');
const archiver = require('archiver');
const execAsync = util.promisify(exec);

// ==========================================
// KONFIGURASI UTAMA (ADMIN VERSION)
// ==========================================
const CONFIG = {
  CONFIG_PATH: '/usr/local/etc/xray/config.json',
  BACKUP_DIR: '/usr/local/etc/xray/backups/',
  DOMAIN_PATH: '/usr/local/etc/xray/domain',
  BOT_TOKEN: process.env.BOT_TOKEN || '7658769893:AAHlmyjDGdr8w6p8lKnP_OfeedDoPMAYSfQ',
  ADMINS_FILE: '/usr/local/etc/xray/admin.txt',
  CONFIGS_DIR: '/var/www/html/configs/',
  EXPIRY_FILE: (agentId) => `/usr/local/etc/xray/expiry_data_${agentId}.json.j2`,
  AGENTS_FILE: '/usr/local/etc/xray/agen.txt',
  MAX_USERS: 2000,
  LOG_FILE: '/var/log/xray-admin.log',
  AUTO_BACKUP_TIME: '00:00',
  ITEMS_PER_PAGE: 10,
  AGENT_PREFIX: 'agent_'
};

const bot = new TelegramBot(CONFIG.BOT_TOKEN, { polling: true });
let userState = {};

// ==========================================
// FUNGSI UTILITAS (ADMIN-SPECIFIC)
// ==========================================
async function logAction(action, details = {}) {
  const timestamp = new Date().toISOString();
  const logEntry = JSON.stringify({
    timestamp,
    action,
    ...details
  }) + '\n';
  
  try {
    await fsp.appendFile(CONFIG.LOG_FILE, logEntry);
  } catch (err) {
    console.error('Gagal menulis log:', err);
  }
}

async function loadAdmins() {
  try {
    const data = await fsp.readFile(CONFIG.ADMINS_FILE, 'utf8');
    return data.split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'));
  } catch (err) {
    await fsp.writeFile(CONFIG.ADMINS_FILE, '');
    return [];
  }
}

async function saveAdmins(admins) {
  const uniqueAdmins = [...new Set(admins)];
  await fsp.writeFile(CONFIG.ADMINS_FILE, uniqueAdmins.join('\n'));
}

async function isAdmin(userId) {
  const admins = await loadAdmins();
  return admins.includes(userId.toString());
}

async function isAgent(userId) {
  const agents = await loadAgents();
  return agents.includes(userId.toString());
}

async function readConfig() {
  try {
    const data = await fsp.readFile(CONFIG.CONFIG_PATH, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    await logAction('CONFIG_READ_ERROR', { error: err.message });
    throw new Error('Gagal membaca konfigurasi');
  }
}

async function createBackup() {
  try {
    await fsp.mkdir(CONFIG.BACKUP_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(CONFIG.BACKUP_DIR, `config-${timestamp}.json`);
    await fsp.copyFile(CONFIG.CONFIG_PATH, backupPath);
    await logAction('CONFIG_BACKUP', { backupPath });
    return backupPath;
  } catch (err) {
    await logAction('BACKUP_FAILED', { error: err.message });
    throw err;
  }
}

async function saveConfig(config) {
  try {
    await createBackup();
    await fsp.writeFile(CONFIG.CONFIG_PATH, JSON.stringify(config, null, 2));
    await logAction('CONFIG_SAVED');
  } catch (err) {
    await logAction('CONFIG_SAVE_ERROR', { error: err.message });
    throw new Error('Gagal menyimpan konfigurasi');
  }
}

async function getDomain() {
  try {
    const domain = await fsp.readFile(CONFIG.DOMAIN_PATH, 'utf8');
    return domain.trim();
  } catch (err) {
    await logAction('DOMAIN_READ_ERROR', { error: err.message });
    throw new Error('Gagal membaca domain');
  }
}

function generateUUID() {
  return crypto.randomUUID();
}

function generatePassword(length = 16) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

async function restartXray() {
  try {
    await execAsync('systemctl restart xray');
    await logAction('SERVICE_RESTART');
  } catch (err) {
    await logAction('RESTART_FAILED', { error: err.message });
    throw new Error('Gagal restart layanan');
  }
}

async function generateQR(text, filename) {
  try {
    await qrcode.toFile(filename, text);
    return true;
  } catch (err) {
    await logAction('QR_GENERATION_FAILED', { error: err.message });
    return false;
  }
}

// ==========================================
// MANAJEMEN EXPIRY (ADMIN-SPECIFIC)
// ==========================================
async function getAllExpiryData() {
  try {
    const files = await fsp.readdir('/usr/local/etc/xray/');
    const expiryFiles = files.filter(f => f.startsWith('expiry_data_') && f.endsWith('.json.j2'));
    const allData = {};

    for (const file of expiryFiles) {
      const agentId = file.replace('expiry_data_', '').replace('.json.j2', '');
      const data = await fsp.readFile(path.join('/usr/local/etc/xray/', file), 'utf8');
      allData[agentId] = JSON.parse(data);
    }

    return allData;
  } catch (err) {
    await logAction('EXPIRY_READ_ALL_ERROR', { error: err.message });
    return {};
  }
}

async function saveExpiryData(username, expiry, agentId = 'admin') {
  const expiryFile = CONFIG.EXPIRY_FILE(agentId);
  let expiryData = {};
  
  try {
    const data = await fsp.readFile(expiryFile, 'utf8');
    expiryData = JSON.parse(data);
  } catch (err) {
    expiryData = {};
  }
  
  expiryData[username] = expiry;
  await fsp.writeFile(expiryFile, JSON.stringify(expiryData, null, 2));
}

async function loadExpiryData(agentId = 'admin') {
  const expiryFile = CONFIG.EXPIRY_FILE(agentId);
  try {
    const data = await fsp.readFile(expiryFile, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    return {};
  }
}

async function removeExpiryData(username, agentId = 'admin') {
  const expiryFile = CONFIG.EXPIRY_FILE(agentId);
  let expiryData = {};
  
  try {
    const data = await fsp.readFile(expiryFile, 'utf8');
    expiryData = JSON.parse(data);
  } catch (err) {
    return;
  }
  
  if (expiryData[username]) {
    delete expiryData[username];
    await fsp.writeFile(expiryFile, JSON.stringify(expiryData, null, 2));
  }
}

// ==========================================
// TEMPLATE PROTOKOL (XRAY VERSION)
// ==========================================
const PROTOCOLS = {
  vless: {
    inbounds: ['vless-ws', 'vless-grpc'],
    fields: ['id'],
    generateLink: (domain, user, creds) => ({
      ws: `vless://${creds.id}@${domain}:443?path=/vless-ws&security=tls&encryption=none&host=${domain}&type=ws&sni=${domain}#${user}`,
      grpc: `vless://${creds.id}@${domain}:443?security=tls&encryption=none&type=grpc&serviceName=vless-grpc&sni=${domain}#${user}`
    })
  },
  trojan: {
    inbounds: ['trojan-ws', 'trojan-grpc'],
    fields: ['password'],
    generateLink: (domain, user, creds) => ({
      ws: `trojan://${creds.password}@${domain}:443?path=/trojan-ws&security=tls&host=${domain}&type=ws&sni=${domain}#${user}`,
      grpc: `trojan://${creds.password}@${domain}:443?security=tls&type=grpc&serviceName=trojan-grpc&sni=${domain}#${user}`
    })
  },
  vmess: {
    inbounds: ['vmess-ws', 'vmess-grpc'],
    fields: ['id'],
    generateLink: (domain, user, creds) => ({
      ws: `vmess://${Buffer.from(JSON.stringify({
        v: "2", ps: user, add: domain, port: "443",
        id: creds.id, aid: "0", net: "ws", type: "none",
        host: domain, path: "/vmess", tls: "tls", sni: domain
      })).toString('base64')}`,
      grpc: `vmess://${Buffer.from(JSON.stringify({
        v: "2", ps: user, add: domain, port: "443",
        id: creds.id, aid: "0", net: "grpc", type: "none",
        host: domain, path: "vmess-grpc", tls: "tls", sni: domain
      })).toString('base64')}`
    })
  }
};

// ==========================================
// MANAJEMAN USER (ADMIN-SPECIFIC)
// ==========================================
async function checkUserLimit() {
  const users = await listAllUsers();
  if (users.totalUsers >= CONFIG.MAX_USERS) {
    throw new Error(`Batas maksimal user (${CONFIG.MAX_USERS}) tercapai`);
  }
}

async function listAllUsers(page = 1, itemsPerPage = CONFIG.ITEMS_PER_PAGE) {
  try {
    const config = await readConfig();
    const allExpiryData = await getAllExpiryData();
    const allUsers = [];

    for (const [agentId, expiryData] of Object.entries(allExpiryData)) {
      for (const [username, expiry] of Object.entries(expiryData)) {
        allUsers.push({
          name: username,
          expiry: expiry || 'N/A',
          expired: expiry ? new Date(expiry) < new Date() : false,
          agent: agentId,
          protocols: []
        });
      }
    }

    for (const inbound of config.inbounds) {
      if (inbound.settings && inbound.settings.clients) {
        for (const client of inbound.settings.clients) {
          if (client.email && !allUsers.some(u => u.name === client.email)) {
            allUsers.push({
              name: client.email,
              expiry: 'N/A',
              expired: false,
              agent: 'unknown',
              protocols: []
            });
          }
        }
      }
    }

    const startIndex = (page - 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const paginatedUsers = allUsers.slice(startIndex, endIndex);

    for (const user of paginatedUsers) {
      for (const inbound of config.inbounds) {
        if (inbound.settings && inbound.settings.clients) {
          if (inbound.settings.clients.some(c => c.email === user.name)) {
            user.protocols.push(inbound.protocol);
          }
        }
      }
      user.protocols = [...new Set(user.protocols)];
    }

    return {
      users: paginatedUsers,
      totalPages: Math.ceil(allUsers.length / itemsPerPage),
      currentPage: page,
      totalUsers: allUsers.length
    };
  } catch (err) {
    await logAction('USER_LIST_ALL_FAILED', { error: err.message });
    throw err;
  }
}

async function addUser(protocol, username, days, adminId, agentId = 'admin') {
  try {
    await checkUserLimit();
    
    const config = await readConfig();
    const domain = await getDomain();

    const allExpiryData = await getAllExpiryData();
    for (const data of Object.values(allExpiryData)) {
      if (data[username]) {
        throw new Error('Username sudah ada');
      }
    }

    const credentials = {};
    const protoConfig = PROTOCOLS[protocol];
    
    for (const field of protoConfig.fields) {
      credentials[field] = field === 'id' ? generateUUID() :
                         field === 'password' ? generatePassword() :
                         username;
    }

    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + days);
    const expiryStr = expiryDate.toISOString().split('T')[0];

    for (const inboundTag of protoConfig.inbounds) {
      let inbound = config.inbounds.find(i => i.tag === inboundTag);
      if (!inbound) {
        inbound = {
          port: 10000 + Math.floor(Math.random() * 1000),
          listen: "0.0.0.0",
          protocol: protocol,
          tag: inboundTag,
          settings: {
            clients: []
          },
          streamSettings: {
            network: inboundTag.includes('grpc') ? 'grpc' : 'ws',
            
            
            wsSettings: inboundTag.includes('grpc') ? null : {
              path: `/${protocol}-ws`
            },
            grpcSettings: inboundTag.includes('grpc') ? {
              serviceName: `${protocol}-grpc`
            } : null
          }
        };
        config.inbounds.push(inbound);
      }
      
      inbound.settings.clients.push({
        email: username,
        ...credentials
      });
    }

    await saveExpiryData(username, expiryStr, agentId);
    await saveConfig(config);
    await restartXray();

    const links = protoConfig.generateLink(domain, username, credentials);
    const qrCodes = [];
    
    await fsp.mkdir(CONFIG.CONFIGS_DIR, { recursive: true });

    for (const [type, link] of Object.entries(links)) {
      const qrPath = path.join(CONFIG.CONFIGS_DIR, `${protocol}-${username}-${type}.png`);
      if (await generateQR(link, qrPath)) {
        qrCodes.push({ type, path: qrPath, link });
      }
    }

    await logAction('USER_ADDED', { 
      username, 
      protocol, 
      expiry: expiryStr,
      admin: adminId,
      agentId
    });

    return { username, protocol, credentials, expiry: expiryStr, qrCodes };
  } catch (err) {
    await logAction('USER_ADD_FAILED', { 
      username, 
      protocol, 
      error: err.message,
      admin: adminId,
      agentId
    });
    throw err;
  }
}

async function deleteUser(username, adminId, agentId = null) {
  try {
    const config = await readConfig();
    let deleted = false;

    config.inbounds.forEach(inbound => {
      if (inbound.settings && inbound.settings.clients) {
        const initialLength = inbound.settings.clients.length;
        inbound.settings.clients = inbound.settings.clients.filter(c => c.email !== username);
        if (inbound.settings.clients.length !== initialLength) {
          deleted = true;
        }
      }
    });

    if (deleted) {
      if (!agentId) {
        const allExpiryFiles = await fsp.readdir('/usr/local/etc/xray/');
        for (const file of allExpiryFiles.filter(f => f.startsWith('expiry_data_') && f.endsWith('.json.j2'))) {
          const currentAgentId = file.replace('expiry_data_', '').replace('.json.j2', '');
          await removeExpiryData(username, currentAgentId);
        }
      } else {
        await removeExpiryData(username, agentId);
      }
      
      await saveConfig(config);
      await restartXray();
      
      for (const proto of Object.keys(PROTOCOLS)) {
        try {
          const files = await fsp.readdir(CONFIG.CONFIGS_DIR);
          for (const file of files.filter(f => f.startsWith(`${proto}-${username}-`))) {
            await fsp.unlink(path.join(CONFIG.CONFIGS_DIR, file));
          }
        } catch (err) {
          await logAction('QR_DELETE_FAILED', { username, error: err.message });
        }
      }

      await logAction('USER_DELETED', { username, admin: adminId, agentId });
      return true;
    }
    return false;
  } catch (err) {
    await logAction('USER_DELETE_FAILED', { 
      username, 
      error: err.message,
      admin: adminId,
      agentId
    });
    throw err;
  }
}

// ... (rest of the file remains the same, just replace all sing-box references with xray)// ... (rest of the file remains the same, just replace all sing-box references with xray)
async function extendUserExpiry(username, days, adminId, agentId = null) {
  try {
    let newExpiryStr = null;
    // Jika agentId tidak diketahui, cari di semua file expiry
    if (!agentId) {
      const allExpiryFiles = await fsp.readdir('/usr/local/etc/xray/');
      let found = false;
      
      for (const file of allExpiryFiles.filter(f => f.startsWith('expiry_data_') && f.endsWith('.json.j2'))) {
        const currentAgentId = file.replace('expiry_data_', '').replace('.json.j2', '');
        const expiryData = await loadExpiryData(currentAgentId);
        
        if (expiryData[username]) {
          const currentExpiry = new Date(expiryData[username]);
          const newExpiry = new Date(currentExpiry);
          newExpiry.setDate(newExpiry.getDate() + days);
          
          expiryData[username] = newExpiry.toISOString().split('T')[0];
          await saveExpiryData(username, expiryData[username], currentAgentId);
          newExpiryStr = expiryData[username];
          found = true;
          
          await logAction('USER_EXTENDED', { 
            username, 
            daysAdded: days,
            newExpiry: expiryData[username],
            admin: adminId,
            agentId: currentAgentId
          });
        }
      }
      
      if (!found) {
        throw new Error('User tidak ditemukan di data expiry');
      }
      return newExpiryStr;
    } else {
      const expiryData = await loadExpiryData(agentId);
      
      if (!expiryData[username]) {
        throw new Error('User tidak ditemukan di data expiry');
      }

      const currentExpiry = new Date(expiryData[username]);
      const newExpiry = new Date(currentExpiry);
      newExpiry.setDate(newExpiry.getDate() + days);
      
      expiryData[username] = newExpiry.toISOString().split('T')[0];
      await saveExpiryData(username, expiryData[username], agentId);
      
      await logAction('USER_EXTENDED', { 
        username, 
        daysAdded: days,
        newExpiry: expiryData[username],
        admin: adminId,
        agentId
      });
      return expiryData[username];
    }
  } catch (err) {
    await logAction('EXTEND_FAILED', { 
      username, 
      error: err.message,
      admin: adminId,
      agentId
    });
    throw err;
  }
}

async function cleanupExpiredUsers() {
  try {
    const allExpiryData = await getAllExpiryData();
    const deleted = [];

    for (const [agentId, expiryData] of Object.entries(allExpiryData)) {
      for (const [username, expiry] of Object.entries(expiryData)) {
        if (new Date(expiry) < new Date()) {
          if (await deleteUser(username, 'system', agentId)) {
            deleted.push({ username, agentId });
          }
        }
      }
    }

    await logAction('AUTO_CLEANUP', { deletedUsers: deleted.length });
    return deleted;
  } catch (err) {
    await logAction('CLEANUP_FAILED', { error: err.message });
    throw err;
  }
}

// ==========================================
// FITUR BACKUP (ADMIN-SPECIFIC)
// ==========================================
async function sendBackupToTelegram(chatId, compress = false) {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const caption = `📁 xray Backup\n⏰ ${new Date().toLocaleString()}`;

    if (compress) {
      const zipPath = path.join('/tmp', `xray-backup-${timestamp}.zip`);
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      // Ambil daftar file expiry sebelum Promise
      const expiryFiles = await fsp.readdir('/usr/local/etc/xray/');
      const filteredExpiryFiles = expiryFiles.filter(f => f.startsWith('expiry_data_') && f.endsWith('.json.j2'));

      return new Promise((resolve, reject) => {
        output.on('close', async () => {
          try {
            await bot.sendDocument(chatId, zipPath, { caption });
            await fsp.unlink(zipPath);
            resolve(true);
          } catch (err) {
            reject(err);
          }
        });

        archive.on('error', reject);
        archive.pipe(output);
        archive.file(CONFIG.CONFIG_PATH, { name: 'config.json' });

        // Backup semua file expiry (pakai hasil filter di atas)
        for (const file of filteredExpiryFiles) {
          archive.file(path.join('/usr/local/etc/xray/', file), { name: file });
        }

        archive.file(CONFIG.ADMINS_FILE, { name: 'admin.txt' });
        archive.file(CONFIG.DOMAIN_PATH, { name: 'domain' });
        archive.file(CONFIG.AGENTS_FILE, { name: 'agen.txt' });
        archive.file('/usr/local/etc/xray/bot-agent.js', { name: 'bot-agent.js' });
        archive.file('/usr/local/etc/xray/bot-admin.js', { name: 'bot-admin.js' });
        archive.finalize();
      });
    } else {
      const tempDir = path.join('/tmp', `xray-backup-${timestamp}`);
      await fsp.mkdir(tempDir, { recursive: true });
      
      // Backup file utama
      await fsp.copyFile(CONFIG.CONFIG_PATH, path.join(tempDir, 'config.json'));
      
      // Backup semua file expiry
      const expiryFiles = await fsp.readdir('/usr/local/etc/xray/');
      for (const file of expiryFiles.filter(f => f.startsWith('expiry_data_') && f.endsWith('.json.j2'))) {
        await fsp.copyFile(
          path.join('/usr/local/etc/xray/', file),
          path.join(tempDir, file)
        );
      }
      
      // File lainnya
      await fsp.copyFile(CONFIG.ADMINS_FILE, path.join(tempDir, 'admin.txt'));
      await fsp.copyFile(CONFIG.DOMAIN_PATH, path.join(tempDir, 'domain'));
      await fsp.copyFile(CONFIG.AGENTS_FILE, path.join(tempDir, 'agen.txt'));
      await fsp.copyFile('/usr/local/etc/xray/bot-agent.js', path.join(tempDir, 'bot-agent.js'));
      await fsp.copyFile('/usr/local/etc/xray/bot-admin.js', path.join(tempDir, 'bot-admin.js'));

      // Zip manual jika perlu
      const zipPath = path.join('/tmp', `xray-backup-${timestamp}.zip`);
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      return new Promise((resolve, reject) => {
        output.on('close', async () => {
          try {
            await bot.sendDocument(chatId, zipPath, { caption });
            await fsp.rm(tempDir, { recursive: true });
            await fsp.unlink(zipPath);
            resolve(true);
          } catch (err) {
            reject(err);
          }
        });

        archive.on('error', reject);
        archive.pipe(output);
        archive.directory(tempDir, false);
        archive.finalize();
      });
    }
  } catch (err) {
    await logAction('BACKUP_SEND_FAILED', { 
      chatId, 
      compress,
      error: err.message 
    });
    throw err;
  }
}

// ==========================================
// HANDLER MENU UTAMA (ADMIN VERSION)
// ==========================================
async function showMainMenu(chatId) {
  await bot.sendMessage(chatId, '🚀 xray Admin Bot', {
    reply_markup: {
      keyboard: [
        ['➕ Tambah User', '🗑 Hapus User'],
        ['⏳ Perpanjang User', '📋 List User'],
        ['🔄 Restart', '🧹 Bersihkan'],
        ['📊 Statistik', '💾 Backup', '🗜 Backup Terkompresi'],
        ['👥 Admin', '👤 Agent Management']
      ],
      resize_keyboard: true
    }
  });
}

// ==========================================
// HANDLER MENU ADMIN
// ==========================================
async function showAdminMenu(chatId) {
  await bot.sendMessage(chatId, '🛠 Menu Admin:', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📋 List Admin', callback_data: 'admin_list' }],
        [{ text: '➕ Tambah Admin', callback_data: 'admin_add' }],
        [{ text: '➖ Hapus Admin', callback_data: 'admin_remove' }],
        [{ text: '🔙 Kembali', callback_data: 'admin_back' }]
      ]
    }
  });
}

// ==========================================
// HANDLER MENU AGENT
// ==========================================
async function showAgentMenu(chatId) {
  await bot.sendMessage(chatId, '👤 Agent Management:', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📋 List Agent', callback_data: 'agent_list' }],
        [{ text: '➕ Tambah Agent', callback_data: 'agent_add' }],
        [{ text: '➖ Hapus Agent', callback_data: 'agent_remove' }],
        [{ text: '👀 Lihat User Agent', callback_data: 'agent_view' }],
        [{ text: '🔙 Kembali', callback_data: 'agent_back' }]
      ]
    }
  });
}

// ==========================================
// HANDLER UTAMA (ADMIN VERSION)
// ==========================================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  if (!(await isAdmin(chatId))) {
    return await bot.sendMessage(chatId, '❌ Anda bukan admin');
  }
  await showMainMenu(chatId);
});

bot.onText(/👥 Admin/, async (msg) => {
  const chatId = msg.chat.id;
  if (!(await isAdmin(chatId))) {
    return await bot.sendMessage(chatId, '❌ Akses ditolak');
  }
  await showAdminMenu(chatId);
});

bot.onText(/👤 Agent Management/, async (msg) => {
  const chatId = msg.chat.id;
  if (!(await isAdmin(chatId))) {
    return await bot.sendMessage(chatId, '❌ Akses ditolak');
  }
  await showAgentMenu(chatId);
});

bot.onText(/➕ Tambah User/, async (msg) => {
  const chatId = msg.chat.id;
  if (!(await isAdmin(chatId))) {
    return await bot.sendMessage(chatId, '❌ Akses ditolak');
  }

  await bot.sendMessage(chatId, 'Pilih protokol untuk user baru:', {
    reply_markup: {
      inline_keyboard: [
        ...Object.keys(PROTOCOLS).map(proto => [
          { text: proto.toUpperCase(), callback_data: `proto_${proto}` }
        ]),
        [{ text: '🔙 Batal', callback_data: 'main_menu' }]
      ]
    }
  });
});

bot.onText(/🗑 Hapus User/, async (msg) => {
  const chatId = msg.chat.id;
  if (!(await isAdmin(chatId))) {
    return await bot.sendMessage(chatId, '❌ Akses ditolak');
  }

  try {
    const keyboard = await sendPaginatedMenu(chatId, 1, 'del', (user) => 
      `${user.name} (${user.agent})`);
    await bot.sendMessage(chatId, 'Pilih user yang akan dihapus:', {
      reply_markup: { inline_keyboard: keyboard }
    });
  } catch (err) {
    await bot.sendMessage(chatId, `❌ Gagal memuat daftar user: ${err.message}`);
  }
});

bot.onText(/⏳ Perpanjang User/, async (msg) => {
  const chatId = msg.chat.id;
  if (!(await isAdmin(chatId))) {
    return await bot.sendMessage(chatId, '❌ Akses ditolak');
  }

  try {
    const keyboard = await sendPaginatedMenu(chatId, 1, 'extend', (user) => 
      `${user.name} (${user.expiry}) - ${user.agent}`);
    await bot.sendMessage(chatId, 'Pilih user yang akan diperpanjang:', {
      reply_markup: { inline_keyboard: keyboard }
    });
  } catch (err) {
    await bot.sendMessage(chatId, `❌ Gagal memuat daftar user: ${err.message}`);
  }
});

bot.onText(/🔄 Restart/, async (msg) => {
  const chatId = msg.chat.id;
  if (!(await isAdmin(chatId))) {
    return await bot.sendMessage(chatId, '❌ Akses ditolak');
  }

  try {
    await restartXray(); // <-- perbaiki di sini
    await bot.sendMessage(chatId, '✅ Layanan berhasil direstart');
  } catch (err) {
    await bot.sendMessage(chatId, `❌ Gagal restart layanan: ${err.message}`);
  }
});

bot.onText(/🧹 Bersihkan/, async (msg) => {
  const chatId = msg.chat.id;
  if (!(await isAdmin(chatId))) {
    return await bot.sendMessage(chatId, '❌ Akses ditolak');
  }

  try {
    const deletedUsers = await cleanupExpiredUsers();
    const message = deletedUsers.length > 0
      ? `✅ ${deletedUsers.length} user kedaluwarsa berhasil dihapus`
      : 'ℹ️ Tidak ada user kedaluwarsa';
    await bot.sendMessage(chatId, message);
  } catch (err) {
    await bot.sendMessage(chatId, `❌ Gagal membersihkan user: ${err.message}`);
  }
});

bot.onText(/📊 Statistik/, async (msg) => {
  const chatId = msg.chat.id;
  if (!(await isAdmin(chatId))) {
    return await bot.sendMessage(chatId, '❌ Akses ditolak');
  }

  try {
    const allExpiryData = await getAllExpiryData();
    let totalUsers = 0;
    let expiredUsers = 0;
    const agentStats = [];

    for (const [agentId, expiryData] of Object.entries(allExpiryData)) {
      const agentTotal = Object.keys(expiryData).length;
      const agentExpired = Object.values(expiryData).filter(expiry => new Date(expiry) < new Date()).length;
      
      totalUsers += agentTotal;
      expiredUsers += agentExpired;
      agentStats.push({
        agentId,
        total: agentTotal,
        expired: agentExpired
      });
    }

    let message = `📊 Statistik Sistem:\n`;
    message += `👥 Total User: ${totalUsers}\n`;
    message += `⏳ User Kedaluwarsa: ${expiredUsers}\n\n`;
    message += `📌 Per Agent:\n`;
    
    agentStats.forEach(stat => {
      message += `- ${stat.agentId}: ${stat.total} user (${stat.expired} expired)\n`;
    });

    await bot.sendMessage(chatId, message);
  } catch (err) {
    await bot.sendMessage(chatId, `❌ Gagal mengambil statistik: ${err.message}`);
  }
});

bot.onText(/💾 Backup/, async (msg) => {
  const chatId = msg.chat.id;
  if (!(await isAdmin(chatId))) {
    return await bot.sendMessage(chatId, '❌ Akses ditolak');
  }

  try {
    await sendBackupToTelegram(chatId, false);
    await bot.sendMessage(chatId, '✅ Backup berhasil dikirim');
  } catch (err) {
    await bot.sendMessage(chatId, `❌ Gagal mengirim backup: ${err.message}`);
  }
});

bot.onText(/🗜 Backup Terkompresi/, async (msg) => {
  const chatId = msg.chat.id;
  if (!(await isAdmin(chatId))) {
    return await bot.sendMessage(chatId, '❌ Akses ditolak');
  }

  try {
    await sendBackupToTelegram(chatId, true);
    await bot.sendMessage(chatId, '✅ Backup terkompresi berhasil dikirim');
  } catch (err) {
    await bot.sendMessage(chatId, `❌ Gagal mengirim backup terkompresi: ${err.message}`);
  }
});

bot.onText(/📋 List User/, async (msg) => {
  const chatId = msg.chat.id;
  if (!(await isAdmin(chatId))) {
    return await bot.sendMessage(chatId, '❌ Akses ditolak');
  }

  try {
    const { users, totalPages, currentPage, totalUsers } = await listAllUsers(1);
    const onlineIPs = await getOnlineUserIPs();

    let message = `📋 Daftar User (${totalUsers}):\n`;
    users.forEach((user, index) => {
      const globalIndex = (currentPage - 1) * CONFIG.ITEMS_PER_PAGE + index + 1;
      const ipArr = onlineIPs[user.name];
      const ipText = ipArr && ipArr.length
        ? `🟢 IP: ${ipArr.join(', ')}`
        : '🔴 Offline';
      message += `${globalIndex}. 👤 ${user.name}\n`;
      message += `   ⏳ Kedaluwarsa: ${user.expiry}\n`;
      message += `   👤 Agent: ${user.agent}\n`;
      message += `   ⚡ Protokol: ${user.protocols.join(', ')}\n`;
      message += `   ${ipText}\n\n`;
    });

    const keyboard = [];
    if (totalPages > 1) {
      const navButtons = [];
      if (currentPage > 1) {
        navButtons.push({ 
          text: '⬅️ Previous', 
          callback_data: `list_page_${currentPage - 1}`
        });
      }
      if (currentPage < totalPages) {
        navButtons.push({ 
          text: 'Next ➡️', 
          callback_data: `list_page_${currentPage + 1}`
        });
      }
      keyboard.push(navButtons);
    }
    keyboard.push([{ text: '🔙 Kembali', callback_data: 'main_menu' }]);

    await bot.sendMessage(chatId, message, {
      reply_markup: { inline_keyboard: keyboard }
    });
  } catch (err) {
    await bot.sendMessage(chatId, `❌ Gagal mengambil daftar user: ${err.message}`);
  }
});

// ==========================================
// HANDLER CALLBACK (ADMIN VERSION)
// ==========================================
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id.toString();
  const data = query.data;

  if (!(await isAdmin(userId))) {
    return await bot.answerCallbackQuery(query.id, { text: '❌ Akses ditolak' });
  }

  try {
    // Handle "Kembali" button
    if (data === 'main_menu') {
      await showMainMenu(chatId);
      await bot.deleteMessage(chatId, query.message.message_id);
    }

    // Handle paginasi list user
    else if (data.startsWith('list_page_')) {
      const parts = data.split('_');
      const page = parseInt(parts[2]);
      const agentId = parts[3] || null;

      const { users, totalPages, currentPage, totalUsers } = agentId 
        ? await listAgentUsers(agentId, page) 
        : await listAllUsers(page);
      const onlineIPs = await getOnlineUserIPs();

      let message = `📋 Daftar User (${totalUsers}):\n`;
      users.forEach((user, index) => {
        const globalIndex = (currentPage - 1) * CONFIG.ITEMS_PER_PAGE + index + 1;
        const ipArr = onlineIPs[user.name];
        const ipText = ipArr && ipArr.length
          ? `🟢 IP: ${ipArr.join(', ')}`
          : '🔴 Offline';
        message += `${globalIndex}. 👤 ${user.name}\n`;
        message += `   ⏳ Kedaluwarsa: ${user.expiry}\n`;
        if (!agentId) message += `   👤 Agent: ${user.agent}\n`;
        message += `   ⚡ Protokol: ${user.protocols.join(', ')}\n`;
        message += `   ${ipText}\n\n`;
      });

      const keyboard = [];
      if (totalPages > 1) {
        const navButtons = [];
        if (currentPage > 1) {
          navButtons.push({
            text: '⬅️ Previous',
            callback_data: `list_page_${currentPage - 1}`
          });
        }
        if (currentPage < totalPages) {
          navButtons.push({
            text: 'Next ➡️',
            callback_data: `list_page_${currentPage + 1}`
          });
        }
        keyboard.push(navButtons);
      }
      keyboard.push([{ text: '🔙 Kembali', callback_data: 'main_menu' }]);

      await bot.editMessageText(message, {
        chat_id: chatId,
        message_id: query.message.message_id,
        reply_markup: { inline_keyboard: keyboard }
      });
    }

    // Handle paginasi hapus user
    else if (data.startsWith('del_page_')) {
      const parts = data.split('_');
      const page = parseInt(parts[2]);
      const agentId = parts[3] || null;

      const keyboard = await sendPaginatedMenu(chatId, page, 'del', 
        (user) => `${user.name} (${user.agent})`, agentId);
      await bot.editMessageReplyMarkup({
        inline_keyboard: keyboard
      }, {
        chat_id: chatId,
        message_id: query.message.message_id
      });
    }

    // Handle paginasi perpanjang user
    else if (data.startsWith('extend_page_')) {
      const parts = data.split('_');
      const page = parseInt(parts[2]);
      const agentId = parts[3] || null;

      const keyboard = await sendPaginatedMenu(chatId, page, 'extend', 
        (user) => `${user.name} (${user.expiry}) - ${user.agent}`, agentId);
      await bot.editMessageReplyMarkup({
        inline_keyboard: keyboard
      }, {
        chat_id: chatId,
        message_id: query.message.message_id
      });
    }

    // Handle callback admin
    else if (data.startsWith('admin_')) {
      await handleAdminCallbacks(query);
    }

    // Handle callback agent management
    else if (data.startsWith('agent_')) {
      await handleAgentCallbacks(query);
    }

    // Handle protocol selection
    else if (data.startsWith('proto_')) {
      await handleProtocolCallback(query);
    }

    // Handle delete user
    else if (data.startsWith('del_')) {
      await handleDeleteUserCallback(query);
    }

    // Handle extend user
    else if (data.startsWith('extend_')) {
      await handleExtendUserCallback(query);
    }

    // Handle remove admin
    else if (data.startsWith('rmadmin_')) {
      await handleRemoveAdminCallback(query);
    }

    // Handle view agent users
    else if (data.startsWith('viewagent_')) {
      await handleViewAgentCallback(query);
    }

    else {
      await bot.answerCallbackQuery(query.id, { text: '⚠️ Perintah tidak dikenali' });
    }
  } catch (err) {
    console.error('Error handling callback:', err);
    await bot.answerCallbackQuery(query.id, { text: '❌ Terjadi kesalahan' });
  }
});

// ==========================================
// HANDLER ADMIN (ADMIN VERSION)
// ==========================================
async function handleAdminCallbacks(query) {
  const chatId = query.message.chat.id;
  const userId = query.from.id.toString();
  const data = query.data;
  const action = data.split('_')[1];

  if (!(await isAdmin(userId))) {
    return await bot.answerCallbackQuery(query.id, { text: '❌ Akses ditolak' });
  }

  switch(action) {
    case 'list': {
      const admins = await loadAdmins();
      const message = admins.length > 0 
        ? `👥 Daftar Admin:\n${admins.join('\n')}`
        : 'Tidak ada admin terdaftar';
      
      await bot.editMessageText(message, {
        chat_id: chatId,
        message_id: query.message.message_id,
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Kembali', callback_data: 'admin_back' }]
          ]
        }
      });
      break;
    }

    case 'add': {
      userState[chatId] = { 
        step: 'add_admin',
        adminId: userId,
        messageId: query.message.message_id
      };
      
      await bot.editMessageText('Masukkan ID Telegram yang akan ditambahkan sebagai admin:', {
        chat_id: chatId,
        message_id: query.message.message_id,
        reply_markup: {
          inline_keyboard: [
            [{ text: '❌ Batal', callback_data: 'admin_back' }]
          ]
        }
      });
      break;
    }

    case 'remove': {
      const currentAdmins = await loadAdmins();
      if (currentAdmins.length <= 1) {
        await bot.editMessageText('❌ Tidak bisa menghapus admin terakhir', {
          chat_id: chatId,
          message_id: query.message.message_id
        });
        break;
      }
      
      await bot.editMessageText('Pilih admin yang akan dihapus:', {
        chat_id: chatId,
        message_id: query.message.message_id,
        reply_markup: {
          inline_keyboard: [
            ...currentAdmins
              .filter(a => a !== userId)
              .map(a => [{ text: a, callback_data: `rmadmin_${a}` }]),
            [{ text: '🔙 Kembali', callback_data: 'admin_back' }]
          ]
        }
      });
      break;
    }

    case 'back': {
      await showMainMenu(chatId);
      await bot.deleteMessage(chatId, query.message.message_id);
      break;
    }

    default: {
      await bot.answerCallbackQuery(query.id, { text: '⚠️ Perintah admin tidak valid' });
      break;
    }
  }
}

// ==========================================
// HANDLER AGENT MANAGEMENT
// ==========================================
async function handleAgentCallbacks(query) {
  const chatId = query.message.chat.id;
  const userId = query.from.id.toString();
  const data = query.data;
  const action = data.split('_')[1];

  if (!(await isAdmin(userId))) {
    return await bot.answerCallbackQuery(query.id, { text: '❌ Akses ditolak' });
  }

  switch(action) {
    case 'list': {
      const agents = await loadAgents();
      if (agents.length === 0) {
        return await bot.editMessageText('Tidak ada agent terdaftar di agen.txt', {
          chat_id: chatId,
          message_id: query.message.message_id
        });
      }
      const keyboard = agents.map(agentId => [
        { text: `👤 ${agentId}`, callback_data: `viewagent_${agentId}` }
      ]);
      keyboard.push([{ text: '🔙 Kembali', callback_data: 'agent_back' }]);
      await bot.editMessageText('📋 Daftar Agent (agen.txt):', {
        chat_id: chatId,
        message_id: query.message.message_id,
        reply_markup: { inline_keyboard: keyboard }
      });
      break;
    }
    case 'add': {
      userState[chatId] = {
        step: 'add_agent',
        adminId: userId,
        messageId: query.message.message_id
      };
      await bot.editMessageText('Masukkan ID Agent yang ingin ditambahkan:', {
        chat_id: chatId,
        message_id: query.message.message_id,
        reply_markup: {
          inline_keyboard: [
            [{ text: '❌ Batal', callback_data: 'agent_back' }]
          ]
        }
      });
      break;
    }
    case 'remove': {
      const agents = await loadAgents();
      if (agents.length === 0) {
        return await bot.editMessageText('Tidak ada agent untuk dihapus.', {
          chat_id: chatId,
          message_id: query.message.message_id
        });
      }
      await bot.editMessageText('Pilih agent yang akan dihapus:', {
        chat_id: chatId,
        message_id: query.message.message_id,
        reply_markup: {
          inline_keyboard: [
            ...agents.map(a => [{ text: a, callback_data: `rmagent_${a}` }]),
            [{ text: '🔙 Kembali', callback_data: 'agent_back' }]
          ]
        }
      });
      break;
    }
    case 'back': {
      await showMainMenu(chatId);
      await bot.deleteMessage(chatId, query.message.message_id);
      break;
    }
    case 'view': {
      userState[chatId] = {
        step: 'view_agent',
        adminId: userId,
        messageId: query.message.message_id
      };
      await bot.editMessageText('Masukkan ID Agent yang ingin dilihat:', {
        chat_id: chatId,
        message_id: query.message.message_id,
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Kembali', callback_data: 'agent_back' }]
          ]
        }
      });
      break;
    }
    default: {
      await bot.answerCallbackQuery(query.id, { text: '⚠️ Perintah agent tidak valid' });
      break;
    }
  }
}

// Handler hapus agent dari agen.txt
bot.on('callback_query', async (query) => {
  // ...existing code...
  if (query.data.startsWith('rmagent_')) {
    const chatId = query.message.chat.id;
    const agentId = query.data.replace('rmagent_', '');
    await removeAgent(agentId);
    await bot.editMessageText(`✅ Agent ${agentId} berhasil dihapus dari agen.txt`, {
      chat_id: chatId,
      message_id: query.message.message_id
    });
    return;
  }
  // ...existing code...
});

// Fungsi utilitas agent
async function loadAgents() {
  try {
    const data = await fsp.readFile(CONFIG.AGENTS_FILE, 'utf8');
    return data.split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'));
  } catch (err) {
    await fsp.writeFile(CONFIG.AGENTS_FILE, '');
    return [];
  }
}

async function addAgent(agentId) {
  const agents = await loadAgents();
  if (!agents.includes(agentId)) {
    agents.push(agentId);
    await fsp.writeFile(CONFIG.AGENTS_FILE, agents.join('\n'));
    return true;
  }
  return false;
}

async function removeAgent(agentId) {
  const agents = await loadAgents();
  const updatedAgents = agents.filter(a => a !== agentId);
  await fsp.writeFile(CONFIG.AGENTS_FILE, updatedAgents.join('\n'));
}

// Handler input agent (tambah agent via input)
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const text = msg.text;
  const state = userState[chatId];

  if (!state || userId !== state.adminId) return;

  try {
    if (state.step === 'add_admin') {
      // ...kode tambah admin...
    } else if (state.step === 'add_agent') {
      const agentId = text.trim();
      if (!/^\d+$/.test(agentId)) {
        await bot.sendMessage(chatId, '❌ Format ID agent tidak valid. Hanya angka.');
        return;
      }
      if (await addAgent(agentId)) {
        await bot.sendMessage(chatId, `✅ Agent ${agentId} berhasil ditambahkan ke agen.txt`);
      } else {
        await bot.sendMessage(chatId, `❌ Agent ${agentId} sudah terdaftar`);
      }
      if (state.messageId) {
        await bot.deleteMessage(chatId, state.messageId);
      }
      delete userState[chatId];
      await showAgentMenu(chatId);
    } else if (state.step === 'add_user_username') {
      const username = text.trim();
      if (!/^[a-zA-Z0-9_\-]+$/.test(username)) {
        await bot.sendMessage(chatId, '❌ Username hanya boleh huruf, angka, _ atau -');
        return;
      }
      // Simpan username, lanjut ke step input hari aktif
      userState[chatId] = {
        ...state,
        step: 'add_user_days',
        username
      };
      await bot.sendMessage(chatId, `Masukkan jumlah hari aktif untuk user *${username}*:`, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '❌ Batal', callback_data: 'main_menu' }]
          ]
        }
      });
    } else if (state.step === 'add_user_days') {
      const days = parseInt(text.trim());
      if (isNaN(days) || days < 1 || days > 365) {
        await bot.sendMessage(chatId, '❌ Masukkan jumlah hari antara 1-365');
        return;
      }
      try {
        const { protocol, username, adminId } = state;
        const result = await addUser(protocol, username, days, adminId);
        let msg = `✅ User *${username}* (${protocol.toUpperCase()}) berhasil ditambahkan!\n`;
        msg += `⏳ Expiry: ${result.expiry}\n\n`;
        msg += `Link:\n`;
        for (const qr of result.qrCodes) {
          msg += `- ${qr.type}: ${qr.link}\n`;
        }
        await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
        // Kirim QR code sebagai gambar
        for (const qr of result.qrCodes) {
          await bot.sendPhoto(chatId, qr.path, { caption: `${protocol.toUpperCase()} - ${qr.type}` });
        }
        if (state.messageId) {
          await bot.deleteMessage(chatId, state.messageId);
        }
        delete userState[chatId];
        await showMainMenu(chatId);
      } catch (err) {
        await bot.sendMessage(chatId, `❌ Gagal menambah user: ${err.message}`);
        delete userState[chatId];
        await showMainMenu(chatId);
      }
    } else if (state.step === 'extend_user_days') {
      const days = parseInt(text.trim());
      if (isNaN(days) || days < 1 || days > 365) {
        await bot.sendMessage(chatId, '❌ Masukkan jumlah hari antara 1-365');
        return;
      }
      try {
        const { username, adminId, agentId, messageId } = state;
        const newExpiry = await extendUserExpiry(username, days, adminId, agentId);
        await bot.sendMessage(chatId, `✅ User *${username}* berhasil diperpanjang hingga ${newExpiry}`, { parse_mode: 'Markdown' });
        if (messageId) {
          await bot.deleteMessage(chatId, messageId);
        }
        delete userState[chatId];
        await showMainMenu(chatId);
      } catch (err) {
        await bot.sendMessage(chatId, `❌ Gagal memperpanjang user: ${err.message}`);
        delete userState[chatId];
        await showMainMenu(chatId);
      }
    }
    // Tambahkan else if lain jika ada step lain
  } catch (err) {
    // ...error handling...
  }
});

// ==========================================
// INISIALISASI & ERROR HANDLING (ADMIN VERSION)
// ==========================================
(async () => {
  try {
    await fsp.mkdir(path.dirname(CONFIG.ADMINS_FILE), { recursive: true });
    await fsp.mkdir(CONFIG.BACKUP_DIR, { recursive: true });
    await fsp.mkdir(CONFIG.CONFIGS_DIR, { recursive: true });

    if (!fs.existsSync(CONFIG.ADMINS_FILE)) {
      const initialAdmin = process.env.INITIAL_ADMIN;
      if (!initialAdmin) throw new Error('INITIAL_ADMIN environment variable required');
      await fsp.writeFile(CONFIG.ADMINS_FILE, initialAdmin);
    }

    console.log('🤖 Admin bot berhasil dijalankan');
    const admins = await loadAdmins();
    if (admins.length > 0) {
      await bot.sendMessage(admins[0], '🟢 Admin bot berhasil diinisialisasi');
    }
  } catch (err) {
    console.error('Gagal inisialisasi:', err);
    process.exit(1);
  }
})();

process.on('unhandledRejection', async (err) => {
  console.error('Unhandled rejection:', err);
  await logAction('UNHANDLED_REJECTION', { error: err.message });
});

process.on('uncaughtException', async (err) => {
  console.error('Uncaught exception:', err);
  await logAction('UNCAUGHT_EXCEPTION', { error: err.message });
  process.exit(1);
});

// Handler command untuk manajemen agent
bot.onText(/\/tambah_agent (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!(await isAdmin(chatId))) return;

  const agentId = match[1];
  if (await addAgent(agentId)) {
    await bot.sendMessage(chatId, `✅ Agent ${agentId} berhasil ditambahkan`);
  } else {
    await bot.sendMessage(chatId, `❌ Agent ${agentId} sudah terdaftar`);
  }
});

bot.onText(/\/hapus_agent (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!(await isAdmin(chatId))) return;

  const agentId = match[1];
  await removeAgent(agentId);
  await bot.sendMessage(chatId, `✅ Agent ${agentId} berhasil dihapus`);
});

bot.onText(/\/list_agent/, async (msg) => {
  const chatId = msg.chat.id;
  if (!(await isAdmin(chatId))) return;

  const agents = await loadAgents();
  await bot.sendMessage(chatId, `📋 Daftar Agent:\n${agents.join('\n') || 'Tidak ada agent'}`);
});

// Handler untuk proses tambah user
async function handleProtocolCallback(query) {
  const chatId = query.message.chat.id;
  const userId = query.from.id.toString();
  const data = query.data;
  const protocol = data.replace('proto_', '');

  // Simpan state untuk proses tambah user
  userState[chatId] = {
    step: 'add_user_username',
    protocol,
    adminId: userId,
    messageId: query.message.message_id
  };

  await bot.editMessageText(`Masukkan username untuk user baru (${protocol.toUpperCase()}):`, {
    chat_id: chatId,
    message_id: query.message.message_id,
    reply_markup: {
      inline_keyboard: [
        [{ text: '❌ Batal', callback_data: 'main_menu' }]
      ]
    }
  });
}

async function handleDeleteUserCallback(query) {
  const chatId = query.message.chat.id;
  const userId = query.from.id.toString();
  const data = query.data;
  const username = data.replace('del_', '');

  try {
    // Cari agentId user (jika ada)
    let agentId = null;
    const allExpiryData = await getAllExpiryData();
    for (const [aid, expiryData] of Object.entries(allExpiryData)) {
      if (expiryData[username]) {
        agentId = aid;
        break;
      }
    }

    const deleted = await deleteUser(username, userId, agentId);
    if (deleted) {
      await bot.editMessageText(`✅ User *${username}* berhasil dihapus.`, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown'
      });
    } else {
      await bot.editMessageText(`❌ User *${username}* tidak ditemukan.`, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown'
      });
    }
  } catch (err) {
    await bot.editMessageText(`❌ Gagal menghapus user: ${err.message}`, {
      chat_id: chatId,
      message_id: query.message.message_id
    });
  }
}

async function handleExtendUserCallback(query) {
  const chatId = query.message.chat.id;
  const userId = query.from.id.toString();
  const data = query.data;
  const username = data.replace('extend_', '');

  // Cari agentId user (jika ada)
  let agentId = null;
  const allExpiryData = await getAllExpiryData();
  for (const [aid, expiryData] of Object.entries(allExpiryData)) {
    if (expiryData[username]) {
      agentId = aid;
      break;
    }
  }

  // Simpan state untuk proses input hari perpanjangan
  userState[chatId] = {
    step: 'extend_user_days',
    username,
    adminId: userId,
    agentId,
    messageId: query.message.message_id
  };

  await bot.editMessageText(
    `Masukkan jumlah hari perpanjangan untuk user *${username}*:`,
    {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '❌ Batal', callback_data: 'main_menu' }]
        ]
      }
    }
  );
}

// Fungsi utilitas untuk membuat menu paginasi user (hapus/perpanjang)
async function sendPaginatedMenu(chatId, page, action, labelFn, agentId = null) {
  const itemsPerPage = CONFIG.ITEMS_PER_PAGE;
  let result;
  if (agentId) {
    result = await listAgentUsers(agentId, page, itemsPerPage);
  } else {
    result = await listAllUsers(page, itemsPerPage);
  }
  const { users, totalPages, currentPage } = result;

  const keyboard = users.map(user => [
    { text: labelFn(user), callback_data: `${action}_${user.name}` }
  ]);

  // Navigasi paginasi
  if (totalPages > 1) {
    const navButtons = [];
    if (currentPage > 1) {
      navButtons.push({
        text: '⬅️ Previous',
        callback_data: `${action}_page_${currentPage - 1}${agentId ? `_${agentId}` : ''}`
      });
    }
    if (currentPage < totalPages) {
      navButtons.push({
        text: 'Next ➡️',
        callback_data: `${action}_page_${currentPage + 1}${agentId ? `_${agentId}` : ''}`
      });
    }
    keyboard.push(navButtons);
  }
  keyboard.push([{ text: '🔙 Kembali', callback_data: agentId ? 'agent_back' : 'main_menu' }]);
  return keyboard;
}

// ==========================================
// MONITORING (ADMIN-SPECIFIC)
// ==========================================
async function getOnlineUserIPs() {
  const logPath = '/var/log/xray/access.log';
  const now = Date.now();
  const TWO_MINUTES = 2 * 60 * 1000;
  try {
    const data = await fsp.readFile(logPath, 'utf8');
    const lines = data.trim().split('\n').reverse();
    const userIpMap = {};
    for (const line of lines) {
      // Format: 2025/05/17 00:36:20.449113 from 140.213.115.74:0 accepted tcp:... email: koko
      const match = line.match(/^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2})\.\d+\s+from ([\d\.]+):\d+ .*email: (\S+)/);
      if (match) {
        const [ , dateStr, ip, user ] = match;
        const logTime = new Date(dateStr.replace(/\//g, '-')).getTime();
        if (now - logTime > TWO_MINUTES) continue; // skip jika lebih dari 2 menit
        if (!userIpMap[user]) userIpMap[user] = [];
        if (!userIpMap[user].includes(ip)) userIpMap[user].push(ip);
      }
      if (Object.keys(userIpMap).length > 100) break;
    }
    return userIpMap;
  } catch (err) {
    return {};
  }
}

async function monitorUserMultiIP() {
  const logPath = '/var/log/xray/access.log';
  const now = Date.now();
  const FIVE_MINUTES = 5 * 60 * 1000;
  try {
    const data = await fsp.readFile(logPath, 'utf8');
    const lines = data.trim().split('\n').reverse();
    const userIpMap = {};
    for (const line of lines) {
      // Format: 2025/05/17 00:36:20.449113 from 140.213.115.74:0 accepted tcp:... email: koko
      const match = line.match(/^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2})\.\d+\s+from ([\d\.]+):\d+ .*email: (\S+)/);
      if (match) {
        const [ , dateStr, ip, user ] = match;
        const logTime = new Date(dateStr.replace(/\//g, '-')).getTime();
        if (now - logTime > FIVE_MINUTES) continue;
        if (!userIpMap[user]) userIpMap[user] = [];
        if (!userIpMap[user].includes(ip)) userIpMap[user].push(ip);
      }
    }
    // Cari user yang punya lebih dari 2 IP
    const suspicious = Object.entries(userIpMap)
      .filter(([user, ips]) => ips.length > 2);
    if (suspicious.length > 0) {
      const admins = await loadAdmins();
      let report = '⚠️ *Deteksi Multi-IP (5 menit terakhir)*\n\n';
      suspicious.forEach(([user, ips]) => {
        report += `👤 *${user}* : ${ips.join(', ')}\n`;
      });
      for (const adminId of admins) {
        await bot.sendMessage(adminId, report, { parse_mode: 'Markdown' });
      }
    }
  } catch (err) {
    // Optional: log error
  }
}
