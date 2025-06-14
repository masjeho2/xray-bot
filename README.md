Skrip Instalasi Otomatis Xray & HAProxy
Skrip ini dirancang untuk mengotomatiskan seluruh proses penyiapan server proxy premium menggunakan Xray-core, dengan HAProxy sebagai reverse proxy dan dilengkapi bot Telegram untuk manajemen.
✨ Fitur Utama
 * 🚀 Instalasi Otomatis: Siapkan semua komponen dari awal hingga akhir dengan satu perintah.
 * ⚙️ Multi-Protokol Xray: Langsung mendukung VLESS, VMess, dan Trojan dengan transpor WebSocket & gRPC.
 * 🔒 Sertifikat SSL Gratis: Otomatis menerbitkan dan memperbarui sertifikat SSL dari Let's Encrypt.
 * 🤖 Bot Manajemen: Kelola pengguna (tambah, hapus, cek) dengan mudah melalui Bot Telegram tanpa perlu login ke server.
 * ⚡ Optimasi Kinerja:
   * Mengaktifkan TCP BBR untuk koneksi lebih cepat dan stabil.
   * Meningkatkan batas sistem (ulimit) untuk menangani ribuan koneksi.
 * 🛡️ Keamanan Dasar:
   * Memasang Fail2Ban untuk melindungi dari serangan brute-force.
   * Menambahkan aturan firewall iptables untuk memblokir lalu lintas torrent.
 * 🖥️ Menu Manajemen: Menyediakan panel menu di terminal untuk pengelolaan pasca-instalasi.
📋 Persyaratan
Pastikan server Anda memenuhi semua persyaratan di bawah ini sebelum memulai.
| Kategori | Persyaratan Minimal | Catatan Penting |
|---|---|---|
| Server (VPS) | Server baru (fresh install) | Jangan gunakan pada server yang sudah memiliki konfigurasi. |
| Sistem Operasi | Ubuntu 20.04+ atau Debian 10+ | Skrip dioptimalkan untuk distro ini. |
| CPU & RAM | 1 Core CPU & 1 GB RAM |  |
| Domain | Sebuah domain dengan A Record | Arahkan domain ke alamat IP server Anda sebelum mulai. |
| Akses | Login sebagai pengguna root | Diperlukan untuk instalasi paket dan konfigurasi sistem. |
🚀 Cara Instalasi
 * Login ke server Anda sebagai pengguna root.
 * Salin dan jalankan perintah di bawah ini:
   bash -c "$(curl -sL https://raw.githubusercontent.com/masjeho2/xray-bot/refs/heads/v1/install)"

 * Skrip akan berjalan. Anda hanya perlu memasukkan nama domain Anda ketika diminta.
 * Setelah selesai, setujui untuk reboot server.
🛠️ Setelah Instalasi
Setelah server menyala kembali, login dan ketik perintah berikut untuk menampilkan panel menu:
menu

Anda kini siap untuk mengelola layanan dan pengguna Anda!
