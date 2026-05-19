import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import { Connection, PublicKey, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import axios from 'axios';

const app = express();

const config = {
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  WALLET_PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY,
  SOLANA_RPC: process.env.SOLANA_RPC,
  SLIPPAGE_BPS: parseInt(process.env.SLIPPAGE_BPS) || 50,
  PORT: process.env.PORT || 3000,
};

const connection = new Connection(config.SOLANA_RPC, 'confirmed');
let wallet = null;

if (config.WALLET_PRIVATE_KEY) {
  try {
    wallet = Keypair.fromSecretKey(bs58.decode(config.WALLET_PRIVATE_KEY));
    console.log("✅ Wallet loaded successfully");
  } catch (e) {
    console.error("❌ Wallet load failed:", e.message);
  }
}

const bot = new TelegramBot(config.TELEGRAM_TOKEN, { polling: true });

// Helper Functions
async function getBalance() {
  if (!wallet) return "❌ Wallet belum diatur";
  try {
    const bal = await connection.getBalance(wallet.publicKey);
    return (bal / 1_000_000_000).toFixed(4) + " SOL";
  } catch {
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

// Commands
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, 
    `🚀 *HervBot - AI Trading Agent Solana*\n\n` +
    `Wallet : ${wallet ? '✅ Aktif' : '❌ Belum diatur'}\n` +
    `RPC    : Helius\n\n` +
    `Perintah:\n` +
    `/saldo\n` +
    `/harga <token>\n` +
    `/buy <token> <jumlah SOL>\n` +
    `/sell <token> <jumlah token>`
  );
});

bot.onText(/\/saldo/, async (msg) => {
  const balance = await getBalance();
  bot.sendMessage(msg.chat.id, `💼 Saldo Wallet:\n${balance}`);
});

bot.onText(/\/harga (.+)/, async (msg, match) => {
  const price = await getTokenPrice(match[1]);
  bot.sendMessage(msg.chat.id, price ? `💰 ${match[1].toUpperCase()}: $${price}` : "❌ Harga tidak ditemukan");
});

bot.on('message', (msg) => {
  if (msg.text && !msg.text.startsWith('/')) {
    bot.sendMessage(msg.chat.id, "Bot sedang dioptimasi. Gunakan /start untuk melihat perintah.");
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(config.PORT, () => {
  console.log(`✅ HervBot berjalan di port ${config.PORT}`);
});
