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

// ── STORAGE ──
const SETTINGS_FILE = '/tmp/hervbot_settings.json';
const SKILLS_FILE = '/tmp/hervbot_skills.json';
const TRADES_FILE = '/tmp/hervbot_trades.json';
const ALERTS_FILE = '/tmp/hervbot_alerts.json';

function loadSettings() { try { if (fs.existsSync(SETTINGS_FILE)) return JSON.parse(fs.readFileSync(SETTINGS_FILE,'utf8')); } catch(e){} return {maxBudgetPerTrade:0.1,slippage:1,autoTrade:false,autoTradeInterval:30}; }
function saveSettings() { try { fs.writeFileSync(SETTINGS_FILE,JSON.stringify(settings)); } catch(e){} }
function loadSavedSkills() { try { if (fs.existsSync(SKILLS_FILE)) return JSON.parse(fs.readFileSync(SKILLS_FILE,'utf8')); } catch(e){} return []; }
function saveSkills() { try { const l=[]; for(const [n,s] of skills) l.push({name:n,url:s.url,content:s.content,active:s.active}); fs.writeFileSync(SKILLS_FILE,JSON.stringify(l)); } catch(e){} }
function loadTrades() { try { if (fs.existsSync(TRADES_FILE)) return JSON.parse(fs.readFileSync(TRADES_FILE,'utf8')); } catch(e){} return []; }
function saveTrades() { try { fs.writeFileSync(TRADES_FILE,JSON.stringify(tradeHistory)); } catch(e){} }
function loadAlerts() { try { if (fs.existsSync(ALERTS_FILE)) { const d=JSON.parse(fs.readFileSync(ALERTS_FILE,'utf8')); for(const [k,v] of Object.entries(d)) priceAlerts.set(parseInt(k),v); } } catch(e){} }
function saveAlerts() { try { const o={}; for(const [k,v] of priceAlerts) o[k]=v; fs.writeFileSync(ALERTS_FILE,JSON.stringify(o)); } catch(e){} }

const settings = loadSettings();
const pendingTrades = new Map();
const tradeHistory = loadTrades();
const priceAlerts = new Map();
const autoTradePositions = new Map();
let autoTradeTimer = null;
let autoTradeChatId = null;
const skills = new Map();

function cleanText(t) { return t.replace(/\*\*(.*?)\*\*/g,'$1').replace(/\*(.*?)\*/g,'$1').replace(/__(.*?)__/g,'$1').replace(/_(.*?)_/g,'$1').replace(/`{3}[\s\S]*?`{3}/g,'').replace(/`(.*?)`/g,'$1').replace(/#{1,6} /g,'').trim(); }
function fmt(n) { if(!n)return '$0'; if(n>=1e9)return '$'+(n/1e9).toFixed(2)+'B'; if(n>=1e6)return '$'+(n/1e6).toFixed(2)+'M'; if(n>=1e3)return '$'+(n/1e3).toFixed(2)+'K'; return '$'+n.toFixed(2); }
function priceFmt(p) { return p<0.0001?p.toFixed(8):p<0.01?p.toFixed(6):p<1?p.toFixed(4):p.toFixed(2); }

// ── DEXSCREENER ──
async function getDex(symbol) {
  try {
    const s = symbol.replace('$','');
    const r = await fetch('https://api.dexscreener.com/latest/dex/search?q='+encodeURIComponent(s));
    if(!r.ok) return null;
    const d = await r.json();
    if(!d.pairs||!d.pairs.length) return null;
    const sol = d.pairs.filter(p=>p.chainId==='solana');
    const p = (sol.length?sol:d.pairs).sort((a,b)=>(b.volume?.h24||0)-(a.volume?.h24||0))[0];
    return {symbol:p.baseToken?.symbol||s,name:p.baseToken?.name||s,address:p.baseToken?.address,price:parseFloat(p.priceUsd||0),ch1:p.priceChange?.h1||0,ch24:p.priceChange?.h24||0,vol24:p.volume?.h24||0,liq:p.liquidity?.usd||0,mcap:p.marketCap||0,buys:p.txns?.h24?.buys||0,sells:p.txns?.h24?.sells||0,chain:p.chainId,dex:p.dexId,url:p.url};
  } catch(e){return null;}
}
async function getDexByAddr(addr) {
  try {
    const r = await fetch('https://api.dexscreener.com/latest/dex/tokens/'+addr);
    if(!r.ok) return null;
    const d = await r.json();
    if(!d.pairs||!d.pairs.length) return null;
    const p = d.pairs[0];
    return {symbol:p.baseToken?.symbol,address:p.baseToken?.address,price:parseFloat(p.priceUsd||0),ch1:p.priceChange?.h1||0,ch24:p.priceChange?.h24||0,vol24:p.volume?.h24||0,liq:p.liquidity?.usd||0,buys:p.txns?.h24?.buys||0,sells:p.txns?.h24?.sells||0,url:p.url};
  } catch(e){return null;}
}
async function getTrending() {
  try {
    const r = await fetch('https://api.dexscreener.com/token-boosts/top/v1');
    if(!r.ok) return [];
    const d = await r.json();
    const res=[];
    for(const t of d.slice(0,8)) { if(t.tokenAddress){const x=await getDexByAddr(t.tokenAddress);if(x)res.push(x);} }
    return res;
  } catch(e){return [];}
}
async function getSolanaPairs() {
  try {
    // Gunakan trending Solana dari DexScreener - filter lebih longgar
    const r = await fetch('https://api.dexscreener.com/latest/dex/pairs/solana');
    if(!r.ok) return [];
    const d = await r.json();
    if(!d.pairs) return [];
    return d.pairs
      .filter(p => (p.liquidity?.usd||0)>1000 && (p.volume?.h24||0)>500)
      .sort((a,b)=>(b.volume?.h24||0)-(a.volume?.h24||0))
      .slice(0,8)
      .map(p=>({symbol:p.baseToken?.symbol,name:p.baseToken?.name,address:p.baseToken?.address,price:parseFloat(p.priceUsd||0),ch24:p.priceChange?.h24||0,vol24:p.volume?.h24||0,liq:p.liquidity?.usd||0,buys:p.txns?.h24?.buys||0,sells:p.txns?.h24?.sells||0,url:p.url}));
  } catch(e){return [];}
}

// ── SOLANA ──
const SOL_MINT='So11111111111111111111111111111111111111112';
const JUPITER='https://quote-api.jup.ag/v6';

async function getSolPrice() { try{const r=await fetch('https://price.jup.ag/v4/price?ids='+SOL_MINT);const d=await r.json();return d.data[SOL_MINT]?.price||0;}catch(e){return 0;} }
async function getBalance(pk) {
  try {
    const r=await fetch(config.SOLANA_RPC,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getBalance',params:[pk]})});
    const d=await r.json();
    const sol=(d.result?.value||0)/1e9;
    const sp=await getSolPrice();
    return {sol:sol.toFixed(4),usd:(sol*sp).toFixed(2)};
  } catch(e){return {sol:'0',usd:'0'};}
}
async function getPubkey(pk) {
  try {
    const A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let n=BigInt(0);
    for(const c of pk){const i=A.indexOf(c);if(i<0)throw new Error('bad');n=n*BigInt(58)+BigInt(i);}
    let h=n.toString(16);if(h.length%2)h='0'+h;
    const b=new Uint8Array(h.match(/.{2}/g).map(x=>parseInt(x,16)));
    if(b.length>=64){
      const pub=b.slice(32,64);
      let m=BigInt('0x'+Array.from(pub).map(x=>x.toString(16).padStart(2,'0')).join(''));
      let res='';while(m>0){res=A[Number(m%BigInt(58))]+res;m=m/BigInt(58);}
      for(let i=0;i<pub.length&&pub[i]===0;i++)res='1'+res;
      return res;
    }
    return null;
  } catch(e){return null;}
}
async function getQuote(im,om,amt) {
  try {
    const u=JUPITER+'/quote?inputMint='+im+'&outputMint='+om+'&amount='+amt+'&slippageBps='+(settings.slippage*100);
    const r=await fetch(u);if(!r.ok)throw new Error(await r.text());
    return {success:true,quote:await r.json()};
  } catch(e){return {success:false,error:e.message};}
}
async function doSwap(quote,pubkey) {
  try {
    const sr=await fetch(JUPITER+'/swap',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({quoteResponse:quote,userPublicKey:pubkey,wrapAndUnwrapSol:true,dynamicComputeUnitLimit:true,prioritizationFeeLamports:'auto'})});
    if(!sr.ok) throw new Error(await sr.text());
    const {swapTransaction}=await sr.json();
    const {Connection,VersionedTransaction,Keypair}=await import('@solana/web3.js');
    const bs58=(await import('bs58')).default;
    const conn=new Connection(config.SOLANA_RPC,'confirmed');
    const tx=VersionedTransaction.deserialize(Buffer.from(swapTransaction,'base64'));
    const kp=Keypair.fromSecretKey(bs58.decode(config.WALLET_PRIVATE_KEY));
    tx.sign([kp]);
    const txid=await conn.sendRawTransaction(tx.serialize(),{skipPreflight:true,maxRetries:3});
    const conf=await conn.confirmTransaction(txid,'confirmed');
    if(conf.value?.err) throw new Error('TX failed');
    return {success:true,txid};
  } catch(e){return {success:false,error:e.message};}
}

// ── AUTO TRADE ──
async function runAutoTrade() {
  if(!settings.autoTrade||!autoTradeChatId) return;
  // Cek posisi aktif - take profit/stop loss
  for(const [addr,pos] of autoTradePositions) {
    const d=await getDexByAddr(addr);
    if(!d) continue;
    const pnl=((d.price-pos.entryPrice)/pos.entryPrice)*100;
    if(pnl>=15||pnl<=-7) {
      const action=pnl>=15?'TAKE PROFIT +'+pnl.toFixed(2)+'%':'STOP LOSS '+pnl.toFixed(2)+'%';
      bot.sendMessage(autoTradeChatId,action+'\n\nToken: '+pos.symbol+'\nEntry: $'+priceFmt(pos.entryPrice)+'\nSekarang: $'+priceFmt(d.price)+'\n\nMengeksekusi sell...');
      const pk=await getPubkey(config.WALLET_PRIVATE_KEY);
      const q=await getQuote(addr,SOL_MINT,Math.floor(pos.tokenAmount*1e6));
      if(q.success) {
        const res=await doSwap(q.quote,pk);
        if(res.success){bot.sendMessage(autoTradeChatId,'Sell berhasil! PnL: '+(pnl>=0?'+':'')+pnl.toFixed(2)+'%\nTX: solscan.io/tx/'+res.txid);tradeHistory.push({type:'sell',symbol:pos.symbol,pnl,txid:res.txid,time:new Date().toISOString()});saveTrades();}
        else bot.sendMessage(autoTradeChatId,'Sell gagal: '+res.error);
      }
      autoTradePositions.delete(addr);
    }
  }
  if(autoTradePositions.size>=3) return;
  // Cari sinyal beli
  const pairs=await getSolanaPairs();
  const sig=pairs.find(p=>{
    if(!p.buys||!p.sells) return false;
    const br=p.buys/(p.buys+p.sells);
    return p.vol24>5000&&p.liq>3000&&br>0.55&&p.ch24>3;
  });
  if(!sig||!sig.address||autoTradePositions.has(sig.address)) return;
  const pk=await getPubkey(config.WALLET_PRIVATE_KEY);
  if(!pk) return;
  const sp=await getSolPrice();
  if(!sp) return;
  const lam=Math.floor((settings.maxBudgetPerTrade/sp)*1e9);
  if(lam<1000) { bot.sendMessage(autoTradeChatId,'Saldo SOL tidak cukup untuk auto trade. Isi wallet dulu!'); stopAutoTrade(); return; }
  const q=await getQuote(SOL_MINT,sig.address,lam);
  if(!q.success) return;
  const out=q.quote.outAmount/1e6;
  bot.sendMessage(autoTradeChatId,'Auto Trade - Sinyal!\n\nToken: '+sig.symbol+'\nHarga: $'+priceFmt(sig.price)+'\nVolume: '+fmt(sig.vol24)+'\nLikuiditas: '+fmt(sig.liq)+'\nBuy ratio: '+((sig.buys/(sig.buys+sig.sells))*100).toFixed(0)+'%\n\nBuy $'+settings.maxBudgetPerTrade+'...');
  const res=await doSwap(q.quote,pk);
  if(res.success){
    autoTradePositions.set(sig.address,{symbol:sig.symbol,entryPrice:sig.price,tokenAmount:out,amountUSD:settings.maxBudgetPerTrade,time:new Date().toISOString(),txid:res.txid});
    tradeHistory.push({type:'buy',symbol:sig.symbol,price:sig.price,amountUSD:settings.maxBudgetPerTrade,txid:res.txid,time:new Date().toISOString()});saveTrades();
    bot.sendMessage(autoTradeChatId,'Buy Berhasil!\n\nToken: '+sig.symbol+'\nDapat: '+out.toFixed(4)+' '+sig.symbol+'\nEntry: $'+priceFmt(sig.price)+'\nTP: +15% | SL: -7%\nTX: solscan.io/tx/'+res.txid);
  } else bot.sendMessage(autoTradeChatId,'Auto buy gagal: '+res.error);
}
function startAutoTrade(chatId) { autoTradeChatId=chatId;settings.autoTrade=true;saveSettings();if(autoTradeTimer)clearInterval(autoTradeTimer);autoTradeTimer=setInterval(runAutoTrade,(settings.autoTradeInterval||30)*60*1000);runAutoTrade(); }
function stopAutoTrade() { settings.autoTrade=false;saveSettings();if(autoTradeTimer){clearInterval(autoTradeTimer);autoTradeTimer=null;} }

// ── PRICE ALERTS ──
function addAlert(chatId,sym,cond,tp) { if(!priceAlerts.has(chatId))priceAlerts.set(chatId,[]);priceAlerts.get(chatId).push({symbol:sym.toUpperCase(),condition:cond,targetPrice:tp,active:true,createdAt:new Date().toISOString()});saveAlerts(); }
async function checkAlerts() {
  for(const [chatId,alerts] of priceAlerts) {
    const active=alerts.filter(a=>a.active);
    if(!active.length) continue;
    const syms=[...new Set(active.map(a=>a.symbol))];
    for(const sym of syms) {
      const d=await getDex(sym);
      if(!d) continue;
      for(const alert of active.filter(a=>a.symbol===sym)) {
        let triggered=false,msg='';
        if(alert.condition==='above'&&d.price>=alert.targetPrice){triggered=true;msg='NAIK melewati $'+alert.targetPrice+'!';}
        else if(alert.condition==='below'&&d.price<=alert.targetPrice){triggered=true;msg='TURUN ke bawah $'+alert.targetPrice+'!';}
        else if(alert.condition==='change_up'&&d.ch1>=alert.targetPrice){triggered=true;msg='NAIK '+d.ch1.toFixed(2)+'% dalam 1 jam!';}
        else if(alert.condition==='change_down'&&d.ch1<=-alert.targetPrice){triggered=true;msg='TURUN '+Math.abs(d.ch1).toFixed(2)+'% dalam 1 jam!';}
        if(triggered){
          alert.active=false;saveAlerts();
          bot.sendMessage(chatId,'ALERT '+sym+'!\n\n'+msg+'\nHarga: $'+priceFmt(d.price)+'\nVolume: '+fmt(d.vol24)+'\n\nMau beli? /buy '+sym);
        }
      }
    }
  }
}
setInterval(checkAlerts,3*60*1000); // cek setiap 3 menit

// ── SKILL LOADER ──
async function loadSkill(url) {
  try {
    let u=url.trim().replace(/\/$/,'').replace('https://','').replace('http://','');
    const parts=u.replace('github.com/','').split('/');
    if(!parts[0]||!parts[1]) throw new Error('Format URL tidak valid');
    let content=null;
    for(const b of ['main','master']){try{const r=await fetch('https://raw.githubusercontent.com/'+parts[0]+'/'+parts[1]+'/'+b+'/SKILL.md');if(r.ok){content=await r.text();break;}}catch(e){}}
    if(!content) throw new Error('SKILL.md tidak ditemukan di repo ini');
    const nm=content.match(/name:\s*(.+)/i);
    const name=nm?nm[1].trim():parts[1];
    skills.set(name,{url:'https://github.com/'+parts[0]+'/'+parts[1],content,active:true});
    saveSkills();
    return {success:true,name};
  } catch(e){return {success:false,error:e.message};}
}

// ── GITHUB API ──
async function githubPush(repo,file,content,msg) {
  try {
    const {GITHUB_TOKEN:tok,GITHUB_USERNAME:own}=config;
    if(!tok) throw new Error('GITHUB_TOKEN belum diset di Railway Variables');
    const chk=await fetch('https://api.github.com/repos/'+own+'/'+repo,{headers:{'Authorization':'Bearer '+tok,'Accept':'application/vnd.github.v3+json'}});
    if(!chk.ok){
      const cr=await fetch('https://api.github.com/user/repos',{method:'POST',headers:{'Authorization':'Bearer '+tok,'Accept':'application/vnd.github.v3+json','Content-Type':'application/json'},body:JSON.stringify({name:repo,private:false,auto_init:true})});
      if(!cr.ok) throw new Error('Gagal buat repo baru');
      await new Promise(r=>setTimeout(r,2000));
    }
    let sha=null;
    const fc=await fetch('https://api.github.com/repos/'+own+'/'+repo+'/contents/'+file,{headers:{'Authorization':'Bearer '+tok,'Accept':'application/vnd.github.v3+json'}});
    if(fc.ok) sha=(await fc.json()).sha;
    const body={message:msg||'Update via HervBot',content:Buffer.from(content).toString('base64')};
    if(sha) body.sha=sha;
    const pr=await fetch('https://api.github.com/repos/'+own+'/'+repo+'/contents/'+file,{method:'PUT',headers:{'Authorization':'Bearer '+tok,'Accept':'application/vnd.github.v3+json','Content-Type':'application/json'},body:JSON.stringify(body)});
    if(!pr.ok) throw new Error('Push gagal: '+await pr.text());
    return {success:true,url:'https://github.com/'+own+'/'+repo};
  } catch(e){return {success:false,error:e.message};}
}
async function searchGithub(keyword) {
  try {
    const tok=config.GITHUB_TOKEN;
    if(!tok) throw new Error('GITHUB_TOKEN belum diset');
    const r=await fetch('https://api.github.com/search/repositories?q='+encodeURIComponent(keyword+' skill trading crypto')+'&sort=stars&order=desc&per_page=8',{headers:{'Authorization':'Bearer '+tok,'Accept':'application/vnd.github.v3+json','User-Agent':'HervBot'}});
    if(!r.ok) throw new Error('GitHub search error: '+r.status);
    const d=await r.json();
    if(!d.items||!d.items.length) return {success:true,results:[]};
    const results=[];
    for(const repo of d.items.slice(0,5)){
      const sc=await fetch('https://raw.githubusercontent.com/'+repo.full_name+'/main/SKILL.md');
      results.push({name:repo.name,url:repo.html_url,desc:(repo.description||'-').slice(0,80),stars:repo.stargazers_count,hasSkill:sc.ok});
    }
    return {success:true,results};
  } catch(e){return {success:false,error:e.message};}
}

// ── AI CHAT ──
const conversations=new Map();
async function chat(userId,userMsg,extraData) {
  if(!conversations.has(userId)) conversations.set(userId,[]);
  const history=conversations.get(userId);
  history.push({role:'user',content:userMsg});
  if(history.length>20) history.splice(0,history.length-20);
  let sc='';
  for(const [n,s] of skills) if(s.active) sc+='\nSKILL '+n+':\n'+s.content.slice(0,600);

  // System prompt yang jelas tentang kemampuan NYATA bot
  const sys = `Kamu adalah HervBot, AI trading agent crypto yang berjalan di Solana.

KEMAMPUAN NYATA YANG KAMU MILIKI (bukan hanya teori):
1. /harga [token] - Ambil harga real-time dari DexScreener
2. /saldo - Cek saldo wallet Solana nyata (${config.WALLET_PRIVATE_KEY?'wallet terhubung':'wallet belum diset'})
3. /buy [token] [USD] - Beli token nyata via Jupiter DEX di Solana
4. /sell [token] [USD] - Jual token nyata
5. /swap [dari] [ke] [USD] - Swap token nyata
6. /scan - Scan token Solana dengan data real-time DexScreener
7. /trending - Token trending real-time
8. /alert [token] above/below/change_up/change_down [nilai] - Alert harga NYATA, dicek setiap 3 menit
9. /autoon - Auto trading NYATA, beli/jual otomatis berdasarkan sinyal DexScreener
10. /install [github url] - Install skill dari GitHub NYATA (baca SKILL.md)
11. /cari [keyword] - Search repo skill di GitHub NYATA via GitHub API
12. /github_push [repo] [url] - Duplikat skill ke GitHub NYATA

Settings: Budget $${settings.maxBudgetPerTrade}, Slippage ${settings.slippage}%, Auto Trade: ${settings.autoTrade?'ON':'OFF'}
${sc?'\nSkill aktif:\n'+sc:''}
${extraData?'\nData real-time:\n'+extraData:''}

PENTING:
- Kalau user tanya "apa yang bisa kamu lakukan", jelaskan semua kemampuan di atas dengan jujur
- Kalau user minta cari skill, arahkan ke /cari [keyword]
- Kalau user minta install skill, arahkan ke /install [url github]
- Jangan bilang "saya tidak bisa akses GitHub" - kamu BISA via perintah /cari dan /install
- Jangan gunakan Markdown. Teks biasa. Bahasa Indonesia santai.`;

  try {
    const r=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+config.GROQ_API_KEY},body:JSON.stringify({model:'llama-3.3-70b-versatile',max_tokens:800,messages:[{role:'system',content:sys},...history]})});
    if(!r.ok) throw new Error(await r.text());
    const d=await r.json();
    const reply=cleanText(d.choices[0].message.content);
    history.push({role:'assistant',content:reply});
    return reply;
  } catch(e){return 'Error AI: '+e.message;}
}

// ── TELEGRAM HANDLERS ──
bot.onText(/\/start/,(msg)=>{
  bot.sendMessage(msg.chat.id,
    'HervBot - AI Trading Agent Solana\n\n'+
    'TRADING NYATA:\n'+
    '/buy [token] [USD] - Beli token\n'+
    '/sell [token] [USD] - Jual token\n'+
    '/swap [dari] [ke] [USD] - Swap\n'+
    '/harga [token] - Harga real-time\n'+
    '/saldo - Cek saldo wallet\n\n'+
    'AUTO TRADING:\n'+
    '/autoon - Aktifkan auto trade\n'+
    '/autooff - Matikan\n'+
    '/posisi - Lihat posisi aktif + PnL\n'+
    '/laporan - Riwayat trading\n\n'+
    'ALERT HARGA:\n'+
    '/alert SOL change_down 1 - Notif SOL turun 1%\n'+
    '/alert SOL change_up 1 - Notif SOL naik 1%\n'+
    '/alert BONK above 0.00005 - Notif BONK naik\n'+
    '/alerts - Lihat semua alert\n'+
    '/clearalerts - Hapus alert\n\n'+
    'ANALISIS:\n'+
    '/scan - Scan token potensial\n'+
    '/scalping - Peluang scalping\n'+
    '/trending - Token trending\n\n'+
    'SKILL:\n'+
    '/skills - Skill aktif\n'+
    '/cari [keyword] - Cari skill di GitHub\n'+
    '/install [url] - Install skill\n'+
    '/github_push [repo] [url] - Duplikat skill\n\n'+
    'SETTING:\n'+
    '/budget [angka] - Set budget per trade\n'+
    '/slippage [angka] - Set slippage %\n'+
    '/interval [menit] - Interval auto trade\n\n'+
    'Budget: $'+settings.maxBudgetPerTrade+' | Auto: '+(settings.autoTrade?'ON':'OFF')
  );
});

bot.onText(/\/autoon/,async(msg)=>{
  const chatId=msg.chat.id;
  const pk=await getPubkey(config.WALLET_PRIVATE_KEY);
  if(!pk){bot.sendMessage(chatId,'Gagal baca wallet. Cek WALLET_PRIVATE_KEY di Railway.');return;}
  const bal=await getBalance(pk);
  if(parseFloat(bal.usd)<settings.maxBudgetPerTrade){
    bot.sendMessage(chatId,'Saldo tidak cukup!\n\nSaldo: $'+bal.usd+'\nBudget per trade: $'+settings.maxBudgetPerTrade+'\n\nSolusi:\n1. Isi wallet dengan SOL\n2. Atau kecilkan budget: /budget 0.05\n\nAlamat wallet: '+pk);
    return;
  }
  startAutoTrade(chatId);
  bot.sendMessage(chatId,'Auto Trade AKTIF!\n\nBudget: $'+settings.maxBudgetPerTrade+'\nInterval scan: '+(settings.autoTradeInterval||30)+' menit\nTake Profit: +15%\nStop Loss: -7%\nMax posisi: 3\n\nBot akan scan DexScreener dan beli/jual otomatis.\nGunakan /autooff untuk matikan.');
});
bot.onText(/\/autooff/,(msg)=>{stopAutoTrade();bot.sendMessage(msg.chat.id,'Auto Trade DIMATIKAN.\nPosisi aktif masih dipantau.');});

bot.onText(/\/posisi/,async(msg)=>{
  const chatId=msg.chat.id;
  if(!autoTradePositions.size){bot.sendMessage(chatId,'Tidak ada posisi aktif.\n\nAktifkan auto trade: /autoon');return;}
  let m='Posisi Aktif ('+autoTradePositions.size+'):\n\n';
  for(const [addr,pos] of autoTradePositions){
    const d=await getDexByAddr(addr);
    const cp=d?.price||pos.entryPrice;
    const pnl=((cp-pos.entryPrice)/pos.entryPrice)*100;
    m+='Token: '+pos.symbol+'\nEntry: $'+priceFmt(pos.entryPrice)+'\nSekarang: $'+priceFmt(cp)+'\nPnL: '+(pnl>=0?'+':'')+pnl.toFixed(2)+'%\nModal: $'+pos.amountUSD+'\n\n';
  }
  bot.sendMessage(chatId,m);
});

bot.onText(/\/laporan/,(msg)=>{
  const chatId=msg.chat.id;
  if(!tradeHistory.length){bot.sendMessage(chatId,'Belum ada riwayat trading.');return;}
  const sells=tradeHistory.filter(t=>t.type==='sell');
  const wins=sells.filter(t=>t.pnl>0).length;
  const totalPnl=sells.reduce((s,t)=>s+(t.pnl||0),0);
  let m='Laporan Trading:\n\nTotal: '+tradeHistory.length+'\nBuy: '+tradeHistory.filter(t=>t.type==='buy').length+' | Sell: '+sells.length+'\nWin rate: '+(sells.length?((wins/sells.length)*100).toFixed(0):0)+'%\nTotal PnL: '+(totalPnl>=0?'+':'')+totalPnl.toFixed(2)+'%\n\nTerakhir 5:\n';
  tradeHistory.slice(-5).reverse().forEach(t=>{m+=t.type.toUpperCase()+' '+t.symbol+(t.pnl?' '+(t.pnl>=0?'+':'')+t.pnl.toFixed(2)+'%':'')+'\n';});
  bot.sendMessage(chatId,m);
});

bot.onText(/\/budget (.+)/,(msg,match)=>{
  const a=parseFloat(match[1]);
  if(isNaN(a)||a<=0){bot.sendMessage(msg.chat.id,'Contoh: /budget 0.1');return;}
  settings.maxBudgetPerTrade=a;saveSettings();bot.sendMessage(msg.chat.id,'Budget per trade: $'+a);
});
bot.onText(/\/slippage (.+)/,(msg,match)=>{
  const s=parseFloat(match[1]);
  if(isNaN(s)||s<=0||s>50){bot.sendMessage(msg.chat.id,'Contoh: /slippage 1');return;}
  settings.slippage=s;saveSettings();bot.sendMessage(msg.chat.id,'Slippage: '+s+'%');
});
bot.onText(/\/interval (.+)/,(msg,match)=>{
  const m=parseInt(match[1]);
  if(isNaN(m)||m<5){bot.sendMessage(msg.chat.id,'Min 5 menit. Contoh: /interval 15');return;}
  settings.autoTradeInterval=m;saveSettings();
  if(settings.autoTrade&&autoTradeTimer){clearInterval(autoTradeTimer);autoTradeTimer=setInterval(runAutoTrade,m*60*1000);}
  bot.sendMessage(msg.chat.id,'Interval auto trade: '+m+' menit');
});

bot.onText(/\/saldo/,async(msg)=>{
  const chatId=msg.chat.id;
  bot.sendMessage(chatId,'Mengecek saldo wallet...');
  const pk=await getPubkey(config.WALLET_PRIVATE_KEY);
  if(!pk){bot.sendMessage(chatId,'Gagal baca wallet.\n\nPastikan WALLET_PRIVATE_KEY sudah diset di Railway Variables dengan benar.');return;}
  const bal=await getBalance(pk);
  bot.sendMessage(chatId,'Saldo Wallet:\n\nSOL: '+bal.sol+'\nUSD: ~$'+bal.usd+'\n\nAlamat: '+pk.slice(0,6)+'...'+pk.slice(-6)+'\n\nUntuk isi saldo, kirim SOL ke alamat di atas.');
});

bot.onText(/\/harga (.+)/,async(msg,match)=>{
  const chatId=msg.chat.id;
  const sym=match[1].trim();
  bot.sendMessage(chatId,'Mengambil data real-time '+sym+'...');
  const d=await getDex(sym);
  if(!d){bot.sendMessage(chatId,'Token '+sym+' tidak ditemukan di DexScreener.');return;}
  bot.sendMessage(chatId,'Data Real-time '+d.symbol+':\n\nHarga: $'+priceFmt(d.price)+'\nPerubahan 1j: '+(d.ch1>=0?'+':'')+d.ch1.toFixed(2)+'%\nPerubahan 24j: '+(d.ch24>=0?'+':'')+d.ch24.toFixed(2)+'%\nVolume 24j: '+fmt(d.vol24)+'\nLikuiditas: '+fmt(d.liq)+'\nBuy/Sell 24j: '+d.buys+'/'+d.sells+'\nChain: '+d.chain+'\n\nChart: '+d.url);
});

bot.onText(/\/buy (.+)/,async(msg,match)=>{
  const chatId=msg.chat.id;
  const parts=match[1].trim().split(' ');
  const sym=parts[0];
  const usd=parseFloat(parts[1])||settings.maxBudgetPerTrade;
  if(usd>settings.maxBudgetPerTrade){bot.sendMessage(chatId,'Melebihi budget $'+settings.maxBudgetPerTrade+'\nUbah dengan /budget [angka]');return;}
  bot.sendMessage(chatId,'Mencari '+sym+' di DexScreener...');
  const td=await getDex(sym);
  if(!td||!td.address){bot.sendMessage(chatId,'Token '+sym+' tidak ditemukan.');return;}
  const sp=await getSolPrice();
  if(!sp){bot.sendMessage(chatId,'Gagal ambil harga SOL.');return;}
  const lam=Math.floor((usd/sp)*1e9);
  const q=await getQuote(SOL_MINT,td.address,lam);
  if(!q.success){bot.sendMessage(chatId,'Gagal buat quote:\n'+q.error);return;}
  const out=q.quote.outAmount/1e6;
  pendingTrades.set(chatId,{type:'buy',token:td,amountUSD:usd,lamports:lam,outAmount:out,quote:q.quote});
  bot.sendMessage(chatId,'Konfirmasi Buy:\n\nToken: '+td.symbol+' ('+td.name+')\nBayar: $'+usd+' ('+(usd/sp).toFixed(4)+' SOL)\nDapat: ~'+out.toFixed(4)+' '+td.symbol+'\nHarga: $'+priceFmt(td.price)+'\nSlippage: '+settings.slippage+'%\n\n/ya - Eksekusi sekarang\n/tidak - Batalkan');
});

bot.onText(/\/ya/,async(msg)=>{
  const chatId=msg.chat.id;
  const p=pendingTrades.get(chatId);
  if(!p){bot.sendMessage(chatId,'Tidak ada transaksi pending.');return;}
  pendingTrades.delete(chatId);
  bot.sendMessage(chatId,'Mengeksekusi transaksi di Solana...\nMohon tunggu...');
  const pk=await getPubkey(config.WALLET_PRIVATE_KEY);
  if(!pk){bot.sendMessage(chatId,'Gagal baca wallet.');return;}
  const res=await doSwap(p.quote,pk);
  if(res.success){
    tradeHistory.push({type:p.type,symbol:p.token.symbol,amountUSD:p.amountUSD,txid:res.txid,time:new Date().toISOString()});saveTrades();
    bot.sendMessage(chatId,'Transaksi BERHASIL!\n\nToken: '+p.token.symbol+'\nJumlah: ~'+p.outAmount.toFixed(4)+' '+p.token.symbol+'\n\nTX Hash: '+res.txid+'\nCek di: solscan.io/tx/'+res.txid);
  } else bot.sendMessage(chatId,'Transaksi GAGAL:\n'+res.error+'\n\nPastikan saldo SOL cukup untuk gas fee (~0.001 SOL).');
});
bot.onText(/\/tidak/,(msg)=>{pendingTrades.delete(msg.chat.id);bot.sendMessage(msg.chat.id,'Transaksi dibatalkan.');});

bot.onText(/\/sell (.+)/,async(msg,match)=>{
  const chatId=msg.chat.id;
  const parts=match[1].trim().split(' ');
  const sym=parts[0];
  const usd=parseFloat(parts[1])||settings.maxBudgetPerTrade;
  const td=await getDex(sym);
  if(!td||!td.address){bot.sendMessage(chatId,'Token tidak ditemukan.');return;}
  const tl=Math.floor((usd/td.price)*1e6);
  const q=await getQuote(td.address,SOL_MINT,tl);
  if(!q.success){bot.sendMessage(chatId,'Gagal quote: '+q.error);return;}
  const so=q.quote.outAmount/1e9;
  const sp=await getSolPrice();
  pendingTrades.set(chatId,{type:'sell',token:td,amountUSD:usd,tokenLamports:tl,solOut:so,quote:q.quote});
  bot.sendMessage(chatId,'Konfirmasi Sell:\n\nJual: '+(usd/td.price).toFixed(4)+' '+td.symbol+'\nDapat: ~'+so.toFixed(4)+' SOL (~$'+(so*sp).toFixed(2)+')\n\n/ya - Eksekusi\n/tidak - Batal');
});

bot.onText(/\/swap (.+) (.+) (.+)/,async(msg,match)=>{
  const chatId=msg.chat.id;
  const [f,t,a]=[match[1],match[2],parseFloat(match[3])||settings.maxBudgetPerTrade];
  const fd=f.toUpperCase()==='SOL'?{address:SOL_MINT,symbol:'SOL',price:await getSolPrice()}:await getDex(f);
  const td=t.toUpperCase()==='SOL'?{address:SOL_MINT,symbol:'SOL'}:await getDex(t);
  if(!fd||!td){bot.sendMessage(chatId,'Token tidak ditemukan.');return;}
  const fl=Math.floor((a/fd.price)*(f.toUpperCase()==='SOL'?1e9:1e6));
  const q=await getQuote(fd.address,td.address,fl);
  if(!q.success){bot.sendMessage(chatId,'Gagal quote: '+q.error);return;}
  const ta=q.quote.outAmount/(t.toUpperCase()==='SOL'?1e9:1e6);
  pendingTrades.set(chatId,{type:'swap',token:td,fromData:fd,amountUSD:a,toAmount:ta,quote:q.quote});
  bot.sendMessage(chatId,'Konfirmasi Swap:\n\nDari: '+(a/fd.price).toFixed(4)+' '+fd.symbol+'\nKe: ~'+ta.toFixed(4)+' '+(td.symbol||t)+'\n\n/ya - Eksekusi\n/tidak - Batal');
});

bot.onText(/\/scan/,async(msg)=>{
  const chatId=msg.chat.id;
  bot.sendMessage(chatId,'Scanning token Solana (real-time DexScreener)...');
  const pairs=await getSolanaPairs();
  if(!pairs.length){bot.sendMessage(chatId,'Tidak ada data dari DexScreener saat ini. Coba lagi.');return;}
  let m='Token Solana Aktif:\n\n';
  pairs.slice(0,5).forEach((t,i)=>{
    const br=t.buys&&t.sells?((t.buys/(t.buys+t.sells))*100).toFixed(0):'?';
    m+=(i+1)+'. '+t.symbol+'\nHarga: $'+priceFmt(t.price)+' ('+(t.ch24>=0?'+':'')+t.ch24.toFixed(2)+'%)\nVolume: '+fmt(t.vol24)+' | Liq: '+fmt(t.liq)+'\nBuy ratio: '+br+'%\nChart: '+t.url+'\n\n';
  });
  bot.sendMessage(chatId,m);
  const reply=await chat(chatId,'Analisis token Solana ini dari data real-time DexScreener. Mana yang paling menarik dan mengapa?',JSON.stringify(pairs.slice(0,3)));
  bot.sendMessage(chatId,'Analisis AI:\n\n'+reply);
});

bot.onText(/\/scalping/,async(msg)=>{
  const chatId=msg.chat.id;
  bot.sendMessage(chatId,'Mencari peluang scalping...');
  const pairs=await getSolanaPairs();
  const reply=await chat(chatId,'Berdasarkan data real-time ini, cari peluang scalping terbaik. Berikan entry, target 5-10%, stop loss.',JSON.stringify(pairs.slice(0,3)));
  bot.sendMessage(chatId,reply);
});

bot.onText(/\/trending/,async(msg)=>{
  const chatId=msg.chat.id;
  bot.sendMessage(chatId,'Mengambil token trending...');
  const tr=await getTrending();
  if(!tr.length){bot.sendMessage(chatId,'Gagal ambil data trending. Coba lagi.');return;}
  let m='Token Trending (Real-time):\n\n';
  tr.slice(0,5).forEach((t,i)=>{m+=(i+1)+'. '+(t.symbol||'?')+'\nHarga: $'+priceFmt(t.price)+' ('+(t.ch24>=0?'+':'')+t.ch24.toFixed(2)+'%)\nVolume: '+fmt(t.vol24)+'\n\n';});
  bot.sendMessage(chatId,m);
});

bot.onText(/\/alert (.+) (.+) (.+)/,async(msg,match)=>{
  const chatId=msg.chat.id;
  const sym=match[1].trim().toUpperCase();
  const cond=match[2].trim().toLowerCase();
  const tp=parseFloat(match[3]);
  if(isNaN(tp)){bot.sendMessage(chatId,'Contoh:\n/alert SOL change_down 1\n/alert SOL change_up 1\n/alert BONK above 0.00005\n/alert SOL below 100');return;}
  if(!['above','below','change_up','change_down'].includes(cond)){bot.sendMessage(chatId,'Kondisi: above, below, change_up, change_down');return;}
  const d=await getDex(sym);
  if(!d){bot.sendMessage(chatId,'Token '+sym+' tidak ditemukan.');return;}
  addAlert(chatId,sym,cond,tp);
  const ct={above:'naik di atas $'+tp,below:'turun di bawah $'+tp,change_up:'naik '+tp+'%/1j',change_down:'turun '+tp+'%/1j'};
  bot.sendMessage(chatId,'Alert dibuat!\n\nToken: '+sym+'\nHarga sekarang: $'+priceFmt(d.price)+'\nNotifikasi kalau: '+ct[cond]+'\nCek setiap: 3 menit\n\nCek semua alert: /alerts');
});
bot.onText(/\/alerts/,(msg)=>{
  const chatId=msg.chat.id;
  const active=(priceAlerts.get(chatId)||[]).filter(a=>a.active);
  if(!active.length){bot.sendMessage(chatId,'Tidak ada alert aktif.\n\nContoh buat alert:\n/alert SOL change_down 1\n/alert SOL change_up 2\n/alert BONK above 0.00005');return;}
  let m='Alert Aktif ('+active.length+'):\n\n';
  const ct={above:'Naik >$',below:'Turun <$',change_up:'Naik ',change_down:'Turun '};
  active.forEach((a,i)=>{m+=(i+1)+'. '+a.symbol+' - '+(ct[a.condition]||'')+a.targetPrice+(a.condition.includes('change')?'%/1j':'')+'\n';});
  m+='\n/clearalerts - Hapus semua';
  bot.sendMessage(chatId,m);
});
bot.onText(/\/clearalerts/,(msg)=>{priceAlerts.set(msg.chat.id,[]);saveAlerts();bot.sendMessage(msg.chat.id,'Semua alert dihapus.');});

bot.onText(/\/skills/,(msg)=>{
  const chatId=msg.chat.id;
  if(!skills.size){bot.sendMessage(chatId,'Belum ada skill terinstall.\n\nCara install:\n/install https://github.com/username/repo\n\nCari skill:\n/cari trading solana');return;}
  let m='Skill Terinstall ('+skills.size+'):\n\n';
  for(const [n,s] of skills) m+='AKTIF - '+n+'\n'+s.url+'\n\n';
  m+='Install skill baru: /install [url]\nCari skill: /cari [keyword]';
  bot.sendMessage(chatId,m);
});

bot.onText(/\/cari (.+)/,async(msg,match)=>{
  const chatId=msg.chat.id;
  const kw=match[1].trim();
  bot.sendMessage(chatId,'Mencari skill "'+kw+'" di GitHub via API...');
  const res=await searchGithub(kw);
  if(!res.success){bot.sendMessage(chatId,'Gagal search GitHub:\n'+res.error);return;}
  if(!res.results.length){bot.sendMessage(chatId,'Tidak ada repo ditemukan untuk "'+kw+'".\n\nCoba keyword lain seperti:\n/cari solana trading\n/cari crypto scalping');return;}
  let m='Hasil search GitHub "'+kw+'":\n\n';
  res.results.forEach((r,i)=>{m+=(i+1)+'. '+r.name+'\n'+r.url+'\nDeskripsi: '+r.desc+'\nStars: '+r.stars+' | SKILL.md: '+(r.hasSkill?'Ada - bisa diinstall!':'Tidak ada')+'\n\n';});
  m+='Install skill:\n/install [url repo]\n\nDuplikat ke GitHub kamu:\n/github_push [nama-repo-baru] [url]';
  bot.sendMessage(chatId,m);
});

bot.onText(/\/install (.+)/,async(msg,match)=>{
  const chatId=msg.chat.id;
  const url=match[1].trim();
  bot.sendMessage(chatId,'Menginstall skill dari:\n'+url+'\n\nMohon tunggu...');
  const res=await loadSkill(url);
  if(res.success) bot.sendMessage(chatId,'Skill "'+res.name+'" berhasil diinstall!\n\nSkill aktif: '+skills.size+'\nCek semua: /skills');
  else bot.sendMessage(chatId,'Gagal install skill:\n'+res.error+'\n\nPastikan:\n1. URL benar\n2. Repo public\n3. Ada file SKILL.md di repo');
});

bot.onText(/\/github_push (.+) (.+)/,async(msg,match)=>{
  const chatId=msg.chat.id;
  const [rn,su]=[match[1].trim(),match[2].trim()];
  bot.sendMessage(chatId,'Menduplikat skill ke repo "'+rn+'"...');
  const parts=su.replace('https://','').replace('http://','').replace('github.com/','').split('/');
  const raw=await fetch('https://raw.githubusercontent.com/'+parts[0]+'/'+parts[1]+'/main/SKILL.md');
  if(!raw.ok){bot.sendMessage(chatId,'SKILL.md tidak ditemukan di '+su);return;}
  let content=await raw.text();
  content=content.replace(/author:\s*.+/gi,'author: '+config.GITHUB_USERNAME);
  const pr=await githubPush(rn,'SKILL.md',content,'Duplicated via HervBot');
  if(!pr.success){bot.sendMessage(chatId,'Gagal push ke GitHub:\n'+pr.error);return;}
  await githubPush(rn,'README.md','# '+rn+'\n\nSkill HervBot.\nDuplikat dari: '+su+'\nOleh: '+config.GITHUB_USERNAME,'Add README');
  bot.sendMessage(chatId,'Berhasil duplikat skill!\n\nRepo baru:\ngithub.com/'+config.GITHUB_USERNAME+'/'+rn+'\n\nInstall ke bot:\n/install https://github.com/'+config.GITHUB_USERNAME+'/'+rn);
});

bot.onText(/\/help/,(msg)=>{
  bot.sendMessage(msg.chat.id,'Semua perintah HervBot:\n\n/start - Menu lengkap\n/buy /sell /swap - Trading nyata\n/harga /saldo - Info wallet\n/ya /tidak - Konfirmasi transaksi\n/autoon /autooff - Auto trading\n/posisi /laporan - Monitor trading\n/alert /alerts /clearalerts - Alert harga\n/scan /scalping /trending - Analisis\n/budget /slippage /interval - Setting\n/skills /cari /install /github_push - Skill');
});

bot.on('message',async(msg)=>{
  if(msg.text&&!msg.text.startsWith('/')){
    bot.sendChatAction(msg.chat.id,'typing');
    bot.sendMessage(msg.chat.id,await chat(msg.chat.id,msg.text));
  }
});

app.get('/health',(req,res)=>res.json({status:'ok',skills:skills.size,settings,positions:autoTradePositions.size,alerts:[...priceAlerts.values()].flat().filter(a=>a.active).length}));

// ── STARTUP ──
async function startup() {
  loadAlerts();
  const saved=loadSavedSkills();
  for(const s of saved) skills.set(s.name,{url:s.url,content:s.content,active:s.active});
  console.log('HervBot started | Skills: '+skills.size+' | Auto: '+settings.autoTrade);
  if(settings.autoTrade&&autoTradeChatId) { autoTradeTimer=setInterval(runAutoTrade,(settings.autoTradeInterval||30)*60*1000); }
  app.listen(config.PORT,()=>console.log('Port '+config.PORT+' | Budget: $'+settings.maxBudgetPerTrade));
}
startup();
