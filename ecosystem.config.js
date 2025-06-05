module.exports = {
  apps: [
    {
      name: "xray-admin-bot", // Nama yang lebih deskriptif untuk bot admin
      script: "/usr/local/etc/xray/bot-admin-mongo.js", // Path ke skrip admin bot BARU
      cwd: "/usr/local/etc/xray/", // Direktori kerja
      watch: false, // Sebaiknya false untuk produksi
      instances: 1, // Bot admin biasanya cukup 1 instance
      exec_mode: "fork",
      env: {
        "NODE_ENV": "production",
        // Variabel lingkungan ini akan dibaca oleh require('dotenv').config() di dalam bot-admin-mongo.js
        // Pastikan path ini menunjuk ke file .env yang berisi BOT_TOKEN untuk admin, INITIAL_ADMIN, dan MONGO_URI
        "ADMIN_ENV_PATH": "/usr/local/etc/xray/adminenv/.env" 
      }
    },
    {
      name: "xray-agent-bot-1", // Nama untuk instance agen bot pertama
      script: "/usr/local/etc/xray/bot-agent-mongo.js", // Path ke skrip agen bot BARU
      cwd: "/usr/local/etc/xray/",
      watch: false,
      instances: 1, // Anda bisa menjalankan beberapa instance agen jika masing-masing memiliki token bot yang berbeda
      exec_mode: "fork",
      env: {
        "NODE_ENV": "production",
        // Variabel lingkungan ini akan dibaca oleh require('dotenv').config() di dalam bot-agent-mongo.js
        // Pastikan path ini menunjuk ke file .env yang berisi BOT_TOKEN untuk agen pertama, MONGO_URI, dan THIRTY_DAY_COST
        "AGENT_ENV_PATH": "/usr/local/etc/xray/bot1.env" // Sesuai contoh Anda
      }
    },
    {
      name: "xray-agent-bot-2", // Nama untuk instance agen bot kedua
      script: "/usr/local/etc/xray/bot-agent-mongo.js", // Skrip yang sama, env yang berbeda
      cwd: "/usr/local/etc/xray/",
      watch: false,
      instances: 1,
      exec_mode: "fork",
      env: {
        "NODE_ENV": "production",
        // Pastikan path ini menunjuk ke file .env yang berisi BOT_TOKEN untuk agen kedua, MONGO_URI, dan THIRTY_DAY_COST
        "AGENT_ENV_PATH": "/usr/local/etc/xray/bot2.env" // Sesuai contoh Anda
      }
    }
    // Tambahkan konfigurasi untuk instance agen bot lainnya jika diperlukan,
    // pastikan setiap instance memiliki 'name' yang unik dan 'AGENT_ENV_PATH'
    // yang menunjuk ke file .env yang sesuai (dengan token bot yang unik per instance).
  ]
};

