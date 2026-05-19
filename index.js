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
  autoTrade: false,
};

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

// ── SOLANA: dynamic import untuk hindari crash ──
let solanaLoaded = false;
let Connection, PublicKey, Keypair, Transaction, VersionedTransaction;
let bs58;

async function loadSolana() {
  if (solanaLoaded) return true;
  try {
    const solana = await import('@solana/web3.js');
    Connection = solana.Connection;
    PublicKey = solana.PublicKey;
    Keypair = solana.Keypair;
    Transaction = solana.Transaction;
    VersionedTransaction = solana.VersionedTransaction;
    const bs58Module = await import('bs58');
    bs58 = bs58Module.default;
    solanaLoaded = true;
    console.log('Solana library loaded successfully');
    return true;
  } catch (e) {
    console.log('Solana load error: ' + e.message);
    return false;
  }
}

function getKeypair() {
  try {
    const decoded = bs58.decode(config.WALLET_PRIVATE_KEY);
    return Keypair.fromSecretKey(decoded);
  } catch (e) {
    return null;
  }
}

function getPublicKey() {
  try {
    const keypair = getKeypair();
    return keypair ? keypair.publicKey.toString() : null;
  } catch (e) {
    return null;
  }
}

// ── JUPITER DEX ──
const JUPITER_API = 'https://quote-api.jup.ag/v6';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const RPC_URL = 'https://api.mainnet-beta.solana.com';

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

async function searchToken(symbol) {
  try {
    const res = await fetch('https://token.jup.ag/all');
    const tokens = await res.json();
    return tokens.filter(t =>
      t.symbol.toLowerCase() === symbol.toLowerCase()
    ).slice(0, 3);
  } catch (e) { return []; }
}

async function getWalletBalance(publicKey) {
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
    const sol = lamports / 1e9;
    const solPrice = await getSolPrice();
    return { sol: sol.toFixed(4), usd: (sol * solPrice).toFixed(2) };
  } catch (e) { return { sol: '0', usd: '0' }; }
}

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

async function executeJupiterSwap(quoteResponse, keypair) {
  try {
    // 1. Dapatkan swap transaction dari Jupiter
    const swapRes = await fetch(JUPITER_API + '/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: keypair.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      }),
    });
    if (!swapRes.ok) throw new Error(await swapRes.text());
    const { swapTransaction } = await swapRes.json();

    // 2. Decode transaction
    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
    const connection = new Connection(RPC_URL, 'confirmed');

    let transaction;
    try {
      transaction = VersionedTransaction.deserialize(swapTransactionBuf);
      transaction.sign([keypair]);
    } catch (e) {
      transaction = Transaction.from(swapTransactionBuf);
      transaction.sign(keypair);
    }

    // 3. Kirim ke blockchain
    const rawTransaction = transaction.serialize();
    const txid = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: true,
      maxRetries: 3,
    });

    // 4. Konfirmasi
    await connection.confirmTransaction(txid, 'confirmed');

    return { success: true, txid };
  } catch (e) {
    return { success: false, error: e.message };
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

  const systemPrompt = 'Kamu adalah HervBot, AI trading agent crypto dengan kemampuan transaksi nyata di Solana via Jupiter DEX.' +
    '\nSettings: Budget $' + settings.maxBudgetPerTrade + ' per trade, Slippage ' + settings.slippage + '%' +
    '\nAuto trade: ' + (settings.autoTrade ? 'ON' : 'OFF') +
    (skillsContext ? '\n\nSkill aktif:\n' + skillsContext : '') +
    '\n\nJangan gunakan karakter Markdown. Tulis teks biasa saja. Bahasa Indonesia santai.';

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
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
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    const reply = cleanText(data.choices[0].message.content);
    history.push({ role: 'assistant', content: reply });
    return reply;
  } catch (e) {
    return 'Error AI: ' + e.message;
  }
}

// ── TELEGRAM HANDLERS ──
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    'HervBot - AI Trading Agent Solana\n\n' +
    'Perintah Trading Nyata:\n' +
    '/buy [token] [USD] - Beli token di Solana\n' +
    '/sell [token] [USD] - Jual token\n' +
    '/swap [dari] [ke] [USD] - Swap token\n' +
    '/harga [token] - Cek harga realtime\n' +
    '/saldo - Cek saldo wallet\n\n' +
    'Pengaturan:\n' +
    '/budget [angka] - Set budget per trade\n' +
    '/slippage [angka] - Set slippage %\n\n' +
    'Analisis AI:\n' +
    '/scan - Scan meme coin\n' +
    '/scalping - Peluang scalping\n' +
    '/trending - Token trending\n\n' +
    'Budget aktif: $' + settings.maxBudgetPerTrade + '\n' +
    'Slippage: ' + settings.slippage + '%'
  );
});

bot.onText(/\/budget (.+)/, (msg, match) => {
  const amount = parseFloat(match[1]);
  if (isNaN(amount) || amount <= 0) {
    bot.sendMessage(msg.chat.id, 'Format salah. Contoh: /budget 10');
    return;
  }
  settings.maxBudgetPerTrade = amount;
  bot.sendMessage(msg.chat.id, 'Budget per trade diset ke $' + amount);
});

bot.onText(/\/slippage (.+)/, (msg, match) => {
  const slip = parseFloat(match[1]);
  if (isNaN(slip) || slip <= 0 || slip > 50) {
    bot.sendMessage(msg.chat.id, 'Slippage harus 0.1-50. Contoh: /slippage 1');
    return;
  }
  settings.slippage = slip;
  bot.sendMessage(msg.chat.id, 'Slippage diset ke ' + slip + '%');
});

bot.onText(/\/saldo/, async (msg) => {
  const chatId = msg.chat.id;
  const loaded = await loadSolana();
  if (!loaded) {
    bot.sendMessage(chatId, 'Solana library gagal load. Coba lagi.');
    return;
  }
  bot.sendMessage(chatId, 'Mengecek saldo...');
  const pubkey = getPublicKey();
  if (!pubkey) {
    bot.sendMessage(chatId, 'Gagal baca wallet. Cek WALLET_PRIVATE_KEY di Railway.');
    return;
  }
  const balance = await getWalletBalance(pubkey);
  bot.sendMessage(chatId,
    'Saldo Wallet:\n\n' +
    'SOL: ' + balance.sol + '\n' +
    'USD: ~$' + balance.usd + '\n\n' +
    'Alamat: ' + pubkey.slice(0, 6) + '...' + pubkey.slice(-6)
  );
});

bot.onText(/\/harga (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const symbol = match[1].trim().toUpperCase();
  bot.sendMessage(chatId, 'Mencari harga ' + symbol + '...');
  const tokens = await searchToken(symbol);
  if (tokens.length === 0) {
    bot.sendMessage(chatId, 'Token ' + symbol + ' tidak ditemukan.');
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
  const symbol = parts[0].toUpperCase();
  const amountUSD = parseFloat(parts[1]) || settings.maxBudgetPerTrade;

  if (amountUSD > settings.maxBudgetPerTrade) {
    bot.sendMessage(chatId, 'Jumlah $' + amountUSD + ' melebihi budget $' + settings.maxBudgetPerTrade + '\nGunakan /budget untuk ubah limit.');
    return;
  }

  bot.sendMessage(chatId, 'Mencari ' + symbol + ' dan membuat quote...');

  const loaded = await loadSolana();
  if (!loaded) {
    bot.sendMessage(chatId, 'Solana library gagal dimuat.');
    return;
  }

  const tokens = await searchToken(symbol);
  if (tokens.length === 0) {
    bot.sendMessage(chatId, 'Token ' + symbol + ' tidak ditemukan di Solana.');
    return;
  }

  const token = tokens[0];
  const solPrice = await getSolPrice();
  if (!solPrice) {
    bot.sendMessage(chatId, 'Gagal ambil harga SOL. Coba lagi.');
    return;
  }

  const solAmount = amountUSD / solPrice;
  const lamports = Math.floor(solAmount * 1e9);

  const quoteResult = await getQuote(SOL_MINT, token.address, lamports);
  if (!quoteResult.success) {
    bot.sendMessage(chatId, 'Gagal buat quote: ' + quoteResult.error);
    return;
  }

  const outAmount = quoteResult.quote.outAmount / Math.pow(10, token.decimals || 6);

  // Simpan pending trade
  pendingTrades.set(chatId, {
    type: 'buy',
    token,
    amountUSD,
    lamports,
    outAmount,
    quote: quoteResult.quote,
  });

  bot.sendMessage(chatId,
    'Konfirmasi Pembelian:\n\n' +
    'Token: ' + token.symbol + ' (' + token.name + ')\n' +
    'Bayar: $' + amountUSD + ' (' + solAmount.toFixed(4) + ' SOL)\n' +
    'Dapat: ~' + outAmount.toFixed(4) + ' ' + token.symbol + '\n' +
    'Slippage: ' + settings.slippage + '%\n\n' +
    'Ketik /ya untuk eksekusi\n' +
    'Ketik /tidak untuk batal'
  );
});

bot.onText(/\/ya/, async (msg) => {
  const chatId = msg.chat.id;
  const pending = pendingTrades.get(chatId);

  if (!pending) {
    bot.sendMessage(chatId, 'Tidak ada transaksi yang menunggu konfirmasi.');
    return;
  }

  bot.sendMessage(chatId, 'Mengeksekusi transaksi di Solana...');
  pendingTrades.delete(chatId);

  const keypair = getKeypair();
  if (!keypair) {
    bot.sendMessage(chatId, 'Gagal baca wallet. Cek WALLET_PRIVATE_KEY.');
    return;
  }

  const result = await executeJupiterSwap(pending.quote, keypair);

  if (result.success) {
    bot.sendMessage(chatId,
      'Transaksi BERHASIL!\n\n' +
      'Token: ' + pending.token.symbol + '\n' +
      'Jumlah: ~' + pending.outAmount.toFixed(4) + ' ' + pending.token.symbol + '\n' +
      'TX Hash: ' + result.txid + '\n\n' +
      'Cek di: solscan.io/tx/' + result.txid
    );
  } else {
    bot.sendMessage(chatId, 'Transaksi GAGAL:\n' + result.error);
  }
});

bot.onText(/\/tidak/, (msg) => {
  pendingTrades.delete(msg.chat.id);
  bot.sendMessage(msg.chat.id, 'Transaksi dibatalkan.');
});

bot.onText(/\/sell (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const parts = match[1].trim().split(' ');
  const symbol = parts[0].toUpperCase();
  const amountUSD = parseFloat(parts[1]) || settings.maxBudgetPerTrade;

  bot.sendMessage(chatId, 'Mencari ' + symbol + '...');

  const loaded = await loadSolana();
  if (!loaded) { bot.sendMessage(chatId, 'Solana gagal dimuat.'); return; }

  const tokens = await searchToken(symbol);
  if (tokens.length === 0) { bot.sendMessage(chatId, 'Token tidak ditemukan.'); return; }

  const token = tokens[0];
  const tokenPrice = await getTokenPrice(token.address);
  if (!tokenPrice) { bot.sendMessage(chatId, 'Gagal ambil harga token.'); return; }

  const tokenAmount = amountUSD / tokenPrice;
  const tokenLamports = Math.floor(tokenAmount * Math.pow(10, token.decimals || 6));

  const quoteResult = await getQuote(token.address, SOL_MINT, tokenLamports);
  if (!quoteResult.success) {
    bot.sendMessage(chatId, 'Gagal buat quote: ' + quoteResult.error);
    return;
  }

  const solOut = quoteResult.quote.outAmount / 1e9;
  const solPrice = await getSolPrice();

  pendingTrades.set(chatId, {
    type: 'sell',
    token,
    amountUSD,
    tokenLamports,
    solOut,
    quote: quoteResult.quote,
  });

  bot.sendMessage(chatId,
    'Konfirmasi Penjualan:\n\n' +
    'Jual: ' + tokenAmount.toFixed(4) + ' ' + token.symbol + '\n' +
    'Nilai: ~$' + amountUSD + '\n' +
    'Dapat: ~' + solOut.toFixed(4) + ' SOL (~$' + (solOut * solPrice).toFixed(2) + ')\n' +
    'Slippage: ' + settings.slippage + '%\n\n' +
    'Ketik /ya untuk eksekusi\n' +
    'Ketik /tidak untuk batal'
  );
});

bot.onText(/\/swap (.+) (.+) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const fromSymbol = match[1].toUpperCase();
  const toSymbol = match[2].toUpperCase();
  const amountUSD = parseFloat(match[3]) || settings.maxBudgetPerTrade;

  bot.sendMessage(chatId, 'Mencari quote swap ' + fromSymbol + ' ke ' + toSymbol + '...');

  const loaded = await loadSolana();
  if (!loaded) { bot.sendMessage(chatId, 'Solana gagal dimuat.'); return; }

  const fromTokens = fromSymbol === 'SOL' ? [{ address: SOL_MINT, symbol: 'SOL', decimals: 9 }] : await searchToken(fromSymbol);
  const toTokens = toSymbol === 'SOL' ? [{ address: SOL_MINT, symbol: 'SOL', decimals: 9 }] : await searchToken(toSymbol);

  if (fromTokens.length === 0 || toTokens.length === 0) {
    bot.sendMessage(chatId, 'Token tidak ditemukan.'); return;
  }

  const fromToken = fromTokens[0];
  const toToken = toTokens[0];

  const fromPrice = await getTokenPrice(fromToken.address);
  const fromAmount = amountUSD / (fromPrice || 1);
  const fromLamports = Math.floor(fromAmount * Math.pow(10, fromToken.decimals || 9));

  const quoteResult = await getQuote(fromToken.address, toToken.address, fromLamports);
  if (!quoteResult.success) {
    bot.sendMessage(chatId, 'Gagal buat quote: ' + quoteResult.error); return;
  }

  const toAmount = quoteResult.quote.outAmount / Math.pow(10, toToken.decimals || 6);

  pendingTrades.set(chatId, {
    type: 'swap',
    fromToken, toToken, amountUSD, toAmount,
    quote: quoteResult.quote,
  });

  bot.sendMessage(chatId,
    'Konfirmasi Swap:\n\n' +
    'Dari: ' + fromAmount.toFixed(4) + ' ' + fromToken.symbol + '\n' +
    'Ke: ~' + toAmount.toFixed(4) + ' ' + toToken.symbol + '\n' +
    'Nilai: ~$' + amountUSD + '\n' +
    'Slippage: ' + settings.slippage + '%\n\n' +
    'Ketik /ya untuk eksekusi\n' +
    'Ketik /tidak untuk batal'
  );
});

bot.onText(/\/scan/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Scanning meme coin terbaik...');
  const reply = await chat(chatId, 'Scan meme coin terbaik di Solana. Berikan top 3 dengan entry point dan stop loss.');
  bot.sendMessage(chatId, reply);
});

bot.onText(/\/scalping/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Mencari peluang scalping...');
  const reply = await chat(chatId, 'Cari koin terbaik untuk scalping. Berikan entry, target profit, dan stop loss.');
  bot.sendMessage(chatId, reply);
});

bot.onText(/\/trending/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Menganalisis trending...');
  const reply = await chat(chatId, 'Koin apa yang trending sekarang? Berikan analisis sentimen dan potensi.');
  bot.sendMessage(chatId, reply);
});

bot.onText(/\/skills/, async (msg) => {
  const chatId = msg.chat.id;
  if (skills.size === 0) {
    bot.sendMessage(chatId, 'Belum ada skill.\n\nInstall: /install https://github.com/username/repo');
    return;
  }
  let list = 'Skill aktif (' + skills.size + '):\n\n';
  for (const [name, skill] of skills) {
    list += 'AKTIF - ' + name + '\n' + skill.url + '\n\n';
  }
  bot.sendMessage(chatId, list);
});

bot.onText(/\/install (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Menginstall skill...');
  const result = await loadSkill(match[1].trim());
  if (result.success) {
    bot.sendMessage(chatId, 'Skill ' + result.name + ' berhasil diinstall!');
  } else {
    bot.sendMessage(chatId, 'Gagal install: ' + result.error);
  }
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    'Perintah HervBot:\n\n' +
    'Trading:\n' +
    '/buy [token] [USD] - Beli token\n' +
    '/sell [token] [USD] - Jual token\n' +
    '/swap [dari] [ke] [USD] - Swap\n' +
    '/harga [token] - Cek harga\n' +
    '/saldo - Cek saldo\n' +
    '/ya - Konfirmasi transaksi\n' +
    '/tidak - Batal transaksi\n\n' +
    'Pengaturan:\n' +
    '/budget [angka] - Set budget\n' +
    '/slippage [angka] - Set slippage\n\n' +
    'Analisis:\n' +
    '/scan - Scan meme coin\n' +
    '/scalping - Peluang scalping\n' +
    '/trending - Token trending\n' +
    '/skills - Kelola skill\n' +
    '/install [url] - Install skill'
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

const pendingTrades = new Map();

app.get('/health', (req, res) => res.json({ status: 'ok', skills: skills.size, settings }));

// Load Solana saat startup
loadSolana().then(() => {
  app.listen(config.PORT, () => {
    console.log('HervBot running on port ' + config.PORT);
  });
});
