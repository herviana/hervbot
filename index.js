const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(cors());
app.use(express.json());

const config = {
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  WALLET_PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY,
  PORT: process.env.PORT || 3000,
};

const bot = new TelegramBot(config.TELEGRAM_TOKEN, { polling: true });

function cleanText(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    .replace(/`{3}[\s\S]*?`{3}/g, '')
    .replace(/`(.*?)`/g, '$1')
    .replace(/#{1,6} /g, '')
    .trim();
}

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
  console.log('Skills loaded: ' + skills.size);
}

const conversations = new Map();

async function chat(userId, userMessage) {
  if (!conversations.has(userId)) conversations.set(userId, []);
  const history = conversations.get(userId);
  history.push({ role: 'user', content: userMessage });
  if (history.length > 20) history.splice(0, history.length - 20);

  const systemPrompt = 'Kamu adalah HervBot, AI trading agent crypto. Bantu analisis trading di BNB Chain, Solana, dan Base. PENTING: Jangan gunakan karakter Markdown seperti bintang, underscore, atau backtick dalam jawabanmu. Tulis teks biasa saja. Gunakan bahasa Indonesia santai.';

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + config.GROQ_API_KEY,
      },
      body: JSON.stringify({
        model: 'llama3-70b-8192',
        max_tokens: 800,
        messages: [{ role: 'system', content: systemPrompt }, ...history],
      }),
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(err);
    }
    const data = await response.json();
    const reply = cleanText(data.choices[0].message.content);
    history.push({ role: 'assistant', content: reply });
    return reply;
  } catch (e) {
    return 'Error: ' + e.message;
  }
}

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId,
    'HervBot - AI Trading Agent Crypto\n\n' +
    'Siap membantu trading di BNB Chain, Solana, dan Base.\n\n' +
    'Perintah:\n' +
    '/scan - Scan meme coin terbaik\n' +
    '/scalping - Cari peluang scalping\n' +
    '/trending - Token trending\n' +
    '/posisi - Cek posisi aktif\n' +
    '/laporan - Laporan trading\n' +
    '/help - Bantuan\n\n' +
    'Atau ketik langsung pertanyaanmu!'
  );
});

bot.onText(/\/scan/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Scanning meme coin terbaik...');
  const reply = await chat(chatId, 'Scan meme coin terbaik di Solana dan BNB Chain. Berikan top 3 rekomendasi dengan alasan singkat.');
  bot.sendMessage(chatId, reply);
});

bot.onText(/\/scalping/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Mencari peluang scalping...');
  const reply = await chat(chatId, 'Cari koin terbaik untuk scalping hari ini. Berikan entry, target, dan stop loss.');
  bot.sendMessage(chatId, reply);
});

bot.onText(/\/trending/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Menganalisis trending...');
  const reply = await chat(chatId, 'Koin apa yang trending hari ini? Berikan analisis sentimen singkat.');
  bot.sendMessage(chatId, reply);
});

bot.onText(/\/laporan/, async (msg) => {
  const chatId = msg.chat.id;
  const reply = await chat(chatId, 'Tampilkan laporan trading hari ini dengan total profit/loss dan win rate.');
  bot.sendMessage(chatId, reply);
});

bot.onText(/\/posisi/, async (msg) => {
  const chatId = msg.chat.id;
  const reply = await chat(chatId, 'Tampilkan semua posisi trading aktif beserta PnL masing-masing.');
  bot.sendMessage(chatId, reply);
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId,
    'Daftar Perintah HervBot:\n\n' +
    '/scan - Scan meme coin terbaik\n' +
    '/scalping - Cari peluang scalping\n' +
    '/trending - Token trending\n' +
    '/posisi - Cek posisi aktif\n' +
    '/laporan - Laporan trading\n' +
    '/start - Mulai ulang\n\n' +
    'Atau ketik langsung pertanyaanmu!'
  );
});

bot.on('message', async (msg) => {
  if (msg.text && !msg.text.startsWith('/')) {
    const chatId = msg.chat.id;
    bot.sendChatAction(chatId, 'typing');
    const reply = await chat(chatId, msg.text);
    bot.sendMessage(chatId, reply);
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

loadDefaultSkills().then(() => {
  app.listen(config.PORT, () => {
    console.log('HervBot running on port ' + config.PORT);
  });
});
