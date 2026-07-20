require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { default: makeWASocket, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const cookieParser = require('cookie-parser');

const { connectDB, SessionModel } = require('./connect/db');
const useMongoDBAuthState = require('./connect/mongoAuthState');
const DeviceModel = require('./connect/DeviceModel');

const createApiRoutes = require('./routes/api');
const { authRouter, verifyToken } = require('./routes/auth');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Map untuk menyimpan sesi aktif dan counter percobaan koneksi
const sessions = new Map();
const connectionAttempts = new Map();

app.use(express.static('public'));
app.use(express.json());
app.use(cookieParser());

// --- FUNGSI UNTUK MEMULIHKAN SESI ---
async function initSessions() {
    try {
        // 1. Ambil semua device yang statusnya 'Terhubung'
        const activeDevices = await DeviceModel.find({ status: 'Terhubung' });

        if (activeDevices.length === 0) {
            console.log('ℹ️ Tidak ada sesi yang perlu dipulihkan.');
            return;
        }

        console.log(`🔄 Memulihkan ${activeDevices.length} sesi aktif...`);

        for (const device of activeDevices) {
            // 2. Kirim userId ke connectToWhatsApp agar status sinkron
            // Pastikan Anda sudah mengubah definisi function connectToWhatsApp(phoneNumber, userId)
            connectToWhatsApp(device.phoneNumber, device.userId);

            // Beri jeda 1 detik agar tidak membombardir server WhatsApp
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    } catch (error) {
        console.error('❌ Gagal memulihkan sesi:', error);
    }
}

connectDB().then(() => initSessions());

// --- FUNGSI UTAMA BAILEYS ---
async function connectToWhatsApp(phoneNumber, userId = null) {
    if (sessions.has(phoneNumber)) {
        try { sessions.get(phoneNumber).end(); } catch (e) { }
        sessions.delete(phoneNumber);
    }

    const { state, saveCreds } = await useMongoDBAuthState(phoneNumber);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['Ubuntu', 'Chrome', '20.0.04']
    });

    sock.ev.on('creds.update', saveCreds);
    
    if (!sock.authState.creds.registered) {
        // Buat fungsi rekursif untuk mencoba request ulang jika koneksi belum siap
        const requestPairing = async (attempt = 1) => {
            try {
                // Beri jeda agak lama agar websocket benar-benar siap (terutama untuk sesi ke-2 dst)
                await new Promise(resolve => setTimeout(resolve, 4000));

                console.log(`⏳ Meminta pairing code untuk ${phoneNumber} (Percobaan ${attempt})...`);
                const code = await sock.requestPairingCode(phoneNumber);

                // Kirim kode ke frontend
                io.emit('pairing-code', { phoneNumber, code });

            } catch (err) {
                // Jika koneksi belum siap (428) atau tertutup
                if (err?.output?.statusCode === 428 || err?.message === 'Connection Closed') {
                    console.log(`⚠️ Koneksi belum siap untuk ${phoneNumber}.`);

                    if (attempt < 3) {
                        console.log(`🔄 Mengulang request pairing code dalam 2 detik...`);
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        return requestPairing(attempt + 1); // Coba lagi
                    } else {
                        // BERITAHU FRONTEND JIKA GAGAL TOTAL AGAR TIDAK STUCK
                        io.emit('status', {
                            phoneNumber,
                            status: 'Gagal meminta kode. Harap hapus perangkat dan coba lagi.'
                        });
                    }
                } else {
                    console.error(`❌ Error request pairing code ${phoneNumber}:`, err);
                    io.emit('status', {
                        phoneNumber,
                        status: 'Terjadi kesalahan sistem. Cek terminal server.'
                    });
                }
            }
        };

        // Jalankan fungsi
        requestPairing();
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        // --- 1. Sinyal Sedang Menghubungkan ---
        if (connection === 'connecting') {
            io.emit('status', { phoneNumber, status: 'Menghubungkan...' });
        }
        // --- 2. Sinyal Berhasil Terhubung ---
        else if (connection === 'open') {
            connectionAttempts.delete(phoneNumber);
            sessions.set(phoneNumber, sock);
            console.log(`✅ ${phoneNumber} terhubung!`);

            // Update status di database DeviceModel menjadi Terhubung
            try {// Pastikan record ada di DeviceModel
                if (userId) {
                    await DeviceModel.findOneAndUpdate(
                        { phoneNumber },
                        { userId, status: 'Terhubung', connectedAt: new Date() },
                        { upsert: true }
                    );
                }
            } catch (dbErr) { console.error('Gagal update DeviceModel:', dbErr); }

            io.emit('status', { phoneNumber, status: 'Terhubung' });
        }
        // --- 3. Sinyal Koneksi Terputus / Gagal ---
        else if (connection === 'close') {
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log(`⚠️ Koneksi ${phoneNumber} terputus. Kode:`, statusCode);

            // Handle Error Sesi Korup / Logged Out (401)
            if (statusCode === 401 || statusCode === DisconnectReason.loggedOut) {
                console.log(`❌ Sesi ${phoneNumber} tidak valid. Mencoba logout otomatis...`);

                // BEST EFFORT: Coba paksa logout dari HP
                try {
                    await sock.logout();
                    console.log(`✅ Berhasil mengirim perintah logout ke HP untuk sesi ${phoneNumber}`);
                } catch (err) {
                    console.log(`⚠️ Gagal logout otomatis ke HP (wajar karena sesi rusak). User harus logout manual.`);
                }

                // Hapus data dari Database (Session & Device) & Memori
                console.log(`Menghapus database sesi ${phoneNumber}...`);
                await SessionModel.deleteMany({ sessionId: phoneNumber });

                try {
                    await DeviceModel.deleteOne({ phoneNumber });
                } catch (dbErr) { console.error('Gagal hapus DeviceModel:', dbErr); }

                sessions.delete(phoneNumber);

                // Beritahu Frontend
                io.emit('status', {
                    phoneNumber,
                    status: 'Sesi kedaluwarsa. Jika perangkat masih ada di HP, harap hapus manual lalu hubungkan ulang.'
                });

                return;
            }

            // --- Logika Reconnect untuk Error Jaringan (503, 440, 408) ---
            if (statusCode === 503 || statusCode === 440 || statusCode === 408) {
                const attempts = (connectionAttempts.get(phoneNumber) || 0) + 1;
                connectionAttempts.set(phoneNumber, attempts);
                const delay = Math.min(attempts * 10000, 60000);

                console.log(`🔄 Error ${statusCode}. Reconnect ${phoneNumber} dalam ${delay / 1000} detik...`);
                io.emit('status', { phoneNumber, status: `Menunggu jaringan (${delay / 1000}s)...` });

                setTimeout(() => connectToWhatsApp(phoneNumber), delay);
            }
            // Default retry untuk error lain
            else {
                console.log(`🔄 Mencoba menghubungkan ulang ${phoneNumber}...`);
                io.emit('status', { phoneNumber, status: 'Menghubungkan ulang...' });

                setTimeout(() => connectToWhatsApp(phoneNumber), 5000);
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const sender = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

        if (text?.toLowerCase() === 'ping') {
            // 1. Kirim status "Sedang mengetik..."
            await sock.sendPresenceUpdate('composing', sender);

            // 2. Beri jeda buatan selama 1 detik
            await new Promise(resolve => setTimeout(resolve, 1000));

            // 3. Kirim pesan balasannya
            await sock.sendMessage(sender, { text: 'Pong! 🤖' });

            // 4. Hentikan status mengetik
            await sock.sendPresenceUpdate('paused', sender);
        }
    });
}

app.use('/api/auth', authRouter);
const apiRoutes = createApiRoutes(sessions, connectToWhatsApp);
app.use('/api', verifyToken, apiRoutes);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server berjalan di http://localhost:${PORT}`));