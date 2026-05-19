const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const { Connection, PublicKey, Keypair, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const axios = require('axios');
const { getMint } = require('@solana/spl-token');

const app = express();
app.use(cors());
app.use(express.json());

const config = {
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  WALLET_PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY,
  SOLANA_RPC: process.env.SOLANA_RPC,
  SLIPPAGE_BPS: parseInt(process.env.SLIPPAGE_BPS) || 50,
  PORT: process.env.PORT || 3000,
};

// ====================== SOLANA SETUP ======================
const connection = new Connection(config.SOLANA_RPC, 'confirmed');
let wallet = null;

if (config.WALLET_PRIVATE_KEY) {
  try {
    const secretKey = bs58.decode(config.WALLET_PRIVATE_KEY);
    wallet = Keypair.fromSecretKey(secretKey);
    console.log("✅ Wallet loaded:", wallet.publicKey.toString().slice(0, 12) + "...");
  } catch (e) {
    console.error("❌ Gagal load wallet:", e.message);
  }
}

// ====================== HELPER FUNCTIONS ======================
async function getTokenDecimals(mintAddress) {
  try {
    const mintPubkey = new PublicKey(mintAddress);
    const mintInfo = await getMint(connection, mintPubkey);
    return mintInfo.decimals;
  } catch {
    return 9;
  }
}

async function getTokenPrice(mint) {
  try {
    const address = mint.replace('$', '').trim();
    const res = await axios.get(`https://api.birdeye.so/defi/price?address=${address}`);
    return res.data?.data?.value ? Number(res.data.data.value).toFixed(6) : null;
  } catch {
    return null;
  }
}

async function getBalance() {
  if (!wallet) return "❌ Wallet belum diatur";
  try {
    const sol = await connection.getBalance(wallet.publicKey);
    return (sol / 1_000_000_000).toFixed(4) + " SOL";
  } catch (e) {
    return "❌ Gagal cek saldo";
  }
}

// ====================== JUPITER SWAP ======================
async function executeSwap(inputMint, outputMint, amountIn, isBuy) {
  if (!wallet) throw new Error("Wallet belum diatur");

  try {
    const decimals = isBuy ? 9 : await getTokenDecimals(inputMint);
    const amount = Math.floor(amountIn * Math.pow(10, decimals));

    const quoteRes = await axios.get('https://quote-api.jup.ag/v6/quote', {
      params: { inputMint, outputMint, amount, slippageBps: config.SLIPPAGE_BPS }
    });

    const swapRes = await axios.post('https://quote-api.jup.ag/v6/swap', {
      quoteResponse: quoteRes.data,
      userPublicKey: wallet.publicKey.toString(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto"
    });

    const transaction = VersionedTransaction.deserialize(
      Buffer.from(swapRes.data.swapTransaction, 'base64')
    );
    transaction.sign([wallet]);

    const txId = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 3
    });

    return { 
      success: true, 
      txId: `https://solscan.io/tx/${txId}` 
    };
  } catch (error) {
    console.error("Swap Error:", error.message);
    return { success: false, error: error.message };
  }
}

// ====================== TELEGRAM BOT ======================
const bot = new TelegramBot(config.TELEGRAM_TOKEN, { polling: true });

// AI Chat
const conversations = new Map();
async function chat(userId, userMessage) {
  if (!conversations.has(userId)) conversations.set(userId, []);
  const history = conversations.get(userId);
  history.push({ role: 'user', content: userMessage });
  if (history.length > 15) history.splice(0, 2);

  const systemPrompt = 'Kamu adalah HervBot, AI Trading Agent Solana. Jawab dengan bahasa Indonesia yang santai dan jelas.';

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + config.GROQ_API_KEY,
      },
      body: JSON.stringify({
        model: 'llama3-70b-8192',
        max_tokens: 700,
        messages: [{ role: 'system', content: systemPrompt }, ...history],
      }),
    });
    const data = await response.json();
    return data.choices[0].message.content.trim();
  } catch (e) {
    return 'Maaf, AI sedang sibuk. Coba lagi nanti.';
  }
}

// ====================== COMMANDS ======================
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 
    `🚀 *HervBot - AI Trading Agent Solana*\n\n` +
    `Wallet : ${wallet ? '✅ Aktif' : '❌ Belum diatur'}\n` +
    `RPC    : Helius\n\n` +
    `Perintah Trading:\n` +
    `/saldo\n` +
    `/harga <token>\n` +
    `/buy <token> <jumlah SOL>\n` +
    `/sell <token> <jumlah token>\n\n` +
    `Contoh:\n` +
    `/harga $GRASS\n` +
    `/buy $GRASS 0.5`
  );
});

bot.onText(/\/saldo/, async (msg) => {
  bot.sendMessage(msg.chat.id, "🔄 Mengecek saldo...");
  const balance = await getBalance();
  bot.sendMessage(msg.chat.id, `💼 Saldo Wallet:\n${balance}`);
});

bot.onText(/\/harga (.+)/, async (msg, match) => {
  const token = match[1].trim();
  bot.sendMessage(msg.chat.id, `🔍 Mencari harga ${token}...`);
  const price = await getTokenPrice(token);
  bot.sendMessage(msg.chat.id, price ? `💰 ${token.toUpperCase()}: $${price}` : `❌ Harga ${token} tidak ditemukan`);
});

bot.onText(/\/buy (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!wallet) return bot.sendMessage(chatId, "❌ Wallet belum diatur!");

  const args = match[1].trim().split(/\s+/);
  const token = args[0];
  const amountSol = parseFloat(args[1]);

  if (!token || !amountSol) {
    return bot.sendMessage(chatId, "Format salah.\nContoh: `/buy $GRASS 0.5`");
  }

  bot.sendMessage(chatId, `🔄 Sedang membeli ${token} dengan ${amountSol} SOL...`);

  const SOL_MINT = "So11111111111111111111111111111111111111112";
  const result = await executeSwap(SOL_MINT, token.replace('$',''), amountSol, true);

  bot.sendMessage(chatId, result.success 
    ? `✅ Berhasil membeli \( {token}!\n \){result.txId}` 
    : `❌ Gagal: ${result.error}`);
});

bot.onText(/\/sell (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!wallet) return bot.sendMessage(chatId, "❌ Wallet belum diatur!");

  const args = match[1].trim().split(/\s+/);
  const token = args[0];
  const amount = parseFloat(args[1]);

  if (!token || !amount) {
    return bot.sendMessage(chatId, "Format salah.\nContoh: `/sell $GRASS 1000000`");
  }

  bot.sendMessage(chatId, `🔄 Sedang menjual ${amount} ${token}...`);

  const SOL_MINT = "So11111111111111111111111111111111111111112";
  const result = await executeSwap(token.replace('$',''), SOL_MINT, amount, false);

  bot.sendMessage(chatId, result.success 
    ? `✅ Berhasil menjual \( {token}!\n \){result.txId}` 
    : `❌ Gagal: ${result.error}`);
});

// AI Commands
bot.onText(/\/scan|\/scalping|\/trending/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendChatAction(chatId, 'typing');
  const reply = await chat(chatId, msg.text);
  bot.sendMessage(chatId, reply);
});

bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  bot.sendChatAction(chatId, 'typing');
  const reply = await chat(chatId, msg.text);
  bot.sendMessage(chatId, reply);
});

// ====================== START ======================
app.get('/health', (req, res) => res.json({ status: 'ok', wallet: !!wallet }));

console.log("🚀 HervBot siap di Railway");
app.listen(config.PORT, () => {
  console.log(`✅ Bot berjalan di port ${config.PORT}`);
});
