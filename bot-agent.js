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
// KONFIGURASI UTAMA (AGENT VERSION)
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
  MAX_USERS: 70,
  LOG_FILE: '/var/log/xray-agent.log',
  AUTO_BACKUP_TIME: '00:00',
  ITEMS_PER_PAGE: 10
};

const bot = new TelegramBot(CONFIG.BOT_TOKEN, { polling: true });
let userState = {};

// ==========================================
// FUNGSI UTILITAS (AGENT-SPECIFIC)
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

// ==========================================
// MANAJEMEN EXPIRY (AGENT-SPECIFIC)
// ==========================================
async function saveExpiryData(username, expiry, agentId) {
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

async function loadExpiryData(agentId) {
  const expiryFile = CONFIG.EXPIRY_FILE(agentId);
  try {
    const data = await fsp.readFile(expiryFile, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    return {};
  }
}

async function removeExpiryData(username, agentId) {
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
// MANAJEMEN USER (AGENT-SPECIFIC)
// ==========================================
async function listUsers(page = 1, itemsPerPage = CONFIG.ITEMS_PER_PAGE, agentId) {
  try {
    const expiryData = await loadExpiryData(agentId);
    const allUsers = Object.keys(expiryData).map(username => ({
      name: username,
      expiry: expiryData[username] || 'N/A',
      expired: expiryData[username] ? new Date(expiryData[username]) < new Date() : false,
      protocols: []
    }));

    const startIndex = (page - 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const paginatedUsers = allUsers.slice(startIndex, endIndex);

    return {
      users: paginatedUsers,
      totalPages: Math.ceil(allUsers.length / itemsPerPage),
      currentPage: page,
      totalUsers: allUsers.length
    };
  } catch (err) {
    await logAction('USER_LIST_FAILED', { error: err.message, agentId });
    throw err;
  }
}

async function addUser(protocol, username, days, agentId) {
  try {
    const config = await readConfig();
    const domain = await getDomain();
    const expiryData = await loadExpiryData(agentId);

    if (expiryData[username]) {
      throw new Error('Username sudah ada');
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
            security: "tls",
            tlsSettings: {
              certificates: [
                {
                  certificateFile: "/usr/local/etc/xray/xray.crt",
                  keyFile: "/usr/local/etc/xray/xray.key"
                }
              ]
            },
            wsSettings: inboundTag.includes('grpc') ? null : {
              path: `/${protocol}`,
              headers: {
                Host: domain
              }
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
    await fsp.writeFile(CONFIG.CONFIG_PATH, JSON.stringify(config, null, 2));
    await execAsync('systemctl restart xray');

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
      agentId
    });

    return { username, protocol, credentials, expiry: expiryStr, qrCodes };
  } catch (err) {
    await logAction('USER_ADD_FAILED', { 
      username, 
      protocol, 
      error: err.message,
      agentId
    });
    throw err;
  }
}

// ... (rest of the file remains the same, just replace all xray references with xray)

async function deleteUser(username, agentId) {
  try {
    const config = await readConfig();
    let deleted = false;

    config.inbounds.forEach(inbound => {
      if (inbound.settings && inbound.settings.clients) {
        const initialLength = inbound.settings.clients.length;
        inbound.settings.clients = inbound.settings.clients.filter(
          client => client.email !== username
        );
        if (inbound.settings.clients.length !== initialLength) {
          deleted = true;
        }
      }
    });

    if (deleted) {
      await removeExpiryData(username, agentId);
      await fsp.writeFile(CONFIG.CONFIG_PATH, JSON.stringify(config, null, 2));
      await execAsync('systemctl restart xray');
      
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

      await logAction('USER_DELETED', { username, agentId });
      return true;
    }
    return false;
  } catch (err) {
    await logAction('USER_DELETE_FAILED', { 
      username, 
      error: err.message,
      agentId
    });
    throw err;
  }
}

async function extendUserExpiry(username, days, agentId) {
  try {
    const expiryData = await loadExpiryData(agentId);
    
    if (!expiryData[username]) {
      throw new Error('User tidak ditemukan');
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
      agentId
    });

    return expiryData[username];
  } catch (err) {
    await logAction('EXTEND_FAILED', { 
      username, 
      error: err.message,
      agentId
    });
    throw err;
  }
}

// Fungsi utilitas untuk membaca config xray
async function readConfig() {
  try {
    const data = await fsp.readFile(CONFIG.CONFIG_PATH, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    throw new Error('Gagal membaca config: ' + err.message);
  }
}

// Fungsi utilitas untuk membaca domain
async function getDomain() {
  try {
    return (await fsp.readFile(CONFIG.DOMAIN_PATH, 'utf8')).trim();
  } catch (err) {
    throw new Error('Gagal membaca domain: ' + err.message);
  }
}

// Fungsi utilitas untuk generate UUID
function generateUUID() {
  return crypto.randomUUID ? crypto.randomUUID() : [
    crypto.randomBytes(4).toString('hex'),
    crypto.randomBytes(2).toString('hex'),
    crypto.randomBytes(2).toString('hex'),
    crypto.randomBytes(2).toString('hex'),
    crypto.randomBytes(6).toString('hex')
  ].join('-');
}

// Fungsi utilitas untuk generate password acak
function generatePassword(length = 16) {
  return crypto.randomBytes(length).toString('hex').slice(0, length);
}

// Fungsi utilitas untuk generate QR code
async function generateQR(text, filePath) {
  try {
    await qrcode.toFile(filePath, text, { width: 300 });
    return true;
  } catch (err) {
    await logAction('QR_FAILED', { error: err.message });
    return false;
  }
}

// ==========================================
// HANDLER MENU UTAMA (AGENT VERSION)
// ==========================================
async function showMainMenu(chatId) {
  await bot.sendMessage(chatId, '🚀 xray Agent Bot', {
    reply_markup: {
      keyboard: [
        ['➕ Tambah User', '🗑 Hapus User'],
        ['⏳ Perpanjang User', '📋 List User'],
        ['📊 Statistik']
      ],
      resize_keyboard: true
    }
  });
}

// ==========================================
// HANDLER UTAMA (AGENT VERSION)
// ==========================================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  if (!(await isAgent(userId))) {
    return bot.sendMessage(chatId, '❌ Anda tidak terdaftar sebagai agent.');
  }
  await showMainMenu(chatId);
});

bot.onText(/➕ Tambah User/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  if (!(await isAgent(userId))) {
    return bot.sendMessage(chatId, '❌ Anda tidak terdaftar sebagai agent.');
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
  const userId = msg.from.id.toString();
  if (!(await isAgent(userId))) {
    return bot.sendMessage(chatId, '❌ Anda tidak terdaftar sebagai agent.');
  }
  const agentId = userId;
  const page = 1;
  await showDeleteUserMenu(chatId, agentId, page);
});

async function showDeleteUserMenu(chatId, agentId, page = 1) {
  try {
    const { users, totalPages } = await listUsers(page, CONFIG.ITEMS_PER_PAGE, agentId);

    if (users.length === 0) {
      return await bot.sendMessage(chatId, 'Tidak ada user yang bisa dihapus');
    }

    const keyboard = users.map(user => [
      { text: `${user.name} (${user.expiry})`, callback_data: `del_${user.name}` }
    ]);

    // Navigasi halaman
    const navButtons = [];
    if (page > 1) navButtons.push({ text: '⏮ Prev', callback_data: `delpage_${page - 1}` });
    if (page < totalPages) navButtons.push({ text: '⏭ Next', callback_data: `delpage_${page + 1}` });
    if (navButtons.length) keyboard.push(navButtons);

    keyboard.push([{ text: '🔙 Kembali', callback_data: 'main_menu' }]);

    await bot.sendMessage(chatId, `Pilih user yang akan dihapus (Halaman ${page}/${totalPages}):`, {
      reply_markup: { inline_keyboard: keyboard }
    });
  } catch (err) {
    await bot.sendMessage(chatId, `❌ Gagal memuat daftar user: ${err.message}`);
  }
}

// Handler Perpanjang User
bot.onText(/⏳ Perpanjang User/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  if (!(await isAgent(userId))) {
    return bot.sendMessage(chatId, '❌ Anda tidak terdaftar sebagai agent.');
  }
  const agentId = userId;
  const page = 1;
  await showExtendUserMenu(chatId, agentId, page);
});

async function showExtendUserMenu(chatId, agentId, page = 1) {
  try {
    const { users, totalPages } = await listUsers(page, CONFIG.ITEMS_PER_PAGE, agentId);

    if (users.length === 0) {
      return await bot.sendMessage(chatId, 'Tidak ada user yang bisa diperpanjang');
    }

    const keyboard = users.map(user => [
      { text: `${user.name} (${user.expiry})`, callback_data: `extend_${user.name}` }
    ]);

    // Navigasi halaman
    const navButtons = [];
    if (page > 1) navButtons.push({ text: '⏮ Prev', callback_data: `extendpage_${page - 1}` });
    if (page < totalPages) navButtons.push({ text: '⏭ Next', callback_data: `extendpage_${page + 1}` });
    if (navButtons.length) keyboard.push(navButtons);

    keyboard.push([{ text: '🔙 Kembali', callback_data: 'main_menu' }]);

    await bot.sendMessage(chatId, `Pilih user yang akan diperpanjang (Halaman ${page}/${totalPages}):`, {
      reply_markup: { inline_keyboard: keyboard }
    });
  } catch (err) {
    await bot.sendMessage(chatId, `❌ Gagal memuat daftar user: ${err.message}`);
  }
}

// Handler List User
bot.onText(/📋 List User/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  if (!(await isAgent(userId))) {
    return bot.sendMessage(chatId, '❌ Anda tidak terdaftar sebagai agent.');
  }
  const agentId = userId;
  const page = 1;
  await showListUserMenu(chatId, agentId, page);
});

async function showListUserMenu(chatId, agentId, page = 1) {
  try {
    const { users, totalUsers, totalPages } = await listUsers(page, CONFIG.ITEMS_PER_PAGE, agentId);
    const onlineIPs = await getOnlineUserIPs();

    if (users.length === 0) {
      return await bot.sendMessage(chatId, 'Tidak ada user.');
    }

    let message = `📋 Daftar User Anda (Halaman ${page}/${totalPages}, Total: ${totalUsers}):\n`;
    users.forEach((user, index) => {
      const ipArr = onlineIPs[user.name];
      const ipText = ipArr && ipArr.length
        ? `🟢 IP: ${ipArr.join(', ')}`
        : '🔴 Offline';
      message += `${index + 1 + (page - 1) * CONFIG.ITEMS_PER_PAGE}. 👤 ${user.name}\n`;
      message += `   ⏳ Kedaluwarsa: ${user.expiry}\n`;
      message += `   ${ipText}\n\n`;
    });

    const keyboard = [];
    const navButtons = [];
    if (page > 1) navButtons.push({ text: '⏮ Prev', callback_data: `listpage_${page - 1}` });
    if (page < totalPages) navButtons.push({ text: '⏭ Next', callback_data: `listpage_${page + 1}` });
    if (navButtons.length) keyboard.push(navButtons);
    keyboard.push([{ text: '🔙 Kembali', callback_data: 'main_menu' }]);

    await bot.sendMessage(chatId, message, {
      reply_markup: { inline_keyboard: keyboard }
    });
  } catch (err) {
    await bot.sendMessage(chatId, `❌ Gagal mengambil daftar user: ${err.message}`);
  }
}

bot.onText(/📊 Statistik/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  if (!(await isAgent(userId))) {
    return bot.sendMessage(chatId, '❌ Anda tidak terdaftar sebagai agent.');
  }
  const agentId = userId;

  try {
    const { totalUsers } = await listUsers(1, 1, agentId);
    const expiryData = await loadExpiryData(agentId);
    const expiredCount = Object.values(expiryData).filter(expiry => new Date(expiry) < new Date()).length;

    const message = `📊 Statistik Anda:\n` +
                    `👥 Total User: ${totalUsers}\n` +
                    `⏳ User Kedaluwarsa: ${expiredCount}`;
    await bot.sendMessage(chatId, message);
  } catch (err) {
    await bot.sendMessage(chatId, `❌ Gagal mengambil statistik: ${err.message}`);
  }
});

// ==========================================
// HANDLER CALLBACK (AGENT VERSION)
// ==========================================
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id.toString();
  if (!(await isAgent(userId))) {
    return bot.answerCallbackQuery(query.id, { text: '❌ Anda bukan agent' });
  }
  const agentId = userId;
  const data = query.data;
  try {
    if (data === 'main_menu') {
      await showMainMenu(chatId);
      await bot.deleteMessage(chatId, query.message.message_id);
    }
    else if (data.startsWith('proto_')) {
      const protocol = data.split('_')[1];
      userState[chatId] = { 
        protocol,
        step: 'username',
        agentId,
        messageId: query.message.message_id
      };

      await bot.editMessageText('Masukkan username atau tekan "Batal" untuk kembali:', {
        chat_id: chatId,
        message_id: query.message.message_id,
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Batal', callback_data: 'main_menu' }]
          ]
        }
      });
    }
    else if (data.startsWith('delpage_')) {
      const page = parseInt(data.split('_')[1]) || 1;
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id });
      await showDeleteUserMenu(chatId, agentId, page);
      await bot.deleteMessage(chatId, query.message.message_id);
    }
    else if (data.startsWith('extendpage_')) {
      const page = parseInt(data.split('_')[1]) || 1;
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id });
      await showExtendUserMenu(chatId, agentId, page);
      await bot.deleteMessage(chatId, query.message.message_id);
    }
    else if (data.startsWith('listpage_')) {
      const page = parseInt(data.split('_')[1]) || 1;
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id });
      await showListUserMenu(chatId, agentId, page);
      await bot.deleteMessage(chatId, query.message.message_id);
    }
    else if (data.startsWith('del_')) {
      const username = data.split('_')[1];
      const deleted = await deleteUser(username, agentId);
      const message = deleted 
        ? `✅ User "${username}" berhasil dihapus`
        : `❌ User "${username}" tidak ditemukan`;
      
      await bot.editMessageText(message, {
        chat_id: chatId,
        message_id: query.message.message_id
      });
    }
    else if (data.startsWith('extend_')) {
      const username = data.split('_')[1];
      userState[chatId] = { 
        username,
        step: 'extend_days',
        agentId,
        messageId: query.message.message_id
      };

      await bot.editMessageText(`Masukkan jumlah hari untuk memperpanjang user ${username}:`, {
        chat_id: chatId,
        message_id: query.message.message_id
      });
    }
  } catch (err) {
    console.error('Error handling callback:', err);
    await bot.answerCallbackQuery(query.id, { text: '❌ Terjadi kesalahan' });
  }
});

// ==========================================
// HANDLER INPUT USER (AGENT VERSION)
// ==========================================
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  if (!(await isAgent(userId))) return;

  const text = msg.text;
  const state = userState[chatId];

  if (!state || userId !== state.agentId) return;

  try {
    if (state.step === 'username') {
      userState[chatId] = {
        ...state,
        username: text,
        step: 'days'
      };
      await bot.sendMessage(chatId, 'Masukkan jumlah hari aktif:');
    }
    else if (state.step === 'days') {
      const days = parseInt(text) || 0;
      if (days <= 0) {
        return await bot.sendMessage(chatId, '❌ Masukkan jumlah hari yang valid');
      }

      const result = await addUser(state.protocol, state.username, days, state.agentId);
      
      for (const { path: qrPath, link } of result.qrCodes) {
        await bot.sendPhoto(chatId, qrPath, { caption: link });
      }
      
      let info = `✅ User Berhasil Ditambahkan\n`;
      info += `👤 Username: ${result.username}\n`;
      info += `📡 Protokol: ${result.protocol.toUpperCase()}\n`;
      info += `📅 Kedaluwarsa: ${result.expiry}\n\n`;
      info += `🔑 Kredensial:\n`;
      info += Object.entries(result.credentials)
        .map(([k, v]) => `- ${k}: \`${v}\``).join('\n');
      
      await bot.sendMessage(chatId, info, { parse_mode: 'Markdown' });
      delete userState[chatId];
    }
    else if (state.step === 'extend_days') {
      const days = parseInt(text) || 0;
      if (days <= 0) {
        return await bot.sendMessage(chatId, '❌ Masukkan jumlah hari yang valid');
      }

      try {
        const newExpiry = await extendUserExpiry(state.username, days, state.agentId);
        await bot.sendMessage(chatId, `✅ Masa aktif user "${state.username}" berhasil diperpanjang hingga ${newExpiry}`);
        
        if (state.messageId) {
          await bot.deleteMessage(chatId, state.messageId);
        }
      } catch (err) {
        await bot.sendMessage(chatId, `❌ Gagal memperpanjang user: ${err.message}`);
      }
      
      delete userState[chatId];
      await showMainMenu(chatId);
    }
  } catch (err) {
    console.error('Error handling message:', err);
    await bot.sendMessage(chatId, '❌ Terjadi kesalahan');
    delete userState[chatId];
  }
});

// ==========================================
// INISIALISASI (AGENT VERSION)
// ==========================================
(async () => {
  try {
    await fsp.mkdir(path.dirname(CONFIG.ADMINS_FILE), { recursive: true });
    await fsp.mkdir(CONFIG.BACKUP_DIR, { recursive: true });
    await fsp.mkdir(CONFIG.CONFIGS_DIR, { recursive: true });

    console.log('🤖 Agent bot berhasil dijalankan');
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

async function isAgent(userId) {
  const agents = await loadAgents();
  return agents.includes(userId.toString());
}

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
        if (now - logTime > TWO_MINUTES) continue;
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
