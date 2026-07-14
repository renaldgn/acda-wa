require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { default: makeWASocket, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');

const { connectDB, SessionModel } = require('./connect/db');
const useMongoDBAuthState = require('./connect/mongoAuthState');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- 🌟 TAMBAHAN BARU: SESSION POOL ---
// Berfungsi untuk menyimpan soket-soket yang sedang online
const sessions = new Map();

app.use(express.static('public'));
app.use(express.json());

// --- 🌟 TAMBAHAN BARU: FUNGSI UNTUK MEMULIHKAN SESI ---
async function initSessions() {
    try {
        // Mencari semua sessionId yang unik (tidak duplikat) di dalam koleksi database
        const sessionIds = await SessionModel.distinct('sessionId');

        if (sessionIds.length === 0) {
            console.log('ℹ️ Tidak ada sesi yang tersimpan di database.');
            return;
        }

        console.log(`🔄 Ditemukan ${sessionIds.length} sesi di database. Memulihkan koneksi...`);

        // Looping untuk menyalakan kembali setiap nomor WA
        for (const sessionId of sessionIds) {
            console.log(`Menghubungkan kembali nomor: ${sessionId}...`);
            // Panggil fungsi Baileys, ia akan otomatis membaca creds dari DB 
            // dan langsung berstatus 'open' tanpa minta Pairing Code lagi
            connectToWhatsApp(sessionId);

            // Beri sedikit jeda (opsional) agar tidak terlalu spam ke server WA jika sesinya banyak
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    } catch (error) {
        console.error('❌ Gagal memulihkan sesi dari database:', error);
    }
}

// Ubah cara pemanggilan connectDB menjadi seperti ini agar initSessions berjalan setelah DB siap
connectDB().then(() => {
    initSessions();
});

// 1. KITA BUNGKUS LOGIKA BAILEYS KE DALAM FUNGSI INI
async function connectToWhatsApp(phoneNumber) {
    const { state, saveCreds } = await useMongoDBAuthState(phoneNumber);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['Ubuntu', 'Chrome', '20.0.04']
    });

    sock.ev.on('creds.update', saveCreds);

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                console.log(`Pairing code untuk ${phoneNumber}: ${code}`);
                io.emit('pairing-code', { phoneNumber, code });
            } catch (err) {
                console.error('Gagal meminta pairing code:', err);
            }
        }, 3000);
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            io.emit('status', { phoneNumber, status: 'Connected!' });
            console.log(`✅ Nomor ${phoneNumber} berhasil terhubung! Data aman di database.`);

            // --- 🌟 TAMBAHAN BARU: SIMPAN SOKET KE POOL ---
            sessions.set(phoneNumber, sock);
        }
        else if (connection === 'close') {
            // --- 🌟 TAMBAHAN BARU: HAPUS SOKET DARI POOL SAAT TERPUTUS ---
            sessions.delete(phoneNumber);

            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;

            console.log(`⚠️ Koneksi untuk ${phoneNumber} terputus. Alasan:`, reason);

            if (reason === DisconnectReason.loggedOut) { // 401
                console.log(`❌ Perangkat dikeluarkan (Logged Out). Menghapus data dari database...`);
                await SessionModel.deleteMany({ sessionId: phoneNumber });
                io.emit('status', { phoneNumber, status: 'Logged out. Silakan login ulang.' });
            }
            else if (reason === DisconnectReason.restartRequired) { // 515
                console.log('🔄 Diperlukan restart (Server meminta restart). Menghubungkan ulang...');
                connectToWhatsApp(phoneNumber);
            }
            else if (reason === DisconnectReason.connectionClosed) { // 428 / 408
                console.log('🔄 Koneksi terputus, mencoba menghubungkan kembali...');
                connectToWhatsApp(phoneNumber);
            }
            else if (reason === DisconnectReason.badSession) { // 500
                console.log(`❌ Sesi buruk/korup. Menghapus data dari database...`);
                await SessionModel.deleteMany({ sessionId: phoneNumber });
                io.emit('status', { phoneNumber, status: 'Sesi korup, silakan minta kode lagi' });
            }
            else {
                console.log('🔄 Error tidak diketahui, mencoba menghubungkan ulang...');
                connectToWhatsApp(phoneNumber);
            }
        }
    });

    // --- 🌟 TAMBAHAN BARU: MENDENGARKAN PESAN MASUK ---
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];

        // Jangan proses pesan dari diri sendiri atau jika tidak ada teksnya
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text;

        console.log(`[${phoneNumber}] Pesan masuk dari ${sender}: ${textMessage}`);

        // Contoh Auto-Reply: Membalas 'ping' dengan 'Pong!'
        if (textMessage && textMessage.toLowerCase() === 'ping') {
            await sock.sendMessage(sender, { text: 'Pong! Bot berjalan lancar 🤖' });
        }
    });
}

// 2. ENDPOINT API UNTUK LOGIN
app.post('/api/start-session', async (req, res) => {
    const { phoneNumber } = req.body;

    if (!phoneNumber) return res.status(400).json({ error: 'Nomor WA wajib diisi' });

    try {
        connectToWhatsApp(phoneNumber);
        res.json({ message: 'Memproses permintaan login...' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Terjadi kesalahan internal' });
    }
});

// --- 🌟 TAMBAHAN BARU: ENDPOINT API UNTUK MENGIRIM PESAN ---
app.post('/api/send-message', async (req, res) => {
    const { senderNumber, targetNumber, message } = req.body;

    // Validasi input JSON
    if (!senderNumber || !targetNumber || !message) {
        return res.status(400).json({ error: 'senderNumber, targetNumber, dan message wajib diisi' });
    }

    // Ambil soket bot yang sedang online dari Map sessions
    const sock = sessions.get(senderNumber);
    if (!sock) {
        return res.status(401).json({ error: `Nomor pengirim ${senderNumber} tidak aktif. Silakan login terlebih dahulu.` });
    }

    try {
        // Format nomor target dengan suffix WhatsApp
        const jid = `${targetNumber}@s.whatsapp.net`;

        // Eksekusi kirim pesan
        await sock.sendMessage(jid, { text: message });

        res.json({ success: true, message: 'Pesan berhasil dikirim!' });
    } catch (error) {
        console.error('Error saat mengirim pesan:', error);
        res.status(500).json({ error: 'Gagal mengirim pesan' });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('🚀 Server berjalan di http://localhost:3000');
});