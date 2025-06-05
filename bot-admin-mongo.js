// ==========================================
//          DEPENDENSI & MODUL
// ==========================================
const { MongoClient, ObjectId } = require('mongodb');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const util = require('util');
const TelegramBot = require('node-telegram-bot-api');
const qrcode = require('qrcode');
const archiver = require('archiver');

// Muat environment variables
require('dotenv').config({ path: process.env.ADMIN_ENV_PATH || '/usr/local/etc/xray/adminenv/.env' });

const execAsync = util.promisify(exec);

// ==========================================
//          KONFIGURASI UTAMA
// ==========================================
const CONFIG = {
  // Path Konfigurasi Xray
  CONFIG_PATH: process.env.CONFIG_PATH || '/usr/local/etc/xray/config.json',
  BACKUP_DIR: process.env.BACKUP_DIR || '/usr/local/etc/xray/backups/',
  DOMAIN_PATH: process.env.DOMAIN_PATH || '/usr/local/etc/xray/domain',
  CONFIGS_DIR: process.env.CONFIGS_DIR || '/var/www/html/configs/', 
  LOG_FILE: process.env.LOG_FILE || '/var/log/xray-admin-mongo.log',

  // Konfigurasi Bot
  BOT_TOKEN: process.env.BOT_TOKEN,
  ITEMS_PER_PAGE: 7,
  NOTIFICATION_GROUP_ID: process.env.NOTIFICATION_GROUP_ID || "", 
  NOTIFICATION_TOPIC_ID: process.env.NOTIFICATION_TOPIC_ID ? parseInt(process.env.NOTIFICATION_TOPIC_ID) : null,

  // Konfigurasi MongoDB
  MONGO_URI: process.env.MONGO_URI || 'mongodb://localhost:27017',
  MONGO_DB_NAME: process.env.MONGO_DB_NAME || 'xray_bot_db',

  // Batas & Default
  MAX_USERS: process.env.MAX_USERS || "2000", // Batas user global di sistem
  DEFAULT_MAX_USERS_PER_AGENT: process.env.DEFAULT_MAX_USERS_PER_AGENT || "50", // BARU: Batas user default untuk agen baru
  MAX_IP_LIMIT: process.env.MAX_IP_LIMIT || "4", // Batas IP per user
  IP_WARNING_THRESHOLD: process.env.IP_WARNING_THRESHOLD || "3", // Batas peringatan IP
  IP_CLEAN_CHECKS_RESET: process.env.IP_CLEAN_CHECKS_RESET || "2", // Reset peringatan IP setelah berapa kali bersih
  IP_MONITOR_INTERVAL: process.env.IP_MONITOR_INTERVAL || "5 * 60 * 1000",
  DEFAULT_AGENT_BALANCE: process.env.DEFAULT_AGENT_BALANCE || "0", // Saldo default untuk agen baru

  // Pengaturan Kuota Pengguna
  QUOTA_SETTINGS: {
    ENABLED: true,
    DEFAULT_QUOTA_GB: 0,
    CHECK_INTERVAL_MINUTES: 1,
    API_SERVER: '127.0.0.1:10000',
    NOTIFY_ADMIN_ON_EXCEED: true, 
  },
  // Pengaturan Auto Delete Expired Users
  AUTO_DELETE_SETTINGS: {
    ENABLED: true,
    RUN_HOUR: 3, 
    RUN_MINUTE: 0, 
    NOTIFY_ADMINS: true 
  }
};

// Template Protokol
const PROTOCOLS = {
  vless: {
    name: 'VLESS',
    inbounds: ['vless-ws', 'vless-grpc'],
    fields: ['id'],
    generateLink: (domain, user, creds) => ({
      ws: `vless://${creds.id}@${domain}:443?path=%2Fvless-ws&security=tls&encryption=none&host=${domain}&type=ws&sni=edge-ig-mqtt-p4-shv-01-gua1.facebook.com#${user}-${domain}`,
      grpc: `vless://${creds.id}@${domain}:443?security=tls&encryption=none&type=grpc&serviceName=vless-grpc&sni=${domain}#${user}-${domain}`
    })
  },
  trojan: {
    name: 'Trojan',
    inbounds: ['trojan-ws', 'trojan-grpc'],
    fields: ['password'],
    generateLink: (domain, user, creds) => ({
      ws: `trojan://${creds.password}@${domain}:443?path=%2Ftrojan-ws&security=tls&host=${domain}&type=ws&sni=static-web.prod.vidiocdn.com#${user}-${domain}`,
      grpc: `trojan://${creds.password}@${domain}:443?security=tls&type=grpc&serviceName=trojan-grpc&sni=${domain}#${user}-${domain}`
    })
  },
  vmess: {
    name: 'VMess',
    inbounds: ['vmess-ws', 'vmess-grpc'],
    fields: ['id'],
    generateLink: (domain, user, creds) => ({
      ws: `vmess://${Buffer.from(JSON.stringify({
        v: "2", ps: `${user}-${domain}`, add: domain, port: "443",
        id: creds.id, aid: "0", net: "ws", type: "none",
        host: domain, path: "/vmess", tls: "tls", sni: domain
      })).toString('base64')}`,
      grpc: `vmess://${Buffer.from(JSON.stringify({
        v: "2", ps: `${user}-${domain}`, add: domain, port: "443",
        id: creds.id, aid: "0", net: "grpc", type: "none",
        host: domain, path: "vmess-grpc", tls: "tls", sni: domain
      })).toString('base64')}`
    })
  }
};


// ==========================================
//      INISIALISASI BOT & DATABASE
// ==========================================
const bot = new TelegramBot(CONFIG.BOT_TOKEN, { polling: true });
let db; 
let userState = {}; 

async function connectToDB() {
  try {
    const client = new MongoClient(CONFIG.MONGO_URI);
    await client.connect();
    db = client.db(CONFIG.MONGO_DB_NAME);
    console.log('✅ Berhasil terhubung ke MongoDB.');

    const indexDefinitions = [
      {
        collection: 'users',
        keys: { usernameLower: 1 },
        options: { name: 'usernameLower_unique_ci', unique: true, collation: { locale: 'en', strength: 2 } }
      },
      { 
        collection: 'users',
        keys: { isActive: 1, "quota.totalBytes": 1, "quota.lastChecked": 1 },
        options: { name: 'active_users_with_quota_check', partialFilterExpression: { "quota.totalBytes": { $gt: 0 }, isActive: true } }
      },
      {
        collection: 'admins',
        keys: { userId: 1 },
        options: { name: 'admins_userId_unique', unique: true } 
      },
      {
        collection: 'agents',
        keys: { agentId: 1 },
        options: { name: 'agents_agentId_unique', unique: true } 
      },
      {
        collection: 'ip_warnings',
        keys: { username: 1 },
        options: { name: 'ipwarnings_username_unique', unique: true } 
      }
    ];

    for (const def of indexDefinitions) {
      try {
        await db.collection(def.collection).createIndex(def.keys, def.options);
        console.log(`Index '${def.options.name}' on collection '${def.collection}' ensured.`);
      } catch (e) {
        if (e.code === 85 || e.code === 86) { 
          console.warn(`⚠️ Index '${def.options.name}' on '${def.collection}' already exists or has a name conflict with different options. Message: ${e.message}. The application will attempt to continue, assuming the existing index is compatible or will be manually reviewed.`);
          await logAction('INDEX_CREATION_CONFLICT_WARNING', { collection: def.collection, indexName: def.options.name, errorCode: e.code, errorMessage: e.message });
        } else {
          console.error(`❌ Error creating index '${def.options.name}' on '${def.collection}':`, e);
          throw e; 
        }
      }
    }

  } catch (err) {
    console.error('❌ Gagal dalam proses koneksi DB atau pembuatan index kritikal:', err);
    await logAction('DB_SETUP_ERROR', { error: err.message, stack: err.stack });
    process.exit(1); 
  }
}

// ==========================================
//          FUNGSI UTILITAS & LOG
// ==========================================

async function logAction(action, details = {}) {
  const timestamp = new Date().toISOString();
  const sanitizedDetails = { ...details };
  if (sanitizedDetails.error && sanitizedDetails.error.message) {
      sanitizedDetails.errorMessage = sanitizedDetails.error.message;
      delete sanitizedDetails.error; 
  }

  const logEntry = JSON.stringify({ timestamp, action, ...sanitizedDetails }) + '\n';
  try {
    await fsp.appendFile(CONFIG.LOG_FILE, logEntry);
  } catch (err) {
    console.error('Gagal menulis log:', err);
  }
}

async function isAdmin(userId) {
  if (!db) {
    console.error("Database belum terhubung saat isAdmin dipanggil.");
    return false;
  }
  const admin = await db.collection('admins').findOne({ userId: userId.toString() });
  return !!admin;
}

async function getDomain() {
  try {
    return (await fsp.readFile(CONFIG.DOMAIN_PATH, 'utf8')).trim();
  } catch (err) {
    await logAction('DOMAIN_READ_ERROR', { error: err });
    throw new Error('Gagal membaca domain. Pastikan file domain ada di ' + CONFIG.DOMAIN_PATH);
  }
}

async function restartXray() {
  try {
    await execAsync('systemctl restart xray');
    await logAction('SERVICE_RESTART_SUCCESS');
  } catch (err) {
    await logAction('SERVICE_RESTART_FAILED', { error: err });
    throw new Error('Gagal me-restart layanan Xray.');
  }
}

function generateUUID() {
  return crypto.randomUUID();
}

function generatePassword(length = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let password = '';
  for (let i = 0; i < length; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

async function generateQR(text, filename) {
  try {
    await qrcode.toFile(filename, text, { errorCorrectionLevel: 'M' });
    return true;
  } catch (err) {
    await logAction('QR_GENERATION_FAILED', { error: err, text, filename });
    return false;
  }
}

async function readXrayConfig() {
  try {
    const data = await fsp.readFile(CONFIG.CONFIG_PATH, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    await logAction('XRAY_CONFIG_READ_ERROR', { error: err });
    throw new Error('Gagal membaca file konfigurasi Xray.');
  }
}

async function saveXrayConfig(configData) {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(CONFIG.BACKUP_DIR, `config-${timestamp}.json`);
    if (!fs.existsSync(CONFIG.BACKUP_DIR)) {
        await fsp.mkdir(CONFIG.BACKUP_DIR, { recursive: true });
    }
    if (fs.existsSync(CONFIG.CONFIG_PATH)) { 
        await fsp.copyFile(CONFIG.CONFIG_PATH, backupPath);
    }
    
    await fsp.writeFile(CONFIG.CONFIG_PATH, JSON.stringify(configData, null, 2));
    await logAction('XRAY_CONFIG_SAVED', { backupPath: fs.existsSync(backupPath) ? backupPath : "Tidak ada file asli untuk dibackup" });
  } catch (err) {
    await logAction('XRAY_CONFIG_SAVE_ERROR', { error: err });
    throw new Error('Gagal menyimpan file konfigurasi Xray.');
  }
}

async function deleteMessage(chatId, messageId) {
    if (chatId && messageId) {
        try {
            await bot.deleteMessage(chatId, messageId);
        } catch (error) {
            if (error.response && (error.response.statusCode === 400 || error.response.statusCode === 404)) {
            } else {
                await logAction('DELETE_MESSAGE_FAILED', { chatId, messageId, error: error.message });
            }
        }
    }
}

async function sendOrEditMessage(chatId, text, options, messageIdToEdit) {
    try {
        if (messageIdToEdit) {
            return await bot.editMessageText(text, { chat_id: chatId, message_id: messageIdToEdit, ...options });
        } else {
            return await bot.sendMessage(chatId, text, options);
        }
    } catch (error) {
        if (error.response && error.response.statusCode === 400 && error.response.body.description.includes("message is not modified")) {
            if (!messageIdToEdit) return await bot.sendMessage(chatId, text, options); 
            return messageIdToEdit ? { chat: {id: chatId}, message_id: messageIdToEdit } : null; 
        }
        await logAction('SEND_OR_EDIT_MESSAGE_FAILED', { chatId, error: error.message, text });
        if (messageIdToEdit) {
            try {
                return await bot.sendMessage(chatId, text, options);
            } catch (sendError) {
                await logAction('SEND_MESSAGE_FALLBACK_FAILED', { chatId, error: sendError.message, text });
            }
        }
        throw error; 
    }
}

function formatBytes(bytes, decimals = 2) {
    if (bytes === undefined || bytes === null || isNaN(bytes) || bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// ==========================================
//          FUNGSI MANAJEMEN MENU
// ==========================================

async function showMainMenu(chatId, messageId) {
  const text = '🤖 **Xray Admin Bot (MongoDB Edition)**\n\nSilakan pilih menu di bawah ini:';
  let inline_keyboard = [
      [{ text: '➕ Tambah User', callback_data: 'user_add_menu' }, { text: '🗑 Hapus User', callback_data: 'user_delete_list_1' }],
      [{ text: '⏳ Perpanjang User', callback_data: 'user_extend_list_1' }, { text: '📋 List Semua User', callback_data: 'user_list_all_1' }],
      [{ text: '👥 Manajemen Admin', callback_data: 'admin_menu' }, { text: '👤 Manajemen Agent', callback_data: 'agent_menu' }], 
      [{ text: '📊 Statistik Sistem', callback_data: 'stats_view' }, { text: '🔄 Restart Xray', callback_data: 'service_restart' }],
      [{ text: '🧹 Bersihkan Expired', callback_data: 'user_cleanup' }, { text: '💾 Backup Sistem', callback_data: 'backup_create' }],
      [{ text: '📡 Cek IP Online', callback_data: 'user_online_ips_1' }]
    ];

  const reply_markup = { inline_keyboard };
  await sendOrEditMessage(chatId, text, { reply_markup, parse_mode: 'Markdown' }, messageId);
}

// ==========================================
//      HANDLER CALLBACK QUERY UTAMA
// ==========================================

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id; 
  const data = query.data;
  const messageId = query.message.message_id;

  if (!(await isAdmin(userId))) {
    return bot.answerCallbackQuery(query.id, { text: '❌ Anda tidak memiliki hak akses.', show_alert: true });
  }

  if (userState[chatId] && !data.startsWith(userState[chatId].expectedCallbackPrefix || '___nevermatch___')) {
     if (userState[chatId].messageId && userState[chatId].messageId !== messageId) {
     }
     delete userState[chatId];
  }

  const [action, ...params] = data.split('_');

  try {
    switch (action) {
      case 'main': 
        await showMainMenu(chatId, messageId);
        break;
      
      case 'user':
        await handleUserCallbacks(query, action, params); 
        break;
      
      case 'admin':
        await handleAdminCallbacks(query, action, params);
        break;

      case 'agent': 
        await handleAgentManagementCallbacks(query, action, params);
        break;
      
      case 'service':
        if (params[0] === 'restart') {
          await bot.answerCallbackQuery(query.id, { text: '⏳ Merestart layanan Xray...' });
          try {
            await restartXray();
            await bot.editMessageText('✅ Layanan Xray berhasil direstart.', { chat_id: chatId, message_id: messageId });
          } catch (err) {
            await bot.editMessageText(`❌ Gagal merestart layanan: ${err.message}`, { chat_id: chatId, message_id: messageId });
          }
          setTimeout(() => showMainMenu(chatId, null), 2000);
        }
        break;
      
      case 'stats':
        if (params[0] === 'view') {
          await displayStats(chatId, messageId, query); 
        }
        break;
      
      case 'backup':
        if (params[0] === 'create') {
          await bot.answerCallbackQuery(query.id, { text: '⏳ Membuat backup sistem...' });
          try {
            const backupPath = await createSystemBackup(chatId); 
            if (backupPath) {
                await bot.sendDocument(chatId, backupPath, { caption: `✅ Backup sistem berhasil dibuat: ${path.basename(backupPath)}` });
                await fsp.unlink(backupPath); 
                await bot.editMessageText('✅ Backup berhasil dibuat dan dikirim.', {chat_id: chatId, message_id: messageId});
            } else {
                 await bot.editMessageText('❌ Gagal membuat file backup.', {chat_id: chatId, message_id: messageId});
            }
          } catch (err) {
            await logAction('BACKUP_FAILED', { error: err }); 
            await bot.editMessageText(`❌ Gagal membuat backup: ${err.message}`, { chat_id: chatId, message_id: messageId });
          }
           setTimeout(() => showMainMenu(chatId, null), 2000);
        }
        break;
      
      case 'cancel': 
        delete userState[chatId];
        try {
            await bot.editMessageText('Aksi dibatalkan.', { chat_id: chatId, message_id: messageId });
        } catch (e) {
            if (e.response && e.response.statusCode === 400) { 
                 await bot.sendMessage(chatId, 'Aksi dibatalkan.');
            } else {
                await logAction("CANCEL_EDIT_ERROR", {error: e.message});
            }
        }
        await showMainMenu(chatId, null); 
        break;

      default:
        if (!query.answered) {
            await bot.answerCallbackQuery(query.id).catch(e => logAction("DEFAULT_ANSWER_CALLBACK_ERROR", {data, error: e.message}));
        }
        break;
    }
    if (!query.answered) {
        await bot.answerCallbackQuery(query.id).catch(e => logAction("FINAL_ANSWER_CALLBACK_ERROR", {data, error: e.message}));
    }

  } catch (error) {
    await logAction('CALLBACK_HANDLER_ERROR', { userId, data, error: error.message, stack: error.stack });
    try {
        if (!query.answered) { 
            await bot.answerCallbackQuery(query.id, { text: '❌ Terjadi kesalahan sistem.', show_alert: true });
        }
    } catch (e) { /* ignore */ }
  }
});


// ==========================================
//          HANDLER PESAN TEKS
// ==========================================

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id; 
  const text = msg.text;

  if (text === '/gettopicinfo') {
    if (msg.is_topic_message && msg.message_thread_id) {
      await bot.sendMessage(chatId, `ℹ️ **Info Topik/Grup**\n\nID Grup (Chat ID): \`${msg.chat.id}\`\nID Topik (Message Thread ID): \`${msg.message_thread_id}\`\n\nSalin ID Topik jika Anda ingin notifikasi dikirim ke topik ini.`, {
        message_thread_id: msg.message_thread_id, 
        parse_mode: 'Markdown'
      });
    } else if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
      await bot.sendMessage(chatId, `ℹ️ **Info Grup**\n\nIni adalah chat grup utama (bukan topik).\nID Grup (Chat ID): \`${msg.chat.id}\``, {parse_mode: 'Markdown'});
    } else {
      await bot.sendMessage(chatId, `Perintah ini hanya berfungsi di dalam grup atau topik grup.`);
    }
    return; 
  }


  if (!(await isAdmin(userId))) {
    if (text === '/start') { 
        await bot.sendMessage(chatId, '❌ Anda bukan admin terdaftar. Hubungi pemilik bot untuk mendapatkan akses.');
    }
    return;
  }
  
  if (text === '/start') {
    delete userState[chatId]; 
    await showMainMenu(chatId);
    await deleteMessage(chatId, msg.message_id); 
    return;
  }
  
  const state = userState[chatId];
  if (!state || state.adminId.toString() !== userId.toString()) {
    return;
  }

  if (state.promptMessageId) {
    await deleteMessage(chatId, state.promptMessageId);
  }
  await deleteMessage(chatId, msg.message_id); 

  try {
    if (state.handler) {
        await state.handler(chatId, text.trim(), state, msg);
    } else {
        await logAction("INVALID_STATE_NO_HANDLER", {chatId, state});
        delete userState[chatId];
        await bot.sendMessage(chatId, "❌ Terjadi kesalahan pada state input. Silakan coba lagi dari menu utama.");
        await showMainMenu(chatId);
    }
  } catch (error) {
    await logAction('TEXT_MESSAGE_HANDLER_ERROR', { userId, text, state, error: error.message, stack: error.stack });
    await bot.sendMessage(chatId, `❌ Terjadi kesalahan: ${error.message}. Silakan coba lagi.`);
    delete userState[chatId]; 
    await showMainMenu(chatId); 
  }
});


// ==========================================
//      FUNGSI-FUNGSI MANAJEMEN SPESIFIK
// ==========================================

// --- Manajemen Admin ---
async function handleAdminCallbacks(query, action, params) {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const currentAdminId = query.from.id.toString();

    switch (params[0]) { 
        case 'menu':
            const adminMenuText = "👥 **Manajemen Admin**\n\nPilih salah satu opsi:";
            const adminMenuKeyboard = {
                inline_keyboard: [
                    [{ text: '➕ Tambah Admin Baru', callback_data: 'admin_add_prompt' }],
                    [{ text: '➖ Hapus Admin', callback_data: 'admin_remove_list' }],
                    [{ text: '📋 Lihat Daftar Admin', callback_data: 'admin_list_view' }],
                    [{ text: '🔙 Kembali ke Menu Utama', callback_data: 'main_menu' }]
                ]
            };
            await sendOrEditMessage(chatId, adminMenuText, { reply_markup: adminMenuKeyboard, parse_mode: 'Markdown' }, messageId);
            break;

        case 'list': 
            const admins = await db.collection('admins').find().toArray();
            let adminListText = "📋 **Daftar Admin Terdaftar:**\n";
            if (admins.length > 0) {
                admins.forEach((admin, index) => {
                    adminListText += `${index + 1}. ID: \`${admin.userId}\` ${admin.userId === currentAdminId ? '(Anda)' : ''} ${admin.role === 'superadmin' ? '👑' : ''}\n`;
                });
            } else {
                adminListText += "Tidak ada admin terdaftar."; 
            }
            await sendOrEditMessage(chatId, adminListText, {
                reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali ke Menu Admin', callback_data: 'admin_menu' }]] },
                parse_mode: 'Markdown'
            }, messageId);
            break;

        case 'add': 
            const promptAdminId = await bot.sendMessage(chatId, "Masukkan ID Telegram numerik untuk admin baru:", {
                reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'admin_menu' }]] }
            });
            userState[chatId] = {
                adminId: currentAdminId, 
                step: 'admin_add_receive_id',
                promptMessageId: promptAdminId.message_id,
                originalMenuMessageId: messageId, 
                handler: handleAdminAddReceiveId,
                expectedCallbackPrefix: 'admin' 
            };
            break;
        
        case 'remove': 
            const allAdmins = await db.collection('admins').find({ userId: { $ne: currentAdminId } }).toArray(); 
            if (allAdmins.length === 0) {
                await bot.answerCallbackQuery(query.id, { text: 'ℹ️ Tidak ada admin lain untuk dihapus.', show_alert: true });
                return;
            }
            const removeAdminKeyboard = allAdmins.map(admin => ([{ text: `Hapus ${admin.userId} ${admin.role === 'superadmin' ? '👑' : ''}`, callback_data: `admin_remove_confirm_${admin.userId}` }]));
            removeAdminKeyboard.push([{ text: '🔙 Kembali ke Menu Admin', callback_data: 'admin_menu' }]);
            await sendOrEditMessage(chatId, "Pilih admin yang ingin dihapus:", { reply_markup: { inline_keyboard: removeAdminKeyboard } }, messageId);
            break;

        case 'removeconfirm': 
            const adminIdToRemove = params[1];
            if (adminIdToRemove === currentAdminId) {
                await bot.answerCallbackQuery(query.id, { text: '❌ Anda tidak bisa menghapus diri sendiri.', show_alert: true });
                return;
            }
            const adminToRemoveDoc = await db.collection('admins').findOne({ userId: adminIdToRemove });
            const superAdminCount = await db.collection('admins').countDocuments({ role: 'superadmin' });

            if (adminToRemoveDoc && adminToRemoveDoc.role === 'superadmin' && superAdminCount <= 1) {
                 await bot.answerCallbackQuery(query.id, { text: '❌ Tidak bisa menghapus superadmin terakhir. Harus ada minimal satu superadmin.', show_alert: true });
                 return;
            }

            try {
                const result = await db.collection('admins').deleteOne({ userId: adminIdToRemove });
                if (result.deletedCount > 0) {
                    await logAction('ADMIN_REMOVED', { adminId: currentAdminId, removedAdmin: adminIdToRemove });
                    await bot.answerCallbackQuery(query.id, { text: `✅ Admin ${adminIdToRemove} berhasil dihapus.` });
                    
                    const updatedAdmins = await db.collection('admins').find({ userId: { $ne: currentAdminId } }).toArray();
                     if (updatedAdmins.length === 0) {
                        await sendOrEditMessage(chatId, "Semua admin lain telah dihapus.", { reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali ke Menu Admin', callback_data: 'admin_menu' }]] } }, messageId);
                     } else {
                        const refreshKeyboard = updatedAdmins.map(admin => ([{ text: `Hapus ${admin.userId} ${admin.role === 'superadmin' ? '👑' : ''}`, callback_data: `admin_remove_confirm_${admin.userId}` }]));
                        refreshKeyboard.push([{ text: '🔙 Kembali ke Menu Admin', callback_data: 'admin_menu' }]);
                        await sendOrEditMessage(chatId, "Pilih admin yang ingin dihapus:", { reply_markup: { inline_keyboard: refreshKeyboard } }, messageId);
                     }
                } else {
                    await bot.answerCallbackQuery(query.id, { text: `⚠️ Admin ${adminIdToRemove} tidak ditemukan.`, show_alert: true });
                }
            } catch (err) {
                await logAction('ADMIN_REMOVE_ERROR', { error: err, adminIdToRemove });
                await bot.answerCallbackQuery(query.id, { text: '❌ Gagal menghapus admin.', show_alert: true });
            }
            break;
        default:
             break;
    }
}

async function handleAdminAddReceiveId(chatId, text, state) {
    const newAdminId = text.trim();
    if (!/^\d+$/.test(newAdminId)) {
        const newPrompt = await bot.sendMessage(chatId, "❌ ID Telegram tidak valid. Harap masukkan ID numerik saja.");
        userState[chatId].promptMessageId = newPrompt.message_id; 
        return; 
    }

    try {
        const existingAdmin = await db.collection('admins').findOne({ userId: newAdminId });
        if (existingAdmin) {
            await bot.sendMessage(chatId, `⚠️ Admin dengan ID \`${newAdminId}\` sudah terdaftar.`);
        } else {
            await db.collection('admins').insertOne({ userId: newAdminId, createdAt: new Date(), addedBy: state.adminId, role: 'admin' }); 
            await logAction('ADMIN_ADDED', { adminId: state.adminId, newAdmin: newAdminId });
            await bot.sendMessage(chatId, `✅ Admin dengan ID \`${newAdminId}\` berhasil ditambahkan.`);
            try {
                await bot.sendMessage(newAdminId, `🎉 Anda telah ditambahkan sebagai admin oleh ${state.adminId}. Ketik /start untuk memulai.`);
            } catch (e) {
                await logAction('ADMIN_ADDED_NOTIFICATION_FAILED', { newAdminId, error: e.message });
                await bot.sendMessage(chatId, `ℹ️ Gagal mengirim notifikasi ke admin baru. Mungkin bot diblokir atau ID salah.`);
            }
        }
    } catch (err) {
        await logAction('ADMIN_ADD_ERROR', { error: err, newAdminId });
        await bot.sendMessage(chatId, '❌ Gagal menambahkan admin baru karena kesalahan database.');
    }
    
    delete userState[chatId];
    const adminMenuText = "👥 **Manajemen Admin**\n\nPilih salah satu opsi:";
    const adminMenuKeyboard = {
        inline_keyboard: [
            [{ text: '➕ Tambah Admin Baru', callback_data: 'admin_add_prompt' }],
            [{ text: '➖ Hapus Admin', callback_data: 'admin_remove_list' }],
            [{ text: '📋 Lihat Daftar Admin', callback_data: 'admin_list_view' }],
            [{ text: '🔙 Kembali ke Menu Utama', callback_data: 'main_menu' }]
        ]
    };
    if (state.originalMenuMessageId) {
        await sendOrEditMessage(chatId, adminMenuText, { reply_markup: adminMenuKeyboard, parse_mode: 'Markdown' }, state.originalMenuMessageId);
    } else {
        await bot.sendMessage(chatId, adminMenuText, { reply_markup: adminMenuKeyboard, parse_mode: 'Markdown' });
    }
}

// --- Manajemen Agent ---
async function handleAgentManagementCallbacks(query, action, params) {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const currentAdminId = query.from.id.toString(); 

    const subAction = params[0]; 
    const subParams = params.slice(1);

    switch (subAction) {
        case 'menu':
            const agentMenuText = "👤 **Manajemen Agent**\n\nPilih salah satu opsi:";
            const agentMenuKeyboard = {
                inline_keyboard: [
                    [{ text: '➕ Tambah Agent Baru', callback_data: 'agent_add_promptid' }], // Diubah ke promptid
                    [{ text: '➖ Hapus Agent', callback_data: 'agent_remove_list_1' }],
                    [{ text: '📋 List Semua Agent', callback_data: 'agent_list_all_1' }],
                    [{ text: '💰 Tambah Saldo Agent', callback_data: 'agent_balance_add_select_1' }],
                    [{ text: '💲 Cek Saldo Agent', callback_data: 'agent_balance_check_select_1' }],
                    [{ text: '👀 Lihat User Milik Agent', callback_data: 'agent_viewusers_select_1' }],
                    [{ text: '⚙️ Setel Batas User Agen', callback_data: 'agent_setmaxusers_select_1'}], // BARU
                    [{ text: '🔙 Kembali ke Menu Utama', callback_data: 'main_menu' }]
                ]
            };
            await sendOrEditMessage(chatId, agentMenuText, { reply_markup: agentMenuKeyboard, parse_mode: 'Markdown' }, messageId);
            break;

        case 'add': // Diubah: Alur tambah agen sekarang meminta ID dulu, baru batas user
            if (subParams[0] === 'promptid') {
                const promptAgentId = await bot.sendMessage(chatId, "Masukkan ID Telegram numerik untuk agent baru:", {
                    reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'agent_menu' }]] }
                });
                userState[chatId] = {
                    adminId: currentAdminId,
                    step: 'agent_add_receive_id', // Step pertama: terima ID
                    promptMessageId: promptAgentId.message_id,
                    originalMenuMessageId: messageId, 
                    handler: handleAgentAddReceiveId, // Handler untuk ID
                    expectedCallbackPrefix: 'agent_add' 
                };
            }
            break;
        
        case 'list': 
             if (subParams[0] === 'all') {
                const page = parseInt(subParams[1] || 1);
                await displayAgentList(chatId, messageId, page, 'all'); 
            }
            break;

        case 'remove': 
            if (subParams[0] === 'list') {
                const page = parseInt(subParams[1] || 1);
                await displayAgentList(chatId, messageId, page, 'remove');
            } else if (subParams[0] === 'confirm') {
                const agentIdToRemove = subParams[1];
                const agentUserCount = await db.collection('users').countDocuments({ agentId: agentIdToRemove });
                let confirmText = `⚠️ Anda yakin ingin menghapus agent dengan ID \`${agentIdToRemove}\`?\n`;
                if (agentUserCount > 0) {
                    confirmText += `Agent ini memiliki ${agentUserCount} user. User-user tersebut TIDAK akan otomatis terhapus dari sistem Xray atau database user, namun tidak akan bisa dikelola lagi oleh agent ini.\n\n`;
                }
                confirmText += `Aksi ini tidak dapat diurungkan.`;

                const confirmKeyboard = [
                    [{ text: `✔️ YA, HAPUS AGENT ${agentIdToRemove}`, callback_data: `agent_remove_execute_${agentIdToRemove}` }],
                    [{ text: `❌ TIDAK, BATAL`, callback_data: `agent_remove_list_1` }]
                ];
                await sendOrEditMessage(chatId, confirmText, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: confirmKeyboard }
                }, messageId);
            } else if (subParams[0] === 'execute') {
                const agentIdToRemove = subParams[1];
                await bot.answerCallbackQuery(query.id, { text: `⏳ Menghapus agent ${agentIdToRemove}...` });
                try {
                    const result = await db.collection('agents').deleteOne({ agentId: agentIdToRemove });
                    if (result.deletedCount > 0) {
                        await logAction('AGENT_REMOVED', { adminId: currentAdminId, removedAgentId: agentIdToRemove });
                        await bot.editMessageText(`✅ Agent \`${agentIdToRemove}\` berhasil dihapus dari daftar agen.`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
                        try {
                            await bot.sendMessage(agentIdToRemove, "Akun agen Anda telah dihapus oleh admin.");
                        } catch (e) { /* ignore */ }
                    } else {
                        await bot.editMessageText(`❌ Agent \`${agentIdToRemove}\` tidak ditemukan.`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
                    }
                } catch (err) {
                    await logAction('AGENT_REMOVE_EXECUTE_ERROR', { error: err, agentIdToRemove, adminId: currentAdminId });
                    await bot.editMessageText(`❌ Terjadi kesalahan sistem saat menghapus agent \`${agentIdToRemove}\`.`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
                }
                setTimeout(() => displayAgentList(chatId, null, 1, 'remove'), 2000);
            }
            break;

        case 'balance': 
            if (subParams[0] === 'add' && subParams[1] === 'select') { 
                const page = parseInt(subParams[2] || 1);
                await displayAgentList(chatId, messageId, page, 'balance_add');
            } else if (subParams[0] === 'add' && subParams[1] === 'setamount') { 
                const agentIdForBalance = subParams[2];
                const promptAmount = await bot.sendMessage(chatId, `Masukkan jumlah saldo yang ingin ditambahkan untuk agent \`${agentIdForBalance}\` (contoh: 50000):`, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'agent_balance_add_select_1' }]] } 
                });
                userState[chatId] = {
                    adminId: currentAdminId,
                    step: 'agent_balance_add_receive_amount',
                    targetAgentId: agentIdForBalance,
                    promptMessageId: promptAmount.message_id,
                    originalMenuMessageId: messageId, 
                    handler: handleAgentBalanceAddReceiveAmount,
                    expectedCallbackPrefix: 'agent_balance_add' 
                };
            } else if (subParams[0] === 'check' && subParams[1] === 'select') { 
                const page = parseInt(subParams[2] || 1);
                await displayAgentList(chatId, messageId, page, 'balance_check');
            } else if (subParams[0] === 'check' && subParams[1] === 'view') { 
                const agentIdToCheck = subParams[2];
                const agentDoc = await db.collection('agents').findOne({ agentId: agentIdToCheck });
                let balanceText;
                if (agentDoc) {
                    balanceText = `💰 Saldo agent \`${agentIdToCheck}\` saat ini adalah: **${(agentDoc.balance || 0).toLocaleString('id-ID', { style: 'currency', currency: 'IDR' })}**`;
                } else {
                    balanceText = `⚠️ Agent \`${agentIdToCheck}\` tidak ditemukan.`;
                }
                await sendOrEditMessage(chatId, balanceText, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali ke List Agent (Cek Saldo)', callback_data: 'agent_balance_check_select_1' }]] }
                }, messageId);
            }
            break;

        case 'viewusers': 
            if (subParams[0] === 'select') { 
                const page = parseInt(subParams[1] || 1);
                await displayAgentList(chatId, messageId, page, 'viewusers');
            } else if (subParams[0] === 'list') { 
                const agentIdToView = subParams[1];
                const page = parseInt(subParams[2] || 1);
                await displayUserList(chatId, messageId, page, 'agent_specific', agentIdToView); 
            }
            break;
        case 'setmaxusers': // BARU: Untuk mengatur batas user agen
            if (subParams[0] === 'select') { // agent_setmaxusers_select_PAGE
                const page = parseInt(subParams[1] || 1);
                await displayAgentList(chatId, messageId, page, 'setmaxusers'); // Mode baru untuk list
            } else if (subParams[0] === 'promptlimit') { // agent_setmaxusers_promptlimit_AGENTID
                const agentIdToSetLimit = subParams[1];
                const agentToSet = await db.collection('agents').findOne({ agentId: agentIdToSetLimit });
                if (!agentToSet) {
                    await bot.answerCallbackQuery(query.id, {text: "Agen tidak ditemukan.", show_alert: true});
                    return;
                }
                const currentLimit = agentToSet.maxUsers || CONFIG.DEFAULT_MAX_USERS_PER_AGENT;

                const promptLimitMsg = await bot.editMessageText(
                    `Agen: \`${agentIdToSetLimit}\`\nBatas User Saat Ini: ${currentLimit}\n\nMasukkan batas maksimal user baru untuk agen ini (angka, misal: 100). Kosongkan untuk menggunakan default (${CONFIG.DEFAULT_MAX_USERS_PER_AGENT}).`,
                    {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'agent_setmaxusers_select_1' }]] }
                    }
                );
                userState[chatId] = {
                    adminId: currentAdminId,
                    step: 'agent_setmaxusers_receive_limit',
                    targetAgentId: agentIdToSetLimit,
                    promptMessageId: promptLimitMsg.message_id,
                    originalMenuMessageId: messageId, 
                    handler: handleAgentSetMaxUsersReceiveLimit,
                    expectedCallbackPrefix: 'agent_setmaxusers'
                };
            }
            break;
        default:
            break;
    }
}

async function handleAgentAddReceiveId(chatId, text, state) {
    const newAgentId = text.trim();
    if (!/^\d+$/.test(newAgentId)) {
        const newPrompt = await bot.sendMessage(chatId, "❌ ID Telegram tidak valid. Harap masukkan ID numerik saja.");
        userState[chatId].promptMessageId = newPrompt.message_id;
        return;
    }

    const existingAgent = await db.collection('agents').findOne({ agentId: newAgentId });
    if (existingAgent) {
        await bot.sendMessage(chatId, `⚠️ Agent dengan ID \`${newAgentId}\` sudah terdaftar.`);
        delete userState[chatId];
        await handleAgentManagementCallbacks({ message: { chat: { id: chatId }, message_id: state.originalMenuMessageId }, from: { id: state.adminId }, data: 'agent_menu'}, 'agent', ['menu']);
        return;
    }
    
    // Lanjutkan ke step meminta batas user
    userState[chatId].newAgentId = newAgentId; // Simpan ID agen yang baru
    userState[chatId].step = 'agent_add_receive_maxusers';
    userState[chatId].handler = handleAgentAddReceiveMaxUsers;
    
    const promptMaxUsers = await bot.sendMessage(chatId, `ID Agen: \`${newAgentId}\`.\nMasukkan batas maksimal user untuk agen ini (angka, contoh: 100). Kosongkan untuk menggunakan default (${CONFIG.DEFAULT_MAX_USERS_PER_AGENT}).`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'agent_menu' }]] }
    });
    userState[chatId].promptMessageId = promptMaxUsers.message_id;
    // originalMenuMessageId sudah ada dari step sebelumnya
}

async function handleAgentAddReceiveMaxUsers(chatId, text, state) {
    const maxUsersInput = text.trim();
    let maxUsers;

    if (maxUsersInput === '') {
        maxUsers = CONFIG.DEFAULT_MAX_USERS_PER_AGENT;
    } else {
        maxUsers = parseInt(maxUsersInput);
        if (isNaN(maxUsers) || maxUsers < 0) {
            const newPrompt = await bot.sendMessage(chatId, "❌ Batas maksimal user tidak valid. Masukkan angka positif, atau kosongkan untuk default.");
            userState[chatId].promptMessageId = newPrompt.message_id;
            return;
        }
    }

    const newAgentId = state.newAgentId; // Ambil ID agen dari state

    try {
        // Cek lagi jika agen sudah ada (kemungkinan kecil, tapi untuk keamanan)
        const existingAgent = await db.collection('agents').findOne({ agentId: newAgentId });
        if (existingAgent) {
            await bot.sendMessage(chatId, `⚠️ Agent dengan ID \`${newAgentId}\` sudah terdaftar (konflik).`);
        } else {
            await db.collection('agents').insertOne({
                agentId: newAgentId,
                balance: CONFIG.DEFAULT_AGENT_BALANCE, 
                maxUsers: maxUsers, // Simpan batas user
                createdAt: new Date(),
                addedBy: state.adminId,
                isActive: true 
            });
            await logAction('AGENT_ADDED', { adminId: state.adminId, newAgentId, maxUsers });
            await bot.sendMessage(chatId, `✅ Agent \`${newAgentId}\` berhasil ditambahkan.\nSaldo awal: ${CONFIG.DEFAULT_AGENT_BALANCE.toLocaleString('id-ID', {style: 'currency', currency: 'IDR'})}.\nBatas User: ${maxUsers}.`);
            try {
                await bot.sendMessage(newAgentId, `🎉 Akun Anda telah didaftarkan sebagai agen oleh admin ${state.adminId}. Saldo awal: ${CONFIG.DEFAULT_AGENT_BALANCE.toLocaleString('id-ID', {style: 'currency', currency: 'IDR'})}. Batas user Anda: ${maxUsers}. Ketik /start untuk memulai.`);
            } catch (e) {
                await logAction('AGENT_ADDED_NOTIFICATION_FAILED', { newAgentId, error: e.message });
                await bot.sendMessage(chatId, `ℹ️ Gagal mengirim notifikasi ke agent baru. Mungkin bot diblokir atau ID salah.`);
            }
        }
    } catch (err) {
        await logAction('AGENT_ADD_DB_ERROR', { error: err, newAgentId, adminId: state.adminId });
        await bot.sendMessage(chatId, '❌ Gagal menambahkan agent baru karena kesalahan database.');
    }
    
    delete userState[chatId];
    if (state.originalMenuMessageId) {
        await handleAgentManagementCallbacks({ message: { chat: { id: chatId }, message_id: state.originalMenuMessageId }, from: { id: state.adminId }, data: 'agent_menu'}, 'agent', ['menu']);
    } else {
        await handleAgentManagementCallbacks({ message: { chat: { id: chatId }}, from: { id: state.adminId }, data: 'agent_menu'}, 'agent', ['menu']);
    }
}


async function handleAgentSetMaxUsersReceiveLimit(chatId, text, state) {
    const maxUsersInput = text.trim();
    let newMaxUsers;

    if (maxUsersInput === '') {
        newMaxUsers = CONFIG.DEFAULT_MAX_USERS_PER_AGENT;
    } else {
        newMaxUsers = parseInt(maxUsersInput);
        if (isNaN(newMaxUsers) || newMaxUsers < 0) {
            const newPrompt = await bot.sendMessage(chatId, "❌ Batas maksimal user tidak valid. Masukkan angka positif, atau kosongkan untuk default.\n\nMasukkan batas lagi:");
            userState[chatId].promptMessageId = newPrompt.message_id;
            return;
        }
    }

    const agentIdToUpdate = state.targetAgentId;

    try {
        const result = await db.collection('agents').updateOne(
            { agentId: agentIdToUpdate },
            { $set: { maxUsers: newMaxUsers, updatedAt: new Date(), lastUpdatedBy: state.adminId } }
        );

        if (result.modifiedCount > 0) {
            await logAction('AGENT_MAX_USERS_SET', { adminId: state.adminId, targetAgentId: agentIdToUpdate, newMaxUsers });
            await bot.sendMessage(chatId, `✅ Batas maksimal user untuk agen \`${agentIdToUpdate}\` berhasil diubah menjadi ${newMaxUsers}.`);
        } else {
            await bot.sendMessage(chatId, `⚠️ Tidak ada perubahan pada batas user agen \`${agentIdToUpdate}\`. Mungkin agen tidak ditemukan atau batas sudah sama.`);
        }
    } catch (err) {
        await logAction('AGENT_MAX_USERS_SET_ERROR', { error: err, targetAgentId: agentIdToUpdate, newMaxUsers });
        await bot.sendMessage(chatId, `❌ Gagal mengubah batas user agen: ${err.message}`);
    }

    delete userState[chatId];
    // Kembali ke menu manajemen agen
    if (state.originalMenuMessageId) {
         await handleAgentManagementCallbacks({ message: { chat: { id: chatId }, message_id: state.originalMenuMessageId }, from: { id: state.adminId }, data: 'agent_menu'}, 'agent', ['menu']);
    } else {
        await handleAgentManagementCallbacks({ message: { chat: { id: chatId }}, from: { id: state.adminId }, data: 'agent_menu'}, 'agent', ['menu']);
    }
}


async function handleAgentBalanceAddReceiveAmount(chatId, text, state) {
    const amount = parseFloat(text.trim());
    if (isNaN(amount) || amount <= 0) {
        const newPrompt = await bot.sendMessage(chatId, "❌ Jumlah saldo tidak valid. Masukkan angka positif.\n\nMasukkan jumlah saldo lagi:");
        userState[chatId].promptMessageId = newPrompt.message_id;
        return;
    }

    try {
        const agentToUpdate = await db.collection('agents').findOne({ agentId: state.targetAgentId });
        if (!agentToUpdate) {
            await bot.sendMessage(chatId, `⚠️ Agent dengan ID \`${state.targetAgentId}\` tidak ditemukan.`);
        } else {
            const result = await db.collection('agents').updateOne(
                { agentId: state.targetAgentId },
                { $inc: { balance: amount }, $set: { lastUpdatedBy: state.adminId, updatedAt: new Date() } }
            );
            if (result.modifiedCount > 0 || result.upsertedCount > 0) { 
                const newBalance = (agentToUpdate.balance || 0) + amount;
                await logAction('AGENT_BALANCE_ADDED', { adminId: state.adminId, targetAgentId: state.targetAgentId, amountAdded: amount, newBalance });
                await bot.sendMessage(chatId, `✅ Saldo berhasil ditambahkan.\nAgent: \`${state.targetAgentId}\`\nJumlah Ditambah: ${amount.toLocaleString('id-ID', {style: 'currency', currency: 'IDR'})}\nSaldo Baru: ${newBalance.toLocaleString('id-ID', {style: 'currency', currency: 'IDR'})}`);
                try {
                    await bot.sendMessage(state.targetAgentId, `💰 Saldo Anda telah ditambahkan sebesar ${amount.toLocaleString('id-ID', {style: 'currency', currency: 'IDR'})} oleh admin. Saldo baru Anda: ${newBalance.toLocaleString('id-ID', {style: 'currency', currency: 'IDR'})}.`);
                } catch (e) {
                    await logAction('AGENT_BALANCE_NOTIFICATION_FAILED', { targetAgentId: state.targetAgentId, error: e.message });
                }
            } else {
                 await bot.sendMessage(chatId, `ℹ️ Tidak ada perubahan saldo untuk agent \`${state.targetAgentId}\`. Mungkin ID salah atau tidak ada perubahan (saldo sudah sama).`);
            }
        }
    } catch (err) {
        await logAction('AGENT_BALANCE_ADD_ERROR', { error: err, targetAgentId: state.targetAgentId, amount, adminId: state.adminId });
        await bot.sendMessage(chatId, '❌ Gagal menambahkan saldo agent karena kesalahan database.');
    }
    
    delete userState[chatId];
    if (state.originalMenuMessageId) {
        await handleAgentManagementCallbacks({ message: { chat: { id: chatId }, message_id: state.originalMenuMessageId }, from: { id: state.adminId }, data: 'agent_menu'}, 'agent', ['menu']);
    } else {
        await handleAgentManagementCallbacks({ message: { chat: { id: chatId }}, from: { id: state.adminId }, data: 'agent_menu'}, 'agent', ['menu']);
    }
}

async function displayAgentList(chatId, messageId, page, mode = 'all') { 
    page = Math.max(1, page);
    const skip = (page - 1) * CONFIG.ITEMS_PER_PAGE;

    const agents = await db.collection('agents').find().sort({ createdAt: -1 }).skip(skip).limit(CONFIG.ITEMS_PER_PAGE).toArray();
    const totalAgents = await db.collection('agents').countDocuments();
    const totalPages = Math.ceil(totalAgents / CONFIG.ITEMS_PER_PAGE);

    let listText = `📋 **Daftar Agen (Halaman ${page}/${totalPages}) - Total: ${totalAgents}**\n\n`;
    const keyboardRows = [];

    if (agents.length === 0) {
        listText += "Tidak ada agen terdaftar.";
    } else {
        for (const agent of agents) { 
            listText += `👤 ID: \`${agent.agentId}\`\n`;
            listText += `   Saldo: ${(agent.balance || 0).toLocaleString('id-ID', { style: 'currency', currency: 'IDR' })}\n`;
            const userCount = await db.collection('users').countDocuments({ agentId: agent.agentId });
            listText += `   Jumlah User Dibuat: ${userCount}\n`;
            listText += `   Batas User: ${agent.maxUsers === undefined ? CONFIG.DEFAULT_MAX_USERS_PER_AGENT : agent.maxUsers}\n`; // Tampilkan batas user
            listText += `   Terdaftar: ${new Date(agent.createdAt).toLocaleDateString('id-ID', {timeZone:'Asia/Jakarta'})}\n`;
            
            let callback_data_action = '';
            let button_text_action = '';

            switch(mode) {
                case 'remove':
                    button_text_action = `🗑 Hapus ${agent.agentId}`;
                    callback_data_action = `agent_remove_confirm_${agent.agentId}`;
                    break;
                case 'balance_add':
                    button_text_action = `💰 Tambah Saldo ke ${agent.agentId}`;
                    callback_data_action = `agent_balance_add_setamount_${agent.agentId}`;
                    break;
                case 'balance_check':
                    button_text_action = `💲 Cek Saldo ${agent.agentId}`;
                    callback_data_action = `agent_balance_check_view_${agent.agentId}`;
                    break;
                case 'viewusers':
                    button_text_action = `👀 Lihat User ${agent.agentId}`;
                    callback_data_action = `agent_viewusers_list_${agent.agentId}_1`; 
                    break;
                case 'setmaxusers': // BARU: Tombol untuk setel batas user
                    button_text_action = `⚙️ Set Batas User ${agent.agentId}`;
                    callback_data_action = `agent_setmaxusers_promptlimit_${agent.agentId}`;
                    break;
            }
            if (mode !== 'all') { 
                 keyboardRows.push([{ text: button_text_action, callback_data: callback_data_action }]);
            }
            listText += `----\n`;
        }
    }

    const paginationButtons = [];
    // Diubah: basis callback untuk paginasi sekarang juga menangani mode setmaxusers
    const paginationBaseCallback = `agent_${mode === 'all' ? 'list_all' : mode === 'setmaxusers' ? 'setmaxusers_select' : 'list_' + mode}`;


    if (page > 1) {
        paginationButtons.push({ text: '⬅️ Hal Seb', callback_data: `${paginationBaseCallback}_${page - 1}` });
    }
    if (page < totalPages) {
        paginationButtons.push({ text: 'Hal Berik ➡️', callback_data: `${paginationBaseCallback}_${page + 1}` });
    }
    if (paginationButtons.length > 0) {
        keyboardRows.push(paginationButtons);
    }
    keyboardRows.push([{ text: '🔙 Kembali ke Menu Agent', callback_data: 'agent_menu' }]);
    
    await sendOrEditMessage(chatId, listText, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboardRows }
    }, messageId);
}


// --- Manajemen User (Admin) ---
async function handleUserCallbacks(query, actionFromMainHandler, params) { 
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id; 
    const currentAdminId = query.from.id.toString();

    const subAction = params[0]; 
    const subParams = params.slice(1); 

    if (subAction === 'add' && subParams[0] === 'menu') {
        const protocolKeyboard = Object.entries(PROTOCOLS).map(([key, val]) => ([
            { text: `➕ ${val.name}`, callback_data: `user_add_protocol_${key}` }
        ]));
        protocolKeyboard.push([{ text: '🔙 Batal & Kembali', callback_data: 'main_menu' }]);
        await sendOrEditMessage(chatId, "Silakan pilih protokol untuk user baru:", {
            reply_markup: { inline_keyboard: protocolKeyboard }
        }, messageId);
    } else if (subAction === 'add' && subParams[0] === 'protocol') {
        const selectedProtocol = subParams[1]; 
        const promptUsername = await bot.sendMessage(chatId, `Protokol: ${PROTOCOLS[selectedProtocol].name}\nMasukkan username untuk user baru (contoh: \`user001\`, tanpa spasi/simbol aneh):`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'main_menu' }]]}
        });
        userState[chatId] = {
            adminId: currentAdminId,
            step: 'user_add_receive_username',
            protocol: selectedProtocol,
            promptMessageId: promptUsername.message_id, 
            originalMenuMessageId: messageId, 
            handler: handleUserAddReceiveUsername,
            expectedCallbackPrefix: 'user_add' 
        };
    } 
    else if (subAction === 'list' && subParams[0] === 'all') { 
        const page = parseInt(subParams[1] || 1);
        await displayUserList(chatId, messageId, page, 'all'); 
    } else if (subAction === 'all' && subParams[0] === 'list') { 
        const page = parseInt(subParams[1] || 1); 
        await displayUserList(chatId, messageId, page, 'all');
    } else if (subAction === 'view') { 
        if (subParams[0] === 'manual' && subParams[1] === 'prompt' && subParams[2] === 'from' && subParams[3] === 'all' && subParams[4] === 'list') {
            const promptUsername = await bot.editMessageText("Masukkan username yang ingin Anda lihat detailnya:", {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'user_list_all_1' }]] }
            });
            userState[chatId] = {
                adminId: currentAdminId,
                step: 'admin_user_view_manual_receive_username', 
                promptMessageId: promptUsername.message_id,
                originalMenuMessageId: messageId,
                handler: handleAdminUserViewManualReceiveUsername, 
                expectedCallbackPrefix: 'user_view_manual_input' 
            };
        } else if (subParams[0] === 'detail' && subParams[1] === 'direct' && subParams[2]) {
            const usernameToView = subParams[2];
            await bot.answerCallbackQuery(query.id, {text: `Mencari detail ${usernameToView}...`}).catch(()=>{});
            const user = await db.collection('users').findOne({ usernameLower: usernameToView.toLowerCase() });
            if (user) {
                await displaySingleUserDetailsForAdmin(chatId, user, messageId);
            } else {
                await bot.sendMessage(chatId, `❌ User \`${usernameToView}\` tidak ditemukan.`);
            }
        }
    }
    else if (subAction === 'delete' && subParams[0] === 'list') { 
        const page = parseInt(subParams[1] || 1);
        await displayUserList(chatId, messageId, page, 'delete');
    } else if (subAction === 'delete' && subParams[0] === 'manual' && subParams[1] === 'prompt') { 
        const promptUsername = await bot.editMessageText("Masukkan username yang ingin Anda HAPUS secara manual:", {
            chat_id: chatId,
            message_id: messageId, 
            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'user_delete_list_1' }]] } 
        });
        userState[chatId] = {
            adminId: currentAdminId,
            step: 'user_delete_manual_receive_username',
            promptMessageId: promptUsername.message_id, 
            originalMenuMessageId: messageId, 
            handler: handleUserDeleteManualReceiveUsername,
            expectedCallbackPrefix: 'user_delete_manual' 
        };
    }
     else if (subAction === 'delete' && subParams[0] === 'confirm') { 
        const usernameToDelete = subParams[1];
        const confirmKeyboard = [
            [{ text: `✔️ YA, HAPUS ${usernameToDelete}`, callback_data: `user_delete_execute_${usernameToDelete}`}],
            [{ text: `❌ TIDAK, BATAL`, callback_data: `user_delete_list_1`}] 
        ];
        await sendOrEditMessage(chatId, `⚠️ Anda yakin ingin menghapus user \`${usernameToDelete}\`? Aksi ini tidak dapat diurungkan.`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: confirmKeyboard }
        }, messageId); 

    } else if (subAction === 'delete' && subParams[0] === 'execute') { 
        const usernameToDelete = subParams[1];
        await bot.answerCallbackQuery(query.id, { text: `⏳ Menghapus ${usernameToDelete}...` });
        try {
            const result = await deleteUser(usernameToDelete, currentAdminId, 'admin_manual_delete'); 
            if (result.success) {
                await bot.editMessageText(`✅ User \`${usernameToDelete}\` berhasil dihapus.`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
            } else {
                await bot.editMessageText(`❌ Gagal menghapus user \`${usernameToDelete}\`: ${result.message}`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
            }
        } catch (err) {
            await logAction('USER_DELETE_EXECUTE_ERROR', { error: err, username: usernameToDelete });
            await bot.editMessageText(`❌ Terjadi kesalahan sistem saat menghapus \`${usernameToDelete}\`.`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        }
        setTimeout(() => displayUserList(chatId, null, 1, 'delete'), 2000); 

    }
    else if (subAction === 'extend' && subParams[0] === 'list') { 
        const page = parseInt(subParams[1] || 1);
        await displayUserList(chatId, messageId, page, 'extend');
    } else if (subAction === 'extend' && subParams[0] === 'manual' && subParams[1] === 'prompt') { 
        const promptUsername = await bot.editMessageText("Masukkan username yang ingin Anda PERPANJANG secara manual:", {
            chat_id: chatId,
            message_id: messageId, 
            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'user_extend_list_1' }]] } 
        });
        userState[chatId] = {
            adminId: currentAdminId,
            step: 'user_extend_manual_receive_username',
            promptMessageId: promptUsername.message_id,
            originalMenuMessageId: messageId, 
            handler: handleUserExtendManualReceiveUsername,
            expectedCallbackPrefix: 'user_extend_manual' 
        };
    }
     else if (subAction === 'extend' && subParams[0] === 'selectuser') { 
        const usernameToExtend = subParams[1];
        const promptDays = await bot.sendMessage(chatId, `Masukkan jumlah hari untuk perpanjangan masa aktif user \`${usernameToExtend}\` (contoh: 30):`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'user_extend_list_1' }]]} 
        });
        userState[chatId] = {
            adminId: currentAdminId,
            step: 'user_extend_receive_days', 
            username: usernameToExtend,
            promptMessageId: promptDays.message_id,
            originalMenuMessageId: messageId, 
            handler: handleUserExtendReceiveDays,
            expectedCallbackPrefix: 'user_extend' 
        };
    }
    else if (subAction === 'cleanup') { 
        await bot.answerCallbackQuery(query.id, { text: "⏳ Membersihkan user expired..." });
        try {
            const cleanedUsers = await cleanupExpiredUsers(currentAdminId); 
            let cleanupMessage = `🧹 **Pembersihan User Expired Manual Selesai:**\n\n`;
            if (cleanedUsers.length > 0) {
                cleanupMessage += `Berhasil menghapus ${cleanedUsers.length} user.\n`;
            } else {
                cleanupMessage += "Tidak ada user expired yang ditemukan untuk dihapus.";
            }
            await sendOrEditMessage(chatId, cleanupMessage, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali ke Menu Utama', callback_data: 'main_menu' }]]}}, messageId);
        } catch (err) {
            await logAction("USER_CLEANUP_ERROR", { error: err });
            await sendOrEditMessage(chatId, `❌ Gagal membersihkan user expired: ${err.message}`, { reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali ke Menu Utama', callback_data: 'main_menu' }]]}}, messageId);
        }
    }
    else if (subAction === 'online' && subParams[0] === 'ips') { 
        const page = parseInt(subParams[1] || 1);
        await displayOnlineUserIPs(chatId, messageId, page);
    }
     else {
    }
}

async function handleUserAddReceiveUsername(chatId, text, state) {
    if (state.originalMenuMessageId) {
        await deleteMessage(chatId, state.originalMenuMessageId);
    }

    const username = text.trim().toLowerCase(); 
    if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
        const newPrompt = await bot.sendMessage(chatId, "❌ Username tidak valid.\nHarus 3-32 karakter, hanya huruf kecil (a-z), angka (0-9), titik (.), underscore (_), atau strip (-).\nContoh: `user.name_01`\n\nMasukkan username lagi:");
        userState[chatId].promptMessageId = newPrompt.message_id; 
        return;
    }

    const existingUser = await db.collection('users').findOne({ usernameLower: username });
    if (existingUser) {
        const newPrompt = await bot.sendMessage(chatId, `⚠️ Username \`${username}\` sudah digunakan. Silakan pilih username lain:`);
        userState[chatId].promptMessageId = newPrompt.message_id; 
        return;
    }

    userState[chatId].username = username;
    userState[chatId].step = 'user_add_receive_days';
    userState[chatId].handler = handleUserAddReceiveDays; 
    
    const newPrompt = await bot.sendMessage(chatId, `Username: \`${username}\`\nProtokol: ${PROTOCOLS[state.protocol].name}\n\nMasukkan jumlah hari masa aktif (contoh: 30):`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'main_menu' }]]}
    });
    userState[chatId].promptMessageId = newPrompt.message_id; 
}

async function handleUserAddReceiveDays(chatId, text, state) {
    const days = parseInt(text.trim());
    if (isNaN(days) || days < 1 || days > 3650) { 
        const newPrompt = await bot.sendMessage(chatId, '❌ Masukkan jumlah hari antara 1-3650');
        userState[chatId].promptMessageId = newPrompt.message_id; 
        return;
    }
    
    userState[chatId].days = days;

    if (CONFIG.QUOTA_SETTINGS.ENABLED) {
        userState[chatId].step = 'user_add_receive_quota';
        userState[chatId].handler = handleUserAddReceiveQuota;
        const quotaPromptMsg = await bot.sendMessage(chatId, `Username: \`${state.username}\`, Durasi: ${days} hari.\n\nMasukkan kuota data untuk user ini dalam GB (contoh: 10 untuk 10GB, atau 0 untuk tanpa batas kuota dari bot):`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'main_menu' }]] }
        });
        userState[chatId].promptMessageId = quotaPromptMsg.message_id;
    } else {
        await processUserCreation(chatId, state, 0); 
    }
}

async function handleUserAddReceiveQuota(chatId, text, state) {
    const quotaGB = parseFloat(text.trim());
    if (isNaN(quotaGB) || quotaGB < 0) {
        const newPrompt = await bot.sendMessage(chatId, '❌ Masukkan jumlah kuota GB yang valid (angka positif, atau 0 untuk tanpa batas).');
        userState[chatId].promptMessageId = newPrompt.message_id;
        return;
    }
    await processUserCreation(chatId, state, quotaGB);
}

async function processUserCreation(chatId, state, quotaGB) {
    const agentId = state.agentIdForUser || 'admin_direct'; 
    const processingMsg = await bot.sendMessage(chatId, `⏳ Menambahkan user \`${state.username}\` dengan masa aktif ${state.days} hari${CONFIG.QUOTA_SETTINGS.ENABLED ? ` dan kuota ${quotaGB} GB` : ''}...`);

    try {
        const result = await addUserToSystem(state.protocol, state.username, state.days, state.adminId, agentId, quotaGB);
        
        await deleteMessage(chatId, processingMsg.message_id);

        let successMessage = `✅ User Berhasil Ditambahkan!\n\n`;
        successMessage += `👤 Username: \`${result.username}\`\n`;
        successMessage += `📡 Protokol: ${PROTOCOLS[result.protocol].name}\n`;
        successMessage += `📅 Kedaluwarsa: ${new Date(result.expiry).toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', year: 'numeric', month: 'long', day: 'numeric' })} (WIB)\n`;
        if (CONFIG.QUOTA_SETTINGS.ENABLED && result.quota && result.quota.totalBytes > 0) {
            successMessage += `⚖️ Kuota: ${formatBytes(result.quota.totalBytes)} (Terpakai: ${formatBytes(result.quota.trafficUsed)})\n`;
        } else if (CONFIG.QUOTA_SETTINGS.ENABLED) {
            successMessage += `⚖️ Kuota: Tidak terbatas (dari sisi bot)\n`;
        }
        successMessage += `🔑 Dibuat oleh: Admin ID \`${state.adminId}\`\n`;
        if (result.agentId && result.agentId !== 'admin_direct') {
            successMessage += `👨‍💼 Agent: \`${result.agentId}\`\n`;
        }
        successMessage += `\n🔗 **Link Konfigurasi & QR Code:**\n`;
        
        await bot.sendMessage(chatId, successMessage, { parse_mode: 'Markdown' });

        for (const qrInfo of result.qrCodes) {
            try {
                await bot.sendPhoto(chatId, qrInfo.path, { 
                    caption: `✨ ${PROTOCOLS[result.protocol].name} - ${qrInfo.type.toUpperCase()}\n\`${qrInfo.link}\`\n\nSalin link di atas atau scan QR code ini.` ,
                    parse_mode: 'Markdown'
                });
                await fsp.unlink(qrInfo.path); 
            } catch (qrError) {
                await logAction("QR_SEND_ERROR", {username: result.username, qrPath: qrInfo.path, error: qrError.message});
                await bot.sendMessage(chatId, `Gagal mengirim QR Code untuk ${qrInfo.type}. Link: \`${qrInfo.link}\``, {parse_mode: 'Markdown'});
            }
        }

    } catch (err) {
        await deleteMessage(chatId, processingMsg.message_id); 
        await logAction('USER_ADD_FINAL_ERROR', { error: err, username: state.username, protocol: state.protocol });
        await bot.sendMessage(chatId, `❌ Gagal menambahkan user: ${err.message}`);
    }

    delete userState[chatId];
    await showMainMenu(chatId); 
}


async function handleUserExtendReceiveDays(chatId, text, state) {
    const days = parseInt(text.trim());
    if (isNaN(days) || days < 1 || days > 3650) {
        const newPrompt = await bot.sendMessage(chatId, '❌ Masukkan jumlah hari antara 1-3650');
        userState[chatId].promptMessageId = newPrompt.message_id;
        return;
    }

    const processingMsg = await bot.sendMessage(chatId, `⏳ Memperpanjang masa aktif user \`${state.username}\` selama ${days} hari...`);

    try {
        const {newExpiry, quotaReset} = await extendUserExpiryInSystem(state.username, days, state.adminId);
        await deleteMessage(chatId, processingMsg.message_id);
        let message = `✅ User \`${state.username}\` berhasil diperpanjang.\nMasa aktif baru hingga: ${new Date(newExpiry).toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', year: 'numeric', month: 'long', day: 'numeric' })} (WIB).`;
        if (quotaReset) {
            message += `\nPenggunaan kuota dan catatan trafik Xray terakhir telah direset.`;
        }
        await bot.sendMessage(chatId, message);

    } catch (err) {
        await deleteMessage(chatId, processingMsg.message_id);
        await logAction('USER_EXTEND_FINAL_ERROR', { error: err, username: state.username });
        await bot.sendMessage(chatId, `❌ Gagal memperpanjang user: ${err.message}`);
    }

    delete userState[chatId];
    await showMainMenu(chatId); 
}

async function handleUserDeleteManualReceiveUsername(chatId, text, state) {
    const username = text.trim().toLowerCase();
    if (!username) {
        await bot.sendMessage(chatId, "❌ Username tidak boleh kosong.");
        await displayUserList(chatId, state.originalMenuMessageId, 1, 'delete');
        delete userState[chatId];
        return;
    }

    const user = await db.collection('users').findOne({ usernameLower: username });
    if (!user) {
        await bot.sendMessage(chatId, `❌ User \`${username}\` tidak ditemukan.`);
        await displayUserList(chatId, state.originalMenuMessageId, 1, 'delete');
        delete userState[chatId];
        return;
    }

    const confirmKeyboard = [
        [{ text: `✔️ YA, HAPUS ${user.username}`, callback_data: `user_delete_execute_${user.username}` }],
        [{ text: `❌ TIDAK, BATAL`, callback_data: `user_delete_list_1` }]
    ];
    await bot.sendMessage(chatId, `⚠️ Anda yakin ingin menghapus user \`${user.username}\`? Aksi ini tidak dapat diurungkan.`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: confirmKeyboard }
    }); 
    
    delete userState[chatId]; 
}

async function handleUserExtendManualReceiveUsername(chatId, text, state) {
    const username = text.trim().toLowerCase();
    if (!username) {
        await bot.sendMessage(chatId, "❌ Username tidak boleh kosong.");
        await displayUserList(chatId, state.originalMenuMessageId, 1, 'extend');
        delete userState[chatId];
        return;
    }

    const user = await db.collection('users').findOne({ usernameLower: username });
    if (!user) {
        await bot.sendMessage(chatId, `❌ User \`${username}\` tidak ditemukan.`);
        await displayUserList(chatId, state.originalMenuMessageId, 1, 'extend');
        delete userState[chatId];
        return;
    }

    userState[chatId] = {
        ...state, 
        step: 'user_extend_manual_receive_days',
        username: user.username, 
        handler: handleUserExtendManualReceiveDays, 
        expectedCallbackPrefix: 'user_extend_manual' 
    };
    const newPrompt = await bot.sendMessage(chatId, `User: \`${user.username}\`.\nMasukkan jumlah hari perpanjangan (contoh: 30):`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'user_extend_list_1' }]] }
    });
    userState[chatId].promptMessageId = newPrompt.message_id; 
}

async function handleUserExtendManualReceiveDays(chatId, text, state) {
    const days = parseInt(text.trim());
    if (isNaN(days) || days < 1 || days > 3650) {
        const newPrompt = await bot.sendMessage(chatId, "❌ Jumlah hari tidak valid. Masukkan angka antara 1-3650.\n\nMasukkan jumlah hari lagi:");
        userState[chatId].promptMessageId = newPrompt.message_id; 
        return; 
    }

    const processingMsg = await bot.sendMessage(chatId, `⏳ Memperpanjang masa aktif user \`${state.username}\` selama ${days} hari...`);

    try {
        const {newExpiry, quotaReset} = await extendUserExpiryInSystem(state.username, days, state.adminId);
        await deleteMessage(chatId, processingMsg.message_id);
        let message = `✅ User \`${state.username}\` berhasil diperpanjang.\nMasa aktif baru hingga: ${new Date(newExpiry).toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', year: 'numeric', month: 'long', day: 'numeric' })} (WIB).`;
        if (quotaReset) {
            message += `\nPenggunaan kuota dan catatan trafik Xray terakhir telah direset.`;
        }
        await bot.sendMessage(chatId, message);

    } catch (err) {
        await deleteMessage(chatId, processingMsg.message_id);
        await logAction('USER_EXTEND_MANUAL_FINAL_ERROR', { error: err, username: state.username, adminId: state.adminId });
        await bot.sendMessage(chatId, `❌ Gagal memperpanjang user: ${err.message}`);
    }

    delete userState[chatId];
    await showMainMenu(chatId); 
}

async function handleAdminUserViewManualReceiveUsername(chatId, text, state) {
    const username = text.trim().toLowerCase();
    if (!username) {
        await bot.sendMessage(chatId, "❌ Username tidak boleh kosong.");
        if (state.originalMenuMessageId) {
            await displayUserList(chatId, state.originalMenuMessageId, 1, 'all');
        } else {
            await displayUserList(chatId, null, 1, 'all');
        }
        delete userState[chatId];
        return;
    }

    const user = await db.collection('users').findOne({ usernameLower: username }); 
    if (!user) {
        await bot.sendMessage(chatId, `❌ User \`${username}\` tidak ditemukan.`);
        if (state.originalMenuMessageId) {
            await displayUserList(chatId, state.originalMenuMessageId, 1, 'all');
        } else {
            await displayUserList(chatId, null, 1, 'all');
        }
        delete userState[chatId];
        return;
    }

    await displaySingleUserDetailsForAdmin(chatId, user, state.originalMenuMessageId); 
    
    delete userState[chatId]; 
}

async function displaySingleUserDetailsForAdmin(chatId, user, messageIdToEdit) {
    let userDetailsText = `📄 **Detail User: \`${user.username}\`**\n\n`;
    userDetailsText += `👤 Username: \`${user.username}\`\n`;
    userDetailsText += `📡 Protokol: ${user.protocols ? user.protocols.join(', ') : 'N/A'}\n`;
    userDetailsText += `🆔 Agent: \`${user.agentId || 'N/A (Admin Direct)'}\`\n`;
    
    const expiryDate = new Date(user.expiry);
    const isExpired = expiryDate < new Date();
    const expiryFormatted = expiryDate.toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Jakarta' });
    userDetailsText += `📅 Kedaluwarsa: ${expiryFormatted} ${isExpired ? '🔴 (Expired)' : user.isActive === false ? '⚪ (Non-Aktif)' : '🟢'}\n`;

    if (CONFIG.QUOTA_SETTINGS.ENABLED && user.quota) {
        if (user.quota.totalBytes > 0) {
            const usedPercent = (user.quota.trafficUsed / user.quota.totalBytes) * 100;
            userDetailsText += `⚖️ Kuota: ${formatBytes(user.quota.trafficUsed)} / ${formatBytes(user.quota.totalBytes)} (${usedPercent.toFixed(1)}%)\n`;
        } else {
            userDetailsText += `⚖️ Kuota: ∞ (Terpakai: ${formatBytes(user.quota.trafficUsed)})\n`;
        }
        userDetailsText += `   - Uplink Xray Terakhir: ${formatBytes(user.quota.lastXrayUplink)}\n`;
        userDetailsText += `   - Downlink Xray Terakhir: ${formatBytes(user.quota.lastXrayDownlink)}\n`;
        userDetailsText += `   - Terakhir Dicek: ${user.quota.lastChecked ? new Date(user.quota.lastChecked).toLocaleString('id-ID', {timeZone: 'Asia/Jakarta'}) : 'Belum pernah'}\n`;
    }
    
    userDetailsText += `🔑 Dibuat Oleh (ID): \`${user.createdBy}\`\n`;
    userDetailsText += `🕒 Tanggal Dibuat: ${new Date(user.createdAt).toLocaleString('id-ID', {timeZone: 'Asia/Jakarta'})}\n`;

    const keyboard = [[{ text: '🔙 Kembali ke List Semua User', callback_data: 'user_list_all_1' }]];
    const sentMessage = await sendOrEditMessage(chatId, userDetailsText, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
    }, messageIdToEdit); 

    const domain = await getDomain();
    const protoConfig = PROTOCOLS[user.protocol];
    if (protoConfig && user.credentials) {
        const links = protoConfig.generateLink(domain, user.username, user.credentials);
        
        if (!fs.existsSync(CONFIG.CONFIGS_DIR)) {
            await fsp.mkdir(CONFIG.CONFIGS_DIR, { recursive: true });
        }
        for (const [type, link] of Object.entries(links)) {
            const qrFilename = `${user.protocol}-${user.username}-${type}-detail-admin-${Date.now()}.png`;
            const qrPath = path.join(CONFIG.CONFIGS_DIR, qrFilename);
            if (await generateQR(link, qrPath)) {
                try {
                    await bot.sendPhoto(chatId, qrPath, { 
                        caption: `✨ ${PROTOCOLS[user.protocol].name} - ${type.toUpperCase()}\n\`${link}\`\n\nSalin link atau scan QR.` ,
                        parse_mode: 'Markdown',
                    });
                    await fsp.unlink(qrPath); 
                } catch (qrError) {
                    await logAction("QR_SEND_ERROR_ADMIN_DETAIL", {username: user.username, qrPath, error: qrError.message});
                    await bot.sendMessage(chatId, `Gagal mengirim QR Code untuk ${type}. Link: \`${link}\``, {parse_mode: 'Markdown'});
                }
            }
        }
    }
}


async function displayUserList(chatId, messageId, page, mode = 'all', filterAgentId = null) { 
    page = Math.max(1, page); 
    const skip = (page - 1) * CONFIG.ITEMS_PER_PAGE;

    const queryFilter = {};
    if (filterAgentId) { 
        queryFilter.agentId = filterAgentId;
    }

    const users = await db.collection('users').find(queryFilter).sort({ createdAt: -1 }).skip(skip).limit(CONFIG.ITEMS_PER_PAGE).toArray();
    const totalUsers = await db.collection('users').countDocuments(queryFilter);
    const totalPages = Math.ceil(totalUsers / CONFIG.ITEMS_PER_PAGE);

    let listTitle = filterAgentId ? `User Milik Agent \`${filterAgentId}\`` : "Semua User";
    let listText = `📋 **${listTitle} (Hal ${page}/${totalPages}) - Total: ${totalUsers}**\n\n`;
    const keyboardRows = [];

    if (users.length === 0) {
        listText += filterAgentId ? "Agent ini belum memiliki user." : "Tidak ada user terdaftar.";
    } else {
        users.forEach(user => {
            const expiryDate = new Date(user.expiry);
            const isExpired = expiryDate < new Date();
            const expiryFormatted = expiryDate.toLocaleDateString('id-ID', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'Asia/Jakarta' });
            
            listText += `👤 \`${user.username}\` (${user.protocols ? user.protocols.join(', ') : 'N/A'})\n`;
            if (!filterAgentId) { 
                listText += `   Agent: \`${user.agentId || 'N/A (Admin)'}\`\n`;
            }
            listText += `   Expire: ${expiryFormatted} ${isExpired ? '🔴 (Expired)' : user.isActive === false ? '⚪ (Non-Aktif)' : '🟢'}\n`;
            
            if (CONFIG.QUOTA_SETTINGS.ENABLED && user.quota) {
                if (user.quota.totalBytes > 0) {
                    const usedPercent = (user.quota.trafficUsed / user.quota.totalBytes) * 100;
                    listText += `   Kuota: ${formatBytes(user.quota.trafficUsed)} / ${formatBytes(user.quota.totalBytes)} (${usedPercent.toFixed(1)}%)\n`;
                } else {
                    listText += `   Kuota: ∞ (Terpakai: ${formatBytes(user.quota.trafficUsed)})\n`;
                }
            }

            if (mode === 'delete') {
                keyboardRows.push([{ text: `🗑 Hapus ${user.username}`, callback_data: `user_delete_confirm_${user.username}` }]);
            } else if (mode === 'extend') {
                keyboardRows.push([{ text: `⏳ Perpanjang ${user.username}`, callback_data: `user_extend_selectuser_${user.username}` }]);
            } else if (mode === 'all' && !filterAgentId) { 
                 keyboardRows.push([{ text: `👁️ Lihat Detail ${user.username}`, callback_data: `user_view_detail_direct_${user.username}` }]);
            }
            listText += `----\n`;
        });
    }

    if (mode === 'delete' && !filterAgentId) {
        keyboardRows.push([{ text: '✏️ Input Nama Manual (Hapus)', callback_data: 'user_delete_manual_prompt' }]);
    } else if (mode === 'extend' && !filterAgentId) {
        keyboardRows.push([{ text: '✏️ Input Nama Manual (Perpanjang)', callback_data: 'user_extend_manual_prompt' }]);
    } else if (mode === 'all' && !filterAgentId) { 
        keyboardRows.push([{ text: '✏️ Input Nama Manual (Lihat)', callback_data: 'user_view_manual_prompt_from_all_list' }]);
    }


    const paginationButtons = [];
    let baseCallback;
    if (mode === 'agent_specific' && filterAgentId) { 
        baseCallback = `agent_viewusers_list_${filterAgentId}`; 
    } else if (mode === 'all') { 
        baseCallback = `user_all_list`; 
    }
     else { 
        baseCallback = `user_${mode}_list`;
    }


    if (page > 1) {
        paginationButtons.push({ text: '⬅️ Hal Seb', callback_data: `${baseCallback}_${page - 1}` });
    }
    if (page < totalPages) {
        paginationButtons.push({ text: 'Hal Berik ➡️', callback_data: `${baseCallback}_${page + 1}` });
    }
    if (paginationButtons.length > 0) {
        keyboardRows.push(paginationButtons);
    }
    
    let backCallback = 'main_menu';
    let backText = '🔙 Kembali ke Menu Utama';
    
    keyboardRows.push([{ text: backText, callback_data: backCallback }]);
    
    await sendOrEditMessage(chatId, listText, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboardRows }
    }, messageId);
}

// --- Fungsi Inti Sistem User ---
async function addUserToSystem(protocol, username, days, adminId, agentId, quotaGB = 0) {
    const totalUsers = await db.collection('users').countDocuments();
    if (totalUsers >= CONFIG.MAX_USERS) {
        throw new Error(`Batas maksimal user (${CONFIG.MAX_USERS}) telah tercapai.`);
    }

    const usernameLower = username.toLowerCase();
    const existingUser = await db.collection('users').findOne({ usernameLower });
    if (existingUser) {
        throw new Error(`Username "${username}" sudah digunakan.`);
    }

    const domain = await getDomain();
    const protoConfig = PROTOCOLS[protocol];
    if (!protoConfig) throw new Error(`Protokol "${protocol}" tidak dikenal.`);

    const credentials = {};
    for (const field of protoConfig.fields) {
        credentials[field] = field === 'id' ? generateUUID() :
                             field === 'password' ? generatePassword() :
                             username; 
    }

    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + days);
    const expiryISO = expiryDate.toISOString(); 

    let userQuotaData = {
        totalBytes: 0,
        trafficUsed: 0,       
        lastXrayUplink: 0,    
        lastXrayDownlink: 0,  
        lastChecked: null
    };

    if (CONFIG.QUOTA_SETTINGS.ENABLED && quotaGB > 0) {
        userQuotaData.totalBytes = quotaGB * 1024 * 1024 * 1024;
    } else if (CONFIG.QUOTA_SETTINGS.ENABLED && CONFIG.QUOTA_SETTINGS.DEFAULT_QUOTA_GB > 0 && quotaGB === 0) {
        userQuotaData.totalBytes = CONFIG.QUOTA_SETTINGS.DEFAULT_QUOTA_GB * 1024 * 1024 * 1024;
    }


    const xrayConfig = await readXrayConfig();
    protoConfig.inbounds.forEach(inboundTag => {
        let inbound = xrayConfig.inbounds.find(i => i.tag === inboundTag);
        if (!inbound) {
            throw new Error(`Inbound tag "${inboundTag}" untuk protokol ${protocol} tidak ditemukan di config.json Xray.`);
        }
        if (!inbound.settings) inbound.settings = {};
        if (!inbound.settings.clients) inbound.settings.clients = [];
        
        inbound.settings.clients = inbound.settings.clients.filter(c => c.email !== username);

        inbound.settings.clients.push({
            email: username, 
            ...credentials
        });
    });
    await saveXrayConfig(xrayConfig);

    const newUserDoc = {
        username,
        usernameLower, 
        protocol, 
        protocols: [protocol], 
        credentials, 
        expiry: expiryISO,
        agentId, 
        createdBy: adminId, 
        createdAt: new Date(),
        isActive: true,
        quota: userQuotaData 
    };
    await db.collection('users').insertOne(newUserDoc);

    await restartXray();

    const links = protoConfig.generateLink(domain, username, credentials);
    const qrCodes = [];
    if (!fs.existsSync(CONFIG.CONFIGS_DIR)) {
        await fsp.mkdir(CONFIG.CONFIGS_DIR, { recursive: true });
    }

    for (const [type, link] of Object.entries(links)) { 
      const qrFilename = `${protocol}-${username}-${type}-${Date.now()}.png`;
      const qrPath = path.join(CONFIG.CONFIGS_DIR, qrFilename);
      if (await generateQR(link, qrPath)) {
        qrCodes.push({ type, path: qrPath, link });
      }
    }
    
    await logAction('USER_ADDED_TO_SYSTEM', { username, protocol, days, adminId, agentId, quotaGB });
    return { username, protocol, expiry: expiryISO, agentId, qrCodes, quota: userQuotaData };
}

async function deleteUser(username, adminId, reason = "unknown") {
    const usernameLower = username.toLowerCase();
    const user = await db.collection('users').findOne({ usernameLower });

    if (!user) {
        return { success: false, message: `User "${username}" tidak ditemukan di database.` };
    }

    const xrayConfig = await readXrayConfig();
    let userFoundInXray = false;
    xrayConfig.inbounds.forEach(inbound => {
        if (inbound.settings && inbound.settings.clients) {
            const initialLength = inbound.settings.clients.length;
            inbound.settings.clients = inbound.settings.clients.filter(c => c.email !== user.username); 
            if (inbound.settings.clients.length < initialLength) {
                userFoundInXray = true;
            }
        }
    });

    if (userFoundInXray) {
        await saveXrayConfig(xrayConfig);
        await restartXray(); 
    }

    await db.collection('users').deleteOne({ usernameLower });
    await db.collection('ip_warnings').deleteOne({ username: user.username }); 

    await logAction('USER_DELETED_FROM_SYSTEM', { username: user.username, deletedBy: adminId, reason, userFoundInXray });
    return { success: true, message: `User "${user.username}" berhasil dihapus.` };
}


async function extendUserExpiryInSystem(username, daysToAdd, adminId) {
    const usernameLower = username.toLowerCase();
    const user = await db.collection('users').findOne({ usernameLower });

    if (!user) {
        throw new Error(`User "${username}" tidak ditemukan.`);
    }

    const currentExpiry = new Date(user.expiry);
    const newExpiryDate = new Date(currentExpiry);
    newExpiryDate.setDate(newExpiryDate.getDate() + daysToAdd);
    const newExpiryISO = newExpiryDate.toISOString();

    const updateFields = { 
        expiry: newExpiryISO, 
        updatedAt: new Date(), 
        lastExtendedBy: adminId,
        isActive: true 
    };

    let quotaResetPerformed = false;
    if (CONFIG.QUOTA_SETTINGS.ENABLED && user.quota) {
        updateFields['quota.trafficUsed'] = 0; 
        updateFields['quota.lastXrayUplink'] = 0;
        updateFields['quota.lastXrayDownlink'] = 0;
        updateFields['quota.lastChecked'] = null; 
        quotaResetPerformed = true;
    }


    await db.collection('users').updateOne(
        { usernameLower },
        { $set: updateFields }
    );

    await logAction('USER_EXTENDED_IN_SYSTEM', { username: user.username, daysAdded: daysToAdd, newExpiry: newExpiryISO, extendedBy: adminId, quotaReset: quotaResetPerformed });
    return {newExpiry: newExpiryISO, quotaReset: quotaResetPerformed};
}

async function cleanupExpiredUsers(adminId = 'system_auto') {
    const now = new Date().toISOString();
    const expiredUserDocs = await db.collection('users').find({ expiry: { $lt: now }, isActive: true }).toArray();
    const cleanedUsersInfo = [];

    for (const userDoc of expiredUserDocs) {
        try {
            await db.collection('users').updateOne({ _id: userDoc._id }, { $set: { isActive: false, cleanedAt: new Date() }});
            
            const deleteResult = await deleteUser(userDoc.username, adminId, 'expired_cleanup'); 
            if (deleteResult.success) {
                 cleanedUsersInfo.push({ username: userDoc.username, agentId: userDoc.agentId }); 
            }
        } catch (err) {
            await logAction('CLEANUP_SINGLE_USER_ERROR', { username: userDoc.username, error: err.message });
        }
    }
    if (cleanedUsersInfo.length > 0) {
        await logAction('EXPIRED_USERS_CLEANED', { count: cleanedUsersInfo.length, cleanedBy: adminId, users: cleanedUsersInfo.map(u=>u.username) });
    }
    return cleanedUsersInfo; 
}


// --- Statistik ---
async function displayStats(chatId, messageId, query) { 
    if (messageId && query) { 
        await bot.answerCallbackQuery(query.id, { text: "⏳ Mengambil data statistik..." }).catch(()=>{/*ignore*/});
    }

    const totalUsers = await db.collection('users').countDocuments();
    const activeUsers = await db.collection('users').countDocuments({ expiry: { $gt: new Date().toISOString() }, isActive: true }); 
    const expiredUsers = await db.collection('users').countDocuments({ expiry: { $lte: new Date().toISOString() }, isActive: true }); 
    const inactiveButNotExpired = await db.collection('users').countDocuments({ expiry: { $gt: new Date().toISOString() }, isActive: false }); 

    const agentStatsPipeline = [
        { $match: { agentId: { $exists: true, $ne: null, $ne: 'admin_direct' } } }, 
        {
            $group: {
                _id: "$agentId",
                total: { $sum: 1 },
                active: { $sum: { $cond: [ { $and: [{$gt: ["$expiry", new Date().toISOString()]}, {$eq: ["$isActive", true]}]}, 1, 0 ] } } 
            }
        },
        { $sort: { _id: 1 } }
    ];
    const agentUserStats = await db.collection('users').aggregate(agentStatsPipeline).toArray();
    const totalRegisteredAgents = await db.collection('agents').countDocuments();

    let statsText = `📊 **Statistik Sistem Xray Bot**\n\n`;
    statsText += `👥 Total User Terdaftar: ${totalUsers}\n`;
    statsText += `🟢 User Aktif (Masa Berlaku OK): ${activeUsers}\n`;
    statsText += `🔴 User Expired (Tapi Masih Aktif di DB): ${expiredUsers}\n`;
    statsText += `🔘 User Non-Aktif (Masa Berlaku OK): ${inactiveButNotExpired}\n`;
    statsText += `🛡️ Batas Maksimal User Global: ${CONFIG.MAX_USERS}\n\n`;
    statsText += `👨‍💼 Total Agen Terdaftar: ${totalRegisteredAgents}\n`;

    if (agentUserStats.length > 0) {
        statsText += `📈 **Statistik User per Agent:**\n`;
        agentUserStats.forEach(stat => {
            statsText += `- \`${stat._id}\`: ${stat.total} user (Aktif: ${stat.active})\n`;
        });
    } else {
        statsText += `ℹ️ Tidak ada data statistik user per agent.\n`;
    }

    await sendOrEditMessage(chatId, statsText, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali ke Menu Utama', callback_data: 'main_menu' }]] }
    }, messageId); 
}

// --- Backup ---
async function createSystemBackup(chatId) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupSessionDir = path.join(CONFIG.BACKUP_DIR, `system-backup-${timestamp}`);
    const zipPath = path.join(CONFIG.BACKUP_DIR, `xray-bot-backup-${timestamp}.zip`);
    let dumpCommand = ''; 

    try {
        await fsp.mkdir(backupSessionDir, { recursive: true });

        const xrayConfigBackupDir = path.join(backupSessionDir, 'xray_configs');
        await fsp.mkdir(xrayConfigBackupDir, { recursive: true });
        if (fs.existsSync(CONFIG.CONFIG_PATH)) {
            await fsp.copyFile(CONFIG.CONFIG_PATH, path.join(xrayConfigBackupDir, 'config.json'));
        }
        if (fs.existsSync(CONFIG.DOMAIN_PATH)) {
            await fsp.copyFile(CONFIG.DOMAIN_PATH, path.join(xrayConfigBackupDir, 'domain'));
        }
        
        const mongoDumpPath = path.join(backupSessionDir, 'mongodb_dump'); 
        await fsp.mkdir(mongoDumpPath, { recursive: true });
        const archiveFilePath = path.join(mongoDumpPath, 'db.gz'); 

        dumpCommand = `mongodump --uri="${CONFIG.MONGO_URI}" --db=${CONFIG.MONGO_DB_NAME} --archive=${archiveFilePath} --gzip`;
        
        console.log(`[INFO] Executing mongodump: ${dumpCommand.replace(/:[^:]+@/, ':<REDACTED_PASSWORD>@')}`); 
        await logAction('MONGODUMP_EXECUTION_START', { command: dumpCommand.replace(/:[^:]+@/, ':<REDACTED_PASSWORD>@') });

        const { stdout, stderr } = await execAsync(dumpCommand); 
        if (stderr) {
            console.warn(`[WARN] mongodump stderr: ${stderr}`);
            await logAction('MONGODUMP_STDERR_OUTPUT', { stderr });
        }
        if (stdout) { 
            console.log(`[INFO] mongodump stdout: ${stdout}`);
            await logAction('MONGODUMP_STDOUT_OUTPUT', { stdout });
        }
        console.log(`[INFO] Mongodump completed successfully for ${archiveFilePath}`);
        
        const logBackupPath = path.join(backupSessionDir, 'bot_logs');
        await fsp.mkdir(logBackupPath, {recursive: true});
        if (fs.existsSync(CONFIG.LOG_FILE)) {
            await fsp.copyFile(CONFIG.LOG_FILE, path.join(logBackupPath, path.basename(CONFIG.LOG_FILE)));
        }

        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        return new Promise((resolve, reject) => {
            output.on('close', async () => {
                await logAction('SYSTEM_BACKUP_CREATED', { zipPath });
                await fsp.rm(backupSessionDir, { recursive: true, force: true }); 
                resolve(zipPath);
            });
            archive.on('warning', (err) => {
                if (err.code === 'ENOENT') {
                    logAction('BACKUP_ARCHIVE_WARNING_ENOENT', { warning: err.message });
                } else {
                    logAction('BACKUP_ARCHIVE_WARNING', { warning: err.message });
                }
            });
            archive.on('error', (err) => {
                 logAction('BACKUP_ARCHIVE_ERROR', { error: err.message, stack: err.stack });
                 reject(err);
            });
            archive.pipe(output);
            archive.directory(backupSessionDir, false); 
            archive.finalize();
        });

    } catch (err) {
        let errorMessage = err.message;
        if (err.stderr) { 
            errorMessage += `\nSTDERR: ${err.stderr}`;
        }
        if (err.stdout) { 
            errorMessage += `\nSTDOUT: ${err.stdout}`;
        }
        const redactedCommand = dumpCommand ? dumpCommand.replace(/:[^:]+@/, ':<REDACTED_PASSWORD>@') : "N/A";
        await logAction('SYSTEM_BACKUP_MONGODUMP_ERROR', { command: redactedCommand, error: errorMessage, stack: err.stack });
        
        if (fs.existsSync(backupSessionDir)) {
            await fsp.rm(backupSessionDir, { recursive: true, force: true }).catch(e => {
                 logAction('SYSTEM_BACKUP_CLEANUP_ERROR', { error: e.message });
            });
        }
        throw new Error(`Gagal membuat backup database: ${err.message}`); 
    }
}

// --- Monitoring IP ---
async function getOnlineUserIPsFromLog() {
    const logPath = '/var/log/xray/access.log'; 
    const userIpMap = {};
    const now = Date.now();
    const TIME_WINDOW = 5 * 60 * 1000; 

    try {
        if (!fs.existsSync(logPath)) {
            await logAction("ACCESS_LOG_NOT_FOUND", {path: logPath});
            return userIpMap; 
        }
        const data = await fsp.readFile(logPath, 'utf8');
        const lines = data.trim().split('\n');
        
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i];
            const match = line.match(/(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}).*? ([\d\.:a-fA-F]+):[\d]+ accepted.*?email: (\S+)/) || 
                          line.match(/(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}).*? ([\d\.:a-fA-F]+):[\d]+ accepted.*?user: (\S+)/);  

            if (match) {
                const logTimestamp = new Date(match[1]).getTime();
                if (now - logTimestamp > TIME_WINDOW && i < lines.length - 100) { 
                     break;
                }

                const ip = match[2].includes(':') && !match[2].startsWith('[') ? `[${match[2]}]` : match[2]; 
                const user = match[3];

                if (!userIpMap[user]) {
                    userIpMap[user] = new Set();
                }
                userIpMap[user].add(ip);
            }
        }
        const result = {};
        for (const user in userIpMap) {
            result[user] = Array.from(userIpMap[user]);
        }
        return result;
    } catch (err) {
        await logAction('GET_ONLINE_IPS_ERROR', { error: err.message });
        return {}; 
    }
}

async function displayOnlineUserIPs(chatId, messageId, page) {
    page = Math.max(1, page);
    const onlineUsersData = await getOnlineUserIPsFromLog();
    const usernames = Object.keys(onlineUsersData).sort(); 
    
    const totalItems = usernames.length;
    const totalPages = Math.ceil(totalItems / CONFIG.ITEMS_PER_PAGE);
    const startIndex = (page - 1) * CONFIG.ITEMS_PER_PAGE;
    const endIndex = startIndex + CONFIG.ITEMS_PER_PAGE;
    const paginatedUsernames = usernames.slice(startIndex, endIndex);

    let text = `📡 **Daftar User Online & IP Terdeteksi (5 Menit Terakhir)**\n(Halaman ${page}/${totalPages} - Total: ${totalItems} user aktif)\n\n`;
    if (paginatedUsernames.length === 0) {
        text += "Tidak ada user aktif terdeteksi saat ini atau log Xray tidak dapat diakses.";
    } else {
        paginatedUsernames.forEach(username => {
            const ips = onlineUsersData[username];
            text += `👤 \`${username}\` (${ips.length} IP):\n   \`${ips.join('`, `')}\`\n`;
            text += `----\n`;
        });
    }

    const keyboardRows = [];
    const paginationButtons = [];
    if (page > 1) {
        paginationButtons.push({ text: '⬅️ Hal Seb', callback_data: `user_online_ips_${page - 1}` });
    }
    if (page < totalPages) {
        paginationButtons.push({ text: 'Hal Berik ➡️', callback_data: `user_online_ips_${page + 1}` });
    }
    if (paginationButtons.length > 0) {
        keyboardRows.push(paginationButtons);
    }
    keyboardRows.push([{ text: '🔄 Refresh', callback_data: `user_online_ips_${page}` }]); 
    keyboardRows.push([{ text: '🔙 Kembali ke Menu Utama', callback_data: 'main_menu' }]);

    await sendOrEditMessage(chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboardRows }
    }, messageId);
}

async function monitorUserMultiIP() {
    try {
        const onlineUsersData = await getOnlineUserIPsFromLog();
        
        const targetChatId = CONFIG.NOTIFICATION_GROUP_ID;
        const messageOptions = { parse_mode: 'Markdown' };
        if (targetChatId && CONFIG.NOTIFICATION_TOPIC_ID) {
            messageOptions.message_thread_id = CONFIG.NOTIFICATION_TOPIC_ID;
        }
        
        let adminsToNotify = [];
        if (!targetChatId) { 
            const admins = await db.collection('admins').find().project({ userId: 1 }).toArray();
            adminsToNotify = admins.map(a => a.userId);
        }


        for (const username in onlineUsersData) {
            const ips = onlineUsersData[username];
            if (ips.length > CONFIG.MAX_IP_LIMIT) {
                let warning = await db.collection('ip_warnings').findOne({ username });
                if (!warning) {
                    warning = { username, count: 0, lastWarningAt: null, cleanChecks: 0, firstViolationAt: new Date() };
                }

                const ONE_HOUR = 60 * 60 * 1000;
                const sendNewWarning = !warning.lastWarningAt || (new Date().getTime() - new Date(warning.lastWarningAt).getTime() > ONE_HOUR) || warning.lastIpSet !== JSON.stringify(ips.sort());

                if (sendNewWarning) {
                    warning.count++;
                    warning.lastWarningAt = new Date();
                    warning.lastIpSet = JSON.stringify(ips.sort()); 
                }
                warning.cleanChecks = 0; 

                let messageToNotify;
                if (warning.count >= CONFIG.IP_WARNING_THRESHOLD) {
                    messageToNotify = `🚫 *PELANGGARAN MULTI-IP BERULANG*\n\n` +
                                     `👤 User: \`${username}\`\n` +
                                     `🌐 Terdeteksi ${ips.length} IP: \`${ips.join(', ')}\`\n` +
                                     `⚠️ Status: User dihapus otomatis setelah ${warning.count}x peringatan.\n` +
                                     `⏰ Waktu: ${new Date().toLocaleString('id-ID', {timeZone:'Asia/Jakarta'})}`;
                    await deleteUser(username, 'system_multi_ip', 'multi_ip_violation'); 
                    await db.collection('ip_warnings').deleteOne({ username }); 
                } else {
                    if (sendNewWarning) { 
                        messageToNotify = `⚠️ *PERINGATAN MULTI-IP*\n\n` +
                                        `👤 User: \`${username}\`\n` +
                                        `🌐 Terdeteksi ${ips.length} IP: \`${ips.join(', ')}\`\n` +
                                        `⚡ Melebihi batas ${CONFIG.MAX_IP_LIMIT} IP.\n` +
                                        `🚨 Peringatan ke-${warning.count} dari ${CONFIG.IP_WARNING_THRESHOLD}.\n` +
                                        `⏰ Waktu: ${new Date().toLocaleString('id-ID', {timeZone:'Asia/Jakarta'})}`;
                    }
                }
                
                if (messageToNotify) { 
                    if (targetChatId) {
                        bot.sendMessage(targetChatId, messageToNotify, messageOptions).catch(e => logAction("SEND_MULTI_IP_WARNING_TO_GROUP_FAILED", {groupId: targetChatId, topicId: CONFIG.NOTIFICATION_TOPIC_ID, error: e.message}));
                    } else {
                        for (const adminId of adminsToNotify) {
                            bot.sendMessage(adminId, messageToNotify, { parse_mode: 'Markdown' }).catch(e => logAction("SEND_MULTI_IP_WARNING_FAILED", {adminId, error: e.message}));
                        }
                    }
                }
                if (warning.count < CONFIG.IP_WARNING_THRESHOLD) {
                    await db.collection('ip_warnings').updateOne({ username }, { $set: warning }, { upsert: true });
                }
                if (sendNewWarning) { 
                     await logAction('MULTI_IP_VIOLATION_DETECTED', { username, ipCount: ips.length, warningCount: warning.count, ips });
                }

            } else { 
                let warning = await db.collection('ip_warnings').findOne({ username });
                if (warning && warning.count > 0) { 
                    warning.cleanChecks = (warning.cleanChecks || 0) + 1;
                    if (warning.cleanChecks >= CONFIG.IP_CLEAN_CHECKS_RESET) {
                        const resetMessage = `✅ *RESET PERINGATAN MULTI-IP*\n\n` +
                                           `👤 User: \`${username}\`\n` +
                                           `ℹ️ Peringatan direset setelah ${warning.cleanChecks}x pengecekan bersih.`;
                        if (targetChatId) {
                            bot.sendMessage(targetChatId, resetMessage, messageOptions).catch(e => logAction("SEND_MULTI_IP_RESET_TO_GROUP_FAILED", {groupId: targetChatId, topicId: CONFIG.NOTIFICATION_TOPIC_ID, error: e.message}));
                        } else {
                            for (const adminId of adminsToNotify) {
                                bot.sendMessage(adminId, resetMessage, { parse_mode: 'Markdown' }).catch(e => logAction("SEND_MULTI_IP_RESET_FAILED", {adminId, error: e.message}));
                            }
                        }
                        await db.collection('ip_warnings').deleteOne({ username });
                        await logAction('MULTI_IP_WARNING_RESET', { username });
                    } else {
                        await db.collection('ip_warnings').updateOne({ username }, { $set: { cleanChecks: warning.cleanChecks } });
                    }
                }
            }
        }
    } catch (err) {
        await logAction('MONITOR_MULTI_IP_ERROR', { error: err.message, stack: err.stack });
    }
}


// ==========================================
//      FUNGSI-FUNGSI MANAJEMEN KUOTA
// ==========================================
async function getXrayTrafficStatsRaw(username) { 
    const uplinkPattern = `user>>>${username}>>>traffic>>>uplink`;
    const downlinkPattern = `user>>>${username}>>>traffic>>>downlink`;
    
    let uplinkBytes = 0;
    let downlinkBytes = 0;

    try {
        const cmdUplink = `xray api statsquery --server=${CONFIG.QUOTA_SETTINGS.API_SERVER} --pattern="${uplinkPattern}" --reset=false`;
        const { stdout: stdoutUplink, stderr: stderrUplink } = await execAsync(cmdUplink);
        
        if (stderrUplink && !stderrUplink.includes("StatsService is not found")) {
            await logAction('XRAY_STATSQUERY_STDERR_RAW', { username, type: 'uplink', stderr: stderrUplink });
        }

        if (stdoutUplink) {
            const statsData = JSON.parse(stdoutUplink);
            if (statsData.stat && statsData.stat.length > 0 && statsData.stat[0].name === uplinkPattern) {
                uplinkBytes = parseInt(statsData.stat[0].value, 10) || 0;
            }
        }
    } catch (error) {
        await logAction('XRAY_STATSQUERY_ERROR_RAW_UPLINK', { username, command: `xray api statsquery ... --pattern="${uplinkPattern}"`, error: error.message, stderr: error.stderr });
        if (error.stderr && error.stderr.includes("StatsService is not found")){
             console.error(`❌ StatsService tidak ditemukan di Xray API untuk uplink. Pastikan StatsService diaktifkan di config.json Xray.`);
        }
    }

    try {
        const cmdDownlink = `xray api statsquery --server=${CONFIG.QUOTA_SETTINGS.API_SERVER} --pattern="${downlinkPattern}" --reset=false`;
        const { stdout: stdoutDownlink, stderr: stderrDownlink } = await execAsync(cmdDownlink);

        if (stderrDownlink && !stderrDownlink.includes("StatsService is not found")) {
            await logAction('XRAY_STATSQUERY_STDERR_RAW', { username, type: 'downlink', stderr: stderrDownlink });
        }

        if (stdoutDownlink) {
            const statsData = JSON.parse(stdoutDownlink);
            if (statsData.stat && statsData.stat.length > 0 && statsData.stat[0].name === downlinkPattern) {
                downlinkBytes = parseInt(statsData.stat[0].value, 10) || 0;
            }
        }
    } catch (error) {
        await logAction('XRAY_STATSQUERY_ERROR_RAW_DOWNLINK', { username, command: `xray api statsquery ... --pattern="${downlinkPattern}"`, error: error.message, stderr: error.stderr });
         if (error.stderr && error.stderr.includes("StatsService is not found")){
             console.error(`❌ StatsService tidak ditemukan di Xray API untuk downlink.`);
        }
    }
    return { uplink: uplinkBytes, downlink: downlinkBytes };
}

async function checkUserQuotas() {
    if (!CONFIG.QUOTA_SETTINGS.ENABLED || !db) {
        return;
    }
    await logAction('QUOTA_CHECK_JOB_STARTED');
    const usersToCheck = await db.collection('users').find({ 
        isActive: true, 
        "quota.totalBytes": { $gt: 0 } 
    }).toArray();

    const targetChatIdForQuota = CONFIG.NOTIFICATION_GROUP_ID;
    const messageOptionsQuota = { parse_mode: 'Markdown' };
    if (targetChatIdForQuota && CONFIG.NOTIFICATION_TOPIC_ID) {
        messageOptionsQuota.message_thread_id = CONFIG.NOTIFICATION_TOPIC_ID;
    }
    
    let adminsToNotifyForQuota = [];
    if (!targetChatIdForQuota && CONFIG.QUOTA_SETTINGS.NOTIFY_ADMIN_ON_EXCEED) {
        const admins = await db.collection('admins').find().project({ userId: 1 }).toArray();
        adminsToNotifyForQuota = admins.map(a => a.userId);
    }


    for (const user of usersToCheck) {
        try {
            const currentXrayTraffic = await getXrayTrafficStatsRaw(user.username);
            
            let lastKnownUplink = user.quota.lastXrayUplink || 0;
            let lastKnownDownlink = user.quota.lastXrayDownlink || 0;
            let accumulatedTrafficUsed = user.quota.trafficUsed || 0;

            let deltaUplink = 0;
            let deltaDownlink = 0;

            if (currentXrayTraffic.uplink < lastKnownUplink) { 
                deltaUplink = currentXrayTraffic.uplink; 
            } else {
                deltaUplink = currentXrayTraffic.uplink - lastKnownUplink;
            }

            if (currentXrayTraffic.downlink < lastKnownDownlink) { 
                deltaDownlink = currentXrayTraffic.downlink;
            } else {
                deltaDownlink = currentXrayTraffic.downlink - lastKnownDownlink;
            }
            
            const totalDelta = deltaUplink + deltaDownlink;
            const newAccumulatedTraffic = accumulatedTrafficUsed + totalDelta;

            await db.collection('users').updateOne(
                { _id: user._id },
                { 
                    $set: { 
                        "quota.trafficUsed": newAccumulatedTraffic, 
                        "quota.lastXrayUplink": currentXrayTraffic.uplink,
                        "quota.lastXrayDownlink": currentXrayTraffic.downlink,
                        "quota.lastChecked": new Date() 
                    } 
                }
            );
            
            await logAction('USER_QUOTA_TRAFFIC_UPDATED', { 
                username: user.username, 
                currentRawUplink: currentXrayTraffic.uplink,
                currentRawDownlink: currentXrayTraffic.downlink,
                lastKnownUplink,
                lastKnownDownlink,
                deltaUplink,
                deltaDownlink,
                oldAccumulatedTraffic: accumulatedTrafficUsed,
                newAccumulatedTraffic
            });


            if (newAccumulatedTraffic >= user.quota.totalBytes) {
                await logAction('USER_QUOTA_EXCEEDED', { username: user.username, trafficUsed: newAccumulatedTraffic, quota: user.quota.totalBytes });
                
                await deleteUser(user.username, 'system_quota_exceeded', 'quota_exceeded'); 
                
                if (CONFIG.QUOTA_SETTINGS.NOTIFY_ADMIN_ON_EXCEED) {
                    const messageToNotify = `🚫 *KUOTA HABIS*\n\n` +
                                         `👤 User: \`${user.username}\`\n` +
                                         `📊 Trafik Terpakai: ${formatBytes(newAccumulatedTraffic)}\n` +
                                         `⚖️ Batas Kuota: ${formatBytes(user.quota.totalBytes)}\n` +
                                         `⚠️ Status: User dinonaktifkan otomatis.\n` +
                                         `⏰ Waktu: ${new Date().toLocaleString('id-ID', {timeZone:'Asia/Jakarta'})}`;
                    if (targetChatIdForQuota) {
                        bot.sendMessage(targetChatIdForQuota, messageToNotify, messageOptionsQuota).catch(e => logAction("SEND_QUOTA_EXCEEDED_TO_GROUP_FAILED", {groupId: targetChatIdForQuota, topicId: CONFIG.NOTIFICATION_TOPIC_ID, error: e.message}));
                    } else {
                        for (const adminId of adminsToNotifyForQuota) { 
                            bot.sendMessage(adminId, messageToNotify, { parse_mode: 'Markdown' }).catch(e => logAction("SEND_QUOTA_EXCEEDED_NOTIFICATION_FAILED", {adminId, error: e.message}));
                        }
                    }
                }
            }
        } catch (error) {
            await logAction('QUOTA_CHECK_USER_ERROR', { username: user.username, error: error.message, stack: error.stack });
        }
        await new Promise(resolve => setTimeout(resolve, 300)); 
    }
    await logAction('QUOTA_CHECK_JOB_FINISHED', { usersChecked: usersToCheck.length });
}

async function handleUserQuotaCallbacks(query, params) {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const currentAdminId = query.from.id.toString();
    const action = params[0]; 

    switch (action) {
        case 'menu':
            const quotaMenuText = "⚖️ **Manajemen Kuota User**\n\nPilih salah satu opsi:";
            const quotaMenuKeyboard = {
                inline_keyboard: [
                    [{ text: '🔄 Reset Penggunaan Trafik User', callback_data: 'user_quota_reset_traffic_select_1' }],
                    [{ text: '⚙️ Setel/Ubah Kuota Total User', callback_data: 'user_quota_set_quota_select_1' }],
                    [{ text: '🔙 Kembali ke Menu Utama', callback_data: 'main_menu' }]
                ]
            };
            await sendOrEditMessage(chatId, quotaMenuText, { reply_markup: quotaMenuKeyboard, parse_mode: 'Markdown' }, messageId);
            break;

        case 'reset_traffic_select': 
            const pageReset = parseInt(params[1] || 1);
            await displayUserList(chatId, messageId, pageReset, 'reset_traffic'); 
            break;

        case 'reset_traffic_confirm': 
            const usernameToReset = params[1];
            const userDocReset = await db.collection('users').findOne({usernameLower: usernameToReset.toLowerCase()});

            if (!userDocReset || !userDocReset.quota || !(userDocReset.quota.totalBytes > 0)) { 
                await bot.answerCallbackQuery(query.id, { text: `ℹ️ User ${usernameToReset} tidak memiliki kuota yang dibatasi atau tidak ditemukan.`, show_alert: true });
                return;
            }

            const confirmKeyboardReset = [
                [{ text: `✔️ YA, RESET TRAFIK ${usernameToReset}`, callback_data: `user_quota_reset_traffic_execute_${usernameToReset}` }],
                [{ text: `❌ TIDAK, BATAL`, callback_data: `user_quota_reset_traffic_select_1` }] 
            ];
            await sendOrEditMessage(chatId, `⚠️ Anda yakin ingin mereset penggunaan trafik untuk user \`${usernameToReset}\`? Penggunaan akan kembali ke 0 Bytes, dan catatan trafik terakhir dari Xray juga akan direset.`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: confirmKeyboardReset }
            }, messageId);
            break;

        case 'reset_traffic_execute': 
            const usernameToExecuteReset = params[1];
            await bot.answerCallbackQuery(query.id, { text: `⏳ Mereset trafik ${usernameToExecuteReset}...` });
            try {
                const result = await db.collection('users').updateOne(
                    { usernameLower: usernameToExecuteReset.toLowerCase(), "quota.totalBytes": { $gt: 0 } }, 
                    { 
                        $set: { 
                            "quota.trafficUsed": 0, 
                            "quota.lastXrayUplink": 0, 
                            "quota.lastXrayDownlink": 0,
                            "quota.lastChecked": new Date() 
                        } 
                    }
                );
                if (result.modifiedCount > 0) {
                    await logAction('USER_TRAFFIC_RESET_MANUAL', { adminId: currentAdminId, username: usernameToExecuteReset });
                    await bot.editMessageText(`✅ Penggunaan trafik dan catatan trafik Xray terakhir untuk user \`${usernameToExecuteReset}\` berhasil direset.`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
                } else {
                    await bot.editMessageText(`⚠️ Gagal mereset trafik untuk \`${usernameToExecuteReset}\`. User tidak ditemukan atau tidak memiliki kuota yang dibatasi.`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
                }
            } catch (err) {
                await logAction('USER_TRAFFIC_RESET_ERROR', { error: err, username: usernameToExecuteReset });
                await bot.editMessageText(`❌ Terjadi kesalahan sistem saat mereset trafik \`${usernameToExecuteReset}\`.`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
            }
            setTimeout(() => showMainMenu(chatId, null), 2000); 
            break;
        
        case 'set_quota_select': 
            const pageSet = parseInt(params[1] || 1);
            await displayUserList(chatId, messageId, pageSet, 'set_quota'); 
            break;

        case 'set_quota_prompt': 
            const usernameToSetQuota = params[1];
            const userToSet = await db.collection('users').findOne({usernameLower: usernameToSetQuota.toLowerCase()});
            if (!userToSet) {
                await bot.answerCallbackQuery(query.id, {text: `User ${usernameToSetQuota} tidak ditemukan.`, show_alert: true});
                return;
            }
            const currentQuotaGB = userToSet.quota && userToSet.quota.totalBytes > 0 ? (userToSet.quota.totalBytes / (1024*1024*1024)).toFixed(2) : "Tidak Terbatas";

            const promptQuotaMsg = await bot.editMessageText(
                `User: \`${usernameToSetQuota}\`\nKuota Saat Ini: ${currentQuotaGB} GB\n\nMasukkan batas kuota total baru dalam GB (contoh: 20 untuk 20GB, atau 0 untuk tanpa batas kuota dari bot).\nMengubah kuota total juga akan mereset penggunaan trafik saat ini.`, 
                {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'user_quota_set_quota_select_1' }]] }
                }
            );
            userState[chatId] = {
                adminId: currentAdminId,
                step: 'user_quota_set_quota_receive_gb',
                username: usernameToSetQuota,
                promptMessageId: promptQuotaMsg.message_id,
                originalMenuMessageId: messageId, 
                handler: handleUserQuotaSetQuotaReceiveGB,
                expectedCallbackPrefix: 'user_quota_set_quota'
            };
            break;
        
        default:
            await bot.answerCallbackQuery(query.id); 
            break;
    }
}

async function handleUserQuotaSetQuotaReceiveGB(chatId, text, state) {
    const newQuotaGB = parseFloat(text.trim());

    if (isNaN(newQuotaGB) || newQuotaGB < 0) {
        const newPrompt = await bot.sendMessage(chatId, "❌ Jumlah kuota GB tidak valid. Masukkan angka positif, atau 0 untuk tanpa batas.\n\nMasukkan jumlah kuota lagi:");
        userState[chatId].promptMessageId = newPrompt.message_id; 
        return;
    }

    const username = state.username;
    await bot.sendMessage(chatId, `⏳ Memperbarui kuota total untuk user \`${username}\` menjadi ${newQuotaGB} GB...`);

    try {
        const newTotalBytes = newQuotaGB > 0 ? newQuotaGB * 1024 * 1024 * 1024 : 0;
        const result = await db.collection('users').updateOne(
            { usernameLower: username.toLowerCase() },
            { 
                $set: { 
                    "quota.totalBytes": newTotalBytes,
                    "quota.trafficUsed": 0, 
                    "quota.lastXrayUplink": 0,
                    "quota.lastXrayDownlink": 0,
                    "quota.lastChecked": new Date(),
                    updatedAt: new Date(),
                    lastUpdatedBy: state.adminId
                }
            }
        );

        if (result.modifiedCount > 0) {
            await logAction('USER_TOTAL_QUOTA_SET', { adminId: state.adminId, username, newQuotaGB });
            await bot.sendMessage(chatId, `✅ Kuota total untuk user \`${username}\` berhasil diubah menjadi ${newQuotaGB > 0 ? newQuotaGB + ' GB' : 'Tidak Terbatas'}. Penggunaan trafik telah direset.`);
        } else {
            await bot.sendMessage(chatId, `⚠️ Gagal mengubah kuota untuk \`${username}\`. User mungkin tidak ditemukan atau tidak ada perubahan.`);
        }
    } catch (err) {
        await logAction('USER_TOTAL_QUOTA_SET_ERROR', { error: err, username });
        await bot.sendMessage(chatId, `❌ Terjadi kesalahan sistem saat mengubah kuota untuk \`${username}\`.`);
    }

    delete userState[chatId];
    await showMainMenu(chatId, state.promptMessageId);
}


// ==========================================
//      INISIALISASI & PENANGANAN ERROR
// ==========================================

(async () => {
  try {
    await connectToDB(); 

    await fsp.mkdir(CONFIG.BACKUP_DIR, { recursive: true });
    await fsp.mkdir(CONFIG.CONFIGS_DIR, { recursive: true });
    await fsp.writeFile(CONFIG.LOG_FILE, '', { flag: 'a' }); 

    const adminCount = await db.collection('admins').countDocuments();
    if (adminCount === 0) {
      const initialAdminId = process.env.INITIAL_ADMIN;
      if (!initialAdminId || !/^\d+$/.test(initialAdminId)) {
        const errMsg = '❌ INITIAL_ADMIN di file .env tidak valid atau tidak ada. Bot tidak dapat dimulai tanpa admin pertama.';
        console.error(errMsg);
        await logAction('INITIAL_ADMIN_ERROR', { message: errMsg });
        process.exit(1);
      }
      await db.collection('admins').insertOne({ userId: initialAdminId.toString(), createdAt: new Date(), role: 'superadmin' });
      console.log(`✅ Admin pertama [${initialAdminId}] berhasil ditambahkan ke database.`);
      await logAction('INITIAL_ADMIN_ADDED', { adminId: initialAdminId });
      try {
          await bot.sendMessage(initialAdminId, '🎉 Selamat! Anda telah ditetapkan sebagai admin utama bot ini. Ketik /start untuk memulai.');
      } catch (e) {
          console.warn(`Gagal mengirim pesan ke admin pertama [${initialAdminId}]. Pastikan bot tidak diblokir atau ID benar.`);
          await logAction('INITIAL_ADMIN_NOTIFICATION_FAILED', { adminId: initialAdminId, error: e.message });
      }
    }

    if (CONFIG.AUTO_DELETE_SETTINGS.ENABLED) {
        console.log(`🕒 Auto-delete pengguna expired diaktifkan untuk berjalan pada jam ${CONFIG.AUTO_DELETE_SETTINGS.RUN_HOUR}:${CONFIG.AUTO_DELETE_SETTINGS.RUN_MINUTE.toString().padStart(2, '0')}.`);
        setInterval(async () => {
          try {
            const now = new Date();
            const nowWIB = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));

            if (nowWIB.getHours() === CONFIG.AUTO_DELETE_SETTINGS.RUN_HOUR && 
                nowWIB.getMinutes() === CONFIG.AUTO_DELETE_SETTINGS.RUN_MINUTE) { 
                
                await logAction('AUTO_CLEANUP_EXPIRED_STARTED');
                const cleanedUsers = await cleanupExpiredUsers('system_daily_cleanup');
                
                if (CONFIG.AUTO_DELETE_SETTINGS.NOTIFY_ADMINS) {
                    const targetChatId = CONFIG.NOTIFICATION_GROUP_ID;
                    const messageOptions = { parse_mode: 'Markdown' };
                    if (targetChatId && CONFIG.NOTIFICATION_TOPIC_ID) {
                        messageOptions.message_thread_id = CONFIG.NOTIFICATION_TOPIC_ID;
                    }
                    let reportMessage = ``;

                    if (cleanedUsers.length > 0) {
                        await logAction('AUTO_CLEANUP_EXPIRED_COMPLETED', { count: cleanedUsers.length, users: cleanedUsers.map(u => u.username) });
                        reportMessage = `🧹 **Laporan Pembersihan Otomatis User Expired**\n\n`;
                        reportMessage += `Berhasil menghapus ${cleanedUsers.length} user expired:\n`;
                        cleanedUsers.forEach(u => {
                            reportMessage += `- \`${u.username}\` (Agent: ${u.agentId || 'N/A'})\n`;
                        });
                    } else {
                        await logAction('AUTO_CLEANUP_EXPIRED_COMPLETED', { count: 0, message: "Tidak ada user expired untuk dihapus." });
                        reportMessage = `ℹ️ Pembersihan otomatis: Tidak ada user expired yang ditemukan untuk dihapus hari ini.`;
                    }
                    reportMessage += `\n⏰ Waktu: ${new Date().toLocaleString('id-ID', {timeZone:'Asia/Jakarta'})}`;

                    if (targetChatId) {
                        try {
                            await bot.sendMessage(targetChatId, reportMessage, messageOptions);
                        } catch (e) {
                            await logAction('AUTO_CLEANUP_NOTIFICATION_TO_GROUP_FAILED', { groupId: targetChatId, topicId: CONFIG.NOTIFICATION_TOPIC_ID, error: e.message });
                        }
                    } else { 
                        const admins = await db.collection('admins').find().project({ userId: 1 }).toArray();
                        for (const admin of admins) {
                            try {
                                await bot.sendMessage(admin.userId, reportMessage, { parse_mode: 'Markdown' });
                            } catch (e) {
                                await logAction('AUTO_CLEANUP_NOTIFICATION_TO_ADMIN_FAILED', { adminId: admin.userId, error: e.message });
                            }
                        }
                    }
                }
            }
          } catch (err) {
            await logAction('AUTO_CLEANUP_EXPIRED_JOB_ERROR', { error: err.message, stack: err.stack });
          }
        }, 60 * 1000); 
    }


    setInterval(monitorUserMultiIP, CONFIG.IP_MONITOR_INTERVAL);
    monitorUserMultiIP(); 

    if (CONFIG.QUOTA_SETTINGS.ENABLED && CONFIG.QUOTA_SETTINGS.CHECK_INTERVAL_MINUTES > 0) {
        setInterval(checkUserQuotas, CONFIG.QUOTA_SETTINGS.CHECK_INTERVAL_MINUTES * 60 * 1000);
        checkUserQuotas(); 
        console.log(`🕒 Pemeriksaan kuota pengguna (akumulatif) diaktifkan setiap ${CONFIG.QUOTA_SETTINGS.CHECK_INTERVAL_MINUTES} menit.`);
    } else if (CONFIG.QUOTA_SETTINGS.ENABLED) {
        console.warn(`⚠️ Fitur kuota diaktifkan tetapi interval pemeriksaan tidak valid (${CONFIG.QUOTA_SETTINGS.CHECK_INTERVAL_MINUTES} menit). Pemeriksaan otomatis tidak akan berjalan.`);
    }


    console.log(`🤖 Admin Bot (MongoDB Edition) berhasil dijalankan pada ${new Date().toLocaleString('id-ID', {timeZone:'Asia/Jakarta'})}`);
    await logAction('BOT_STARTED_SUCCESSFULLY');

    const superAdmin = await db.collection('admins').findOne({ role: 'superadmin' });
    if (superAdmin) {
        bot.sendMessage(superAdmin.userId, `🟢 Bot berhasil direstart pada ${new Date().toLocaleString('id-ID', {timeZone:'Asia/Jakarta'})}.`, {disable_notification: true}).catch(()=>{/*ignore*/});
    }


  } catch (err) {
    console.error('❌ Gagal inisialisasi bot:', err);
    await logAction('BOT_INITIALIZATION_FAILED', { error: err.message, stack: err.stack });
    process.exit(1);
  }
})();

process.on('unhandledRejection', async (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  await logAction('UNHANDLED_REJECTION', { reason: reason instanceof Error ? reason.message : reason, stack: reason instanceof Error ? reason.stack : undefined });
});

process.on('uncaughtException', async (err) => {
  console.error('Uncaught Exception:', err);
  await logAction('UNCAUGHT_EXCEPTION', { error: err.message, stack: err.stack });
});
