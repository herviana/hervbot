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
const ALERTS_FILE = '/tmp/hervbot_alerts.json';

function loadSettings() {
  try { if (fs.existsSync(SETTINGS_FILE)) return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch (e) {}
  return { maxBudgetPerTrade: 0.1, slippage: 1, autoTrade: false, autoTradeInterval: 30 };
}
function saveSettings() { try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings)); } catch (e) {} }
function loadSavedSkills() { try { if (fs.existsSync(SKILLS_FILE)) return JSON.parse(fs.readFileSync(SKILLS_FILE, 'utf8')); } catch (e) {} return []; }
function saveSkills() { try { const l = []; for (const [n, s] of skills) l.push({ name: n, url: s.url, content: s.content, active: s.active }); fs.writeFileSync(SKILLS_FILE, JSON.stringify(l)); } catch (e) {} }
function loadTrades() { try { if (fs.existsSync(TRADES_FILE)) return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8')); } catch (e) {} return []; }
function saveTrades() { try { fs.writeFileSync(TRADES_FILE, JSON.stringify(tradeHistory)); } catch (e) {} }
function loadAlerts() { try { if (fs.existsSync(ALERTS_FILE)) { const d = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8')); for (const [k, v] of Object.entries(d)) priceAlerts.set(parseInt(k), v); } } catch (e) {} }
function saveAlerts() { try { const o = {}; for (const [k, v] of priceAlerts) o[k] = v; fs.writeFileSync(ALERTS_FILE, JSON.stringify(o)); } catch (e) {} }

const settings = loadSettings();
const pendingTrades = new Map();
const tradeHistory = loadTrades();
const priceAlerts = new Map();
const autoTradePositions = new Map();
let autoTradeTimer = null;
let autoTradeChatId = null;

function cleanText(text) {
  return text.replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1').replace(/__(.*?)__/g, '$1').replace(/_(.*?)_/g, '$1').replace(/`{3}[\s\S]*?`{3}/g, '').replace(/`(.*?)`/g, '$1').replace(/#{1,6} /g, '').trim();
}
function formatNumber(num) {
  if (!num) return '$0';
  if (num >= 1e9) return '$' + (num/1e9).toFixed(2) + 'B';
  if (num >= 1e6) return '$' + (num/1e6).toFixed(2) + 'M';
  if (num >= 1e3) return '$' + (num/1e3).toFixed(2) + 'K';
  return '$' + num.toFixed(2);
}

// ── DEXSCREENER ──
async function getDexScreenerData(symbol) {
  try {
    const s = symbol.replace('$','');
    const res = await fetch('https://api.dexscreener.com/latest/dex/search?q=' + s);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.pairs || !data.pairs.length) return null;
    const pairs = data.pairs.filter(p => p.chainId === 'solana');
    const p = (pairs.length ? pairs : data.pairs).sort((a,b) => (b.volume?.h24||0)-(a.volume?.h24||0))[0];
    return { symbol: p.baseToken?.symbol||s, name: p.baseToken?.name||s, address: p.baseToken?.address, price: parseFloat(p.priceUsd||0), priceChange1h: p.priceChange?.h1||0, priceChange24h: p.priceChange?.h24||0, volume24h: p.volume?.h24||0, liquidity: p.liquidity?.usd||0, marketCap: p.marketCap||0, buys24h: p.txns?.h24?.buys||0, sells24h: p.txns?.h24?.sells||0, chainId: p.chainId, dexId: p.dexId, dexUrl: p.url };
  } catch (e) { return null; }
}
async function getDexScreenerByAddress(address) {
  try {
    const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + address);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.pairs || !data.pairs.length) return null;
    const p = data.pairs[0];
    return { symbol: p.baseToken?.symbol, name: p.baseToken?.name, address: p.baseToken?.address, price: parseFloat(p.priceUsd||0), priceChange1h: p.priceChange?.h1||0, priceChange24h: p.priceChange?.h24||0, volume24h: p.volume?.h24||0, liquidity: p.liquidity?.usd||0, buys24h: p.txns?.h24?.buys||0, sells24h: p.txns?.h24?.sells||0, chainId: p.chainId, dexUrl: p.url };
  } catch (e) { return null; }
}
async function getTrendingTokens() {
  try {
    const res = await fetch('https://api.dexscreener.com/token-boosts/top/v1');
    if (!res.ok) return [];
    const data = await res.json();
    const results = [];
    for (const t of data.slice(0,5)) { if (t.tokenAddress) { const d = await getDexScreenerByAddress(t.tokenAddress); if (d) results.push(d); } }
    return results;
  } catch (e) { return []; }
}
async function getSolanaNewPairs() {
  try {
    const res = await fetch('https://api.dexscreener.com/latest/dex/pairs/solana');
    if (!res.ok) return [];
    const data = await res.json();
    if (!data.pairs) return [];
    return data.pairs.filter(p => p.liquidity?.usd > 5000 && p.volume?.h24 > 1000).sort((a,b) => (b.volume?.h24||0)-(a.volume?.h24||0)).slice(0,5).map(p => ({ symbol: p.baseToken?.symbol, name: p.baseToken?.name, address: p.baseToken?.address, price: parseFloat(p.priceUsd||0), priceChange24h: p.priceChange?.h24||0, volume24h: p.volume?.h24||0, liquidity: p.liquidity?.usd||0, buys24h: p.txns?.h24?.buys||0, sells24h: p.txns?.h24?.sells||0, dexUrl: p.url }));
  } catch (e) { return []; }
}

// ── SOLANA ──
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_API = 'https://quote-api.jup.ag/v6';

async function getSolPrice() {
  try { const r = await fetch('https://price.jup.ag/v4/price?ids=' + SOL_MINT); const d = await r.json(); return d.data[SOL_MINT]?.price||0; } catch (e) { return 0; }
}
async function getWalletBalance(pk) {
  try {
    const r = await fetch(config.SOLANA_RPC, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({jsonrpc:'2.0',id:1,method:'getBalance',params:[pk]}) });
    const d = await r.json();
    const sol = (d.result?.value||0)/1e9;
    const sp = await getSolPrice();
    return { sol: sol.toFixed(4), usd: (sol*sp).toFixed(2) };
  } catch (e) { return {sol:'0',usd:'0'}; }
}
async function getPublicKeyFromPrivate(pk) {
  try {
    const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let n = BigInt(0);
    for (const c of pk) { const i = A.indexOf(c); if (i<0) throw new Error('bad'); n = n*BigInt(58)+BigInt(i); }
    let h = n.toString(16); if (h.length%2) h='0'+h;
    const b = new Uint8Array(h.match(/.{2}/g).map(x=>parseInt(x,16)));
    if (b.length>=64) {
      const pub = b.slice(32,64);
      let m = BigInt('0x'+Array.from(pub).map(x=>x.toString(16).padStart(2,'0')).join(''));
      let r = ''; while (m>0) { r=A[Number(m%BigInt(58))]+r; m=m/BigInt(58); }
      for (let i=0;i<pub.length&&pub[i]===0;i++) r='1'+r;
      return r;
    }
    return null;
  } catch (e) { return null; }
}
async function getQuote(i, o, a) {
  try {
    const u = JUPITER_API+'/quote?inputMint='+i+'&outputMint='+o+'&amount='+a+'&slippageBps='+(settings.slippage*100);
    const r = await fetch(u); if (!r.ok) throw new Error(await r.text());
    return {success:true, quote: await r.json()};
  } catch (e) { return {success:false, error:e.message}; }
}
async function executeSwap(quoteResponse, publicKey) {
  try {
    const sr = await fetch(JUPITER_API+'/swap', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ quoteResponse, userPublicKey: publicKey, wrapAndUnwrapSol:true, dynamicComputeUnitLimit:true, prioritizationFeeLamports:'auto' }) });
    if (!sr.ok) throw new Error(await sr.text());
    const {swapTransaction} = await sr.json();
    const {Connection, VersionedTransaction, Keypair} = await import('@solana/web3.js');
    const bs58 = (await import('bs58')).default;
    const conn = new Connection(config.SOLANA_RPC, 'confirmed');
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction,'base64'));
    const kp = Keypair.fromSecretKey(bs58.decode(config.WALLET_PRIVATE_KEY));
    tx.sign([kp]);
    const txid = await conn.sendRawTransaction(tx.serialize(), {skipPreflight:true, maxRetries:3});
    const conf = await conn.confirmTransaction(txid, 'confirmed');
    if (conf.value?.err) throw new Error('TX failed: '+JSON.stringify(conf.value.err));
    return {success:true, txid};
  } catch (e) { return {success:false, error:e.message}; }
}

// ── AUTO TRADE ──
async function analyzeForAutoTrade() {
  try {
    const pairs = await getSolanaNewPairs();
    return pairs.find(p => { const br = p.buys24h/(p.buys24h+p.sells24h+1); return p.volume24h>10000 && p.liquidity>10000 && br>0.6 && p.priceChange24h>5; }) || null;
  } catch (e) { return null; }
}
async function checkAutoTradePositions() {
  for (const [addr, pos] of autoTradePositions) {
    const d = await getDexScreenerByAddress(addr);
    if (!d) continue;
    const pnl = ((d.price-pos.entryPrice)/pos.entryPrice)*100;
    if (pnl>=15||pnl<=-7) {
      const action = pnl>=15 ? 'TAKE PROFIT' : 'STOP LOSS';
      if (autoTradeChatId) bot.sendMessage(autoTradeChatId, action+' Triggered!\n\nToken: '+pos.symbol+'\nEntry: $'+pos.entryPrice.toFixed(8)+'\nSekarang: $'+d.price.toFixed(8)+'\nPnL: '+(pnl>=0?'+':'')+pnl.toFixed(2)+'%\n\nMengeksekusi sell...');
      const pk = await getPublicKeyFromPrivate(config.WALLET_PRIVATE_KEY);
      const q = await getQuote(addr, SOL_MINT, Math.floor(pos.tokenAmount*1e6));
      if (q.success) {
        const res = await executeSwap(q.quote, pk);
        if (autoTradeChatId) {
          if (res.success) { bot.sendMessage(autoTradeChatId, 'Sell berhasil!\nPnL: '+(pnl>=0?'+':'')+pnl.toFixed(2)+'%\nTX: solscan.io/tx/'+res.txid); tradeHistory.push({type:'sell',symbol:pos.symbol,pnl,txid:res.txid,time:new Date().toISOString()}); saveTrades(); }
          else bot.sendMessage(autoTradeChatId, 'Sell gagal: '+res.error);
        }
      }
      autoTradePositions.delete(addr);
    }
  }
}
async function runAutoTrade() {
  if (!settings.autoTrade||!autoTradeChatId) return;
  await checkAutoTradePositions();
  if (autoTradePositions.size>=3) return;
  const sig = await analyzeForAutoTrade();
  if (!sig||autoTradePositions.has(sig.address)) return;
  const pk = await getPublicKeyFromPrivate(config.WALLET_PRIVATE_KEY);
  if (!pk) return;
  const sp = await getSolPrice();
  const lam = Math.floor((settings.maxBudgetPerTrade/sp)*1e9);
  const q = await getQuote(SOL_MINT, sig.address, lam);
  if (!q.success) return;
  const out = q.quote.outAmount/1e6;
  bot.sendMessage(autoTradeChatId, 'Auto Trade - Sinyal!\n\nToken: '+sig.symbol+'\nHarga: $'+sig.price.toFixed(8)+'\nVolume: '+formatNumber(sig.volume24h)+'\nBuy ratio: '+((sig.buys24h/(sig.buys24h+sig.sells24h))*100).toFixed(0)+'%\n\nBuy $'+settings.maxBudgetPerTrade+'...');
  const res = await executeSwap(q.quote, pk);
  if (res.success) {
    autoTradePositions.set(sig.address, {symbol:sig.symbol, entryPrice:sig.price, tokenAmount:out, amountUSD:settings.maxBudgetPerTrade, buyTime:new Date().toISOString(), txid:res.txid});
    tradeHistory.push({type:'buy',symbol:sig.symbol,price:sig.price,amountUSD:settings.maxBudgetPerTrade,txid:res.txid,time:new Date().toISOString()}); saveTrades();
    bot.sendMessage(autoTradeChatId, 'Buy Berhasil!\n\nToken: '+sig.symbol+'\nDapat: '+out.toFixed(4)+' '+sig.symbol+'\nEntry: $'+sig.price.toFixed(8)+'\nTP: +15% | SL: -7%\nTX: solscan.io/tx/'+res.txid);
  } else bot.sendMessage(autoTradeChatId, 'Auto buy gagal: '+res.error);
}
function startAutoTrade(chatId) {
  autoTradeChatId = chatId; settings.autoTrade = true; saveSettings();
  if (autoTradeTimer) clearInterval(autoTradeTimer);
  autoTradeTimer = setInterval(runAutoTrade, (settings.autoTradeInterval||30)*60*1000);
  runAutoTrade();
}
function stopAutoTrade() {
  settings.autoTrade = false; saveSettings();
  if (autoTradeTimer) { clearInterval(autoTradeTimer); autoTradeTimer = null; }
}

// ── PRICE ALERTS ──
function addAlert(chatId, symbol, condition, targetPrice) {
  if (!priceAlerts.has(chatId)) priceAlerts.set(chatId, []);
  priceAlerts.get(chatId).push({symbol:symbol.toUpperCase(), condition, targetPrice, active:true, createdAt:new Date().toISOString()});
  saveAlerts();
}
async function checkPriceAlerts() {
  for (const [chatId, alerts] of priceAlerts) {
    const active = alerts.filter(a => a.active);
    if (!active.length) continue;
    const symbols = [...new Set(active.map(a => a.symbol))];
    for (const sym of symbols) {
      const d = await getDexScreenerData(sym);
      if (!d) continue;
      for (const alert of active.filter(a => a.symbol === sym)) {
        let triggered = false, msg2 = '';
        if (alert.condition==='above'&&d.price>=alert.targetPrice) { triggered=true; msg2='NAIK MELEWATI TARGET!'; }
        else if (alert.condition==='below'&&d.price<=alert.targetPrice) { triggered=true; msg2='TURUN KE BAWAH TARGET!'; }
        else if (alert.condition==='change_up'&&d.priceChange1h>=alert.targetPrice) { triggered=true; msg2='NAIK '+d.priceChange1h.toFixed(2)+'% dalam 1 jam!'; }
        else if (alert.condition==='change_down'&&d.priceChange1h<=-alert.targetPrice) { triggered=true; msg2='TURUN '+Math.abs(d.priceChange1h).toFixed(2)+'% dalam 1 jam!'; }
        if (triggered) {
          alert.active = false; saveAlerts();
          const ps = d.price<0.001?d.price.toFixed(8):d.price.toFixed(6);
          bot.sendMessage(chatId, 'ALERT - '+sym+'\n\n'+msg2+'\nHarga: $'+ps+'\nTarget: $'+alert.targetPrice+'\nPerubahan 1j: '+(d.priceChange1h>=0?'+':'')+d.priceChange1h.toFixed(2)+'%\nVolume: '+formatNumber(d.volume24h)+'\n\nMau beli? /buy '+sym+' '+settings.maxBudgetPerTrade);
        }
      }
    }
  }
}
async function checkMarketAlerts() {
  try {
    const pairs = await getSolanaNewPairs();
    const explosive = pairs.filter(p => p.volume24h>100000&&p.priceChange24h>30&&p.buys24h>p.sells24h*2);
    if (!explosive.length) return;
    for (const [chatId] of priceAlerts) {
      let msg2 = 'SINYAL KUAT TERDETEKSI!\n\n';
      explosive.slice(0,2).forEach(t => { msg2+='Token: '+t.symbol+'\nNaik: +'+t.priceChange24h.toFixed(2)+'%\nVolume: '+formatNumber(t.volume24h)+'\nBuy ratio: '+((t.buys24h/(t.buys24h+t.sells24h))*100).toFixed(0)+'%\n\n'; });
      msg2 += 'Mau beli? /buy '+explosive[0].symbol;
      bot.sendMessage(chatId, msg2);
    }
  } catch (e) {}
}
setInterval(checkPriceAlerts, 5*60*1000);
setInterval(checkMarketAlerts, 15*60*1000);

// ── SKILLS & GITHUB ──
const skills = new Map();
async function loadSkill(githubUrl) {
  try {
    let url = githubUrl.trim().replace(/\/$/, '').replace('https://','').replace('http://','');
    const parts = url.replace('github.com/','').split('/');
    if (!parts[0]||!parts[1]) throw new Error('Format URL tidak valid');
    let content = null;
    for (const branch of ['main','master']) { try { const r=await fetch('https://raw.githubusercontent.com/'+parts[0]+'/'+parts[1]+'/'+branch+'/SKILL.md'); if (r.ok) { content=await r.text(); break; } } catch (e) {} }
    if (!content) throw new Error('SKILL.md tidak ditemukan');
    const nm = content.match(/name:\s*(.+)/i);
    const name = nm?nm[1].trim():parts[1];
    skills.set(name, {url:'https://github.com/'+parts[0]+'/'+parts[1], content, active:true});
    saveSkills();
    return {success:true, name};
  } catch (e) { return {success:false, error:e.message}; }
}
async function githubPushFile(repoName, filePath, content, msg2) {
  try {
    const {GITHUB_TOKEN:tok, GITHUB_USERNAME:own} = config;
    if (!tok) throw new Error('GITHUB_TOKEN belum diset');
    const check = await fetch('https://api.github.com/repos/'+own+'/'+repoName, {headers:{'Authorization':'Bearer '+tok,'Accept':'application/vnd.github.v3+json'}});
    if (!check.ok) {
      const cr = await fetch('https://api.github.com/user/repos', {method:'POST',headers:{'Authorization':'Bearer '+tok,'Accept':'application/vnd.github.v3+json','Content-Type':'application/json'},body:JSON.stringify({name:repoName,private:false,auto_init:true})});
      if (!cr.ok) throw new Error('Gagal buat repo');
      await new Promise(r=>setTimeout(r,2000));
    }
    let sha = null;
    const fc = await fetch('https://api.github.com/repos/'+own+'/'+repoName+'/contents/'+filePath, {headers:{'Authorization':'Bearer '+tok,'Accept':'application/vnd.github.v3+json'}});
    if (fc.ok) sha = (await fc.json()).sha;
    const body = {message:msg2||'Update via HervBot', content:Buffer.from(content).toString('base64')};
    if (sha) body.sha = sha;
    const pr = await fetch('https://api.github.com/repos/'+own+'/'+repoName+'/contents/'+filePath, {method:'PUT',headers:{'Authorization':'Bearer '+tok,'Accept':'application/vnd.github.v3+json','Content-Type':'application/json'},body:JSON.stringify(body)});
    if (!pr.ok) throw new Error('Push gagal: '+await pr.text());
    return {success:true, url:'https://github.com/'+own+'/'+repoName};
  } catch (e) { return {success:false, error:e.message}; }
}
async function searchGithubSkills(keyword) {
  try {
    const tok = config.GITHUB_TOKEN;
    const r = await fetch('https://api.github.com/search/repositories?q='+encodeURIComponent(keyword+' skill trading crypto')+'&sort=stars&order=desc&per_page=8', {headers:{'Authorization':'Bearer '+tok,'Accept':'application/vnd.github.v3+json','User-Agent':'HervBot'}});
    if (!r.ok) throw new Error('Search gagal');
    const d = await r.json();
    if (!d.items||!d.items.length) return {success:true, results:[]};
    const results = [];
    for (const repo of d.items.slice(0,5)) {
      const sc = await fetch('https://raw.githubusercontent.com/'+repo.full_name+'/main/SKILL.md');
      results.push({name:repo.name, url:repo.html_url, description:(repo.description||'-').slice(0,80), stars:repo.stargazers_count, hasSkill:sc.ok});
    }
    return {success:true, results};
  } catch (e) { return {success:false, error:e.message}; }
}

// ── AI CHAT ──
const conversations = new Map();
async function chat(userId, userMessage, extraContext) {
  if (!conversations.has(userId)) conversations.set(userId, []);
  const history = conversations.get(userId);
  history.push({role:'user', content:userMessage});
  if (history.length>20) history.splice(0,history.length-20);
  let sc = '';
  for (const [n, s] of skills) if (s.active) sc += '\nSKILL '+n+':\n'+s.content.slice(0,800);
  const sys = 'Kamu adalah HervBot, AI trading agent crypto dengan data real-time DexScreener dan transaksi nyata Solana via Jupiter DEX.\nSettings: Budget $'+settings.maxBudgetPerTrade+', Slippage '+settings.slippage+'%, Auto Trade: '+(settings.autoTrade?'ON':'OFF')+(sc?'\n\nSkill aktif:\n'+sc:'')+(extraContext?'\n\nData Real-time:\n'+extraContext:'')+'\n\nJangan mengarang URL GitHub. Untuk cari skill pakai /cari [keyword]. Jangan Markdown. Teks biasa. Bahasa Indonesia santai.';
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+config.GROQ_API_KEY},body:JSON.stringify({model:'llama-3.3-70b-versatile',max_tokens:800,messages:[{role:'system',content:sys},...history]})});
    if (!r.ok) throw new Error(await r.text());
    const d = await r.json();
    const reply = cleanText(d.choices[0].message.content);
    history.push({role:'assistant', content:reply});
    return reply;
  } catch (e) { return 'Error: '+e.message; }
}

// ── TELEGRAM HANDLERS ──
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, 'HervBot - AI Trading Agent Solana\n\nTrading:\n/buy [token] [USD]\n/sell [token] [USD]\n/swap [dari] [ke] [USD]\n/harga [token]\n/saldo\n\nAuto Trade:\n/autoon - Aktifkan\n/autooff - Matikan\n/posisi - Posisi aktif\n/laporan - Riwayat\n\nAlert:\n/alert [token] above/below/change_up/change_down [nilai]\n/alerts - Lihat alert\n/clearalerts - Hapus alert\n\nAnalisis:\n/scan\n/scalping\n/trending\n\nPengaturan:\n/budget [angka]\n/slippage [angka]\n/interval [menit]\n\nSkills:\n/skills\n/cari [keyword]\n/install [url]\n/github_push [repo] [url]\n\nBudget: $'+settings.maxBudgetPerTrade+' | Auto: '+(settings.autoTrade?'ON':'OFF'));
});

bot.onText(/\/autoon/, async (msg) => {
  const chatId = msg.chat.id;
  const pk = await getPublicKeyFromPrivate(config.WALLET_PRIVATE_KEY);
  if (!pk) { bot.sendMessage(chatId, 'Gagal baca wallet.'); return; }
  const bal = await getWalletBalance(pk);
  if (parseFloat(bal.usd) < settings.maxBudgetPerTrade) { bot.sendMessage(chatId, 'Saldo tidak cukup!\nSaldo: $'+bal.usd+'\nBudget: $'+settings.maxBudgetPerTrade+'\n\nIsi saldo dulu!'); return; }
  startAutoTrade(chatId);
  bot.sendMessage(chatId, 'Auto Trade AKTIF!\n\nBudget: $'+settings.maxBudgetPerTrade+'\nInterval: '+(settings.autoTradeInterval||30)+' menit\nTP: +15% | SL: -7%\nMax posisi: 3\n\nBot akan otomatis beli/jual berdasarkan sinyal DexScreener.');
});
bot.onText(/\/autooff/, (msg) => { stopAutoTrade(); bot.sendMessage(msg.chat.id, 'Auto Trade DIMATIKAN.'); });
bot.onText(/\/posisi/, async (msg) => {
  const chatId = msg.chat.id;
  if (!autoTradePositions.size) { bot.sendMessage(chatId, 'Tidak ada posisi aktif.'); return; }
  let m = 'Posisi Aktif ('+autoTradePositions.size+'):\n\n';
  for (const [addr, pos] of autoTradePositions) {
    const d = await getDexScreenerByAddress(addr);
    const cp = d?.price||pos.entryPrice;
    const pnl = ((cp-pos.entryPrice)/pos.entryPrice)*100;
    m += 'Token: '+pos.symbol+'\nEntry: $'+pos.entryPrice.toFixed(8)+'\nSekarang: $'+cp.toFixed(8)+'\nPnL: '+(pnl>=0?'+':'')+pnl.toFixed(2)+'%\nModal: $'+pos.amountUSD+'\n\n';
  }
  bot.sendMessage(chatId, m);
});
bot.onText(/\/laporan/, (msg) => {
  const chatId = msg.chat.id;
  if (!tradeHistory.length) { bot.sendMessage(chatId, 'Belum ada riwayat.'); return; }
  const sells = tradeHistory.filter(t=>t.type==='sell');
  const wins = sells.filter(t=>t.pnl>0).length;
  const totalPnl = sells.reduce((s,t)=>s+(t.pnl||0),0);
  let m = 'Laporan Trading:\n\nTotal: '+tradeHistory.length+'\nBuy: '+tradeHistory.filter(t=>t.type==='buy').length+' | Sell: '+sells.length+'\nWin rate: '+(sells.length?((wins/sells.length)*100).toFixed(0):0)+'%\nTotal PnL: '+(totalPnl>=0?'+':'')+totalPnl.toFixed(2)+'%\n\nTerakhir:\n';
  tradeHistory.slice(-5).reverse().forEach(t => { m += t.type.toUpperCase()+' '+t.symbol+(t.pnl?' '+(t.pnl>=0?'+':'')+t.pnl.toFixed(2)+'%':'')+'\n'; });
  bot.sendMessage(chatId, m);
});
bot.onText(/\/interval (.+)/, (msg, match) => {
  const mins = parseInt(match[1]);
  if (isNaN(mins)||mins<5) { bot.sendMessage(msg.chat.id, 'Min 5 menit. Contoh: /interval 30'); return; }
  settings.autoTradeInterval = mins; saveSettings();
  if (settings.autoTrade&&autoTradeTimer) { clearInterval(autoTradeTimer); autoTradeTimer=setInterval(runAutoTrade,mins*60*1000); }
  bot.sendMessage(msg.chat.id, 'Interval: '+mins+' menit');
});
bot.onText(/\/budget (.+)/, (msg, match) => {
  const a = parseFloat(match[1]);
  if (isNaN(a)||a<=0) { bot.sendMessage(msg.chat.id, 'Contoh: /budget 0.5'); return; }
  settings.maxBudgetPerTrade=a; saveSettings(); bot.sendMessage(msg.chat.id, 'Budget: $'+a);
});
bot.onText(/\/slippage (.+)/, (msg, match) => {
  const s = parseFloat(match[1]);
  if (isNaN(s)||s<=0||s>50) { bot.sendMessage(msg.chat.id, 'Contoh: /slippage 1'); return; }
  settings.slippage=s; saveSettings(); bot.sendMessage(msg.chat.id, 'Slippage: '+s+'%');
});
bot.onText(/\/saldo/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Mengecek saldo...');
  const pk = await getPublicKeyFromPrivate(config.WALLET_PRIVATE_KEY);
  if (!pk) { bot.sendMessage(chatId, 'Gagal baca wallet.'); return; }
  const bal = await getWalletBalance(pk);
  bot.sendMessage(chatId, 'Saldo Wallet:\n\nSOL: '+bal.sol+'\nUSD: ~$'+bal.usd+'\n\nAlamat: '+pk.slice(0,6)+'...'+pk.slice(-6));
});
bot.onText(/\/harga (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Mengambil data real-time...');
  const d = await getDexScreenerData(match[1].trim());
  if (!d) { bot.sendMessage(chatId, 'Token tidak ditemukan.'); return; }
  const ps = d.price<0.001?d.price.toFixed(8):d.price<1?d.price.toFixed(6):d.price.toFixed(4);
  bot.sendMessage(chatId, 'Data Real-time '+d.symbol+':\n\nHarga: $'+ps+'\nPerubahan 1j: '+(d.priceChange1h>=0?'+':'')+d.priceChange1h.toFixed(2)+'%\nPerubahan 24j: '+(d.priceChange24h>=0?'+':'')+d.priceChange24h.toFixed(2)+'%\nVolume 24j: '+formatNumber(d.volume24h)+'\nLikuiditas: '+formatNumber(d.liquidity)+'\nBuy/Sell: '+d.buys24h+'/'+d.sells24h+'\nChain: '+d.chainId+'\n\nChart: '+d.dexUrl);
});
bot.onText(/\/buy (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const [sym, amt] = match[1].trim().split(' ');
  const usd = parseFloat(amt)||settings.maxBudgetPerTrade;
  if (usd>settings.maxBudgetPerTrade) { bot.sendMessage(chatId, 'Melebihi budget $'+settings.maxBudgetPerTrade); return; }
  bot.sendMessage(chatId, 'Mencari '+sym+'...');
  const td = await getDexScreenerData(sym);
  if (!td||!td.address) { bot.sendMessage(chatId, 'Token tidak ditemukan.'); return; }
  const sp = await getSolPrice();
  if (!sp) { bot.sendMessage(chatId, 'Gagal ambil harga SOL.'); return; }
  const lam = Math.floor((usd/sp)*1e9);
  const q = await getQuote(SOL_MINT, td.address, lam);
  if (!q.success) { bot.sendMessage(chatId, 'Gagal quote: '+q.error); return; }
  const out = q.quote.outAmount/1e6;
  pendingTrades.set(chatId, {type:'buy',token:td,amountUSD:usd,lamports:lam,outAmount:out,quote:q.quote});
  bot.sendMessage(chatId, 'Konfirmasi Buy:\n\nToken: '+td.symbol+'\nBayar: $'+usd+' ('+(usd/sp).toFixed(4)+' SOL)\nDapat: ~'+out.toFixed(4)+' '+td.symbol+'\nHarga: $'+td.price.toFixed(8)+'\nSlippage: '+settings.slippage+'%\n\n/ya - Eksekusi\n/tidak - Batal');
});
bot.onText(/\/ya/, async (msg) => {
  const chatId = msg.chat.id;
  const p = pendingTrades.get(chatId);
  if (!p) { bot.sendMessage(chatId, 'Tidak ada transaksi pending.'); return; }
  pendingTrades.delete(chatId);
  bot.sendMessage(chatId, 'Mengeksekusi transaksi...');
  const pk = await getPublicKeyFromPrivate(config.WALLET_PRIVATE_KEY);
  if (!pk) { bot.sendMessage(chatId, 'Gagal baca wallet.'); return; }
  const res = await executeSwap(p.quote, pk);
  if (res.success) { tradeHistory.push({type:p.type,symbol:p.token.symbol,amountUSD:p.amountUSD,txid:res.txid,time:new Date().toISOString()}); saveTrades(); bot.sendMessage(chatId, 'Transaksi BERHASIL!\n\nToken: '+p.token.symbol+'\nJumlah: ~'+p.outAmount.toFixed(4)+' '+p.token.symbol+'\n\nTX: '+res.txid+'\nCek: solscan.io/tx/'+res.txid); }
  else bot.sendMessage(chatId, 'Transaksi GAGAL:\n'+res.error);
});
bot.onText(/\/tidak/, (msg) => { pendingTrades.delete(msg.chat.id); bot.sendMessage(msg.chat.id, 'Dibatalkan.'); });
bot.onText(/\/sell (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const [sym, amt] = match[1].trim().split(' ');
  const usd = parseFloat(amt)||settings.maxBudgetPerTrade;
  const td = await getDexScreenerData(sym);
  if (!td||!td.address) { bot.sendMessage(chatId, 'Token tidak ditemukan.'); return; }
  const tl = Math.floor((usd/td.price)*1e6);
  const q = await getQuote(td.address, SOL_MINT, tl);
  if (!q.success) { bot.sendMessage(chatId, 'Gagal quote: '+q.error); return; }
  const so = q.quote.outAmount/1e9;
  const sp = await getSolPrice();
  pendingTrades.set(chatId, {type:'sell',token:td,amountUSD:usd,tokenLamports:tl,solOut:so,quote:q.quote});
  bot.sendMessage(chatId, 'Konfirmasi Sell:\n\nJual: '+(usd/td.price).toFixed(4)+' '+td.symbol+'\nDapat: ~'+so.toFixed(4)+' SOL (~$'+(so*sp).toFixed(2)+')\n\n/ya - Eksekusi\n/tidak - Batal');
});
bot.onText(/\/swap (.+) (.+) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const [fs2, ts2, au] = [match[1], match[2], parseFloat(match[3])||settings.maxBudgetPerTrade];
  const fd = fs2.toUpperCase()==='SOL'?{address:SOL_MINT,symbol:'SOL',price:await getSolPrice()}:await getDexScreenerData(fs2);
  const td = ts2.toUpperCase()==='SOL'?{address:SOL_MINT,symbol:'SOL'}:await getDexScreenerData(ts2);
  if (!fd||!td) { bot.sendMessage(chatId, 'Token tidak ditemukan.'); return; }
  const fl = Math.floor((au/fd.price)*(fs2.toUpperCase()==='SOL'?1e9:1e6));
  const q = await getQuote(fd.address, td.address, fl);
  if (!q.success) { bot.sendMessage(chatId, 'Gagal quote: '+q.error); return; }
  const ta = q.quote.outAmount/(ts2.toUpperCase()==='SOL'?1e9:1e6);
  pendingTrades.set(chatId, {type:'swap',token:td,fromData:fd,amountUSD:au,toAmount:ta,quote:q.quote});
  bot.sendMessage(chatId, 'Konfirmasi Swap:\n\nDari: '+(au/fd.price).toFixed(4)+' '+fd.symbol+'\nKe: ~'+ta.toFixed(4)+' '+(td.symbol||ts2)+'\n\n/ya - Eksekusi\n/tidak - Batal');
});
bot.onText(/\/scan/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Scanning token potensial...');
  const pairs = await getSolanaNewPairs();
  let m = 'Token Potensial Solana:\n\n';
  if (!pairs.length) m += 'Tidak ada token memenuhi filter saat ini.';
  else pairs.forEach((t,i) => { m+=(i+1)+'. '+t.symbol+' ('+t.name+')\nHarga: $'+(t.price<0.001?t.price.toFixed(8):t.price.toFixed(4))+' ('+(t.priceChange24h>=0?'+':'')+t.priceChange24h.toFixed(2)+'%)\nVolume: '+formatNumber(t.volume24h)+' | Liq: '+formatNumber(t.liquidity)+'\nBuy ratio: '+((t.buys24h/(t.buys24h+t.sells24h+1))*100).toFixed(0)+'%\nChart: '+t.dexUrl+'\n\n'; });
  bot.sendMessage(chatId, m);
  const reply = await chat(chatId, 'Analisis token potensial ini dan berikan rekomendasi.', JSON.stringify(pairs.slice(0,3)));
  bot.sendMessage(chatId, 'Analisis AI:\n\n'+reply);
});
bot.onText(/\/scalping/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Mencari peluang scalping...');
  const pairs = await getSolanaNewPairs();
  const reply = await chat(chatId, 'Cari peluang scalping terbaik. Entry, target 5-10%, stop loss.', JSON.stringify(pairs.slice(0,3)));
  bot.sendMessage(chatId, reply);
});
bot.onText(/\/trending/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Mengambil trending...');
  const tr = await getTrendingTokens();
  if (!tr.length) { bot.sendMessage(chatId, 'Gagal ambil trending.'); return; }
  let m = 'Token Trending:\n\n';
  tr.forEach((t,i) => { m+=(i+1)+'. '+(t.symbol||'?')+'\nHarga: $'+(t.price<0.001?t.price.toFixed(8):t.price.toFixed(4))+' ('+(t.priceChange24h>=0?'+':'')+t.priceChange24h.toFixed(2)+'%)\nVolume: '+formatNumber(t.volume24h)+'\n\n'; });
  bot.sendMessage(chatId, m);
});
bot.onText(/\/alert (.+) (.+) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const sym = match[1].trim().toUpperCase();
  const cond = match[2].trim().toLowerCase();
  const tp = parseFloat(match[3]);
  if (isNaN(tp)) { bot.sendMessage(chatId, 'Contoh:\n/alert BONK above 0.00005\n/alert SOL below 100\n/alert WIF change_up 10\n/alert SOL change_down 5'); return; }
  if (!['above','below','change_up','change_down'].includes(cond)) { bot.sendMessage(chatId, 'Kondisi: above, below, change_up, change_down'); return; }
  const d = await getDexScreenerData(sym);
  if (!d) { bot.sendMessage(chatId, 'Token '+sym+' tidak ditemukan.'); return; }
  addAlert(chatId, sym, cond, tp);
  const ct = {above:'naik di atas $'+tp, below:'turun di bawah $'+tp, change_up:'naik '+tp+'%/1j', change_down:'turun '+tp+'%/1j'};
  const ps = d.price<0.001?d.price.toFixed(8):d.price.toFixed(6);
  bot.sendMessage(chatId, 'Alert dibuat!\n\nToken: '+sym+'\nHarga sekarang: $'+ps+'\nNotifikasi kalau: '+ct[cond]+'\n\nCek: /alerts');
});
bot.onText(/\/alerts/, (msg) => {
  const chatId = msg.chat.id;
  const active = (priceAlerts.get(chatId)||[]).filter(a=>a.active);
  if (!active.length) { bot.sendMessage(chatId, 'Tidak ada alert aktif.\n\nCara buat:\n/alert BONK above 0.00005\n/alert SOL below 100\n/alert WIF change_up 10'); return; }
  let m = 'Alert Aktif ('+active.length+'):\n\n';
  const ct = {above:'Naik >$',below:'Turun <$',change_up:'Naik ',change_down:'Turun '};
  active.forEach((a,i) => { m+=(i+1)+'. '+a.symbol+' - '+(ct[a.condition]||a.condition)+a.targetPrice+(a.condition.includes('change')?'%/1j':'')+'\n'; });
  m += '\n/clearalerts - Hapus semua';
  bot.sendMessage(chatId, m);
});
bot.onText(/\/clearalerts/, (msg) => { priceAlerts.set(msg.chat.id,[]); saveAlerts(); bot.sendMessage(msg.chat.id, 'Semua alert dihapus.'); });
bot.onText(/\/skills/, (msg) => {
  const chatId = msg.chat.id;
  if (!skills.size) { bot.sendMessage(chatId, 'Belum ada skill.\n/install https://github.com/username/repo'); return; }
  let m = 'Skill aktif ('+skills.size+'):\n\n';
  for (const [n,s] of skills) m+='AKTIF - '+n+'\n'+s.url+'\n\n';
  bot.sendMessage(chatId, m);
});
bot.onText(/\/cari (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Mencari skill di GitHub...');
  const res = await searchGithubSkills(match[1].trim());
  if (!res.success) { bot.sendMessage(chatId, 'Gagal: '+res.error); return; }
  if (!res.results.length) { bot.sendMessage(chatId, 'Tidak ada skill ditemukan.'); return; }
  let m = 'Hasil pencarian:\n\n';
  res.results.forEach((r,i) => { m+=(i+1)+'. '+r.name+'\nURL: '+r.url+'\nDeskripsi: '+r.description+'\nStars: '+r.stars+' | SKILL.md: '+(r.hasSkill?'Ada':'Tidak ada')+'\n\n'; });
  m += 'Install: /install [url]\nDuplikat: /github_push [nama] [url]';
  bot.sendMessage(chatId, m);
});
bot.onText(/\/install (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Menginstall skill...');
  const res = await loadSkill(match[1].trim());
  bot.sendMessage(chatId, res.success?'Skill '+res.name+' berhasil diinstall!':'Gagal: '+res.error);
});
bot.onText(/\/github_push (.+) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const [rn, su] = [match[1].trim(), match[2].trim()];
  bot.sendMessage(chatId, 'Menduplikat skill ke '+rn+'...');
  const parts = su.replace('https://','').replace('http://','').replace('github.com/','').split('/');
  const raw = await fetch('https://raw.githubusercontent.com/'+parts[0]+'/'+parts[1]+'/main/SKILL.md');
  if (!raw.ok) { bot.sendMessage(chatId, 'SKILL.md tidak ditemukan.'); return; }
  let content = await raw.text();
  content = content.replace(/author:\s*.+/gi, 'author: '+config.GITHUB_USERNAME);
  const pr = await githubPushFile(rn, 'SKILL.md', content, 'Duplicated via HervBot');
  if (!pr.success) { bot.sendMessage(chatId, 'Gagal push: '+pr.error); return; }
  await githubPushFile(rn, 'README.md', '# '+rn+'\n\nSkill HervBot.\nDuplikat dari: '+su, 'Add README');
  bot.sendMessage(chatId, 'Berhasil!\n\ngithub.com/'+config.GITHUB_USERNAME+'/'+rn+'\n\nInstall:\n/install https://github.com/'+config.GITHUB_USERNAME+'/'+rn);
});
bot.onText(/\/help/, (msg) => { bot.sendMessage(msg.chat.id, 'Perintah:\n/buy /sell /swap /harga /saldo\n/autoon /autooff /posisi /laporan\n/alert /alerts /clearalerts\n/scan /scalping /trending\n/budget /slippage /interval\n/skills /cari /install /github_push'); });
bot.on('message', async (msg) => { if (msg.text&&!msg.text.startsWith('/')) { bot.sendChatAction(msg.chat.id,'typing'); bot.sendMessage(msg.chat.id, await chat(msg.chat.id, msg.text)); } });

app.get('/health', (req, res) => res.json({status:'ok', skills:skills.size, settings, positions:autoTradePositions.size, alerts:[...priceAlerts.values()].flat().filter(a=>a.active).length}));

// ── STARTUP ──
async function startup() {
  loadAlerts();
  const saved = loadSavedSkills();
  for (const s of saved) skills.set(s.name, {url:s.url, content:s.content, active:s.active});
  console.log('Skills: '+skills.size+' | Alerts: '+[...priceAlerts.values()].flat().filter(a=>a.active).length);
  if (settings.autoTrade) { console.log('Resuming auto trade...'); autoTradeTimer = setInterval(runAutoTrade, (settings.autoTradeInterval||30)*60*1000); }
  app.listen(config.PORT, () => console.log('HervBot running on port '+config.PORT+' | Budget: $'+settings.maxBudgetPerTrade));
}
startup();
