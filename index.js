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
    let url = githubUrl.trim().replace(/\/$/, '');
    url = url.replace('https://', '').replace('http://', '');
    const parts = url.replace('github.com/', '').split('/');
    const owner = parts[0];
    const repo = parts[1];
    if (!owner || !repo) throw new Error('Format URL tidak valid. Gunakan: https://github.com/username/repo');

    const branches = ['main', 'master'];
    let content = null;
    for (const branch of branches) {
      const rawUrl = 'https://raw.githubusercontent.com/' + owner + '/' + repo + '/' + branch + '/SKILL.md';
      try {
        const res = await fetch(rawUrl);
        if (res.ok) {
          content = await res.text();
          break;
        }
      } catch (e) {}
    }

    if (!content) throw new Error('File SKILL.md tidak ditemukan di repo tersebut');

    const nameMatch = content.match(/name:\s*(.+)/i);
    const name = nameMatch ? nameMatch[1].trim() : repo;
    skills.set(name, { url: 'https://github.com/' + owner + '/' + repo, content, active: true });
    return { success: true, name };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

const conversations = new Map();

async function chat(userId, userMessage) {
  if (!conversations.has(userId)) conversations.set(userId, []);
  const history = conversations.get(userId);
  history.push({ role: 'user', content: userMessage });
  if (history.length > 20) history.splice(0, history.length - 20);

  let skillsContext = '';
  for (const [name, skill] of skills) {
    if (skill.active) {
      skillsContext += '\n\nSKILL ' + name + ':\n' + skill.content.slice(0, 2000);
    }
  }

  const systemPrompt = 'Kamu adalah HervBot, AI trading agent crypto. Bantu analisis trading di BNB Chain, Solana, dan Base.' +
    (skillsContext ? '\n\nSkill aktif:' + skillsContext : '') +
    '\n\nPENTING: Jangan gunakan karakter Markdown seperti bintang, underscore, atau backtick. Tulis teks biasa saja. Gunakan bahasa Indonesia santai.';

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + config.GROQ_API_KEY,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
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
    '/skills - Lihat skill aktif\n' +
    '/install [url] - Install skill baru\n' +
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

bot.onText(/\/skills/, async (msg) => {
  const chatId = msg.chat.id;
  if (skills.size === 0) {
    bot.sendMessage(chatId,
      'Belum ada skill yang terinstall.\n\n' +
      'Cara install:\n' +
      '/install https://github.com/username/repo-name'
    );
    return;
  }
  let skillList = 'Skill yang aktif (' + skills.size + '):\n\n';
  for (const [name, skill] of skills) {
    skillList += (skill.active ? 'AKTIF' : 'NONAKTIF') + ' - ' + name + '\n' + skill.url + '\n\n';
  }
  bot.sendMessage(chatId, skillList);
});

bot.onText(/\/install (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const url = match[1].trim();
  bot.sendMessage(chatId, 'Menginstall skill dari:\n' + url + '\n\nMohon tunggu...');
  const result = await loadSkill(url);
  if (result.success) {
    bot.sendMessage(chatId,
      'Skill berhasil diinstall!\n\n' +
      'Nama: ' + result.name + '\n' +
      'Bot sekarang menggunakan skill ini.'
    );
  } else {
    bot.sendMessage(chatId,
      'Gagal install skill.\n\n' +
      'Alasan: ' + result.error + '\n\n' +
      'Pastikan:\n' +
      '1. URL benar\n' +
      '2. Repo publik\n' +
      '3. Ada file SKILL.md di dalam repo'
    );
  }
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
    '/skills - Lihat skill aktif\n' +
    '/install [url] - Install skill baru\n' +
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

app.get('/health', (req, res) => res.json({ status: 'ok', skills: skills.size }));

app.listen(config.PORT, () => {
  console.log('HervBot running on port ' + config.PORT);
});
