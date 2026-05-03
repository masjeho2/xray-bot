#!/bin/bash

# =================================================================
# Skrip Instalasi Server Xray, HAProxy, dan Bot
#
# Deskripsi:
# Skrip ini mengotomatiskan penyiapan server proxy dengan Xray,
# menggunakan HAProxy sebagai reverse proxy, dan menyertakan
# bot Telegram untuk manajemen.
#
# Versi: 2.0 (Idempotent - Aman Dijalankan Berulang)
# =================================================================

set -e

# --- [BAGIAN 1: PENGATURAN AWAL & VARIABEL] ---

NC='\e[0m'
DEFBOLD='\e[39;1m'
RB='\e[31;1m'
GB='\e[32;1m'
YB='\e[33;1m'
BB='\e[34;1m'
WB='\e[37;1m'

GITHUB_REPO="raw.githubusercontent.com/masjeho2"
XRAY_BOT_REPO_V1="${GITHUB_REPO}/xray-bot/v1"
CONF_REPO="${GITHUB_REPO}/conf/main"
MENU_REPO="${GITHUB_REPO}/v1/xray"

start_time=$(date +%s)

# --- [BAGIAN 2: FUNGSI UTILITAS] ---

log_message() {
    local type="$1"
    local message="$2"
    case "$type" in
        "INFO")  color="$GB" ;;
        "WARN")  color="$YB" ;;
        "ERROR") color="$RB" ;;
        "SKIP")  color="$BB" ;;
        *)       color="$NC" ;;
    esac
    echo -e "${color}[ ${type} ]${NC} ${WB}${message}${NC}"
}

secs_to_human() {
    local total_secs=$1
    local hours=$((total_secs / 3600))
    local minutes=$(((total_secs / 60) % 60))
    local seconds=$((total_secs % 60))
    log_message "INFO" "Total waktu instalasi: ${hours} jam, ${minutes} menit, ${seconds} detik."
}

# Cek apakah paket sudah terinstall
is_pkg_installed() {
    dpkg -l "$1" 2>/dev/null | grep -q "^ii"
}

# Cek apakah command tersedia
is_cmd_installed() {
    command -v "$1" &>/dev/null
}

# --- [BAGIAN 3: FUNGSI-FUNGSI INSTALASI] ---

# Update sistem (selalu dijalankan agar paket tetap up-to-date)
update_system() {
    log_message "INFO" "Memperbarui daftar paket sistem..."
    apt-get update -y
    apt-get full-upgrade -y
    apt-get dist-upgrade -y
    apt-get autoremove -y
    log_message "INFO" "Pembaruan sistem selesai."
}

# Install dependensi — lewati paket yang sudah ada
install_dependencies() {
    log_message "INFO" "Memeriksa dan menginstal dependensi..."
    local pkgs=(
        socat curl screen cron screenfetch netfilter-persistent
        vnstat lsof fail2ban sysstat jq gnupg
        software-properties-common lolcat
    )
    local to_install=()
    for pkg in "${pkgs[@]}"; do
        if is_pkg_installed "$pkg"; then
            log_message "SKIP" "Paket '${pkg}' sudah terinstall, dilewati."
        else
            to_install+=("$pkg")
        fi
    done
    if [ ${#to_install[@]} -gt 0 ]; then
        apt-get install -y "${to_install[@]}"
        log_message "INFO" "Instalasi dependensi selesai: ${to_install[*]}"
    else
        log_message "SKIP" "Semua dependensi sudah terinstall."
    fi
}

# Buat direktori — mkdir -p aman untuk idempoten
setup_directories() {
    log_message "INFO" "Memastikan direktori yang diperlukan sudah ada..."
    mkdir -p \
        /backup /user \
        /var/www/html/{vmess,vless,trojan,shadowsocks,shadowsocks2022,socks5,allxray} \
        /usr/local/etc/xray/{adminenv,agenenv} \
        /etc/haproxy/certs \
        /var/log/xray \
        /usr/local/share/xray
    log_message "INFO" "Direktori siap."
}

# Install & konfigurasi Xray — lewati jika binary sudah ada
setup_xray() {
    if is_cmd_installed "/usr/local/bin/xray"; then
        log_message "SKIP" "Xray sudah terinstall, melewati instalasi binary."
    else
        log_message "INFO" "Menginstal Xray Core..."
        bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" - install
        chmod +x /usr/local/bin/xray
        log_message "INFO" "Xray Core berhasil diinstall."
    fi

    # Selalu tulis ulang unit file (idempoten, tidak merusak)
    log_message "INFO" "Memperbarui unit systemd Xray..."
    cat > /etc/systemd/system/xray.service << 'END'
[Unit]
Description=Xray Service
Documentation=https://github.com/xtls
After=network.target nss-lookup.target

[Service]
User=nobody
CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ExecStart=/usr/local/bin/xray run -config /usr/local/etc/xray/config.json
Restart=on-failure
RestartPreventExitStatus=23
LimitNPROC=10000
LimitNOFILE=1000000

[Install]
WantedBy=multi-user.target
END

    systemctl daemon-reload
    systemctl enable xray

    # Backup binary hanya jika belum ada
    if [ ! -f /backup/xray.mod.backup ]; then
        cp /usr/local/bin/xray /backup/xray.mod.backup
        log_message "INFO" "Backup binary Xray disimpan."
    else
        log_message "SKIP" "Backup Xray sudah ada, dilewati."
    fi

    # Ambil info Geo hanya jika belum ada
    if [ ! -f /usr/local/etc/xray/city ]; then
        log_message "INFO" "Mengambil informasi Geo server..."
        curl -s ipinfo.io/city > /usr/local/etc/xray/city
        curl -s ipinfo.io/org | cut -d " " -f 2-10 > /usr/local/etc/xray/org
        curl -s ipinfo.io/timezone > /usr/local/etc/xray/timezone
    else
        log_message "SKIP" "Info Geo sudah ada, dilewati."
    fi

    # Download GeoIP & GeoSite hanya jika belum ada
    if [ ! -f /usr/local/share/xray/geoip.dat ]; then
        log_message "INFO" "Mengunduh file GeoIP dan GeoSite..."
        curl -L -o /usr/local/share/xray/geoip.dat \
            https://github.com/malikshi/v2ray-rules-dat/releases/latest/download/geoip.dat
        curl -L -o /usr/local/share/xray/geosite.dat \
            https://github.com/malikshi/v2ray-rules-dat/releases/latest/download/geosite.dat
    else
        log_message "SKIP" "File GeoIP/GeoSite sudah ada, dilewati."
    fi

    chown -R nobody /var/log/xray
    systemctl restart xray
    log_message "INFO" "Xray siap."
}

# Install HAProxy via haproxy.debian.net (tanpa PPA Launchpad)
install_haproxy() {
    # Setup Timezone (idempoten)
    ln -fs /usr/share/zoneinfo/Asia/Jakarta /etc/localtime

    if is_pkg_installed "haproxy"; then
        log_message "SKIP" "HAProxy sudah terinstall, melewati instalasi."
    else
        log_message "INFO" "Menambahkan repo resmi HAProxy 2.8 (haproxy.debian.net)..."

        # Tambah GPG key
        curl -fsSL https://haproxy.debian.net/bernat.debian.org.gpg \
            | gpg --dearmor -o /usr/share/keyrings/haproxy.debian.net.gpg

        # Deteksi distro otomatis
        local distro
        distro=$(lsb_release -cs)
        echo "deb [signed-by=/usr/share/keyrings/haproxy.debian.net.gpg] \
https://haproxy.debian.net ${distro}-backports-2.8 main" \
            > /etc/apt/sources.list.d/haproxy.list

        apt-get update
        apt-get install -y "haproxy=2.8.*"
        log_message "INFO" "HAProxy 2.8 berhasil diinstall."
    fi

    # Pastikan HAProxy aktif
    systemctl enable haproxy
}

# Install Node.js — lewati jika sudah ada
install_nodejs() {
    if is_cmd_installed "node"; then
        log_message "SKIP" "Node.js sudah terinstall ($(node -v)), dilewati."
    else
        log_message "INFO" "Menginstal Node.js 18..."
        curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
        apt-get install -y nodejs
        log_message "INFO" "Node.js berhasil diinstall."
    fi
}

# Konfigurasi domain dan SSL
configure_domain_and_ssl() {
    local domain_file="/usr/local/etc/xray/domain"

    # Jika domain sudah tersimpan, tanya apakah mau ganti
    if [ -f "$domain_file" ] && [ -s "$domain_file" ]; then
        local existing_domain
        existing_domain=$(cat "$domain_file")
        log_message "WARN" "Domain sudah dikonfigurasi: ${existing_domain}"
        read -rp "$(echo -e "${YB}Apakah ingin mengganti domain? (Y/N): ${NC}")" change_domain
        if [[ ! "$change_domain" =~ ^[Yy]$ ]]; then
            log_message "SKIP" "Konfigurasi domain dilewati. Menggunakan domain: ${existing_domain}"
            return 0
        fi
    fi

    rm -f /var/www/html/*.html

    read -rp "$(echo -e "${WB}Masukkan domain Anda: ${NC}")" dns
    if [ -z "$dns" ]; then
        log_message "ERROR" "Tidak ada domain yang dimasukkan. Proses dibatalkan."
        exit 1
    fi

    echo "$dns" > "$domain_file"
    echo "DNS=$dns" > /var/lib/dnsvps.conf
    log_message "INFO" "Domain '${dns}' berhasil disimpan."

    local domain
    domain=$(cat "$domain_file")

    # Cek apakah sertifikat sudah ada dan valid
    if [ -f /usr/local/etc/xray/fullchain.crt ] && [ -f /usr/local/etc/xray/private.key ]; then
        log_message "WARN" "Sertifikat SSL sudah ditemukan."
        read -rp "$(echo -e "${YB}Apakah ingin memperbarui/menerbitkan ulang sertifikat SSL? (Y/N): ${NC}")" reissue_cert
        if [[ ! "$reissue_cert" =~ ^[Yy]$ ]]; then
            log_message "SKIP" "Penerbitan sertifikat SSL dilewati."
            return 0
        fi
    fi

    log_message "INFO" "Menerbitkan sertifikat SSL untuk domain ${domain}..."
    systemctl stop haproxy || true

    # Install acme.sh jika belum ada
    if [ ! -f ~/.acme.sh/acme.sh ]; then
        curl https://get.acme.sh | sh
        source ~/.bashrc
    else
        log_message "SKIP" "acme.sh sudah terinstall."
    fi

    ~/.acme.sh/acme.sh --issue \
        -d "$domain" \
        --server letsencrypt \
        --keylength ec-256 \
        --fullchain-file /usr/local/etc/xray/fullchain.crt \
        --key-file /usr/local/etc/xray/private.key \
        --standalone \
        --force

    # Gabungkan sertifikat untuk HAProxy
    cat /usr/local/etc/xray/fullchain.crt /usr/local/etc/xray/private.key \
        > /etc/haproxy/certs/domain.pem

    log_message "INFO" "Sertifikat SSL berhasil dibuat dan dikonfigurasi."
}

# Download konfigurasi — tanya jika sudah ada
download_configurations() {
    log_message "INFO" "Mengunduh file konfigurasi Xray dan HAProxy..."

    local xray_config="/usr/local/etc/xray/config.json"
    local haproxy_config="/etc/haproxy/haproxy.cfg"

    # Config Xray
    if [ -f "$xray_config" ]; then
        log_message "WARN" "File config.json Xray sudah ada."
        read -rp "$(echo -e "${YB}Timpa config.json Xray? (Y/N): ${NC}")" overwrite_xray
        if [[ "$overwrite_xray" =~ ^[Yy]$ ]]; then
            wget -q -O "$xray_config" "${XRAY_BOT_REPO_V1}/config.json"
            log_message "INFO" "config.json Xray diperbarui."
        else
            log_message "SKIP" "config.json Xray dilewati."
        fi
    else
        wget -q -O "$xray_config" "${XRAY_BOT_REPO_V1}/config.json"
        log_message "INFO" "config.json Xray berhasil diunduh."
    fi

    # Config HAProxy
    if [ -f "$haproxy_config" ]; then
        log_message "WARN" "File haproxy.cfg sudah ada."
        read -rp "$(echo -e "${YB}Timpa haproxy.cfg? (Y/N): ${NC}")" overwrite_haproxy
        if [[ "$overwrite_haproxy" =~ ^[Yy]$ ]]; then
            wget -q -O "$haproxy_config" "${XRAY_BOT_REPO_V1}/haproxy.cfg"
            log_message "INFO" "haproxy.cfg diperbarui."
        else
            log_message "SKIP" "haproxy.cfg dilewati."
        fi
    else
        wget -q -O "$haproxy_config" "${XRAY_BOT_REPO_V1}/haproxy.cfg"
        log_message "INFO" "haproxy.cfg berhasil diunduh."
    fi

    # robots.txt (selalu update, tidak kritis)
    wget -q -O /var/www/html/robots.txt "${CONF_REPO}/robots.txt"
    log_message "INFO" "robots.txt diperbarui."
}

# Tuning sistem (firewall & kernel) — idempoten
tune_system_performance() {
    log_message "INFO" "Melakukan tuning performa sistem..."

    # iptables — cek dulu sebelum menambah rule duplikat
    log_message "INFO" "Mengonfigurasi iptables (blokir torrent)..."
    local IPTABLES_RULES=(
        "get_peers" "announce_peer" "find_node" ".torrent"
        "announce.php?passkey=" "torrent" "announce" "info_hash"
        "BitTorrent" "BitTorrent protocol" "peer_id="
    )
    for rule in "${IPTABLES_RULES[@]}"; do
        if ! iptables -C FORWARD -m string --string "$rule" --algo bm -j DROP 2>/dev/null; then
            iptables -A FORWARD -m string --string "$rule" --algo bm -j DROP
        fi
    done
    iptables-save > /etc/iptables.up.rules
    netfilter-persistent save
    netfilter-persistent reload

    # limits.conf
    log_message "INFO" "Meningkatkan batas sistem (ulimit)..."
    cat > /etc/security/limits.conf << 'END'
* soft nofile 1000000
* hard nofile 1000000
* soft nproc 1000000
* hard nproc 1000000
END
    grep -q '^session\s\+required\s\+pam_limits.so' /etc/pam.d/common-session \
        || echo "session required pam_limits.so" >> /etc/pam.d/common-session
    grep -q '^session\s\+required\s\+pam_limits.so' /etc/pam.d/common-session-noninteractive \
        || echo "session required pam_limits.so" >> /etc/pam.d/common-session-noninteractive
    ulimit -n 1000000
    ulimit -u 100000

    # sysctl.conf
    log_message "INFO" "Melakukan tuning parameter kernel (sysctl)..."
    cat > /etc/sysctl.conf << 'END'
# Tuning by Auto-Installer v2.0
net.core.default_qdisc=fq
net.ipv4.tcp_congestion_control=bbr
fs.file-max = 1000000
fs.inotify.max_user_instances = 8192
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_fin_timeout = 30
net.ipv4.tcp_tw_reuse = 1
net.ipv4.ip_local_port_range = 1024 65000
net.ipv4.tcp_max_syn_backlog = 16384
net.ipv4.tcp_max_tw_buckets = 6000
net.ipv4.route.gc_timeout = 100
net.ipv4.tcp_syn_retries = 1
net.ipv4.tcp_synack_retries = 1
net.core.somaxconn = 32768
net.core.netdev_max_backlog = 32768
net.ipv4.tcp_timestamps = 0
net.ipv4.tcp_max_orphans = 32768
net.ipv4.ip_forward = 1
END
    sysctl -p
    log_message "INFO" "Tuning sistem selesai."
}

# Download menu scripts — timpa selalu (bisa update)
download_menu_scripts() {
    log_message "INFO" "Mengunduh skrip-skrip menu..."
    local scripts=(
        "menu:menu/menu.sh"
        "dns:other/dns.sh"
        "certxray:other/certxray.sh"
        "xraymod:other/xraymod.sh"
        "xrayofficial:other/xrayofficial.sh"
        "about:other/about.sh"
        "clear-log:other/clear-log.sh"
    )
    for script_info in "${scripts[@]}"; do
        local filename="${script_info%%:*}"
        local filepath="${script_info#*:}"
        wget -q -O "/usr/bin/${filename}" "${MENU_REPO}/${filepath}"
    done
    chmod +x /usr/bin/{menu,dns,certxray,xraymod,xrayofficial,about,clear-log}
    log_message "INFO" "Skrip menu berhasil diunduh."
}

# Install pm2 jika belum ada
install_pm2() {
    if is_cmd_installed "pm2"; then
        log_message "SKIP" "pm2 sudah terinstall, dilewati."
    else
        log_message "INFO" "Menginstal pm2 secara global..."
        mkdir -p /root/api
        npm install -g pm2
        log_message "INFO" "pm2 berhasil diinstall."
    fi
}

# Finalisasi: cron, profil, restart layanan
finalize_installation() {
    log_message "INFO" "Menyelesaikan tahap akhir instalasi..."

    # Hapus service file bot yang tidak digunakan
    rm -f /etc/systemd/system/bot-agent.service
    rm -f /etc/systemd/system/bot-admin.service

    # Cron jobs (selalu tulis ulang agar konsisten)
    log_message "INFO" "Mengonfigurasi cron jobs..."
    cat > /etc/crontab << 'END'
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin

*/5 * * * * root clear-log
*/3 * * * * root truncate -s 0 /var/log/xray/access.log
0 1 * * 1 root curl -L -o /usr/local/share/xray/geoip.dat https://github.com/malikshi/v2ray-rules-dat/releases/latest/download/geoip.dat && curl -L -o /usr/local/share/xray/geosite.dat https://github.com/malikshi/v2ray-rules-dat/releases/latest/download/geosite.dat && systemctl restart xray
END

    # Profil root
    log_message "INFO" "Mengonfigurasi profil shell untuk root..."
    cat > /root/.profile << 'END'
if [ "$BASH" ]; then
    if [ -f ~/.bashrc ]; then
        . ~/.bashrc
    fi
fi
mesg n || true
clear
neofetch
echo ""
echo "Ketik 'menu' untuk menampilkan opsi panel."
END
    chmod 644 /root/.profile

    # Enable dan restart layanan
    log_message "INFO" "Mengaktifkan dan merestart semua layanan..."
    systemctl daemon-reload
    systemctl enable cron haproxy xray
    systemctl restart cron haproxy xray

    log_message "INFO" "Tahap akhir selesai."
}

# Tampilkan ringkasan
display_summary() {
    clear
    echo ""
    echo -e "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" | lolcat -a -d 5
    echo -e "              ${WB}INSTALASI SCRIPT SELESAI v2.0${NC}              "
    echo -e "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" | lolcat -a -d 5
    echo ""
    echo -e "  ${WB}»»» Layanan Protokol «««   |  »»» Protokol Jaringan «««${NC}"
    echo -e "  ───────────────────────────  |  ───────────────────────────"
    echo -e "  ${YB}- Vless${NC}                    ${WB}|${NC}  ${YB}- Websocket (CDN) non TLS${NC}"
    echo -e "  ${YB}- Vmess${NC}                    ${WB}|${NC}  ${YB}- Websocket (CDN) TLS${NC}"
    echo -e "  ${YB}- Trojan${NC}                   ${WB}|${NC}  ${YB}- gRPC (CDN) TLS${NC}"
    echo ""
    echo -e "               ${WB}»»» Port Jaringan Aktif «««${NC}              "
    echo -e "  ───────────────────────────────────────────────────────────"
    echo -e "  ${YB}- HTTPS : 443${NC}"
    echo -e "  ${YB}- HTTP  : 80${NC}"
    echo -e "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" | lolcat -a -d 5
    echo ""
}

# --- [BAGIAN 4: EKSEKUSI UTAMA] ---

main() {
    rm -f install
    clear

    log_message "INFO" "=============================================="
    log_message "INFO" " Memulai Instalasi Server Xray + HAProxy v2.0"
    log_message "INFO" " (Mode Idempoten — Aman Dijalankan Berulang)  "
    log_message "INFO" "=============================================="
    echo ""

    update_system
    install_dependencies
    setup_directories
    setup_xray
    install_haproxy          # <-- Menggunakan haproxy.debian.net (bukan PPA)
    install_nodejs
    configure_domain_and_ssl
    download_configurations
    tune_system_performance
    download_menu_scripts
    install_pm2
    finalize_installation
    display_summary

    # Hapus skrip ini setelah selesai
    # rm -f "$0"   # Uncomment jika ingin skrip terhapus otomatis setelah selesai

    secs_to_human "$(($(date +%s) - start_time))"

    echo ""
    read -rp $'\e[33;1m[ PERINGATAN ]\e[0m \e[37;1mApakah Anda ingin me-reboot server sekarang? (Y/N): \e[0m' answer
    if [[ "$answer" =~ ^[Yy]$ ]]; then
        log_message "INFO" "Server akan di-reboot dalam 5 detik..."
        sleep 5
        reboot
    else
        log_message "INFO" "Reboot dibatalkan. Silakan reboot secara manual."
        exit 0
    fi
}

main
