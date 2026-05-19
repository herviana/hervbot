# ⚡ HervBot — AI Trading Agent

Bot trading crypto mirip Bankr, dibuat oleh Herviana.
Berjalan di Telegram + Web App, hosting gratis di Railway.

---

## 🚀 Cara Deploy (15 menit)

### Step 1 — Buat Telegram Bot

1. Buka Telegram → cari **@BotFather**
2. Ketik `/newbot`
3. Beri nama: `HervBot`
4. Beri username: `herviana_trading_bot` (atau nama lain)
5. Copy **Bot Token** yang diberikan

---

### Step 2 — Siapkan API Keys

**Groq API Key (GRATIS):**
1. Buka **console.groq.com**
2. Daftar gratis dengan Google/email
3. Klik **"Create API Key"**
4. Beri nama bebas (contoh: `HervBot`)
5. Copy key-nya (dimulai dengan `gsk_...`)

**Wallet:**
1. Buat wallet BARU khusus trading (jangan pakai wallet utama!)
2. Export private key
3. Isi dengan modal kecil dulu untuk test

---

### Step 3 — Deploy ke Railway (Gratis)

1. Buka **railway.app**
2. Login dengan GitHub
3. Klik **"New Project"** → **"Deploy from GitHub repo"**
4. Upload semua file ini ke GitHub repo baru
5. Connect repo ke Railway
6. Buka tab **"Variables"** → tambah:
   ```
   TELEGRAM_TOKEN     = (token dari BotFather)
   GROQ_API_KEY       = (key dari console.groq.com)
   WALLET_PRIVATE_KEY = (private key wallet trading)
   ```
7. Railway otomatis deploy! ✅

---

### Step 4 — Test Bot

Buka Telegram → cari bot kamu → ketik `/start`

---

## 📱 Perintah Telegram

```
/start    - Mulai bot
/scan     - Scan meme coin terbaik
/scalping - Cari peluang scalping
/trending - Token trending di X
/posisi   - Cek posisi aktif
/laporan  - Laporan trading
/skills   - Kelola skill
/install  - Install skill baru
/help     - Bantuan
```

---

## ⚡ Install Skill Baru

Ketik di Telegram:
```
/install github.com/herviana/x-trending-crypto
/install github.com/herviana/crypto-scalping-trader
/install github.com/herviana/memecoin-trader-auto
```

---

## ⚠️ Keamanan

- **JANGAN** gunakan wallet utama!
- **JANGAN** share private key ke siapapun
- Gunakan wallet baru khusus trading
- Isi modal kecil dulu untuk test ($5-10)
- Railway mengenkripsi environment variables

---

## 📁 Struktur File

```
hervbot/
├── index.js          ← Main server + Telegram bot
├── package.json      ← Dependencies
├── .env.example      ← Template environment variables
└── README.md         ← Panduan ini
```

---

## 🆓 Biaya

| Komponen | Biaya |
|----------|-------|
| Railway hosting | Gratis (500 jam/bulan) |
| Telegram Bot | Gratis |
| Groq API (AI) | Gratis |
| **Total** | **$0/bulan** |

---

Dibuat oleh **Herviana** 🚀
