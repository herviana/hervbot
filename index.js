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

const settings = {
  maxBudgetPerTrade: 5,
  slippage: 1,
};

const pendingTrades = new Map();

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

// ── SOLANA via RPC (tanpa library) ──
const RPC_URL = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

async function getSolanaBalance(publicKey) {
  try {
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getBalance',
        params: [publicKey],
      }),
    });
    const data = await res.json();
    const lamports = data.result?.value || 0;
    return lamports / 1e9;
  } catch (e) { return 0; }
}

async function getSolPrice() {
  try {
    const res = await fetch('https://price.jup.ag/v4/price?ids=' + SOL_MINT);
    const data = await res.json();
    return data.data[SOL_MINT]?.price || 0;
  } catch (e) { return 0; }
}

async function getTokenPrice(mint) {
  try {
    const res = await fetch('https://price.jup.ag/v4/price?ids=' + mint);
    const data = await res.json();
    return data.data[mint]?.price || 0;
  } catch (e) { return 0; }
}

async function searchToken(symbolRaw) {
  try {
    const symbol = symbolRaw.replace('$', '').toUpperCase();
    const res = await fetch('https://token.jup.ag/strict');
    const tokens = await res.json();
    const exact = tokens.filter(t => t.symbol.toUpperCase() === symbol);
    if (exact.length > 0) return exact.slice(0, 3);
    return tokens.filter(t => t.symbol.toUpperCase().includes(symbol)).slice(0, 3);
  } catch (e) { return []; }
}

// ── JUPITER QUOTE ──
const JUPITER_API = 'https://quote-api.jup.ag/v6';

async function getQuote(inputMint, outputMint, amountLamports) {
  try {
    const url = JUPITER_API + '/quote?inputMint=' + inputMint +
      '&outputMint=' + outputMint +
      '&amount=' + amountLamports +
      '&slippageBps=' + (settings.slippage * 100);
    const res = await fetch(url);
    if (!res.ok) throw new Error(await res.text());
    return { success: true, quote: await res.json() };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── WALLET PUBLIC KEY dari Private Key (murni JS, tanpa library) ──
async function getPublicKeyFromPrivate(privateKeyBase58) {
  try {
    // Decode base58
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let num = BigInt(0);
    for (const char of privateKeyBase58) {
      const idx = ALPHABET.indexOf(char);
      if (idx < 0) throw new Error('Invalid base58');
      num = num * BigInt(58) + BigInt(idx);
    }
    let hex = num.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    const bytes = new Uint8Array(hex.match(/.{2}/g).map(b => parseInt(b, 16)));
    // Private key Solana = 64 bytes, public key = bytes[32..63]
    if (bytes.length >= 64) {
      const pubKeyBytes = bytes.slice(32, 64);
      // Encode public key ke base58
      let n = BigInt('0x' + Array.from(pubKeyBytes).map(b => b.toString(16).padStart(2, '0')).join(''));
      let result = '';
      while (n > 0) {
        result = ALPHABET[Number(n % BigInt(58))] + result;
        n = n / BigInt(58);
      }
      return result;
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ── SKILL LOADER ──
const skills = new Map();

async function loadSkill(githubUrl) {
  try {
    let url = githubUrl.trim().replace(/\/$/, '');
    url = url.replace('https://', '').replace('http://', '');
    const parts = url.replace('github.com/', '').split('/');
    const owner = parts[0];
    const repo = parts[1];
    if (!owner || !repo) throw new Error('Format URL tidak valid');
    const branches = ['main', 'master'];
    let content = null;
    for (const branch of branches) {
      const rawUrl = 'https://raw.githubusercontent.com/' + owner + '/' + repo + '/' + branch + '/SKILL.md';
      try {
        const res = await fetch(rawUrl);
        if (res.ok) { content = await res.text(); break; }
      } catch (e) {}
    }
    if (!content) throw new Error('File SKILL.md tidak ditemukan');
    const nameMatch = content.match(/name:\s*(.+)/i);
    const name = nameMatch ? nameMatch[1].trim() : repo;
    skills.set(name, { url: 'https://github.com/' + owner + '/' + repo, content, active: true });
    return { success: true, name };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── AI CHAT ──
const conversations = new Map();

async function chat(userId, userMessage) {
  if (!conversations.has(userId)) conversations.set(userId, []);
  const history = conversations.get(userId);
  history.push({ role: 'user', content: userMessage });
  if (history.length > 20) history.splice(0, history.length - 20);
  let skillsContext = '';
  for (const [name, skill] of skills) {
    if (skill.active) skillsContext += '\nSKILL ' + name + ':\n' + skill.content.slice(0, 1500);
  }
  const systemPrompt = 'Kamu adalah HervBot, AI trading agent crypto di Solana.' +
    '\nSettings: Budget $' + settings.maxBudgetPerTrade + ', Slippage ' + settings.slippage + '%' +
    (skillsContext ? '\n\nSkill aktif:\n' + skillsContext : '') +
    '\n\nJangan gunakan Markdown. Teks biasa saja. Bahasa Indonesia santai.';
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + config.GROQ_API_KEY },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 800,
        messages: [{ role: 'system', content: systemPrompt }, ...history],
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    const reply = cleanText(data.choices[0].message.content);
    history.push({ role: 'assistant', content: reply });
    return reply;
  } catch (e) { return 'Error: ' + e.message; }
}

// ── TELEGRAM HANDLERS ──
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    'HervBot - AI Trading Agent Solana\n\n' +
    'Trading:\n' +
    '/buy [token] [USD] - Beli token\n' +
    '/sell [token] [USD] - Jual token\n' +
    '/swap [dari] [ke] [USD] - Swap\n' +
    '/harga [token] - Cek harga\n' +
    '/saldo - Cek saldo wallet\n\n' +
    'Pengaturan:\n' +
    '/budget [angka] - Set budget\n' +
    '/slippage [angka] - Set slippage\n\n' +
    'Analisis:\n' +
    '/scan - Scan meme coin\n' +
    '/scalping - Peluang scalping\n' +
    '/trending - Token trending\n\n' +
    'Budget: $' + settings.maxBudgetPerTrade + ' | Slippage: ' + settings.slippage + '%'
  );
});

bot.onText(/\/budget (.+)/, (msg, match) => {
  const amount = parseFloat(match[1]);
  if (isNaN(amount) || amount <= 0) { bot.sendMessage(msg.chat.id, 'Contoh: /budget 10'); return; }
  settings.maxBudgetPerTrade = amount;
  bot.sendMessage(msg.chat.id, 'Budget per trade: $' + amount);
});

bot.onText(/\/slippage (.+)/, (msg, match) => {
  const slip = parseFloat(match[1]);
  if (isNaN(slip) || slip <= 0 || slip > 50) { bot.sendMessage(msg.chat.id, 'Contoh: /slippage 1'); return; }
  settings.slippage = slip;
  bot.sendMessage(msg.chat.id, 'Slippage: ' + slip + '%');
});

bot.onText(/\/saldo/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Mengecek saldo...');
  const pubkey = await getPublicKeyFromPrivate(config.WALLET_PRIVATE_KEY);
  if (!pubkey) {
    bot.sendMessage(chatId, 'Gagal baca wallet. Pastikan WALLET_PRIVATE_KEY benar di Railway.');
    return;
  }
  const sol = await getSolanaBalance(pubkey);
  const solPrice = await getSolPrice();
  const usd = (sol * solPrice).toFixed(2);
  bot.sendMessage(chatId,
    'Saldo Wallet:\n\n' +
    'SOL: ' + sol.toFixed(4) + '\n' +
    'USD: ~$' + usd + '\n\n' +
    'Alamat: ' + pubkey.slice(0, 6) + '...' + pubkey.slice(-6)
  );
});

bot.onText(/\/harga (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const symbol = match[1].trim();
  bot.sendMessage(chatId, 'Mencari harga ' + symbol + '...');
  const tokens = await searchToken(symbol);
  if (tokens.length === 0) {
    bot.sendMessage(chatId, 'Token ' + symbol + ' tidak ditemukan.\nCoba tanpa simbol $ contoh: /harga GRASS');
    return;
  }
  const token = tokens[0];
  const price = await getTokenPrice(token.address);
  bot.sendMessage(chatId,
    'Harga ' + token.symbol + ':\n\n' +
    '$' + (price > 0.01 ? price.toFixed(4) : price.toFixed(8)) + '\n' +
    'Nama: ' + token.name
  );
});

bot.onText(/\/buy (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const parts = match[1].trim().split(' ');
  const symbol = parts[0];
  const amountUSD = parseFloat(parts[1]) || settings.maxBudgetPerTrade;

  if (amountUSD > settings.maxBudgetPerTrade) {
    bot.sendMessage(chatId, 'Melebihi budget $' + settings.maxBudgetPerTrade + '\nGunakan /budget untuk ubah.');
    return;
  }

  bot.sendMessage(chatId, 'Mencari ' + symbol + '...');
  const tokens = await searchToken(symbol);
  if (tokens.length === 0) { bot.sendMessage(chatId, 'Token tidak ditemukan.'); return; }

  const token = tokens[0];
  const solPrice = await getSolPrice();
  if (!solPrice) { bot.sendMessage(chatId, 'Gagal ambil harga SOL.'); return; }

  const solAmount = amountUSD / solPrice;
  const lamports = Math.floor(solAmount * 1e9);

  const quoteResult = await getQuote(SOL_MINT, token.address, lamports);
  if (!quoteResult.success) { bot.sendMessage(chatId, 'Gagal quote: ' + quoteResult.error); return; }

  const outAmount = quoteResult.quote.outAmount / Math.pow(10, token.decimals || 6);

  pendingTrades.set(chatId, { type: 'buy', token, amountUSD, lamports, outAmount, quote: quoteResult.quote });

  bot.sendMessage(chatId,
    'Konfirmasi Pembelian:\n\n' +
    'Token: ' + token.symbol + ' (' + token.name + ')\n' +
    'Bayar: $' + amountUSD + ' (' + solAmount.toFixed(4) + ' SOL)\n' +
    'Dapat: ~' + outAmount.toFixed(4) + ' ' + token.symbol + '\n' +
    'Slippage: ' + settings.slippage + '%\n\n' +
    '/ya - Eksekusi\n/tidak - Batal'
  );
});

bot.onText(/\/ya/, async (msg) => {
  const chatId = msg.chat.id;
  const pending = pendingTrades.get(chatId);
  if (!pending) { bot.sendMessage(chatId, 'Tidak ada transaksi pending.'); return; }
  pendingTrades.delete(chatId);
  bot.sendMessage(chatId, 'Mengirim transaksi ke Solana...\nMohon tunggu...');

  try {
    // Dapatkan swap transaction dari Jupiter
    const pubkey = await getPublicKeyFromPrivate(config.WALLET_PRIVATE_KEY);
    const swapRes = await fetch(JUPITER_API + '/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: pending.quote,
        userPublicKey: pubkey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      }),
    });
    if (!swapRes.ok) throw new Error(await swapRes.text());
    const { swapTransaction } = await swapRes.json();

    // Sign dan kirim dengan @solana/web3.js via dynamic import
    const { Connection, VersionedTransaction } = await import('@solana/web3.js');
    const bs58 = (await import('bs58')).default;

    const connection = new Connection(RPC_URL, 'confirmed');
    const swapBuf = Buffer.from(swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapBuf);

    const privateKeyBytes = bs58.decode(config.WALLET_PRIVATE_KEY);
    const { Keypair } = await import('@solana/web3.js');
    const keypair = Keypair.fromSecretKey(privateKeyBytes);
    transaction.sign([keypair]);

    const rawTx = transaction.serialize();
    const txid = await connection.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 3 });
    await connection.confirmTransaction(txid, 'confirmed');

    bot.sendMessage(chatId,
      'Transaksi BERHASIL!\n\n' +
      'Token: ' + pending.token.symbol + '\n' +
      'Jumlah: ~' + pending.outAmount.toFixed(4) + ' ' + pending.token.symbol + '\n\n' +
      'TX: ' + txid + '\n' +
      'Cek: solscan.io/tx/' + txid
    );
  } catch (e) {
    bot.sendMessage(chatId, 'Transaksi gagal:\n' + e.message);
  }
});

bot.onText(/\/tidak/, (msg) => {
  pendingTrades.delete(msg.chat.id);
  bot.sendMessage(msg.chat.id, 'Transaksi dibatalkan.');
});

bot.onText(/\/sell (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const parts = match[1].trim().split(' ');
  const symbol = parts[0];
  const amountUSD = parseFloat(parts[1]) || settings.maxBudgetPerTrade;

  bot.sendMessage(chatId, 'Mencari ' + symbol + '...');
  const tokens = await searchToken(symbol);
  if (tokens.length === 0) { bot.sendMessage(chatId, 'Token tidak ditemukan.'); return; }

  const token = tokens[0];
  const tokenPrice = await getTokenPrice(token.address);
  if (!tokenPrice) { bot.sendMessage(chatId, 'Gagal ambil harga token.'); return; }

  const tokenAmount = amountUSD / tokenPrice;
  const tokenLamports = Math.floor(tokenAmount * Math.pow(10, token.decimals || 6));

  const quoteResult = await getQuote(token.address, SOL_MINT, tokenLamports);
  if (!quoteResult.success) { bot.sendMessage(chatId, 'Gagal quote: ' + quoteResult.error); return; }

  const solOut = quoteResult.quote.outAmount / 1e9;
  const solPrice = await getSolPrice();

  pendingTrades.set(chatId, { type: 'sell', token, amountUSD, tokenLamports, solOut, quote: quoteResult.quote });

  bot.sendMessage(chatId,
    'Konfirmasi Penjualan:\n\n' +
    'Jual: ' + tokenAmount.toFixed(4) + ' ' + token.symbol + '\n' +
    'Nilai: ~$' + amountUSD + '\n' +
    'Dapat: ~' + solOut.toFixed(4) + ' SOL (~$' + (solOut * solPrice).toFixed(2) + ')\n\n' +
    '/ya - Eksekusi\n/tidak - Batal'
  );
});

bot.onText(/\/swap (.+) (.+) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const fromSymbol = match[1];
  const toSymbol = match[2];
  const amountUSD = parseFloat(match[3]) || settings.maxBudgetPerTrade;

  bot.sendMessage(chatId, 'Mencari quote swap...');

  const fromTokens = fromSymbol.toUpperCase() === 'SOL' ? [{ address: SOL_MINT, symbol: 'SOL', decimals: 9 }] : await searchToken(fromSymbol);
  const toTokens = toSymbol.toUpperCase() === 'SOL' ? [{ address: SOL_MINT, symbol: 'SOL', decimals: 9 }] : await searchToken(toSymbol);

  if (!fromTokens.length || !toTokens.length) { bot.sendMessage(chatId, 'Token tidak ditemukan.'); return; }

  const fromToken = fromTokens[0];
  const toToken = toTokens[0];
  const fromPrice = await getTokenPrice(fromToken.address);
  const fromAmount = amountUSD / (fromPrice || 1);
  const fromLamports = Math.floor(fromAmount * Math.pow(10, fromToken.decimals || 9));

  const quoteResult = await getQuote(fromToken.address, toToken.address, fromLamports);
  if (!quoteResult.success) { bot.sendMessage(chatId, 'Gagal quote: ' + quoteResult.error); return; }

  const toAmount = quoteResult.quote.outAmount / Math.pow(10, toToken.decimals || 6);
  pendingTrades.set(chatId, { type: 'swap', fromToken, toToken, amountUSD, toAmount, quote: quoteResult.quote });

  bot.sendMessage(chatId,
    'Konfirmasi Swap:\n\n' +
    'Dari: ' + fromAmount.toFixed(4) + ' ' + fromToken.symbol + '\n' +
    'Ke: ~' + toAmount.toFixed(4) + ' ' + toToken.symbol + '\n' +
    'Nilai: ~$' + amountUSD + '\n\n' +
    '/ya - Eksekusi\n/tidak - Batal'
  );
});

bot.onText(/\/scan/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Scanning...');
  const reply = await chat(chatId, 'Scan meme coin terbaik di Solana. Top 3 dengan entry dan stop loss.');
  bot.sendMessage(chatId, reply);
});

bot.onText(/\/scalping/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Mencari peluang scalping...');
  const reply = await chat(chatId, 'Cari koin terbaik untuk scalping. Entry, target, stop loss.');
  bot.sendMessage(chatId, reply);
});

bot.onText(/\/trending/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Menganalisis trending...');
  const reply = await chat(chatId, 'Koin trending sekarang? Analisis sentimen dan potensi.');
  bot.sendMessage(chatId, reply);
});

bot.onText(/\/skills/, async (msg) => {
  const chatId = msg.chat.id;
  if (skills.size === 0) { bot.sendMessage(chatId, 'Belum ada skill.\n/install https://github.com/username/repo'); return; }
  let list = 'Skill aktif (' + skills.size + '):\n\n';
  for (const [name, skill] of skills) list += 'AKTIF - ' + name + '\n' + skill.url + '\n\n';
  bot.sendMessage(chatId, list);
});

bot.onText(/\/install (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Menginstall skill...');
  const result = await loadSkill(match[1].trim());
  bot.sendMessage(chatId, result.success ? 'Skill ' + result.name + ' berhasil diinstall!' : 'Gagal: ' + result.error);
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    'Perintah HervBot:\n\n' +
    '/buy [token] [USD]\n/sell [token] [USD]\n/swap [dari] [ke] [USD]\n' +
    '/harga [token]\n/saldo\n/ya\n/tidak\n' +
    '/budget [angka]\n/slippage [angka]\n' +
    '/scan\n/scalping\n/trending\n' +
    '/skills\n/install [url]'
  );
});

bot.on('message', async (msg) => {
  if (msg.text && !msg.text.startsWith('/')) {
    bot.sendChatAction(msg.chat.id, 'typing');
    bot.sendMessage(msg.chat.id, await chat(msg.chat.id, msg.text));
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', skills: skills.size }));

app.listen(config.PORT, () => console.log('HervBot running on port ' + config.PORT));
