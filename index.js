const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Connection, PublicKey, Keypair, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const axios = require('axios');

const app = express();

const config = {
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  WALLET_PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY,
  SOLANA_RPC: process.env.SOLANA_RPC,
  SLIPPAGE_BPS: parseInt(process.env.SLIPPAGE_BPS) || 50,
  PORT: process.env.PORT || 3000,
};

// Solana Setup
const connection = new Connection(config.SOLANA_RPC, 'confirmed');
let wallet = null;

if (config.WALLET_PRIVATE_KEY) {
  try {
    wallet = Keypair.fromSecretKey(bs58.decode(config.WALLET_PRIVATE_KEY));
    console.log("✅ Wallet loaded successfully");
  } catch (e) {
    console.error("❌ Wallet error:", e.message);
  }
}

const bot = new TelegramBot(config.TELEGRAM_TOKEN, { polling: true });

// Helper Functions
async function getBalance() {
  if (!wallet) return "❌ Wallet belum diatur";
  try {
    const bal = await connection.getBalance(wallet.publicKey);
    return (bal / 1_000_000_000).toFixed(4) + " SOL";
  } catch (e) {
    return "❌ Gagal cek saldo";
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

// Basic Commands
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, 
    `🚀 HervBot Solana\n\n` +
    `Status Wallet: ${wallet ? '✅ Aktif' : '❌ Error'}\n` +
    `RPC: Helius\n\n` +
    `Perintah:\n` +
    `/saldo\n` +
    `/harga $GRASS\n` +
    `/buy $GRASS 0.5`
  );
});

bot.onText(/\/saldo/, async (msg) => {
  bot.sendMessage(msg.chat.id, "🔄 Cek saldo...");
  const balance = await getBalance();
  bot.sendMessage(msg.chat.id, `💼 ${balance}`);
});

bot.onText(/\/harga (.+)/, async (msg, match) => {
  bot.sendMessage(msg.chat.id, `🔍 Mencari harga ${match[1]}...`);
  const price = await getTokenPrice(match[1]);
  bot.sendMessage(msg.chat.id, price ? `💰 ${match[1]}: $${price}` : "❌ Harga tidak ditemukan");
});

bot.on('message', async (msg) => {
  if (msg.text && !msg.text.startsWith('/')) {
    bot.sendMessage(msg.chat.id, "Bot trading sedang dioptimasi. Gunakan /start");
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(config.PORT, () => {
  console.log(`✅ HervBot berjalan di Railway - Port ${config.PORT}`);
});
