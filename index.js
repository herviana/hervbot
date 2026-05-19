const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const { Connection, PublicKey } = require('@solana/web3.js');

const app = express();
app.use(cors());
app.use(express.json());

// ── CONFIG ──
const config = {
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  WALLET_PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY,
  PORT: process.env.PORT || 3000,
};

// ── TELEGRAM BOT ──
const bot = new TelegramBot(config.TELEGRAM_TOKEN, { polling: true });

// ── SKILL LOADER ──
const skills = new Map();

async function loadSkill(githubUrl) {
  try {
    const rawUrl = githubUrl
      .replace('github.com', 'raw.githubusercontent.com')
      .replace('/tree/main', '')
      .replace('/tree/master', '') + '/main/SKILL.md';

    const res = await fetch(rawUrl);
    if (!res.ok) throw new Error('Skill tidak ditemukan');
    const content = await res.text();

    const nameMatch = content.match(/name:\s*(.+)/);
    const name = nameMatch ? nameMatch[1].trim() : githubUrl.split('/').pop();

    skills.set(name, { url: githubUrl, content, active: true });
    return { success: true, name };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function getActiveSkillsContext() {
  let context = '';
  for (const [name, skill] of skills) {
    if (skill.active) {
      context += `\n\n=== SKILL: ${name} ===\n${skill.content.slice(0, 2000)}`;
    }
  }
  return context;
}

async function loadDefaultSkills() {
  const defaultSkills = [
    'https://github.com/herviana/x-trending-crypto',
    'https://github.com/herviana/crypto-scalping-trader',
    'https://github.com/herviana/memecoin-trader-auto',
    'https://github.com/herviana/morse-translator',
    'https://github.com/herviana/caesar-cipher-plus4',
  ];

  for (const url of defaultSkills) {
    await loadSkill(url);
  }
  console.log('✅ Default skills loaded:', skills.size);
}

// ── AI AGENT (menggunakan Groq - GRATIS) ──
const conversations = new Map();

async function chat(userId, userMessage) {
  if (!conversations.has(userId)) {
    conversations.set(userId, []);
  }

  const history = conversations.get(userId);
  history.push({ role: 'user', content: userMessage });

  if (history.length > 20) history.splice(0, history.length - 20);

  const skillsContext = getActiveSkillsContext();

  const systemPrompt = `Kamu adalah HervBot, AI trading agent crypto yang cerdas.
Kamu memiliki kemampuan trading nyata di BNB Chain, Solana, dan Base.

SKILL YANG AKTIF:
${skillsContext}

KEMAMPUAN:
- Analisis teknikal (RSI, EMA, Volume, MACD)
- Scan meme coin dan trending token
- Eksekusi swap via DEX (Jupiter untuk Solana, PancakeSwap untuk BNB)
- Manajemen risiko otomatis
- Encode/decode morse dan Caesar cipher

ATURAN TRADING:
- Selalu cek keamanan token sebelum beli
- Gunakan stop loss
- Max per trade sesuai budget yang diset
- Laporkan setiap transaksi dengan hash

Gunakan bahasa Indonesia yang santai. Berikan analisis konkret.`;

  try {
    // Panggil Groq API (gratis, tidak perlu bayar)
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama3-70b-8192', // Model gratis dari Groq
        max_tokens: 1000,
        messages: [
          { role: 'system', content: systemPrompt },
          ...history,
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Groq API error: ${errText}`);
    }

    const data = await response.json();
    const reply = data.choices[0].message.content;
    history.push({ role: 'assistant', content: reply });
    return reply;
  } catch (e) {
    return `❌ Error: ${e.message}`;
  }
}

// ── TELEGRAM HANDLERS ──
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const welcome = `⚡ *Selamat datang di HervBot!*

AI Trading Agent crypto yang siap membantu kamu trading di:
• BNB Chain
• Solana  
• Base

*Skill aktif:*
🔥 X Trending Crypto
⚡ Crypto Scalping Trader
🚀 Meme Coin Auto Trader
📡 Morse Translator
🔐 Caesar Cipher +4

*Perintah:*
/scan - Scan meme coin terbaik
/scalping - Cari peluang scalping
/trending - Token trending di X
/posisi - Cek posisi aktif
/laporan - Laporan trading hari ini
/skills - Kelola skill
/help - Bantuan

Atau ketik langsung pertanyaanmu! 😊`;

  bot.sendMessage(chatId, welcome, { parse_mode: 'Markdown' });
});

bot.onText(/\/scan/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '🔍 Scanning meme coin terbaik...');
  const reply = await chat(chatId, 'Scan meme coin terbaik di BNB chain dan Solana sekarang. Gunakan semua filter keamanan. Berikan top 3 rekomendasi.');
  bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
});

bot.onText(/\/scalping/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '⚡ Mencari peluang scalping...');
  const reply = await chat(chatId, 'Cari koin terbaik untuk scalping hari ini. Analisis RSI, EMA, dan volume. Berikan entry, target, dan stop loss.');
  bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
});

bot.onText(/\/trending/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '🔥 Menganalisis trending di X...');
  const reply = await chat(chatId, 'Koin apa yang trending di X/Twitter hari ini? Berikan skor trending dan analisis sentimen.');
  bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
});

bot.onText(/\/skills/, async (msg) => {
  const chatId = msg.chat.id;
  let skillList = '⚡ *Daftar Skill:*\n\n';
  for (const [name, skill] of skills) {
    skillList += `${skill.active ? '✅' : '❌'} *${name}*\n\`${skill.url}\`\n\n`;
  }
  skillList += '\nUntuk install skill baru:\n`/install github.com/username/skill-name`';
  bot.sendMessage(chatId, skillList, { parse_mode: 'Markdown' });
});

bot.onText(/\/install (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const url = match[1].trim();
  bot.sendMessage(chatId, `📦 Installing skill dari ${url}...`);
  const result = await loadSkill(url.startsWith('http') ? url : 'https://' + url);
  if (result.success) {
    bot.sendMessage(chatId, `✅ Skill *${result.name}* berhasil diinstall!`, { parse_mode: 'Markdown' });
  } else {
    bot.sendMessage(chatId, `❌ Gagal install: ${result.error}`);
  }
});

bot.onText(/\/laporan/, async (msg) => {
  const chatId = msg.chat.id;
  const reply = await chat(chatId, 'Tampilkan laporan lengkap trading hari ini. Berikan total profit/loss, win rate, dan posisi aktif.');
  bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
});

bot.onText(/\/posisi/, async (msg) => {
  const chatId = msg.chat.id;
  const reply = await chat(chatId, 'Tampilkan semua posisi trading yang sedang aktif sekarang beserta PnL masing-masing.');
  bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const help = `📖 *Daftar Perintah HervBot:*

*Trading:*
/scan - Scan meme coin terbaik
/scalping - Cari peluang scalping
/trending - Token trending di X
/posisi - Cek posisi aktif
/laporan - Laporan trading

*Skills:*
/skills - Lihat semua skill
/install [url] - Install skill baru

*Lainnya:*
/start - Mulai bot
/help - Bantuan ini

Atau ketik langsung pertanyaanmu dalam bahasa Indonesia! 😊`;
  bot.sendMessage(chatId, help, { parse_mode: 'Markdown' });
});

bot.on('message', async (msg) => {
  if (msg.text && !msg.text.startsWith('/')) {
    const chatId = msg.chat.id;
    bot.sendChatAction(chatId, 'typing');
    const reply = await chat(chatId, msg.text);
    bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
  }
});

// ── REST API untuk Web App ──
app.post('/api/chat', async (req, res) => {
  const { userId, message } = req.body;
  if (!userId || !message) return res.status(400).json({ error: 'Missing params' });
  const reply = await chat(userId, message);
  res.json({ reply });
});

app.get('/api/skills', (req, res) => {
  const list = [];
  for (const [name, skill] of skills) {
    list.push({ name, url: skill.url, active: skill.active });
  }
  res.json(list);
});

app.post('/api/skills/install', async (req, res) => {
  const { url } = req.body;
  const result = await loadSkill(url);
  res.json(result);
});

app.get('/health', (req, res) => res.json({ status: 'ok', skills: skills.size }));

// ── START ──
loadDefaultSkills().then(() => {
  app.listen(config.PORT, () => {
    console.log(`🚀 HervBot running on port ${config.PORT}`);
    console.log(`📱 Telegram bot active`);
    console.log(`🌐 API ready`);
  });
});
