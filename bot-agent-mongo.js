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

const envPath = process.env.AGENT_ENV_PATH || '/usr/local/etc/xray/agenenv/.env';
require('dotenv').config({ path: envPath });

console.log(`[INFO] Agent Bot: Memuat environment dari: ${envPath}`);

const execAsync = util.promisify(exec);

// ==========================================
//          KONFIGURASI UTAMA (AGENT VERSION)
// ==========================================
const CONFIG = {
  CONFIG_PATH: process.env.CONFIG_PATH || '/usr/local/etc/xray/config.json',
  DOMAIN_PATH: process.env.DOMAIN_PATH || '/usr/local/etc/xray/domain',
  CONFIGS_DIR: process.env.CONFIGS_DIR || '/var/www/html/configs/', 
  LOG_FILE: process.env.LOG_FILE || '/var/log/xray-agent-mongo.log',
  BACKUP_DIR: process.env.BACKUP_DIR || '/usr/local/etc/xray/backups_agent/',

  BOT_TOKEN: process.env.BOT_TOKEN, 
  ITEMS_PER_PAGE: 7,
  
  MONGO_URI: process.env.MONGO_URI || 'mongodb://localhost:27017',
  MONGO_DB_NAME: process.env.MONGO_DB_NAME || 'xray_bot_db',

  THIRTY_DAY_COST: parseFloat(process.env.THIRTY_DAY_COST) || 20000, 
  // MAX_USERS_PER_AGENT sudah tidak digunakan secara global, akan diambil dari DB per agen
  // DEFAULT_MAX_USERS_PER_AGENT_FALLBACK: 50, // Fallback jika maxUsers tidak ada di DB agen

  QUOTA_SETTINGS: {
    ENABLED: true, 
    PRESET_QUOTAS_GB: [100, 150, 200, 500, 0], 
    API_SERVER: '127.0.0.1:10000', 
  },
};

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
    console.log('✅ Agent Bot: Berhasil terhubung ke MongoDB.');
  } catch (err) {
    console.error('❌ Agent Bot: Gagal terhubung ke MongoDB:', err);
    await logAction('DB_CONNECTION_ERROR_AGENT', { error: err.message, stack: err.stack });
    process.exit(1);
  }
}

// ==========================================
//          FUNGSI UTILITAS & LOG (AGENT)
// ==========================================
async function logAction(action, details = {}) {
  const timestamp = new Date().toISOString();
  const sanitizedDetails = { ...details };
  if (sanitizedDetails.error && sanitizedDetails.error.message) {
      sanitizedDetails.errorMessage = sanitizedDetails.error.message;
      delete sanitizedDetails.error;
  }
  const logEntry = JSON.stringify({ timestamp, botType: 'agent', action, ...sanitizedDetails }) + '\n';
  try {
    await fsp.appendFile(CONFIG.LOG_FILE, logEntry);
  } catch (err) {
    console.error('Agent Bot: Gagal menulis log:', err);
  }
}

async function getValidAgent(agentId) {
  if (!db) {
    console.error("Database belum terhubung saat getValidAgent dipanggil.");
    return null;
  }
  const agent = await db.collection('agents').findOne({ agentId: agentId.toString() });
  // Pastikan field balance dan maxUsers ada dan bertipe number (atau maxUsers bisa undefined jika menggunakan default)
  if (agent && typeof agent.balance === 'number') { 
      // Jika maxUsers tidak ada di DB, admin belum set, maka agen tidak bisa buat user.
      // Admin harus set dulu di bot admin.
      // Atau, kita bisa definisikan default di sini jika diperlukan.
      // Untuk sekarang, kita asumsikan admin sudah set. Jika tidak, agen tidak bisa buat.
      // if (typeof agent.maxUsers !== 'number') {
      //     agent.maxUsers = CONFIG.DEFAULT_MAX_USERS_PER_AGENT_FALLBACK || 0; // Default jika tidak diset
      // }
      return agent;
  }
  return null;
}

async function getDomain() {
  try {
    return (await fsp.readFile(CONFIG.DOMAIN_PATH, 'utf8')).trim();
  } catch (err) {
    await logAction('DOMAIN_READ_ERROR_AGENT', { error: err });
    throw new Error('Gagal membaca domain. Hubungi admin.');
  }
}

async function restartXray() {
  try {
    await execAsync('systemctl restart xray'); 
    await logAction('XRAY_RESTARTED_BY_AGENT_OR_SYSTEM'); 
    console.log("[INFO] Layanan Xray direstart.");
  } catch (err) {
    await logAction('XRAY_RESTART_FAILED_AGENT_CONTEXT', { error: err.message, stack: err.stack });
    throw new Error(`Gagal me-restart layanan Xray: ${err.message}. Hubungi admin jika masalah berlanjut.`);
  }
}

function generateUUID() { return crypto.randomUUID(); }
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
    await logAction('QR_GENERATION_FAILED_AGENT', { error: err, text, filename });
    return false;
  }
}

async function readXrayConfig() {
  try {
    const data = await fsp.readFile(CONFIG.CONFIG_PATH, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    await logAction('XRAY_CONFIG_READ_ERROR_AGENT', { error: err });
    throw new Error('Gagal membaca file konfigurasi Xray. Hubungi admin.');
  }
}

async function saveXrayConfig(configData) {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDirForAgent = CONFIG.BACKUP_DIR || '/tmp/xray_agent_backups'; 
    if (!fs.existsSync(backupDirForAgent)) { 
        await fsp.mkdir(backupDirForAgent, { recursive: true });
    }
    const backupPath = path.join(backupDirForAgent, `config-agent-op-${timestamp}.json`);
    
    if (fs.existsSync(CONFIG.CONFIG_PATH)) {
        await fsp.copyFile(CONFIG.CONFIG_PATH, backupPath);
    }
    
    await fsp.writeFile(CONFIG.CONFIG_PATH, JSON.stringify(configData, null, 2));
    await logAction('XRAY_CONFIG_SAVED_BY_AGENT', { backupPath: fs.existsSync(backupPath) ? backupPath : "Tidak ada file asli untuk dibackup" });
  } catch (err) {
    await logAction('XRAY_CONFIG_SAVE_ERROR_AGENT', { error: err });
    throw new Error('Gagal menyimpan file konfigurasi Xray. Hubungi admin.');
  }
}

async function deleteMessage(chatId, messageId) {
    if (chatId && messageId) {
        try { await bot.deleteMessage(chatId, messageId); } catch (error) { /* ignore */ }
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
        await logAction('SEND_OR_EDIT_MESSAGE_FAILED_AGENT', { chatId, error: error.message, text });
        if (messageIdToEdit) {
            try { return await bot.sendMessage(chatId, text, options); } catch (sendError) { /* ignore */ }
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
//          FUNGSI MANAJEMEN MENU (AGENT)
// ==========================================
async function showAgentMainMenu(chatId, messageId, agentId) {
  const agent = await getValidAgent(agentId);
  if (!agent) return; 

  const balance = agent.balance.toLocaleString('id-ID', { style: 'currency', currency: 'IDR' });
  const userCount = await db.collection('users').countDocuments({ agentId: agent.agentId });
  const maxUsers = typeof agent.maxUsers === 'number' ? agent.maxUsers : 'N/A (Hub. Admin)'; // Ambil maxUsers dari DB

  let text = `🤖 **Menu Agen Xray**\n`;
  text += `Saldo Anda: ${balance}\n`;
  text += `User Dibuat: ${userCount} / ${maxUsers}\n\n`; // Tampilkan info batas user
  text += `Silakan pilih menu:`;

  const reply_markup = {
    inline_keyboard: [
      [{ text: '➕ Tambah User Baru', callback_data: 'agent_user_add_menu' },
      { text: '🗑 Hapus User', callback_data: 'agent_user_delete_list_1' }],
      [{ text: '⏳ Perpanjang User', callback_data: 'agent_user_extend_list_1' },
      { text: '📋 List User Saya', callback_data: 'agent_user_list_my_1' }],
      [{ text: '💰 Cek Saldo Detail', callback_data: 'agent_balance_check' }],
      [{ text: '📡 Cek IP Online (User Saya)', callback_data: 'agent_user_online_ips_1' }]
    ]
  };
  await sendOrEditMessage(chatId, text, { reply_markup, parse_mode: 'Markdown' }, messageId);
}

// ==========================================
//      HANDLER CALLBACK QUERY UTAMA (AGENT)
// ==========================================
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const agentId = query.from.id;
  const data = query.data;
  const messageId = query.message.message_id;

  const agent = await getValidAgent(agentId.toString()); // Pastikan agentId adalah string
  if (!agent) {
    if(!query.answered) await bot.answerCallbackQuery(query.id, { text: '❌ Akun agen Anda tidak valid atau saldo bermasalah. Hubungi admin.', show_alert: true }).catch(()=>{});
    return;
  }

  if (userState[chatId] && !data.startsWith(userState[chatId].expectedCallbackPrefix || '___nevermatch___')) {
     delete userState[chatId];
  }

  const [actionPrefix, mainAction, ...params] = data.split('_');

  try {
    if (actionPrefix !== 'agent' && data !== 'main_agent_menu') { 
        if (data === 'cancel_agent_action') { 
            delete userState[chatId];
            await bot.editMessageText('Aksi dibatalkan.', { chat_id: chatId, message_id: messageId });
            await showAgentMainMenu(chatId, null, agentId.toString());
            if(!query.answered) await bot.answerCallbackQuery(query.id).catch(()=>{});
            return;
        }
        if (!query.answered) await bot.answerCallbackQuery(query.id).catch(()=>{});
        return;
    }
    
    if (data === 'main_agent_menu') {
        await showAgentMainMenu(chatId, messageId, agentId.toString());
        if(!query.answered) await bot.answerCallbackQuery(query.id).catch(()=>{});
        return;
    }


    switch (mainAction) {
      case 'user':
        await handleAgentUserCallbacks(query, agent, mainAction, params);
        break;
      case 'balance':
        if (params[0] === 'check') {
            const balanceText = `💰 Saldo Anda saat ini: ${agent.balance.toLocaleString('id-ID', { style: 'currency', currency: 'IDR' })}`;
            await sendOrEditMessage(chatId, balanceText, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'main_agent_menu' }]] }
            }, messageId);
        }
        break;
      default:
        break;
    }
     if (!query.answered) {
        await bot.answerCallbackQuery(query.id).catch(e => logAction("ANSWER_CALLBACK_ERROR_AGENT", {data, error: e.message}));
    }
  } catch (error) {
    await logAction('CALLBACK_HANDLER_ERROR_AGENT', { agentId, data, error: error.message, stack: error.stack });
    try {
        if (!query.answered) await bot.answerCallbackQuery(query.id, { text: '❌ Terjadi kesalahan sistem pada bot agen.', show_alert: true });
    } catch (e) { /* ignore */ }
  }
});

// ==========================================
//          HANDLER PESAN TEKS (AGENT)
// ==========================================
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const agentId = msg.from.id;
  const text = msg.text;

  const agent = await getValidAgent(agentId.toString());
  if (!agent) {
    if (text === '/start') {
        await bot.sendMessage(chatId, '❌ Akun Anda tidak terdaftar sebagai agen atau saldo Anda bermasalah. Silakan hubungi admin.');
    }
    return;
  }

  if (text === '/start') {
    delete userState[chatId];
    await showAgentMainMenu(chatId, null, agentId.toString());
    await deleteMessage(chatId, msg.message_id);
    return;
  }
  
  const state = userState[chatId];
  if (!state || state.agentTelegramId.toString() !== agentId.toString()) {
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
        await logAction("INVALID_STATE_NO_HANDLER_AGENT", {chatId, state});
        delete userState[chatId];
        await bot.sendMessage(chatId, "❌ Terjadi kesalahan pada input. Silakan coba lagi dari menu utama.");
        await showAgentMainMenu(chatId, null, agentId.toString());
    }
  } catch (error) {
    await logAction('TEXT_MESSAGE_HANDLER_ERROR_AGENT', { agentId, text, state, error: error.message, stack: error.stack });
    await bot.sendMessage(chatId, `❌ Terjadi kesalahan: ${error.message}. Silakan coba lagi.`);
    delete userState[chatId];
    await showAgentMainMenu(chatId, null, agentId.toString());
  }
});

// ==========================================
//      FUNGSI-FUNGSI MANAJEMEN SPESIFIK (AGENT)
// ==========================================

async function handleAgentUserCallbacks(query, agent, mainAction, params) {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id; 
    const agentId = agent.agentId; 

    const subAction = params[0]; 
    const subParams = params.slice(1);

    switch (subAction) {
        case 'add': 
            if (subParams[0] === 'menu') {
                // Cek batas user sebelum menampilkan pilihan protokol
                const agentData = await db.collection('agents').findOne({ agentId: agentId.toString() });
                const currentAgentUserCount = await db.collection('users').countDocuments({ agentId: agentId.toString() });
                const agentMaxUsers = (agentData && typeof agentData.maxUsers === 'number') ? agentData.maxUsers : 0; // Default 0 jika tidak diset

                if (currentAgentUserCount >= agentMaxUsers && agentMaxUsers > 0) { // Jika maxUsers 0 berarti tak terbatas
                    await bot.answerCallbackQuery(query.id, { text: `❌ Anda telah mencapai batas maksimal user (${agentMaxUsers}). Tidak bisa menambah user baru.`, show_alert: true });
                    return;
                }

                const protocolKeyboard = Object.entries(PROTOCOLS).map(([key, val]) => ([
                    { text: `➕ ${val.name}`, callback_data: `agent_user_add_protocol_${key}` }
                ]));
                protocolKeyboard.push([{ text: '🔙 Batal', callback_data: 'main_agent_menu' }]);
                await sendOrEditMessage(chatId, "Pilih protokol untuk user baru:", {
                    reply_markup: { inline_keyboard: protocolKeyboard }
                }, messageId); 
            } else if (subParams[0] === 'protocol') {
                const selectedProtocol = subParams[1]; 
                const promptUsername = await bot.sendMessage(chatId, `Protokol: ${PROTOCOLS[selectedProtocol].name}\nMasukkan username untuk user baru (contoh: \`user001\`, tanpa spasi/simbol aneh):`, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'main_agent_menu' }]]}
                });
                userState[chatId] = {
                    agentTelegramId: agentId, 
                    step: 'agent_user_add_receive_username',
                    protocol: selectedProtocol,
                    promptMessageId: promptUsername.message_id, 
                    originalMenuMessageId: messageId, 
                    handler: handleAgentUserAddReceiveUsername,
                    expectedCallbackPrefix: 'agent_user_add' 
                };
            }
            break;

        case 'list': 
            if (subParams[0] === 'my') {
                const page = parseInt(subParams[1] || 1);
                await displayAgentUserList(chatId, messageId, page, agentId, 'my');
            }
            break;
        
        case 'my': 
            if (subParams[0] === 'list') { 
                const page = parseInt(subParams[1] || 1);
                await displayAgentUserList(chatId, messageId, page, agentId, 'my');
            } else if (subParams[0] === 'manual' && subParams[1] === 'prompt') {
                if (subParams[2] === 'view' && subParams[3]) { 
                    const usernameToView = subParams[3];
                    await bot.answerCallbackQuery(query.id).catch(()=>{}); // Jawab dulu callbacknya
                    const user = await db.collection('users').findOne({ usernameLower: usernameToView.toLowerCase(), agentId: agentId.toString() });
                    if (user) {
                        await displaySingleUserDetailsForAgent(chatId, user, messageId); 
                    } else {
                        await bot.sendMessage(chatId, `❌ User \`${usernameToView}\` tidak ditemukan atau bukan milik Anda.`);
                    }
                } else { 
                    const promptUsername = await bot.editMessageText("Masukkan username user Anda yang ingin dilihat detailnya:", {
                        chat_id: chatId,
                        message_id: messageId,
                        reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'agent_user_list_my_1' }]] }
                    });
                    userState[chatId] = {
                        agentTelegramId: agentId,
                        step: 'agent_user_view_manual_receive_username',
                        promptMessageId: promptUsername.message_id,
                        originalMenuMessageId: messageId, 
                        handler: handleAgentUserViewManualReceiveUsername, 
                        expectedCallbackPrefix: 'agent_user_view_manual_input' 
                    };
                }
            }
            break;
        
        case 'delete': 
            if (subParams[0] === 'list') { 
                const page = parseInt(subParams[1] || 1);
                await displayAgentUserList(chatId, messageId, page, agentId, 'delete');
            } else if (subParams[0] === 'manual' && subParams[1] === 'prompt') { 
                const promptUsername = await bot.editMessageText("Masukkan username user Anda yang ingin dihapus:", {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'agent_user_delete_list_1' }]] }
                });
                userState[chatId] = {
                    agentTelegramId: agentId,
                    step: 'agent_user_delete_manual_receive_username',
                    promptMessageId: promptUsername.message_id,
                    originalMenuMessageId: messageId, 
                    handler: handleAgentUserDeleteManualReceiveUsername,
                    expectedCallbackPrefix: 'agent_user_delete_manual'
                };
            }
             else if (subParams[0] === 'confirm') {
                const usernameToDelete = subParams[1];
                const confirmKeyboard = [
                    [{ text: `✔️ YA, HAPUS ${usernameToDelete}`, callback_data: `agent_user_delete_execute_${usernameToDelete}`}],
                    [{ text: `❌ TIDAK, BATAL`, callback_data: `agent_user_delete_list_1`}]
                ];
                await sendOrEditMessage(chatId, `⚠️ Anda yakin ingin menghapus user \`${usernameToDelete}\` yang Anda buat?`, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: confirmKeyboard }
                }, messageId);
            } else if (subParams[0] === 'execute') {
                const usernameToDelete = subParams[1];
                await bot.answerCallbackQuery(query.id, { text: `⏳ Menghapus ${usernameToDelete}...` });
                try {
                    const userDoc = await db.collection('users').findOne({ usernameLower: usernameToDelete.toLowerCase(), agentId: agentId });
                    if (!userDoc) {
                        await bot.editMessageText(`❌ User \`${usernameToDelete}\` tidak ditemukan atau bukan milik Anda.`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
                    } else {
                        const result = await deleteUserFromSystem(usernameToDelete, agentId, true); 
                        if (result.success) {
                            await bot.editMessageText(`✅ User \`${usernameToDelete}\` berhasil dihapus.`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
                        } else {
                            await bot.editMessageText(`❌ Gagal menghapus user \`${usernameToDelete}\`: ${result.message}`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
                        }
                    }
                } catch (err) {
                    await logAction('AGENT_USER_DELETE_EXECUTE_ERROR', { error: err, username: usernameToDelete, agentId });
                    await bot.editMessageText(`❌ Terjadi kesalahan sistem saat menghapus \`${usernameToDelete}\`.`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
                }
                setTimeout(() => displayAgentUserList(chatId, null, 1, agentId, 'delete'), 2000);
            }
            break;

        case 'extend': 
            if (subParams[0] === 'list') { 
                const page = parseInt(subParams[1] || 1);
                await displayAgentUserList(chatId, messageId, page, agentId, 'extend');
            } else if (subParams[0] === 'manual' && subParams[1] === 'prompt') { 
                const promptUsername = await bot.editMessageText("Masukkan username user Anda yang ingin diperpanjang:", {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'agent_user_extend_list_1' }]] }
                });
                userState[chatId] = {
                    agentTelegramId: agentId,
                    step: 'agent_user_extend_manual_receive_username',
                    promptMessageId: promptUsername.message_id,
                    originalMenuMessageId: messageId,
                    handler: handleAgentUserExtendManualReceiveUsername,
                    expectedCallbackPrefix: 'agent_user_extend_manual'
                };
            }
             else if (subParams[0] === 'selectuser') { 
                const usernameToExtend = subParams[1];
                const userDoc = await db.collection('users').findOne({ usernameLower: usernameToExtend.toLowerCase(), agentId: agentId });
                if (!userDoc) {
                    await bot.answerCallbackQuery(query.id, { text: `User ${usernameToExtend} bukan milik Anda.`, show_alert: true });
                    await displayAgentUserList(chatId, messageId, 1, agentId, 'extend'); 
                    return;
                }

                const costPer30Days = CONFIG.THIRTY_DAY_COST;
                const durationKeyboard = [
                    [{ text: `30 Hari (Biaya: ${costPer30Days * 1})`, callback_data: `agent_user_extend_setduration_${usernameToExtend}_30` }],
                    [{ text: `60 Hari (Biaya: ${costPer30Days * 2})`, callback_data: `agent_user_extend_setduration_${usernameToExtend}_60` }],
                    [{ text: `90 Hari (Biaya: ${costPer30Days * 3})`, callback_data: `agent_user_extend_setduration_${usernameToExtend}_90` }],
                    [{ text: '🔙 Batal', callback_data: `agent_user_extend_list_1` }]
                ];
                await sendOrEditMessage(chatId, `Pilih durasi perpanjangan untuk user \`${usernameToExtend}\`:`, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: durationKeyboard }
                }, messageId);
            } else if (subParams[0] === 'setduration') {
                const usernameToExtend = subParams[1];
                const daysToAdd = parseInt(subParams[2]);
                const cost = (daysToAdd / 30) * CONFIG.THIRTY_DAY_COST;

                const currentAgent = await getValidAgent(agentId); 

                if (currentAgent.balance < cost) {
                    await bot.answerCallbackQuery(query.id, { text: `⚠️ Saldo tidak cukup! Butuh ${cost.toLocaleString('id-ID')}, saldo Anda ${currentAgent.balance.toLocaleString('id-ID')}.`, show_alert: true });
                    return;
                }
                
                await bot.answerCallbackQuery(query.id, { text: `⏳ Memperpanjang ${usernameToExtend}...` });
                try {
                    const {newExpiry, quotaReset} = await extendUserExpiryInSystem(usernameToExtend, daysToAdd, agentId, true); 
                    await db.collection('agents').updateOne({ agentId }, { $inc: { balance: -cost } });
                    await logAction("AGENT_USER_EXTENDED_BALANCE_DEDUCTED", { agentId, username: usernameToExtend, cost, newBalance: currentAgent.balance - cost });
                    
                    let message = `✅ User \`${usernameToExtend}\` diperpanjang hingga ${new Date(newExpiry).toLocaleDateString('id-ID', {timeZone: 'Asia/Jakarta'})}.\nBiaya: ${cost.toLocaleString('id-ID')}. Saldo baru: ${(currentAgent.balance - cost).toLocaleString('id-ID', { style: 'currency', currency: 'IDR' })}.`;
                    if (quotaReset) {
                         message += `\nPenggunaan kuota dan catatan trafik Xray terakhir telah direset.`;
                    }
                    await bot.editMessageText(message, {
                        chat_id: chatId, message_id: messageId, parse_mode: 'Markdown'
                    });

                } catch (err) {
                    await logAction('AGENT_USER_EXTEND_FINAL_ERROR', { error: err, username: usernameToExtend, agentId });
                    await bot.editMessageText(`❌ Gagal memperpanjang user \`${usernameToExtend}\`: ${err.message}`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
                }
                setTimeout(() => showAgentMainMenu(chatId, null, agentId), 3000);
            }
            break;
        
        case 'online': 
            if (subParams[0] === 'ips') { 
                const page = parseInt(subParams[1] || 1);
                await displayAgentOnlineUserIPs(chatId, messageId, page, agentId);
            }
            break;

        default:
            break;
    }
    if(!query.answered) await bot.answerCallbackQuery(query.id).catch(()=>{});
}

async function handleAgentUserAddReceiveUsername(chatId, text, state) {
    if (state.originalMenuMessageId) {
        await deleteMessage(chatId, state.originalMenuMessageId);
    }

    const username = text.trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
        const newPrompt = await bot.sendMessage(chatId, "❌ Username tidak valid.\nHarus 3-32 karakter (huruf kecil, angka, ., _, -).\nMasukkan username lagi:");
        userState[chatId].promptMessageId = newPrompt.message_id; 
        return;
    }

    const existingUser = await db.collection('users').findOne({ usernameLower: username });
    if (existingUser) {
        const newPrompt = await bot.sendMessage(chatId, `⚠️ Username \`${username}\` sudah digunakan global. Pilih username lain:`);
        userState[chatId].promptMessageId = newPrompt.message_id;
        return;
    }
    
    const agentData = await db.collection('agents').findOne({ agentId: state.agentTelegramId });
    const agentMaxUsers = (agentData && typeof agentData.maxUsers === 'number') ? agentData.maxUsers : 0; // Default ke 0 jika tidak diset oleh admin
    const currentAgentUserCount = await db.collection('users').countDocuments({ agentId: state.agentTelegramId });

    if (agentMaxUsers > 0 && currentAgentUserCount >= agentMaxUsers) { // Hanya batasi jika maxUsers > 0
        await bot.sendMessage(chatId, `❌ Anda telah mencapai batas maksimal user (${agentMaxUsers}). Tidak bisa menambah user baru.`);
        delete userState[chatId];
        await showAgentMainMenu(chatId, null, state.agentTelegramId);
        return;
    }


    userState[chatId].username = username;
    userState[chatId].step = 'agent_user_add_receive_days'; 
    userState[chatId].handler = handleAgentUserAddReceiveDays; 
    
    const costPer30Days = CONFIG.THIRTY_DAY_COST;
    const durationKeyboard = [
        [{ text: `30 Hari (Biaya: ${costPer30Days * 1})`, callback_data: `agent_user_add_setduration_30` }],
        [{ text: `60 Hari (Biaya: ${costPer30Days * 2})`, callback_data: `agent_user_add_setduration_60` }],
        [{ text: `90 Hari (Biaya: ${costPer30Days * 3})`, callback_data: `agent_user_add_setduration_90` }],
        [{ text: '🔙 Batal', callback_data: 'main_agent_menu' }] 
    ];

    const newPrompt = await bot.sendMessage(chatId, `Username: \`${username}\`\nProtokol: ${PROTOCOLS[state.protocol].name}\n\nPilih durasi masa aktif:`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: durationKeyboard }
    });
    userState[chatId].promptMessageId = newPrompt.message_id; 
    userState[chatId].expectedCallbackPrefix = 'agent_user_add_setduration'; 
}

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const agentId = query.from.id.toString(); 
    const data = query.data;
    
    const agent = await getValidAgent(agentId); 
    if (!agent) {
        if(!query.answered) await bot.answerCallbackQuery(query.id, { text: "Akun agen tidak valid.", show_alert: true }).catch(()=>{});
        return;
    }

    const state = userState[chatId];
    if (!state || state.agentTelegramId !== agentId || !data.startsWith('agent_user_add_setduration_')) {
        if (data.startsWith('agent_user_add_setduration_') && (!state || state.agentTelegramId !== agentId)) {
             if(!query.answered) await bot.answerCallbackQuery(query.id, { text: "Sesi input tidak valid atau sudah berakhir.", show_alert: true }).catch(()=>{});
        }
        return; 
    }

    const days = parseInt(data.split('_').pop());
    if (isNaN(days)) {
        if(!query.answered) await bot.answerCallbackQuery(query.id, { text: "Durasi tidak valid.", show_alert: true }).catch(()=>{});
        return;
    }
    
    if (state.promptMessageId) {
        await deleteMessage(chatId, state.promptMessageId);
        state.promptMessageId = null; 
    }

    state.days = days;
    state.step = 'agent_user_add_receive_quota';
    state.handler = handleAgentUserAddReceiveQuota; 
    state.expectedCallbackPrefix = 'agent_user_add_setquota'; 

    const quotaOptionsKeyboard = CONFIG.QUOTA_SETTINGS.PRESET_QUOTAS_GB.map(gb => {
        const label = gb === 0 ? "Tanpa Batas" : `${gb} GB`;
        return [{ text: label, callback_data: `agent_user_add_setquota_${gb}` }];
    });
    quotaOptionsKeyboard.push([{ text: '🔙 Batal (Pilih Durasi)', callback_data: `agent_user_add_receive_username` }]); 
                                                                                                                        
    const quotaPrompt = await bot.sendMessage(chatId, `Username: \`${state.username}\`, Durasi: ${days} hari.\n\nPilih kuota data untuk user ini:`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: quotaOptionsKeyboard }
    });
    state.promptMessageId = quotaPrompt.message_id;

    if(!query.answered) await bot.answerCallbackQuery(query.id).catch(()=>{}); 
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const agentId = query.from.id.toString();
    const data = query.data;

    const agent = await getValidAgent(agentId);
    if (!agent) {
        if (!query.answered) await bot.answerCallbackQuery(query.id, { text: "Akun agen tidak valid.", show_alert: true }).catch(() => {});
        return;
    }

    const state = userState[chatId];
    if (!state || state.agentTelegramId !== agentId || !data.startsWith('agent_user_add_setquota_')) {
        if (data.startsWith('agent_user_add_setquota_') && (!state || state.agentTelegramId !== agentId)) {
            if (!query.answered) await bot.answerCallbackQuery(query.id, { text: "Sesi input tidak valid atau sudah berakhir.", show_alert: true }).catch(() => {});
        }
        return;
    }

    const quotaGB = parseInt(data.split('_').pop());
    if (isNaN(quotaGB)) { 
        if (!query.answered) await bot.answerCallbackQuery(query.id, { text: "Pilihan kuota tidak valid.", show_alert: true }).catch(() => {});
        return;
    }

    if (state.promptMessageId) {
        await deleteMessage(chatId, state.promptMessageId);
        state.promptMessageId = null;
    }
    
    await handleAgentUserAddReceiveQuota(chatId, quotaGB, state, query); 
    if (!query.answered) await bot.answerCallbackQuery(query.id).catch(() => {});
});


async function handleAgentUserAddReceiveDays(chatId, textOrDays, state, originalQueryForAnswer) {
    const days = parseInt(textOrDays); 
    if (isNaN(days) || days < 1 || days > 3650) {
        const newPrompt = await bot.sendMessage(chatId, "❌ Jumlah hari tidak valid. Silakan ulangi dari awal.");
        userState[chatId].promptMessageId = newPrompt.message_id; 
        delete userState[chatId]; 
        await showAgentMainMenu(chatId, null, state.agentTelegramId);
        if(originalQueryForAnswer && !originalQueryForAnswer.answered) await bot.answerCallbackQuery(originalQueryForAnswer.id).catch(()=>{});
        return;
    }
    state.days = days; 

    state.step = 'agent_user_add_receive_quota';
    state.handler = handleAgentUserAddReceiveQuota;
    state.expectedCallbackPrefix = 'agent_user_add_setquota';

    const quotaOptionsKeyboard = CONFIG.QUOTA_SETTINGS.PRESET_QUOTAS_GB.map(gb => {
        const label = gb === 0 ? "Tanpa Batas" : `${gb} GB`;
        return [{ text: label, callback_data: `agent_user_add_setquota_${gb}` }];
    });
    quotaOptionsKeyboard.push([{ text: '🔙 Batal', callback_data: `main_agent_menu` }]); 

    const quotaPrompt = await bot.sendMessage(chatId, `Username: \`${state.username}\`, Durasi: ${days} hari.\n\nPilih kuota data untuk user ini:`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: quotaOptionsKeyboard }
    });
    state.promptMessageId = quotaPrompt.message_id; 

    if(originalQueryForAnswer && !originalQueryForAnswer.answered) await bot.answerCallbackQuery(originalQueryForAnswer.id).catch(()=>{});
}

async function handleAgentUserAddReceiveQuota(chatId, quotaGB, state, originalQueryForAnswer) {
    const days = state.days; 
    const cost = (days / 30) * CONFIG.THIRTY_DAY_COST;
    const currentAgent = await getValidAgent(state.agentTelegramId); 

    if (currentAgent.balance < cost) {
        await bot.sendMessage(chatId, `❌ Saldo tidak mencukupi! Anda memerlukan ${cost.toLocaleString('id-ID')}, saldo Anda saat ini ${currentAgent.balance.toLocaleString('id-ID', { style: 'currency', currency: 'IDR' })}.`);
        delete userState[chatId];
        await showAgentMainMenu(chatId, null, state.agentTelegramId);
        if(originalQueryForAnswer && !originalQueryForAnswer.answered) await bot.answerCallbackQuery(originalQueryForAnswer.id).catch(()=>{});
        return;
    }
    
    const processingMsg = await bot.sendMessage(chatId, `⏳ Menambahkan user \`${state.username}\` (protokol: ${state.protocol}, ${days} hari, kuota: ${quotaGB === 0 ? 'Tanpa Batas' : quotaGB + 'GB'}, biaya: ${cost.toLocaleString('id-ID')})...`);

    try {
        const result = await addUserToSystem(state.protocol, state.username, days, state.agentTelegramId, state.agentTelegramId, true, quotaGB); 
        
        await db.collection('agents').updateOne({ agentId: state.agentTelegramId }, { $inc: { balance: -cost } });
        await logAction("AGENT_USER_ADDED_BALANCE_DEDUCTED", { agentId: state.agentTelegramId, username: state.username, cost, newBalance: currentAgent.balance - cost, quotaGB });
        
        await deleteMessage(chatId, processingMsg.message_id);

        let successMessage = `✅ User Berhasil Ditambahkan!\n\n`;
        successMessage += `👤 Username: \`${result.username}\`\n`;
        successMessage += `📡 Protokol: ${PROTOCOLS[result.protocol].name}\n`;
        successMessage += `📅 Kedaluwarsa: ${new Date(result.expiry).toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', year: 'numeric', month: 'long', day: 'numeric' })} (WIB)\n`;
        if (CONFIG.QUOTA_SETTINGS.ENABLED && result.quota && result.quota.totalBytes > 0) {
            successMessage += `⚖️ Kuota: ${formatBytes(result.quota.totalBytes)}\n`;
        } else if (CONFIG.QUOTA_SETTINGS.ENABLED) {
            successMessage += `⚖️ Kuota: Tidak terbatas\n`;
        }
        successMessage += `💰 Biaya: ${cost.toLocaleString('id-ID')}\n`;
        successMessage += `💲 Saldo Baru Anda: ${(currentAgent.balance - cost).toLocaleString('id-ID', { style: 'currency', currency: 'IDR' })}\n`;
        
        await bot.sendMessage(chatId, successMessage, { parse_mode: 'Markdown' });

        for (const qrInfo of result.qrCodes) {
            try {
                await bot.sendPhoto(chatId, qrInfo.path, { 
                    caption: `✨ ${PROTOCOLS[result.protocol].name} - ${qrInfo.type.toUpperCase()}\n\`${qrInfo.link}\`\n\nSalin link di atas atau scan QR code ini.` ,
                    parse_mode: 'Markdown'
                });
                await fsp.unlink(qrInfo.path);
            } catch (qrError) {
                await logAction("QR_SEND_ERROR_AGENT", {username: result.username, qrPath: qrInfo.path, error: qrError.message});
                await bot.sendMessage(chatId, `Gagal mengirim QR Code untuk ${qrInfo.type}. Link: \`${qrInfo.link}\``, {parse_mode: 'Markdown'});
            }
        }

    } catch (err) {
        await deleteMessage(chatId, processingMsg.message_id);
        await logAction('AGENT_USER_ADD_FINAL_ERROR', { error: err, username: state.username, protocol: state.protocol, agentId: state.agentTelegramId, quotaGB });
        await bot.sendMessage(chatId, `❌ Gagal menambahkan user: ${err.message}`);
    }

    delete userState[chatId];
    await showAgentMainMenu(chatId, null, state.agentTelegramId);
    if(originalQueryForAnswer && !originalQueryForAnswer.answered) await bot.answerCallbackQuery(originalQueryForAnswer.id).catch(()=>{});
}


async function handleAgentUserDeleteManualReceiveUsername(chatId, text, state) {
    const username = text.trim().toLowerCase();
    if (!username) {
        await bot.sendMessage(chatId, "❌ Username tidak boleh kosong.");
        await displayAgentUserList(chatId, state.originalMenuMessageId, 1, state.agentTelegramId, 'delete');
        delete userState[chatId];
        return;
    }

    const user = await db.collection('users').findOne({ usernameLower: username, agentId: state.agentTelegramId });
    if (!user) {
        await bot.sendMessage(chatId, `❌ User \`${username}\` tidak ditemukan atau bukan milik Anda.`);
        await displayAgentUserList(chatId, state.originalMenuMessageId, 1, state.agentTelegramId, 'delete');
        delete userState[chatId];
        return;
    }

    const confirmKeyboard = [
        [{ text: `✔️ YA, HAPUS ${user.username}`, callback_data: `agent_user_delete_execute_${user.username}` }],
        [{ text: `❌ TIDAK, BATAL`, callback_data: `agent_user_delete_list_1` }]
    ];
    await bot.sendMessage(chatId, `⚠️ Anda yakin ingin menghapus user \`${user.username}\` yang Anda buat?`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: confirmKeyboard }
    }); 
    
    delete userState[chatId]; 
}

async function handleAgentUserExtendManualReceiveUsername(chatId, text, state) {
    const username = text.trim().toLowerCase();
    if (!username) {
        await bot.sendMessage(chatId, "❌ Username tidak boleh kosong.");
        await displayAgentUserList(chatId, state.originalMenuMessageId, 1, state.agentTelegramId, 'extend');
        delete userState[chatId];
        return;
    }

    const user = await db.collection('users').findOne({ usernameLower: username, agentId: state.agentTelegramId });
    if (!user) {
        await bot.sendMessage(chatId, `❌ User \`${username}\` tidak ditemukan atau bukan milik Anda.`);
        await displayAgentUserList(chatId, state.originalMenuMessageId, 1, state.agentTelegramId, 'extend');
        delete userState[chatId];
        return;
    }
    
    userState[chatId] = { 
        ...state, 
        username: user.username, 
        expectedCallbackPrefix: 'agent_user_extend_setduration' 
    };
    
    const costPer30Days = CONFIG.THIRTY_DAY_COST;
    const durationKeyboard = [
        [{ text: `30 Hari (Biaya: ${costPer30Days * 1})`, callback_data: `agent_user_extend_setduration_${user.username}_30` }],
        [{ text: `60 Hari (Biaya: ${costPer30Days * 2})`, callback_data: `agent_user_extend_setduration_${user.username}_60` }],
        [{ text: `90 Hari (Biaya: ${costPer30Days * 3})`, callback_data: `agent_user_extend_setduration_${user.username}_90` }],
        [{ text: '🔙 Batal', callback_data: `agent_user_extend_list_1` }]
    ];

    const newPrompt = await bot.sendMessage(chatId, `User: \`${user.username}\`.\nPilih durasi perpanjangan:`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: durationKeyboard }
    });
    userState[chatId].promptMessageId = newPrompt.message_id; 
}

async function handleAgentUserViewManualReceiveUsername(chatId, text, state) {
    const username = text.trim().toLowerCase();
    if (!username) {
        await bot.sendMessage(chatId, "❌ Username tidak boleh kosong.");
        if (state.originalMenuMessageId) {
            await displayAgentUserList(chatId, state.originalMenuMessageId, 1, state.agentTelegramId, 'my');
        } else {
            await displayAgentUserList(chatId, null, 1, state.agentTelegramId, 'my');
        }
        delete userState[chatId];
        return;
    }

    const user = await db.collection('users').findOne({ usernameLower: username, agentId: state.agentTelegramId.toString() });
    if (!user) {
        await bot.sendMessage(chatId, `❌ User \`${username}\` tidak ditemukan atau bukan milik Anda.`);
        if (state.originalMenuMessageId) {
            await displayAgentUserList(chatId, state.originalMenuMessageId, 1, state.agentTelegramId, 'my');
        } else {
            await displayAgentUserList(chatId, null, 1, state.agentTelegramId, 'my');
        }
        delete userState[chatId];
        return;
    }

    await displaySingleUserDetailsForAgent(chatId, user, state.originalMenuMessageId); 
    
    delete userState[chatId]; 
}

async function displaySingleUserDetailsForAgent(chatId, user, messageIdToEdit) {
    let userDetailsText = `📄 **Detail User: \`${user.username}\`**\n\n`;
    userDetailsText += `👤 Username: \`${user.username}\`\n`;
    userDetailsText += `📡 Protokol: ${user.protocols ? user.protocols.join(', ') : 'N/A'}\n`;
    
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
    }
    
    userDetailsText += `🕒 Tanggal Dibuat: ${new Date(user.createdAt).toLocaleString('id-ID', {timeZone: 'Asia/Jakarta'})}\n`;

    const keyboard = [[{ text: '🔙 Kembali ke List User Saya', callback_data: 'agent_user_list_my_1' }]];
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
            const qrFilename = `${user.protocol}-${user.username}-${type}-detail-agent-${Date.now()}.png`;
            const qrPath = path.join(CONFIG.CONFIGS_DIR, qrFilename);
            if (await generateQR(link, qrPath)) {
                try {
                    await bot.sendPhoto(chatId, qrPath, { 
                        caption: `✨ ${PROTOCOLS[user.protocol].name} - ${type.toUpperCase()}\n\`${link}\`\n\nSalin link atau scan QR.` ,
                        parse_mode: 'Markdown',
                    });
                    await fsp.unlink(qrPath); 
                } catch (qrError) {
                    await logAction("QR_SEND_ERROR_AGENT_DETAIL", {username: user.username, qrPath, error: qrError.message});
                    await bot.sendMessage(chatId, `Gagal mengirim QR Code untuk ${type}. Link: \`${link}\``, {parse_mode: 'Markdown'});
                }
            }
        }
    }
}


async function displayAgentUserList(chatId, messageId, page, agentId, mode = 'my') { 
    page = Math.max(1, page);
    const skip = (page - 1) * CONFIG.ITEMS_PER_PAGE;

    const query = { agentId: agentId.toString() }; 
    const users = await db.collection('users').find(query).sort({ createdAt: -1 }).skip(skip).limit(CONFIG.ITEMS_PER_PAGE).toArray();
    const totalUsers = await db.collection('users').countDocuments(query);
    const totalPages = Math.ceil(totalUsers / CONFIG.ITEMS_PER_PAGE);

    let listText = `📋 **Daftar User Anda (Halaman ${page}/${totalPages}) - Total: ${totalUsers}**\n\n`;
    const keyboardRows = [];

    if (users.length === 0) {
        listText += "Anda belum memiliki user terdaftar.";
    } else {
        users.forEach(user => {
            const expiryDate = new Date(user.expiry);
            const isExpired = expiryDate < new Date();
            const expiryFormatted = expiryDate.toLocaleDateString('id-ID', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'Asia/Jakarta' });
            
            listText += `👤 \`${user.username}\` (${user.protocols ? user.protocols.join(', ') : 'N/A'})\n`;
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
                keyboardRows.push([{ text: `🗑 Hapus ${user.username}`, callback_data: `agent_user_delete_confirm_${user.username}` }]);
            } else if (mode === 'extend') {
                keyboardRows.push([{ text: `⏳ Perpanjang ${user.username}`, callback_data: `agent_user_extend_selectuser_${user.username}` }]);
            } else if (mode === 'my') { 
                keyboardRows.push([{ text: `👁️ Lihat Detail ${user.username}`, callback_data: `agent_user_my_manual_prompt_view_${user.username}` }]);
            }
            listText += `----\n`;
        });
    }

    if (mode === 'delete') {
        keyboardRows.push([{ text: '✏️ Input Nama Manual (Hapus)', callback_data: 'agent_user_delete_manual_prompt' }]);
    } else if (mode === 'extend') {
        keyboardRows.push([{ text: '✏️ Input Nama Manual (Perpanjang)', callback_data: 'agent_user_extend_manual_prompt' }]);
    } else if (mode === 'my') { 
        keyboardRows.push([{ text: '✏️ Input Nama Manual (Lihat)', callback_data: 'agent_user_my_manual_prompt' }]);
    }


    const paginationButtons = [];
    let paginationCallbackPrefix = `agent_user_${mode}_list`; 
    if (mode === 'my') {
        paginationCallbackPrefix = `agent_user_my_list`; 
    }


    if (page > 1) {
        paginationButtons.push({ text: '⬅️ Hal Seb', callback_data: `${paginationCallbackPrefix}_${page - 1}` }); 
    }
    if (page < totalPages) {
        paginationButtons.push({ text: 'Hal Berik ➡️', callback_data: `${paginationCallbackPrefix}_${page + 1}` }); 
    }
    if (paginationButtons.length > 0) {
        keyboardRows.push(paginationButtons);
    }
    keyboardRows.push([{ text: '🔙 Kembali ke Menu Agen', callback_data: 'main_agent_menu' }]);
    
    await sendOrEditMessage(chatId, listText, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboardRows }
    }, messageId);
}

async function displayAgentOnlineUserIPs(chatId, messageId, page, agentId) {
    page = Math.max(1, page);
    const onlineUsersData = await getOnlineUserIPsFromLog(); 

    const agentUsers = await db.collection('users').find({ agentId: agentId.toString() }, { projection: { username: 1 } }).toArray();
    const agentUsernames = agentUsers.map(u => u.username);

    const filteredOnlineUserData = {};
    agentUsernames.forEach(username => {
        if (onlineUsersData[username]) {
            filteredOnlineUserData[username] = onlineUsersData[username];
        }
    });

    const usernamesOnline = Object.keys(filteredOnlineUserData).sort();
    
    const totalItems = usernamesOnline.length;
    const totalPages = Math.ceil(totalItems / CONFIG.ITEMS_PER_PAGE);
    const startIndex = (page - 1) * CONFIG.ITEMS_PER_PAGE;
    const endIndex = startIndex + CONFIG.ITEMS_PER_PAGE;
    const paginatedUsernames = usernamesOnline.slice(startIndex, endIndex);

    let text = `📡 **User Online Anda & IP Terdeteksi (5 Menit Terakhir)**\n(Halaman ${page}/${totalPages} - Total: ${totalItems} user aktif)\n\n`;
    if (paginatedUsernames.length === 0) {
        text += "Tidak ada user Anda yang aktif terdeteksi atau log Xray tidak dapat diakses.";
    } else {
        paginatedUsernames.forEach(username => {
            const ips = filteredOnlineUserData[username];
            text += `👤 \`${username}\` (${ips.length} IP):\n   \`${ips.join('`, `')}\`\n`;
            text += `----\n`;
        });
    }

    const keyboardRows = [];
    const paginationButtons = [];
    if (page > 1) {
        paginationButtons.push({ text: '⬅️ Hal Seb', callback_data: `agent_user_online_ips_${page - 1}` });
    }
    if (page < totalPages) {
        paginationButtons.push({ text: 'Hal Berik ➡️', callback_data: `agent_user_online_ips_${page + 1}` });
    }
    if (paginationButtons.length > 0) {
        keyboardRows.push(paginationButtons);
    }
    keyboardRows.push([{ text: '🔄 Refresh', callback_data: `agent_user_online_ips_${page}` }]);
    keyboardRows.push([{ text: '🔙 Kembali ke Menu Agen', callback_data: 'main_agent_menu' }]);

    await sendOrEditMessage(chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboardRows }
    }, messageId);
}


// --- Fungsi Inti Sistem User (disesuaikan untuk agen) ---
async function addUserToSystem(protocol, username, days, actorId, agentIdForUser, isAgentAction = false, quotaGB = 0) { 
    // Pemeriksaan batas user agen dipindahkan ke handleAgentUserAddReceiveUsername
    // agar agen mendapat feedback lebih awal sebelum memasukkan semua detail.

    const usernameLower = username.toLowerCase();
    const existingUser = await db.collection('users').findOne({ usernameLower });
    if (existingUser) {
        throw new Error(`Username "${username}" sudah digunakan secara global.`);
    }

    const domain = await getDomain();
    const protoConfig = PROTOCOLS[protocol];
    if (!protoConfig) throw new Error(`Protokol "${protocol}" tidak dikenal.`);

    const credentials = {};
    for (const field of protoConfig.fields) {
        credentials[field] = field === 'id' ? generateUUID() :
                             field === 'password' ? generatePassword() : username;
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
    } 

    const xrayConfig = await readXrayConfig();
    protoConfig.inbounds.forEach(inboundTag => {
        let inbound = xrayConfig.inbounds.find(i => i.tag === inboundTag);
        if (!inbound) throw new Error(`Inbound tag "${inboundTag}" tidak ditemukan. Hubungi admin.`);
        if (!inbound.settings) inbound.settings = {};
        if (!inbound.settings.clients) inbound.settings.clients = [];
        inbound.settings.clients = inbound.settings.clients.filter(c => c.email !== username);
        inbound.settings.clients.push({ email: username, ...credentials });
    });
    await saveXrayConfig(xrayConfig); 
    await restartXray(); 

    const newUserDoc = {
        username, usernameLower, protocol, protocols: [protocol], credentials,
        expiry: expiryISO, agentId: agentIdForUser, createdBy: actorId, 
        createdAt: new Date(), isActive: true,
        quota: userQuotaData 
    };
    await db.collection('users').insertOne(newUserDoc);

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
    
    await logAction('USER_ADDED_TO_SYSTEM_BY_AGENT', { username, protocol, days, actorId, agentIdForUser, quotaGB });
    return { username, protocol, expiry: expiryISO, agentId: agentIdForUser, qrCodes, quota: userQuotaData };
}

async function deleteUserFromSystem(username, actorId, isAgentAction = false) {
    const usernameLower = username.toLowerCase();
    const query = { usernameLower };
    if (isAgentAction) {
        query.agentId = actorId.toString(); 
    }
    const user = await db.collection('users').findOne(query);

    if (!user) {
        return { success: false, message: `User "${username}" tidak ditemukan atau bukan milik Anda.` };
    }

    const xrayConfig = await readXrayConfig();
    let userFoundInXray = false;
    xrayConfig.inbounds.forEach(inbound => {
        if (inbound.settings && inbound.settings.clients) {
            const initialLength = inbound.settings.clients.length;
            inbound.settings.clients = inbound.settings.clients.filter(c => c.email !== user.username);
            if (inbound.settings.clients.length < initialLength) userFoundInXray = true;
        }
    });

    if (userFoundInXray) {
        await saveXrayConfig(xrayConfig); 
        await restartXray(); 
    }

    await db.collection('users').deleteOne({ _id: user._id }); 

    await logAction('USER_DELETED_FROM_SYSTEM_BY_AGENT', { username: user.username, actorId, userFoundInXray });
    return { success: true, message: `User "${user.username}" berhasil dihapus.` };
}

async function extendUserExpiryInSystem(username, daysToAdd, actorId, isAgentAction = false) {
    const usernameLower = username.toLowerCase();
    const query = { usernameLower };
     if (isAgentAction) {
        query.agentId = actorId.toString(); 
    }
    const user = await db.collection('users').findOne(query);

    if (!user) {
        throw new Error(`User "${username}" tidak ditemukan atau bukan milik Anda.`);
    }

    const currentExpiry = new Date(user.expiry);
    const newExpiryDate = new Date(currentExpiry);
    newExpiryDate.setDate(newExpiryDate.getDate() + daysToAdd);
    const newExpiryISO = newExpiryDate.toISOString();

    const updateFields = { 
        expiry: newExpiryISO, 
        updatedAt: new Date(), 
        lastExtendedBy: actorId,
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
        { _id: user._id }, 
        { $set: updateFields }
    );

    await logAction('USER_EXTENDED_IN_SYSTEM_BY_AGENT', { username: user.username, daysAdded: daysToAdd, newExpiry: newExpiryISO, actorId, quotaReset: quotaResetPerformed });
    return {newExpiry: newExpiryISO, quotaReset: quotaResetPerformed};
}

async function getOnlineUserIPsFromLog() { 
    const logPath = '/var/log/xray/access.log';
    const userIpMap = {};
    const now = Date.now();
    const TIME_WINDOW = 5 * 60 * 1000; 

    try {
        if (!fs.existsSync(logPath)) return userIpMap;
        const data = await fsp.readFile(logPath, 'utf8');
        const lines = data.trim().split('\n');
        
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i];
            const match = line.match(/(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}).*? ([\d\.:a-fA-F]+):[\d]+ accepted.*?email: (\S+)/) ||
                          line.match(/(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}).*? ([\d\.:a-fA-F]+):[\d]+ accepted.*?user: (\S+)/);
            if (match) {
                const logTimestamp = new Date(match[1]).getTime();
                if (now - logTimestamp > TIME_WINDOW && i < lines.length - 100) break; 
                const ip = match[2].includes(':') && !match[2].startsWith('[') ? `[${match[2]}]` : match[2];
                const user = match[3];
                if (!userIpMap[user]) userIpMap[user] = new Set();
                userIpMap[user].add(ip);
            }
        }
        const result = {};
        for (const user in userIpMap) result[user] = Array.from(userIpMap[user]);
        return result;
    } catch (err) {
        await logAction('GET_ONLINE_IPS_ERROR_AGENT', { error: err.message });
        return {};
    }
}

// ==========================================
//      INISIALISASI & PENANGANAN ERROR (AGENT)
// ==========================================
(async () => {
  try {
    await connectToDB();
    if (!fs.existsSync(CONFIG.CONFIGS_DIR)) { 
        await fsp.mkdir(CONFIG.CONFIGS_DIR, { recursive: true });
    }
    await fsp.writeFile(CONFIG.LOG_FILE, '', { flag: 'a' }); 

    if (!CONFIG.BOT_TOKEN) {
        const errMsg = "❌ BOT_TOKEN tidak ditemukan di environment variables. Agent bot tidak dapat dimulai.";
        console.error(errMsg);
        await logAction("AGENT_BOT_STARTUP_ERROR", {message: errMsg});
        process.exit(1);
    }
    if (!CONFIG.THIRTY_DAY_COST || CONFIG.THIRTY_DAY_COST <=0) {
        const errMsg = "❌ THIRTY_DAY_COST tidak valid atau tidak diset. Agent bot tidak dapat menghitung biaya.";
        console.error(errMsg);
        await logAction("AGENT_BOT_STARTUP_ERROR", {message: errMsg});
    }


    console.log(`🤖 Agent Bot (MongoDB Edition) berhasil dijalankan pada ${new Date().toLocaleString('id-ID', {timeZone: 'Asia/Jakarta'})}`);
    await logAction('AGENT_BOT_STARTED_SUCCESSFULLY');

  } catch (err) {
    console.error('❌ Gagal inisialisasi Agent Bot:', err);
    await logAction('AGENT_BOT_INITIALIZATION_FAILED', { error: err.message, stack: err.stack });
    process.exit(1);
  }
})();

process.on('unhandledRejection', async (reason, promise) => {
  console.error('Agent Bot: Unhandled Rejection at:', promise, 'reason:', reason);
  await logAction('UNHANDLED_REJECTION_AGENT', { reason: reason instanceof Error ? reason.message : reason, stack: reason instanceof Error ? reason.stack : undefined });
});

process.on('uncaughtException', async (err) => {
  console.error('Agent Bot: Uncaught Exception:', err);
  await logAction('UNCAUGHT_EXCEPTION_AGENT', { error: err.message, stack: err.stack });
});
