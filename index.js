const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const config = {
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  WALLET_PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY,
  SOLANA_RPC: process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com',
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  GITHUB_USERNAME: process.env.GITHUB_USERNAME || 'herviana',
  PORT: process.env.PORT || 3000,
};

const bot = new TelegramBot(config.TELEGRAM_TOKEN, { polling: true });

// ── AUTO-SAVE ──
const SETTINGS_FILE = '/tmp/hervbot_settings.json';
const SKILLS_FILE = '/tmp/hervbot_skills.json';
const TRADES_FILE = '/tmp/hervbot_trades.json';

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch (e) {}
  return { maxBudgetPerTrade: 0.1, slippage: 1, autoTrade: false, autoTradeInterval: 30 };
}
function saveSettings() {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings)); } catch (e) {}
}
function loadSavedSkills() {
  try {
    if (fs.existsSync(SKILLS_FILE)) return JSON.parse(fs.readFileSync(SKILLS_FILE, 'utf8'));
  } catch (e) {}
  return [];
}
function saveSkills() {
  try {
    const list = [];
    for (const [name, skill] of skills) list.push({ name, url: skill.url, content: skill.content, active: skill.active });
    fs.writeFileSync(SKILLS_FILE, JSON.stringify(list));
  } catch (e) {}
}
function loadTrades() {
  try {
    if (fs.existsSync(TRADES_FILE)) return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
  } catch (e) {}
  return [];
}
function saveTrades() {
  try { fs.writeFileSync(TRADES_FILE, JSON.stringify(tradeHistory)); } catch (e) {}
}

const settings = loadSettings();
const pendingTrades = new Map();
const tradeHistory = loadTrades();

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

function formatNumber(num) {
  if (!num) return '$0';
  if (num >= 1e9) return '$' + (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return '$' + (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return '$' + (num / 1e3).toFixed(2) + 'K';
  return '$' + num.toFixed(2);
}

// ── DEXSCREENER API ──
async function getDexScreenerData(symbol) {
  try {
    const s = symbol.replace('$', '');
    const res = await fetch('https://api.dexscreener.com/latest/dex/search?q=' + s);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.pairs || data.pairs.length === 0) return null;
    const solPairs = data.pairs.filter(p => p.chainId === 'solana');
    const pairs = solPairs.length > 0 ? solPairs : data.pairs;
    pairs.sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0));
    const p = pairs[0];
    return {
      symbol: p.baseToken?.symbol || s,
      name: p.baseToken?.name || s,
      address: p.baseToken?.address,
      price: parseFloat(p.priceUsd || 0),
      priceChange1h: p.priceChange?.h1 || 0,
      priceChange24h: p.priceChange?.h24 || 0,
      volume24h: p.volume?.h24 || 0,
      liquidity: p.liquidity?.usd || 0,
      marketCap: p.marketCap || 0,
      buys24h: p.txns?.h24?.buys || 0,
      sells24h: p.txns?.h24?.sells || 0,
      chainId: p.chainId,
      dexId: p.dexId,
      dexUrl: p.url,
    };
  } catch (e) { return null; }
}

async function getTrendingTokens() {
  try {
    const res = await fetch('https://api.dexscreener.com/token-boosts/top/v1');
    if (!res.ok) return [];
    const data = await res.json();
    // Ambil detail tiap token
    const results = [];
    for (const t of data.slice(0, 5)) {
      if (t.tokenAddress) {
        const detail = await getDexScreenerByAddress(t.tokenAddress);
        if (detail) results.push(detail);
      }
    }
    return results;
  } catch (e) { return []; }
}

async function getDexScreenerByAddress(address) {
  try {
    const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + address);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.pairs || data.pairs.length === 0) return null;
    const p = data.pairs[0];
    return {
      symbol: p.baseToken?.symbol,
      name: p.baseToken?.name,
      address: p.baseToken?.address,
      price: parseFloat(p.priceUsd || 0),
      priceChange1h: p.priceChange?.h1 || 0,
      priceChange24h: p.priceChange?.h24 || 0,
      volume24h: p.volume?.h24 || 0,
      liquidity: p.liquidity?.usd || 0,
      buys24h: p.txns?.h24?.buys || 0,
      sells24h: p.txns?.h24?.sells || 0,
      chainId: p.chainId,
      dexUrl: p.url,
    };
  } catch (e) { return null; }
}

async function getSolanaNewPairs() {
  try {
    const res = await fetch('https://api.dexscreener.com/latest/dex/pairs/solana');
    if (!res.ok) return [];
    const data = await res.json();
    if (!data.pairs) return [];
    return data.pairs
      .filter(p => p.liquidity?.usd > 5000 && p.volume?.h24 > 1000)
      .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))
      .slice(0, 5)
      .map(p => ({
        symbol: p.baseToken?.symbol,
        name: p.baseToken?.name,
        address: p.baseToken?.address,
        price: parseFloat(p.priceUsd || 0),
        priceChange24h: p.priceChange?.h24 || 0,
        volume24h: p.volume?.h24 || 0,
        liquidity: p.liquidity?.usd || 0,
        buys24h: p.txns?.h24?.buys || 0,
        sells24h: p.txns?.h24?.sells || 0,
        dexUrl: p.url,
        pairCreatedAt: p.pairCreatedAt,
      }));
  } catch (e) { return []; }
}

// ── SOLANA WALLET ──
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_API = 'https://quote-api.jup.ag/v6';

async function getSolPrice() {
  try {
    const res = await fetch('https://price.jup.ag/v4/price?ids=' + SOL_MINT);
    const data = await res.json();
    return data.data[SOL_MINT]?.price || 0;
  } catch (e) { return 0; }
}

async function getWalletBalance(publicKey) {
  try {
    const res = await fetch(config.SOLANA_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [publicKey] }),
    });
    const data = await res.json();
    const sol = (data.result?.value || 0) / 1e9;
    const solPrice = await getSolPrice();
    return { sol: sol.toFixed(4), usd: (sol * solPrice).toFixed(2) };
  } catch (e) { return { sol: '0', usd: '0' }; }
}

async function getPublicKeyFromPrivate(privateKeyBase58) {
  try {
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
    if (bytes.length >= 64) {
      const pubKeyBytes = bytes.slice(32, 64);
      let n = BigInt('0x' + Array.from(pubKeyBytes).map(b => b.toString(16).padStart(2, '0')).join(''));
      let result = '';
      while (n > 0) { result = ALPHABET[Number(n % BigInt(58))] + result; n = n / BigInt(58); }
      for (let i = 0; i < pubKeyBytes.length && pubKeyBytes[i] === 0; i++) result = '1' + result;
      return result;
    }
    return null;
  } catch (e) { return null; }
}

async function getQuote(inputMint, outputMint, amountLamports) {
  try {
    const url = JUPITER_API + '/quote?inputMint=' + inputMint + '&outputMint=' + outputMint +
      '&amount=' + amountLamports + '&slippageBps=' + (settings.slippage * 100);
    const res = await fetch(url);
    if (!res.ok) throw new Error(await res.text());
    return { success: true, quote: await res.json() };
  } catch (e) { return { success: false, error: e.message }; }
}

async function executeSwap(quoteResponse, publicKey) {
  try {
    const swapRes = await fetch(JUPITER_API + '/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: publicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      }),
    });
    if (!swapRes.ok) throw new Error(await swapRes.text());
    const { swapTransaction } = await swapRes.json();

    // Sign dan kirim via Solana web3
    const { Connection, VersionedTransaction, Keypair } = await import('@solana/web3.js');
    const bs58 = (await import('bs58')).default;
    const connection = new Connection(config.SOLANA_RPC, 'confirmed');
    const swapBuf = Buffer.from(swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapBuf);
    const privateKeyBytes = bs58.decode(config.WALLET_PRIVATE_KEY);
    const keypair = Keypair.fromSecretKey(privateKeyBytes);
    transaction.sign([keypair]);
    const rawTx = transaction.serialize();
    const txid = await connection.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 3 });
    const confirmation = await connection.confirmTransaction(txid, 'confirmed');
    if (confirmation.value?.err) throw new Error('Transaction failed: ' + JSON.stringify(confirmation.value.err));
    return { success: true, txid };
  } catch (e) { return { success: false, error: e.message }; }
}

// ── AUTO TRADING ENGINE ──
let autoTradeTimer = null;
const autoTradePositions = new Map();
let autoTradeChatId = null;

async function analyzeForAutoTrade() {
  try {
    const pairs = await getSolanaNewPairs();
    if (pairs.length === 0) return null;

    // Filter sinyal kuat: volume tinggi, banyak buyer, likuiditas cukup
    const signals = pairs.filter(p => {
      const buyRatio = p.buys24h / (p.buys24h + p.sells24h + 1);
      return (
        p.volume24h > 10000 &&
        p.liquidity > 10000 &&
        buyRatio > 0.6 &&
        p.priceChange24h > 5
      );
    });

    if (signals.length === 0) return null;
    return signals[0];
  } catch (e) { return null; }
}

async function checkAutoTradePositions() {
  for (const [address, pos] of autoTradePositions) {
    const data = await getDexScreenerByAddress(address);
    if (!data) continue;

    const currentPrice = data.price;
    const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

    // Take profit: +15% atau Stop loss: -7%
    if (pnlPct >= 15 || pnlPct <= -7) {
      const action = pnlPct >= 15 ? 'TAKE PROFIT' : 'STOP LOSS';

      if (autoTradeChatId) {
        bot.sendMessage(autoTradeChatId,
          action + ' Triggered!\n\n' +
          'Token: ' + pos.symbol + '\n' +
          'Entry: $' + pos.entryPrice.toFixed(8) + '\n' +
          'Sekarang: $' + currentPrice.toFixed(8) + '\n' +
          'PnL: ' + (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(2) + '%\n\n' +
          'Mengeksekusi sell...'
        );
      }

      // Eksekusi sell
      const pubkey = await getPublicKeyFromPrivate(config.WALLET_PRIVATE_KEY);
      const tokenLamports = Math.floor(pos.tokenAmount * Math.pow(10, 6));
      const quoteResult = await getQuote(address, SOL_MINT, tokenLamports);
      if (quoteResult.success) {
        const result = await executeSwap(quoteResult.quote, pubkey);
        if (autoTradeChatId) {
          if (result.success) {
            bot.sendMessage(autoTradeChatId,
              'Sell berhasil!\n' +
              'PnL: ' + (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(2) + '%\n' +
              'TX: solscan.io/tx/' + result.txid
            );
            tradeHistory.push({ type: 'sell', symbol: pos.symbol, pnl: pnlPct, txid: result.txid, time: new Date().toISOString() });
            saveTrades();
          } else {
            bot.sendMessage(autoTradeChatId, 'Sell gagal: ' + result.error);
          }
        }
      }
      autoTradePositions.delete(address);
    }
  }
}

async function runAutoTrade() {
  if (!settings.autoTrade || !autoTradeChatId) return;

  // Cek posisi aktif dulu
  await checkAutoTradePositions();

  // Kalau posisi sudah penuh (max 3), skip
  if (autoTradePositions.size >= 3) return;

  const signal = await analyzeForAutoTrade();
  if (!signal) return;

  // Jangan beli token yang sudah punya posisi
  if (autoTradePositions.has(signal.address)) return;

  const pubkey = await getPublicKeyFromPrivate(config.WALLET_PRIVATE_KEY);
  if (!pubkey) return;

  const solPrice = await getSolPrice();
  const amountUSD = settings.maxBudgetPerTrade;
  const solAmount = amountUSD / solPrice;
  const lamports = Math.floor(solAmount * 1e9);

  const quoteResult = await getQuote(SOL_MINT, signal.address, lamports);
  if (!quoteResult.success) return;

  const outAmount = quoteResult.quote.outAmount / Math.pow(10, 6);

  // Beritahu user
  bot.sendMessage(autoTradeChatId,
    'Auto Trade - Sinyal Terdeteksi!\n\n' +
    'Token: ' + signal.symbol + '\n' +
    'Harga: $' + signal.price.toFixed(8) + '\n' +
    'Volume 24j: ' + formatNumber(signal.volume24h) + '\n' +
    'Likuiditas: ' + formatNumber(signal.liquidity) + '\n' +
    'Buy ratio: ' + ((signal.buys24h / (signal.buys24h + signal.sells24h)) * 100).toFixed(0) + '%\n\n' +
    'Mengeksekusi buy $' + amountUSD + '...'
  );

  const result = await executeSwap(quoteResult.quote, pubkey);

  if (result.success) {
    autoTradePositions.set(signal.address, {
      symbol: signal.symbol,
      entryPrice: signal.price,
      tokenAmount: outAmount,
      amountUSD,
      buyTime: new Date().toISOString(),
      txid: result.txid,
    });

    tradeHistory.push({ type: 'buy', symbol: signal.symbol, price: signal.price, amountUSD, txid: result.txid, time: new Date().toISOString() });
    saveTrades();

    bot.sendMessage(autoTradeChatId,
      'Buy Berhasil!\n\n' +
      'Token: ' + signal.symbol + '\n' +
      'Dapat: ' + outAmount.toFixed(4) + ' ' + signal.symbol + '\n' +
      'Entry: $' + signal.price.toFixed(8) + '\n' +
      'Take Profit: +15% | Stop Loss: -7%\n' +
      'TX: solscan.io/tx/' + result.txid
    );
  } else {
    bot.sendMessage(autoTradeChatId, 'Auto buy gagal: ' + result.error);
  }
}

function startAutoTrade(chatId) {
  autoTradeChatId = chatId;
  settings.autoTrade = true;
  saveSettings();
  if (autoTradeTimer) clearInterval(autoTradeTimer);
  const intervalMs = (settings.autoTradeInterval || 30) * 60 * 1000;
  autoTradeTimer = setInterval(runAutoTrade, intervalMs);
  runAutoTrade(); // Jalankan sekali langsung
}

function stopAutoTrade() {
  settings.autoTrade = false;
  saveSettings();
  if (autoTradeTimer) { clearInterval(autoTradeTimer); autoTradeTimer = null; }
}

// ── SKILL LOADER ──
const skills = new Map();

async function loadSkill(githubUrl) {
  try {
    let url = githubUrl.trim().replace(/\/$/, '').replace('https://', '').replace('http://', '');
    const parts = url.replace('github.com/', '').split('/');
    const owner = parts[0];
    const repo = parts[1];
    if (!owner || !repo) throw new Error('Format URL tidak valid');
    const branches = ['main', 'master'];
    let content = null;
    for (const branch of branches) {
      try {
        const res = await fetch('https://raw.githubusercontent.com/' + owner + '/' + repo + '/' + branch + '/SKILL.md');
        if (res.ok) { content = await res.text(); break; }
      } catch (e) {}
    }
    if (!content) throw new Error('SKILL.md tidak ditemukan');
    const nameMatch = content.match(/name:\s*(.+)/i);
    const name = nameMatch ? nameMatch[1].trim() : repo;
    skills.set(name, { url: 'https://github.com/' + owner + '/' + repo, content, active: true });
    saveSkills();
    return { success: true, name };
  } catch (e) { return { success: false, error: e.message }; }
}

// ── GITHUB API ──
async function githubPushFile(repoName, filePath, content, commitMessage) {
  try {
    const token = config.GITHUB_TOKEN;
    const owner = config.GITHUB_USERNAME;
    if (!token) throw new Error('GITHUB_TOKEN belum diset');
    const repoCheck = await fetch('https://api.github.com/repos/' + owner + '/' + repoName, {
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github.v3+json' },
    });
    if (!repoCheck.ok) {
      const createRepo = await fetch('https://api.github.com/user/repos', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: repoName, private: false, auto_init: true }),
      });
      if (!createRepo.ok) throw new Error('Gagal buat repo');
      await new Promise(r => setTimeout(r, 2000));
    }
    let sha = null;
    const fileCheck = await fetch('https://api.github.com/repos/' + owner + '/' + repoName + '/contents/' + filePath, {
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github.v3+json' },
    });
    if (fileCheck.ok) sha = (await fileCheck.json()).sha;
    const body = { message: commitMessage || 'Update via HervBot', content: Buffer.from(content).toString('base64') };
    if (sha) body.sha = sha;
    const pushRes = await fetch('https://api.github.com/repos/' + owner + '/' + repoName + '/contents/' + filePath, {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!pushRes.ok) throw new Error('Gagal push: ' + await pushRes.text());
    return { success: true, url: 'https://github.com/' + owner + '/' + repoName };
  } catch (e) { return { success: false, error: e.message }; }
}

async function searchGithubSkills(keyword) {
  try {
    const token = config.GITHUB_TOKEN;
    const url = 'https://api.github.com/search/repositories?q=' + encodeURIComponent(keyword + ' skill trading crypto') + '&sort=stars&order=desc&per_page=8';
    const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'HervBot' } });
    if (!res.ok) throw new Error('GitHub search gagal');
    const data = await res.json();
    if (!data.items || data.items.length === 0) return { success: true, results: [] };
    const results = [];
    for (const repo of data.items.slice(0, 5)) {
      const skillCheck = await fetch('https://raw.githubusercontent.com/' + repo.full_name + '/main/SKILL.md');
      results.push({ name: repo.name, fullName: repo.full_name, url: repo.html_url, description: repo.description || '-', stars: repo.stargazers_count, hasSkill: skillCheck.ok });
    }
    return { success: true, results };
  } catch (e) { return { success: false, error: e.message }; }
}

// ── AI CHAT ──
const conversations = new Map();

async function chat(userId, userMessage, extraContext) {
  if (!conversations.has(userId)) conversations.set(userId, []);
  const history = conversations.get(userId);
  history.push({ role: 'user', content: userMessage });
  if (history.length > 20) history.splice(0, history.length - 20);
  let skillsContext = '';
  for (const [name, skill] of skills) {
    if (skill.active) skillsContext += '\nSKILL ' + name + ':\n' + skill.content.slice(0, 800);
  }
  const systemPrompt = 'Kamu adalah HervBot, AI trading agent crypto dengan data real-time dari DexScreener dan kemampuan transaksi nyata di Solana via Jupiter DEX.' +
    '\nSettings: Budget $' + settings.maxBudgetPerTrade + ', Slippage ' + settings.slippage + '%, Auto Trade: ' + (settings.autoTrade ? 'ON' : 'OFF') +
    (skillsContext ? '\n\nSkill aktif:\n' + skillsContext : '') +
    (extraContext ? '\n\nData Real-time:\n' + extraContext : '') +
    '\n\nJangan mengarang URL GitHub. Untuk cari skill pakai /cari [keyword]. Jangan gunakan Markdown. Teks biasa. Bahasa Indonesia santai.';
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + config.GROQ_API_KEY },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 800, messages: [{ role: 'system', content: systemPrompt }, ...history] }),
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
    'Trading Nyata:\n' +
    '/buy [token] [USD] - Beli token\n' +
    '/sell [token] [USD] - Jual token\n' +
    '/swap [dari] [ke] [USD] - Swap\n' +
    '/harga [token] - Harga real-time\n' +
    '/saldo - Cek saldo wallet\n\n' +
    'Auto Trading:\n' +
    '/autoon - Aktifkan auto trade\n' +
    '/autooff - Matikan auto trade\n' +
    '/posisi - Posisi aktif\n' +
    '/laporan - Laporan trading\n\n' +
    'Analisis:\n' +
    '/scan - Scan token potensial\n' +
    '/scalping - Peluang scalping\n' +
    '/trending - Token trending\n\n' +
    'Skills:\n' +
    '/skills - Kelola skill\n' +
    '/cari [keyword] - Cari skill di GitHub\n' +
    '/install [url] - Install skill\n\n' +
    'Pengaturan:\n' +
    '/budget [angka] - Set budget\n' +
    '/slippage [angka] - Set slippage\n' +
    '/interval [menit] - Set interval auto trade\n\n' +
    'Alert Harga:\n' +
    '/alert [token] above/below/change_up/change_down [nilai]\n' +
    '/alerts - Lihat alert aktif\n' +
    '/clearalerts - Hapus semua alert\n\n' +
    'Budget: $' + settings.maxBudgetPerTrade + ' | Auto: ' + (settings.autoTrade ? 'ON' : 'OFF')
  );
});

bot.onText(/\/autoon/, async (msg) => {
  const chatId = msg.chat.id;
  const pubkey = await getPublicKeyFromPrivate(config.WALLET_PRIVATE_KEY);
  if (!pubkey) { bot.sendMessage(chatId, 'Gagal baca wallet. Cek WALLET_PRIVATE_KEY.'); return; }
  const balance = await getWalletBalance(pubkey);
  if (parseFloat(balance.usd) < settings.maxBudgetPerTrade) {
    bot.sendMessage(chatId, 'Saldo tidak cukup untuk auto trade.\nSaldo: $' + balance.usd + '\nBudget: $' + settings.maxBudgetPerTrade + '\n\nIsi saldo wallet dulu!');
    return;
  }
  startAutoTrade(chatId);
  bot.sendMessage(chatId,
    'Auto Trade AKTIF!\n\n' +
    'Budget per trade: $' + settings.maxBudgetPerTrade + '\n' +
    'Interval scan: ' + (settings.autoTradeInterval || 30) + ' menit\n' +
    'Take Profit: +15%\n' +
    'Stop Loss: -7%\n' +
    'Max posisi: 3\n\n' +
    'Bot akan otomatis beli/jual berdasarkan sinyal DexScreener.'
  );
});

bot.onText(/\/autooff/, (msg) => {
  stopAutoTrade();
  bot.sendMessage(msg.chat.id, 'Auto Trade DIMATIKAN.\n\nPosisi aktif masih dipantau sampai take profit/stop loss.');
});

bot.onText(/\/posisi/, async (msg) => {
  const chatId = msg.chat.id;
  if (autoTradePositions.size === 0) {
    bot.sendMessage(chatId, 'Tidak ada posisi aktif saat ini.');
    return;
  }
  let msg2 = 'Posisi Aktif (' + autoTradePositions.size + '):\n\n';
  for (const [address, pos] of autoTradePositions) {
    const data = await getDexScreenerByAddress(address);
    const currentPrice = data?.price || pos.entryPrice;
    const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
    msg2 += 'Token: ' + pos.symbol + '\n';
    msg2 += 'Entry: $' + pos.entryPrice.toFixed(8) + '\n';
    msg2 += 'Sekarang: $' + currentPrice.toFixed(8) + '\n';
    msg2 += 'PnL: ' + (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(2) + '%\n';
    msg2 += 'Modal: $' + pos.amountUSD + '\n\n';
  }
  bot.sendMessage(chatId, msg2);
});

bot.onText(/\/laporan/, (msg) => {
  const chatId = msg.chat.id;
  if (tradeHistory.length === 0) {
    bot.sendMessage(chatId, 'Belum ada riwayat trading.');
    return;
  }
  const buys = tradeHistory.filter(t => t.type === 'buy').length;
  const sells = tradeHistory.filter(t => t.type === 'sell').length;
  const wins = tradeHistory.filter(t => t.type === 'sell' && t.pnl > 0).length;
  const totalPnl = tradeHistory.filter(t => t.type === 'sell').reduce((sum, t) => sum + (t.pnl || 0), 0);
  let msg2 = 'Laporan Trading:\n\n';
  msg2 += 'Total transaksi: ' + tradeHistory.length + '\n';
  msg2 += 'Buy: ' + buys + ' | Sell: ' + sells + '\n';
  msg2 += 'Win rate: ' + (sells > 0 ? ((wins / sells) * 100).toFixed(0) : 0) + '%\n';
  msg2 += 'Total PnL: ' + (totalPnl >= 0 ? '+' : '') + totalPnl.toFixed(2) + '%\n\n';
  msg2 += 'Riwayat terakhir:\n';
  tradeHistory.slice(-5).reverse().forEach(t => {
    msg2 += t.type.toUpperCase() + ' ' + t.symbol + (t.pnl ? ' ' + (t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(2) + '%' : '') + '\n';
  });
  bot.sendMessage(chatId, msg2);
});

bot.onText(/\/interval (.+)/, (msg, match) => {
  const mins = parseInt(match[1]);
  if (isNaN(mins) || mins < 5) { bot.sendMessage(msg.chat.id, 'Minimal 5 menit. Contoh: /interval 30'); return; }
  settings.autoTradeInterval = mins;
  saveSettings();
  if (settings.autoTrade && autoTradeTimer) {
    clearInterval(autoTradeTimer);
    autoTradeTimer = setInterval(runAutoTrade, mins * 60 * 1000);
  }
  bot.sendMessage(msg.chat.id, 'Interval auto trade: ' + mins + ' menit');
});

bot.onText(/\/budget (.+)/, (msg, match) => {
  const amount = parseFloat(match[1]);
  if (isNaN(amount) || amount <= 0) { bot.sendMessage(msg.chat.id, 'Contoh: /budget 0.5'); return; }
  settings.maxBudgetPerTrade = amount;
  saveSettings();
  bot.sendMessage(msg.chat.id, 'Budget per trade: $' + amount);
});

bot.onText(/\/slippage (.+)/, (msg, match) => {
  const slip = parseFloat(match[1]);
  if (isNaN(slip) || slip <= 0 || slip > 50) { bot.sendMessage(msg.chat.id, 'Contoh: /slippage 1'); return; }
  settings.slippage = slip;
  saveSettings();
  bot.sendMessage(msg.chat.id, 'Slippage: ' + slip + '%');
});

bot.onText(/\/saldo/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Mengecek saldo...');
  const pubkey = await getPublicKeyFromPrivate(config.WALLET_PRIVATE_KEY);
  if (!pubkey) { bot.sendMessage(chatId, 'Gagal baca wallet.'); return; }
  const balance = await getWalletBalance(pubkey);
  bot.sendMessage(chatId, 'Saldo Wallet:\n\nSOL: ' + balance.sol + '\nUSD: ~$' + balance.usd + '\n\nAlamat: ' + pubkey.slice(0, 6) + '...' + pubkey.slice(-6));
});

bot.onText(/\/harga (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const symbol = match[1].trim();
  bot.sendMessage(chatId, 'Mengambil data real-time...');
  const data = await getDexScreenerData(symbol);
  if (!data) { bot.sendMessage(chatId, 'Token ' + symbol + ' tidak ditemukan.'); return; }
  const priceStr = data.price < 0.001 ? data.price.toFixed(8) : data.price < 1 ? data.price.toFixed(6) : data.price.toFixed(4);
  bot.sendMessage(chatId,
    'Data Real-time ' + data.symbol + ':\n\n' +
    'Harga: $' + priceStr + '\n' +
    'Perubahan 1j: ' + (data.priceChange1h >= 0 ? '+' : '') + data.priceChange1h.toFixed(2) + '%\n' +
    'Perubahan 24j: ' + (data.priceChange24h >= 0 ? '+' : '') + data.priceChange24h.toFixed(2) + '%\n' +
    'Volume 24j: ' + formatNumber(data.volume24h) + '\n' +
    'Likuiditas: ' + formatNumber(data.liquidity) + '\n' +
    'Buy/Sell 24j: ' + data.buys24h + '/' + data.sells24h + '\n' +
    'Chain: ' + data.chainId + '\n\n' +
    'Chart: ' + data.dexUrl
  );
});

bot.onText(/\/buy (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const parts = match[1].trim().split(' ');
  const symbol = parts[0];
  const amountUSD = parseFloat(parts[1]) || settings.maxBudgetPerTrade;
  if (amountUSD > settings.maxBudgetPerTrade) { bot.sendMessage(chatId, 'Melebihi budget $' + settings.maxBudgetPerTrade); return; }
  bot.sendMessage(chatId, 'Mencari ' + symbol + '...');
  const tokenData = await getDexScreenerData(symbol);
  if (!tokenData || !tokenData.address) { bot.sendMessage(chatId, 'Token tidak ditemukan.'); return; }
  const solPrice = await getSolPrice();
  if (!solPrice) { bot.sendMessage(chatId, 'Gagal ambil harga SOL.'); return; }
  const lamports = Math.floor((amountUSD / solPrice) * 1e9);
  const quoteResult = await getQuote(SOL_MINT, tokenData.address, lamports);
  if (!quoteResult.success) { bot.sendMessage(chatId, 'Gagal quote: ' + quoteResult.error); return; }
  const outAmount = quoteResult.quote.outAmount / Math.pow(10, 6);
  pendingTrades.set(chatId, { type: 'buy', token: tokenData, amountUSD, lamports, outAmount, quote: quoteResult.quote });
  bot.sendMessage(chatId,
    'Konfirmasi Buy:\n\n' +
    'Token: ' + tokenData.symbol + '\n' +
    'Bayar: $' + amountUSD + ' (' + (amountUSD / solPrice).toFixed(4) + ' SOL)\n' +
    'Dapat: ~' + outAmount.toFixed(4) + ' ' + tokenData.symbol + '\n' +
    'Harga: $' + tokenData.price.toFixed(8) + '\n' +
    'Slippage: ' + settings.slippage + '%\n\n' +
    '/ya - Eksekusi\n/tidak - Batal'
  );
});

bot.onText(/\/ya/, async (msg) => {
  const chatId = msg.chat.id;
  const pending = pendingTrades.get(chatId);
  if (!pending) { bot.sendMessage(chatId, 'Tidak ada transaksi pending.'); return; }
  pendingTrades.delete(chatId);
  bot.sendMessage(chatId, 'Mengeksekusi transaksi di Solana...');
  const pubkey = await getPublicKeyFromPrivate(config.WALLET_PRIVATE_KEY);
  if (!pubkey) { bot.sendMessage(chatId, 'Gagal baca wallet.'); return; }
  const result = await executeSwap(pending.quote, pubkey);
  if (result.success) {
    tradeHistory.push({ type: pending.type, symbol: pending.token.symbol, amountUSD: pending.amountUSD, txid: result.txid, time: new Date().toISOString() });
    saveTrades();
    bot.sendMessage(chatId, 'Transaksi BERHASIL!\n\nToken: ' + pending.token.symbol + '\nJumlah: ~' + pending.outAmount.toFixed(4) + ' ' + pending.token.symbol + '\n\nTX: ' + result.txid + '\nCek: solscan.io/tx/' + result.txid);
  } else {
    bot.sendMessage(chatId, 'Transaksi GAGAL:\n' + result.error);
  }
});

bot.onText(/\/tidak/, (msg) => { pendingTrades.delete(msg.chat.id); bot.sendMessage(msg.chat.id, 'Dibatalkan.'); });

bot.onText(/\/sell (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const parts = match[1].trim().split(' ');
  const symbol = parts[0];
  const amountUSD = parseFloat(parts[1]) || settings.maxBudgetPerTrade;
  const tokenData = await getDexScreenerData(symbol);
  if (!tokenData || !tokenData.address) { bot.sendMessage(chatId, 'Token tidak ditemukan.'); return; }
  const tokenLamports = Math.floor((amountUSD / tokenData.price) * Math.pow(10, 6));
  const quoteResult = await getQuote(tokenData.address, SOL_MINT, tokenLamports);
  if (!quoteResult.success) { bot.sendMessage(chatId, 'Gagal quote: ' + quoteResult.error); return; }
  const solOut = quoteResult.quote.outAmount / 1e9;
  const solPrice = await getSolPrice();
  pendingTrades.set(chatId, { type: 'sell', token: tokenData, amountUSD, tokenLamports, solOut, quote: quoteResult.quote });
  bot.sendMessage(chatId, 'Konfirmasi Sell:\n\nJual: ' + (amountUSD / tokenData.price).toFixed(4) + ' ' + tokenData.symbol + '\nDapat: ~' + solOut.toFixed(4) + ' SOL (~$' + (solOut * solPrice).toFixed(2) + ')\n\n/ya - Eksekusi\n/tidak - Batal');
});

bot.onText(/\/swap (.+) (.+) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const fromSymbol = match[1];
  const toSymbol = match[2];
  const amountUSD = parseFloat(match[3]) || settings.maxBudgetPerTrade;
  const fromData = fromSymbol.toUpperCase() === 'SOL' ? { address: SOL_MINT, symbol: 'SOL', price: await getSolPrice() } : await getDexScreenerData(fromSymbol);
  const toData = toSymbol.toUpperCase() === 'SOL' ? { address: SOL_MINT, symbol: 'SOL' } : await getDexScreenerData(toSymbol);
  if (!fromData || !toData) { bot.sendMessage(chatId, 'Token tidak ditemukan.'); return; }
  const fromLamports = Math.floor((amountUSD / fromData.price) * (fromSymbol.toUpperCase() === 'SOL' ? 1e9 : 1e6));
  const quoteResult = await getQuote(fromData.address, toData.address, fromLamports);
  if (!quoteResult.success) { bot.sendMessage(chatId, 'Gagal quote: ' + quoteResult.error); return; }
  const toAmount = quoteResult.quote.outAmount / (toSymbol.toUpperCase() === 'SOL' ? 1e9 : 1e6);
  pendingTrades.set(chatId, { type: 'swap', token: toData, fromData, amountUSD, toAmount, quote: quoteResult.quote });
  bot.sendMessage(chatId, 'Konfirmasi Swap:\n\nDari: ' + (amountUSD / fromData.price).toFixed(4) + ' ' + fromData.symbol + '\nKe: ~' + toAmount.toFixed(4) + ' ' + (toData.symbol || toSymbol) + '\n\n/ya - Eksekusi\n/tidak - Batal');
});

bot.onText(/\/scan/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Scanning token potensial di Solana...');
  const pairs = await getSolanaNewPairs();
  let scanMsg = 'Token Potensial Solana (Real-time):\n\n';
  if (pairs.length === 0) { scanMsg += 'Tidak ada token yang memenuhi filter saat ini.'; }
  else {
    pairs.forEach((t, i) => {
      const change = (t.priceChange24h >= 0 ? '+' : '') + t.priceChange24h.toFixed(2);
      const buyRatio = ((t.buys24h / (t.buys24h + t.sells24h + 1)) * 100).toFixed(0);
      scanMsg += (i+1) + '. ' + t.symbol + ' (' + t.name + ')\n';
      scanMsg += 'Harga: $' + (t.price < 0.001 ? t.price.toFixed(8) : t.price.toFixed(4)) + ' (' + change + '%)\n';
      scanMsg += 'Volume: ' + formatNumber(t.volume24h) + ' | Liq: ' + formatNumber(t.liquidity) + '\n';
      scanMsg += 'Buy ratio: ' + buyRatio + '%\n';
      scanMsg += 'Chart: ' + t.dexUrl + '\n\n';
    });
  }
  bot.sendMessage(chatId, scanMsg);
  const aiPrompt = 'Data token potensial Solana real-time:\n' + JSON.stringify(pairs.slice(0,3)) + '\n\nBerikan analisis singkat mana yang paling menarik dan risikonya.';
  const reply = await chat(chatId, aiPrompt, JSON.stringify(pairs));
  bot.sendMessage(chatId, 'Analisis AI:\n\n' + reply);
});

bot.onText(/\/scalping/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Mencari peluang scalping...');
  const pairs = await getSolanaNewPairs();
  const context = 'Data Solana real-time:\n' + JSON.stringify(pairs.slice(0,3));
  const reply = await chat(chatId, 'Berdasarkan data real-time, cari peluang scalping terbaik. Berikan entry, target profit 5-10%, dan stop loss.', context);
  bot.sendMessage(chatId, reply);
});

bot.onText(/\/trending/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Mengambil token trending...');
  const trending = await getTrendingTokens();
  if (trending.length === 0) { bot.sendMessage(chatId, 'Gagal ambil trending.'); return; }
  let msg2 = 'Token Trending (Real-time):\n\n';
  trending.forEach((t, i) => {
    const change = (t.priceChange24h >= 0 ? '+' : '') + t.priceChange24h.toFixed(2);
    msg2 += (i+1) + '. ' + (t.symbol || 'Unknown') + '\n';
    msg2 += 'Harga: $' + (t.price < 0.001 ? t.price.toFixed(8) : t.price.toFixed(4)) + ' (' + change + '%)\n';
    msg2 += 'Volume: ' + formatNumber(t.volume24h) + '\n\n';
  });
  bot.sendMessage(chatId, msg2);
});

bot.onText(/\/skills/, (msg) => {
  const chatId = msg.chat.id;
  if (skills.size === 0) { bot.sendMessage(chatId, 'Belum ada skill.\n/install https://github.com/username/repo'); return; }
  let list = 'Skill aktif (' + skills.size + '):\n\n';
  for (const [name, skill] of skills) list += 'AKTIF - ' + name + '\n' + skill.url + '\n\n';
  bot.sendMessage(chatId, list);
});

bot.onText(/\/cari (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const keyword = match[1].trim();
  bot.sendMessage(chatId, 'Mencari skill di GitHub...');
  const result = await searchGithubSkills(keyword);
  if (!result.success) { bot.sendMessage(chatId, 'Gagal search: ' + result.error); return; }
  if (result.results.length === 0) { bot.sendMessage(chatId, 'Tidak ada skill ditemukan.'); return; }
  let msg2 = 'Hasil pencarian "' + keyword + '":\n\n';
  result.results.forEach((r, i) => {
    msg2 += (i+1) + '. ' + r.name + '\n';
    msg2 += 'URL: ' + r.url + '\n';
    msg2 += 'Deskripsi: ' + r.description.slice(0, 80) + '\n';
    msg2 += 'Stars: ' + r.stars + ' | SKILL.md: ' + (r.hasSkill ? 'Ada' : 'Tidak ada') + '\n\n';
  });
  msg2 += 'Install: /install https://github.com/username/repo\nDuplikat: /github_push nama-baru https://github.com/username/repo';
  bot.sendMessage(chatId, msg2);
});

bot.onText(/\/install (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Menginstall skill...');
  const result = await loadSkill(match[1].trim());
  bot.sendMessage(chatId, result.success ? 'Skill ' + result.name + ' berhasil diinstall!' : 'Gagal: ' + result.error);
});

bot.onText(/\/github_push (.+) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const repoName = match[1].trim();
  const sourceUrl = match[2].trim();
  bot.sendMessage(chatId, 'Menduplikat skill ke ' + repoName + '...');
  let url = sourceUrl.replace('https://', '').replace('http://', '');
  const parts = url.replace('github.com/', '').split('/');
  const rawUrl = 'https://raw.githubusercontent.com/' + parts[0] + '/' + parts[1] + '/main/SKILL.md';
  const res = await fetch(rawUrl);
  if (!res.ok) { bot.sendMessage(chatId, 'SKILL.md tidak ditemukan di repo tersebut.'); return; }
  let content = await res.text();
  content = content.replace(/author:\s*.+/gi, 'author: ' + config.GITHUB_USERNAME);
  const pushResult = await githubPushFile(repoName, 'SKILL.md', content, 'Duplicated via HervBot');
  if (!pushResult.success) { bot.sendMessage(chatId, 'Gagal push: ' + pushResult.error); return; }
  const readme = '# ' + repoName + '\n\nSkill untuk HervBot.\nDiduplikat dari: ' + sourceUrl;
  await githubPushFile(repoName, 'README.md', readme, 'Add README');
  bot.sendMessage(chatId, 'Berhasil!\n\ngithub.com/' + config.GITHUB_USERNAME + '/' + repoName + '\n\nInstall:\n/install https://github.com/' + config.GITHUB_USERNAME + '/' + repoName);
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    'Perintah HervBot:\n\n' +
    '/buy [token] [USD]\n/sell [token] [USD]\n/swap [dari] [ke] [USD]\n' +
    '/harga [token]\n/saldo\n/ya\n/tidak\n' +
    '/autoon\n/autooff\n/posisi\n/laporan\n' +
    '/scan\n/scalping\n/trending\n' +
    '/budget [angka]\n/slippage [angka]\n/interval [menit]\n' +
    '/skills\n/cari [keyword]\n/install [url]\n/github_push [repo] [url]'
  );
});

bot.on('message', async (msg) => {
  if (msg.text && !msg.text.startsWith('/')) {
    bot.sendChatAction(msg.chat.id, 'typing');
    bot.sendMessage(msg.chat.id, await chat(msg.chat.id, msg.text));
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', skills: skills.size, settings, positions: autoTradePositions.size }));


// ── PRICE ALERT SYSTEM ──
const priceAlerts = new Map(); // Map<chatId, Array<Alert>>
const ALERTS_FILE = '/tmp/hervbot_alerts.json';

function loadAlerts() {
  try {
    if (fs.existsSync(ALERTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8'));
      for (const [chatId, alerts] of Object.entries(data)) {
        priceAlerts.set(parseInt(chatId), alerts);
      }
    }
  } catch (e) {}
}

function saveAlerts() {
  try {
    const obj = {};
    for (const [chatId, alerts] of priceAlerts) obj[chatId] = alerts;
    fs.writeFileSync(ALERTS_FILE, JSON.stringify(obj));
  } catch (e) {}
}

function addAlert(chatId, symbol, condition, targetPrice) {
  if (!priceAlerts.has(chatId)) priceAlerts.set(chatId, []);
  const alerts = priceAlerts.get(chatId);
  alerts.push({ symbol: symbol.toUpperCase(), condition, targetPrice, active: true, createdAt: new Date().toISOString() });
  priceAlerts.set(chatId, alerts);
  saveAlerts();
}

async function checkPriceAlerts() {
  for (const [chatId, alerts] of priceAlerts) {
    if (!alerts || alerts.length === 0) continue;
    const activeAlerts = alerts.filter(a => a.active);
    if (activeAlerts.length === 0) continue;

    // Group by symbol untuk hemat API call
    const symbols = [...new Set(activeAlerts.map(a => a.symbol))];
    for (const symbol of symbols) {
      const data = await getDexScreenerData(symbol);
      if (!data) continue;
      const currentPrice = data.price;

      for (const alert of activeAlerts.filter(a => a.symbol === symbol)) {
        let triggered = false;
        let message = '';

        if (alert.condition === 'above' && currentPrice >= alert.targetPrice) {
          triggered = true;
          message = 'NAIK MELEWATI TARGET!';
        } else if (alert.condition === 'below' && currentPrice <= alert.targetPrice) {
          triggered = true;
          message = 'TURUN KE BAWAH TARGET!';
        } else if (alert.condition === 'change_up' && data.priceChange1h >= alert.targetPrice) {
          triggered = true;
          message = 'NAIK ' + data.priceChange1h.toFixed(2) + '% dalam 1 jam!';
        } else if (alert.condition === 'change_down' && data.priceChange1h <= -alert.targetPrice) {
          triggered = true;
          message = 'TURUN ' + Math.abs(data.priceChange1h).toFixed(2) + '% dalam 1 jam!';
        }

        if (triggered) {
          alert.active = false; // Nonaktifkan setelah trigger
          saveAlerts();
          const priceStr = currentPrice < 0.001 ? currentPrice.toFixed(8) : currentPrice.toFixed(6);
          bot.sendMessage(chatId,
            'ALERT - ' + symbol + '

' +
            message + '
' +
            'Harga sekarang: $' + priceStr + '
' +
            'Target: $' + alert.targetPrice + '
' +
            'Perubahan 1j: ' + (data.priceChange1h >= 0 ? '+' : '') + data.priceChange1h.toFixed(2) + '%
' +
            'Volume 24j: ' + formatNumber(data.volume24h) + '

' +
            'Mau beli? /buy ' + symbol + ' ' + settings.maxBudgetPerTrade
          );
        }
      }
    }
  }
}

// Jalankan cek alert setiap 5 menit
setInterval(checkPriceAlerts, 5 * 60 * 1000);

// ── ALERT TELEGRAM HANDLERS ──
bot.onText(/\/alert (.+) (.+) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const symbol = match[1].trim().toUpperCase();
  const condition = match[2].trim().toLowerCase();
  const targetPrice = parseFloat(match[3]);

  if (isNaN(targetPrice)) {
    bot.sendMessage(chatId, 'Format salah. Contoh:\n/alert BONK above 0.00005\n/alert SOL below 100\n/alert BONK change_up 10\n/alert SOL change_down 5');
    return;
  }

  const validConditions = ['above', 'below', 'change_up', 'change_down'];
  if (!validConditions.includes(condition)) {
    bot.sendMessage(chatId, 'Kondisi tidak valid. Gunakan: above, below, change_up, change_down');
    return;
  }

  // Cek token valid dulu
  const data = await getDexScreenerData(symbol);
  if (!data) { bot.sendMessage(chatId, 'Token ' + symbol + ' tidak ditemukan.'); return; }

  addAlert(chatId, symbol, condition, targetPrice);

  const conditionText = {
    above: 'naik di atas $' + targetPrice,
    below: 'turun di bawah $' + targetPrice,
    change_up: 'naik ' + targetPrice + '% dalam 1 jam',
    change_down: 'turun ' + targetPrice + '% dalam 1 jam',
  };

  const priceStr = data.price < 0.001 ? data.price.toFixed(8) : data.price.toFixed(6);

  bot.sendMessage(chatId,
    'Alert dibuat!

' +
    'Token: ' + symbol + '
' +
    'Harga sekarang: $' + priceStr + '
' +
    'Notifikasi kalau: ' + conditionText[condition] + '

' +
    'Cek alert aktif: /alerts'
  );
});

bot.onText(/\/alerts/, (msg) => {
  const chatId = msg.chat.id;
  const alerts = priceAlerts.get(chatId) || [];
  const active = alerts.filter(a => a.active);

  if (active.length === 0) {
    bot.sendMessage(chatId,
      'Tidak ada alert aktif.

' +
      'Cara buat alert:
' +
      '/alert [token] above [harga] - Notif kalau naik
' +
      '/alert [token] below [harga] - Notif kalau turun
' +
      '/alert [token] change_up [%] - Notif kalau naik X%
' +
      '/alert [token] change_down [%] - Notif kalau turun X%

' +
      'Contoh:
' +
      '/alert BONK above 0.00005
' +
      '/alert SOL below 100
' +
      '/alert WIF change_up 10'
    );
    return;
  }

  let msg2 = 'Alert Aktif (' + active.length + '):

';
  active.forEach((a, i) => {
    const condText = {
      above: 'Naik > $' + a.targetPrice,
      below: 'Turun < $' + a.targetPrice,
      change_up: 'Naik ' + a.targetPrice + '%/1j',
      change_down: 'Turun ' + a.targetPrice + '%/1j',
    };
    msg2 += (i+1) + '. ' + a.symbol + ' - ' + (condText[a.condition] || a.condition) + '
';
  });

  msg2 += '
Hapus semua: /clearalerts';
  bot.sendMessage(chatId, msg2);
});

bot.onText(/\/clearalerts/, (msg) => {
  priceAlerts.set(msg.chat.id, []);
  saveAlerts();
  bot.sendMessage(msg.chat.id, 'Semua alert dihapus.');
});

// Alert untuk auto trade - notif perubahan signifikan
async function checkMarketAlerts() {
  try {
    const pairs = await getSolanaNewPairs();
    if (!pairs || pairs.length === 0) return;

    for (const [chatId] of priceAlerts) {
      // Notif kalau ada token Solana yang volume meledak
      const explosive = pairs.filter(p =>
        p.volume24h > 100000 &&
        p.priceChange24h > 30 &&
        p.buys24h > p.sells24h * 2
      );

      if (explosive.length > 0) {
        let msg2 = 'SINYAL KUAT TERDETEKSI!

';
        explosive.slice(0, 2).forEach(t => {
          msg2 += 'Token: ' + t.symbol + '
';
          msg2 += 'Naik: +' + t.priceChange24h.toFixed(2) + '% (24j)
';
          msg2 += 'Volume: ' + formatNumber(t.volume24h) + '
';
          msg2 += 'Buy ratio: ' + ((t.buys24h / (t.buys24h + t.sells24h)) * 100).toFixed(0) + '%
';
          msg2 += 'Chart: ' + t.dexUrl + '

';
        });
        msg2 += 'Mau beli? /buy ' + explosive[0].symbol;
        bot.sendMessage(chatId, msg2);
      }
    }
  } catch (e) {}
}

// Cek market alert setiap 15 menit
setInterval(checkMarketAlerts, 15 * 60 * 1000);

// ── STARTUP ──
async function startup() {
  // Load saved skills
  loadAlerts();
  const saved = loadSavedSkills();
  for (const s of saved) skills.set(s.name, { url: s.url, content: s.content, active: s.active });
  console.log('Skills loaded: ' + skills.size);

  // Resume auto trade jika sebelumnya aktif
  if (settings.autoTrade) {
    console.log('Resuming auto trade...');
    const intervalMs = (settings.autoTradeInterval || 30) * 60 * 1000;
    autoTradeTimer = setInterval(runAutoTrade, intervalMs);
  }

  app.listen(config.PORT, () => {
    console.log('HervBot running on port ' + config.PORT);
    console.log('Budget: $' + settings.maxBudgetPerTrade + ' | Auto: ' + settings.autoTrade);
  });
}

startup();
