const { default: makeWASocket, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');

const { SessionModel } = require('../connect/db');
const useMongoDBAuthState = require('../connect/mongoAuthState');
const DeviceModel = require('../connect/DeviceModel');

// Map untuk menyimpan sesi aktif dan counter percobaan koneksi
const sessions = new Map();
const connectionAttempts = new Map();

let io; // Akan diisi dari index.js

// Setter untuk instance Socket.io
const setSocketIO = (socketIoInstance) => {
    io = socketIoInstance;
};

// --- FUNGSI UNTUK MEMULIHKAN SESI (Diperpanjang jedanya agar aman dari 440) ---
async function initSessions() {
    try {
        const activeDevices = await DeviceModel.find({ status: 'Terhubung' });

        if (activeDevices.length === 0) {
            console.log('ℹ️ Tidak ada sesi yang perlu dipulihkan.');
            return;
        }

        console.log(`🔄 Memulihkan ${activeDevices.length} sesi aktif ke dalam memori...`);

        for (const device of activeDevices) {
            const sessionKey = device.phoneNumber;

            if (sessions.has(sessionKey)) {
                console.log(`⚠️ Sesi ${sessionKey} sudah aktif di memori. Melewati pemulihan.`);
                continue;
            }

            console.log(`🔌 Menghubungkan kembali sesi: ${sessionKey}`);
            connectToWhatsApp(device.phoneNumber, device.userId);

            // PERBAIKAN: Ubah jeda antar perangkat menjadi 6 detik untuk menghindari Rate Limit & Error 440
            await new Promise(resolve => setTimeout(resolve, 6000));
        }

        console.log('✅ Proses pemulihan semua sesi selesai.');
    } catch (error) {
        console.error('❌ Gagal memulihkan sesi:', error);
    }
}

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
        const requestPairing = async (attempt = 1) => {
            try {
                await new Promise(resolve => setTimeout(resolve, 4000));
                console.log(`⏳ Meminta pairing code untuk ${phoneNumber} (Percobaan ${attempt})...`);
                const code = await sock.requestPairingCode(phoneNumber);

                if (io) io.emit('pairing-code', { phoneNumber, code });
            } catch (err) {
                if (err?.output?.statusCode === 428 || err?.message === 'Connection Closed') {
                    console.log(`⚠️ Koneksi belum siap untuk ${phoneNumber} (Error 428).`);
                    if (attempt < 4) {
                        console.log(`🔄 Mengulang request pairing code dalam 2 detik...`);
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        return requestPairing(attempt + 1);
                    } else {
                        console.log(`❌ Batal meminta pairing code untuk ${phoneNumber}, batas percobaan habis.`);
                        if (io) io.emit('status', { phoneNumber, status: 'Koneksi lambat. Harap hapus perangkat dan coba lagi.' });
                    }
                } else {
                    console.error(`❌ Error request pairing code ${phoneNumber}:`, err);
                    if (io) io.emit('status', { phoneNumber, status: 'Gagal meminta kode pairing. Cek terminal server.' });
                }
            }
        };
        requestPairing();
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'connecting') {
            if (io) io.emit('status', { phoneNumber, status: 'Menghubungkan...' });
        }
        else if (connection === 'open') {
            connectionAttempts.delete(phoneNumber);
            sessions.set(phoneNumber, sock);
            console.log(`✅ ${phoneNumber} terhubung!`);

            try {
                if (userId) {
                    await DeviceModel.findOneAndUpdate(
                        { phoneNumber },
                        { userId, status: 'Terhubung', connectedAt: new Date() },
                        { upsert: true, returnDocument: 'after' }
                    );
                }
            } catch (dbErr) { console.error('Gagal update DeviceModel:', dbErr); }

            if (io) io.emit('status', { phoneNumber, status: 'Terhubung' });
        }
        else if (connection === 'close') {
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log(`⚠️ Koneksi ${phoneNumber} terputus. Kode:`, statusCode);

            if (statusCode === 401 || statusCode === DisconnectReason.loggedOut) {
                console.log(`❌ Sesi ${phoneNumber} tidak valid. Mencoba logout otomatis...`);
                try {
                    await sock.logout();
                    console.log(`✅ Berhasil mengirim perintah logout ke HP untuk sesi ${phoneNumber}`);
                } catch (err) { }

                console.log(`Menghapus database sesi ${phoneNumber}...`);
                await SessionModel.deleteMany({ sessionId: phoneNumber });
                try { await DeviceModel.deleteOne({ phoneNumber }); } catch (dbErr) { }

                sessions.delete(phoneNumber);
                if (io) io.emit('status', { phoneNumber, status: 'Sesi kedaluwarsa. Hapus manual lalu hubungkan ulang.' });
                return;
            }

            // Penanganan Khusus Error 440 (Conflict) atau Error Jaringan Lainnya
            if (statusCode === 503 || statusCode === 440 || statusCode === 408) {
                const attempts = (connectionAttempts.get(phoneNumber) || 0) + 1;
                connectionAttempts.set(phoneNumber, attempts);

                // Beri jeda lebih panjang untuk error 440 agar socket lama bersih total
                const delay = statusCode === 440 ? Math.max(attempts * 15000, 30000) : Math.min(attempts * 10000, 60000);

                console.log(`🔄 Error ${statusCode}. Reconnect ${phoneNumber} dalam ${delay / 1000} detik...`);
                if (io) io.emit('status', { phoneNumber, status: `Menunggu jaringan (${delay / 1000}s)...` });

                setTimeout(() => connectToWhatsApp(phoneNumber, userId), delay);
            } else {
                console.log(`🔄 Mencoba menghubungkan ulang ${phoneNumber}...`);
                if (io) io.emit('status', { phoneNumber, status: 'Menghubungkan ulang...' });

                setTimeout(() => connectToWhatsApp(phoneNumber, userId), 5000);
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const sender = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

        if (text?.toLowerCase() === 'ping') {
            await sock.sendPresenceUpdate('composing', sender);
            await new Promise(resolve => setTimeout(resolve, 1000));
            await sock.sendMessage(sender, { text: 'Pong! 🤖' });
            await sock.sendPresenceUpdate('paused', sender);
        }
    });

    return sock;
}

module.exports = {
    sessions,
    setSocketIO,
    initSessions,
    connectToWhatsApp
};