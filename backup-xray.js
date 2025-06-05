// backup-xray.js

// Import modul yang diperlukan
const cron = require('node-cron');
const fs = require('fs').promises; // Menggunakan fs.promises untuk async/await
const fssync = require('fs'); // Untuk createReadStream
const path = require('path');
const os = require('os'); // Modul os untuk mendapatkan direktori temporary sistem
const { exec } = require('child_process');
const axios = require('axios');
const FormData = require('form-data');

// --- Konfigurasi (Silakan sesuaikan jika perlu) ---
// WARNING: Menyimpan token API secara langsung dalam kode tidak disarankan untuk produksi.
// Pertimbangkan untuk menggunakan variabel lingkungan.
const TELEGRAM_BOT_TOKEN = '7175139538:AAEVAER74yWldaNyMA9euH2gg4IiJ3f09AM'; // GANTI DENGAN TOKEN BOT ANDA
const TELEGRAM_CHAT_ID = '8111568992'; // GANTI DENGAN CHAT ID ANDA

const SOURCE_DIR_PARENT = '/usr/local/etc'; // Direktori induk dari folder yang akan di-backup
const SOURCE_DIR_NAME = 'xray'; // Nama folder yang akan di-backup
const SOURCE_FULL_PATH = path.join(SOURCE_DIR_PARENT, SOURCE_DIR_NAME);

// Direktori untuk menyimpan file backup sementara sebelum dikirim
// Menggunakan direktori temporary sistem (/tmp pada Linux/macOS)
const TEMP_BACKUP_DIR = path.join(os.tmpdir(), 'temp_backups_xray');
const EXCLUDE_PATTERN = 'node_modules'; // Folder atau pola yang akan dikecualikan

// --- Fungsi Helper ---

/**
 * Menjalankan perintah shell dan mengembalikan Promise.
 * @param {string} command Perintah yang akan dijalankan.
 * @returns {Promise<string>} Output stdout dari perintah.
 */
function executeCommand(command) {
    return new Promise((resolve, reject) => {
        console.log(`[CMD] Executing: ${command}`);
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error(`[CMD ERROR] Error executing command: ${command}\n${error.message}`);
                if (stderr) console.error(`[CMD STDERR] ${stderr}`);
                reject(error);
                return;
            }
            if (stderr) {
                // Beberapa perintah mungkin mengeluarkan output ke stderr untuk info, bukan error
                console.warn(`[CMD STDERR (possibly non-fatal)] For command: ${command}\n${stderr}`);
            }
            console.log(`[CMD STDOUT] For command: ${command}\n${stdout || '(No stdout)'}`);
            resolve(stdout);
        });
    });
}

/**
 * Memastikan direktori backup sementara ada, jika tidak maka akan dibuat.
 */
async function ensureTempBackupDirExists() {
    try {
        await fs.mkdir(TEMP_BACKUP_DIR, { recursive: true });
        console.log(`[INFO] Temporary backup directory ensured: ${TEMP_BACKUP_DIR}`);
    } catch (error) {
        console.error(`[ERROR] Failed to create temporary backup directory ${TEMP_BACKUP_DIR}:`, error);
        throw error; // Lempar error agar bisa ditangani di level atas
    }
}

/**
 * Membuat file arsip (backup).
 * @returns {Promise<string|null>} Path ke file backup yang dibuat, atau null jika gagal.
 */
async function createBackupArchive() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFileName = `xray-backup-${timestamp}.tar.gz`;
    const backupFilePath = path.join(TEMP_BACKUP_DIR, backupFileName);

    // Periksa apakah direktori sumber ada
    try {
        await fs.access(SOURCE_FULL_PATH);
        console.log(`[INFO] Source directory ${SOURCE_FULL_PATH} exists.`);
    } catch (error) {
        console.error(`[ERROR] Source directory ${SOURCE_FULL_PATH} does not exist or is not accessible. Skipping backup.`);
        return null;
    }

    // Perintah tar:
    // -c: create archive
    // -z: compress with gzip
    // -f: specify archive filename
    // -C <dir>: change to directory <dir> before performing any operations
    // --exclude=<pattern>: exclude files matching pattern
    // ${SOURCE_DIR_NAME}: directory to archive (relative to -C path)
    const tarCommand = `tar -czf "${backupFilePath}" -C "${SOURCE_DIR_PARENT}" --exclude="${EXCLUDE_PATTERN}" "${SOURCE_DIR_NAME}"`;

    try {
        console.log(`[INFO] Creating backup archive for ${SOURCE_FULL_PATH}...`);
        await executeCommand(tarCommand);
        console.log(`[SUCCESS] Backup archive created: ${backupFilePath}`);
        return backupFilePath;
    } catch (error) {
        console.error(`[ERROR] Failed to create backup archive:`, error);
        return null;
    }
}

/**
 * Mengirim file backup ke Telegram.
 * @param {string} filePath Path ke file backup.
 * @returns {Promise<boolean>} True jika berhasil terkirim, false jika gagal.
 */
async function sendBackupToTelegram(filePath) {
    const fileName = path.basename(filePath);
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`;

    const form = new FormData();
    form.append('chat_id', TELEGRAM_CHAT_ID);
    form.append('document', fssync.createReadStream(filePath), fileName); // Gunakan fssync untuk stream
    form.append('caption', `Backup otomatis folder '${SOURCE_DIR_NAME}'\nTanggal: ${new Date().toLocaleString('id-ID')}\nNama file: ${fileName}`);

    try {
        console.log(`[INFO] Sending ${fileName} to Telegram...`);
        const response = await axios.post(url, form, {
            headers: {
                ...form.getHeaders(), // Penting untuk multipart/form-data
            },
            maxContentLength: Infinity, // Untuk menangani file besar jika perlu
            maxBodyLength: Infinity,
        });

        if (response.data && response.data.ok) {
            console.log(`[SUCCESS] Backup ${fileName} successfully sent to Telegram.`);
            return true;
        } else {
            console.error(`[ERROR] Failed to send backup to Telegram. Response:`, response.data);
            return false;
        }
    } catch (error) {
        console.error(`[ERROR] Error sending backup to Telegram:`, error.response ? error.response.data : error.message);
        return false;
    }
}

/**
 * Menghapus file backup lokal.
 * @param {string} filePath Path ke file backup yang akan dihapus.
 * @returns {Promise<void>}
 */
async function deleteLocalBackupFile(filePath) {
    try {
        await fs.unlink(filePath);
        console.log(`[INFO] Local backup file ${filePath} deleted successfully.`);
    } catch (error) {
        console.error(`[ERROR] Failed to delete local backup file ${filePath}:`, error);
        // Tidak melempar error di sini agar proses lain bisa berlanjut jika diinginkan
    }
}

// --- Proses Utama Backup ---
async function runFullBackupProcess() {
    console.log(`[${new Date().toISOString()}] Starting hourly backup process for '${SOURCE_FULL_PATH}'...`);

    try {
        await ensureTempBackupDirExists(); // Pastikan direktori temp ada sebelum membuat arsip
        const backupFilePath = await createBackupArchive();

        if (backupFilePath) {
            const telegramSuccess = await sendBackupToTelegram(backupFilePath);
            if (telegramSuccess) {
                await deleteLocalBackupFile(backupFilePath);
            } else {
                console.warn(`[WARN] Backup file ${backupFilePath} was not deleted because Telegram send failed. It should be cleaned on next reboot if it's in /tmp.`);
            }
        } else {
            console.error(`[ERROR] Backup process aborted due to failure in archive creation.`);
        }
    } catch (error) {
        console.error(`[ERROR] An error occurred during the backup process:`, error);
    }
    console.log(`[${new Date().toISOString()}] Hourly backup process finished.`);
}

// --- Penjadwalan Cron ---
// Format cron: 'detik menit jam hari_bulan bulan hari_minggu'
// '0 * * * *' artinya "pada menit ke-0 setiap jam" (setiap jam xx:00)
cron.schedule('0 * * * *', async () => {
    try {
        await runFullBackupProcess();
    } catch (error) {
        // Menangkap error yang tidak tertangani dari runFullBackupProcess
        console.error(`[FATAL CRON ERROR][${new Date().toISOString()}] Unhandled error during scheduled backup process:`, error);
    }
});

// --- Inisialisasi Skrip ---
(async () => {
    try {
        await ensureTempBackupDirExists(); // Pastikan direktori temp ada saat skrip dimulai
        console.log(`[INIT] Xray Backup Script to Telegram started successfully.`);
        console.log(`[INIT] Source directory to backup: ${SOURCE_FULL_PATH}`);
        console.log(`[INIT] Exclude pattern: ${EXCLUDE_PATTERN}`);
        console.log(`[INIT] Temporary backup storage: ${TEMP_BACKUP_DIR}`);
        console.log(`[INIT] Scheduled to run every hour at minute 0.`);
        console.log(`[INIT] Press CTRL+C to stop the script.`);
        // Anda bisa uncomment baris di bawah jika ingin menjalankan backup sekali saat skrip pertama kali dijalankan.
        // console.log('[INIT] Performing initial backup run...');
        // await runFullBackupProcess();
    } catch (error) {
        console.error("[FATAL INIT ERROR] Failed to initialize backup script. Please check configurations and permissions.", error);
        process.exit(1); // Keluar jika inisialisasi gagal
    }
})();

