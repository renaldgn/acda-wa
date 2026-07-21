// routes/api.js
const express = require('express');
const DeviceModel = require('../connect/DeviceModel'); // <-- Tambahan DeviceModel
const { SessionModel } = require('../connect/db');

// Set untuk melacak nomor yang sedang dalam proses request login (Mencegah Spam)
const processingNumbers = new Set();

// Fungsi ini akan menerima variabel sessions dan connectToWhatsApp dari index.js
function createApiRoutes(sessions, connectToWhatsApp) {
    const router = express.Router();

    // 1. Endpoint untuk Login / Minta Kode
    router.post('/start-session', async (req, res) => {
        const { phoneNumber } = req.body;
        const userId = req.user.id;

        if (!phoneNumber) return res.status(400).json({ error: 'Nomor WA wajib diisi' });

        // CEK APAKAH SUDAH ADA SOKET YANG JALAN
        if (sessions.has(phoneNumber)) {
            return res.json({ message: 'Sesi sudah berjalan!' });
        }

        // CEK APAKAH SEDANG DIPROSES (Mencegah Spam Klik / Rate Limiting)
        if (processingNumbers.has(phoneNumber)) {
            return res.status(429).json({ error: 'Tunggu sebentar, permintaan sebelumnya sedang diproses!' });
        }

        try {
            // Tandai nomor sedang diproses
            processingNumbers.add(phoneNumber);

            // --- TAMBAHAN: Simpan Nomor HP & User ID ke Database ---
            await DeviceModel.findOneAndUpdate(
                { phoneNumber }, // Cari berdasarkan nomor HP
                {
                    userId: userId,
                    status: 'Menghubungkan...'
                },
                { upsert: true, returnDocument: 'after' } // Buat baru jika belum ada
            );
            // --------------------------------------------------------

            connectToWhatsApp(phoneNumber, userId);

            // Hapus tanda proses setelah 15 detik (waktu aman untuk Baileys generate kode)
            setTimeout(() => processingNumbers.delete(phoneNumber), 15000);

            res.json({ message: 'Memproses permintaan login...' });
        } catch (error) {
            // Jika gagal eksekusi, segera hapus dari daftar antrean
            processingNumbers.delete(phoneNumber);
            console.log(error)
            res.status(500).json({ error: 'Terjadi kesalahan' });
        }
    });

    // 2. Endpoint untuk Mengirim Pesan
    router.post('/send-message', async (req, res) => {
        const { senderNumber, targetNumber, message } = req.body;

        // Validasi input
        if (!senderNumber || !targetNumber || !message) {
            return res.status(400).json({ error: 'senderNumber, targetNumber, dan message wajib diisi' });
        }

        // Ambil soket bot yang sedang online dari Map sessions
        const sock = sessions.get(senderNumber);
        if (!sock) {
            return res.status(401).json({ error: `Nomor pengirim ${senderNumber} tidak aktif. Silakan login terlebih dahulu.` });
        }

        try {
            const jid = `${targetNumber}@s.whatsapp.net`;

            // Eksekusi kirim pesan
            await sock.sendMessage(jid, { text: message });

            res.json({ success: true, message: 'Pesan berhasil dikirim!' });
        } catch (error) {
            console.error('Error saat mengirim pesan:', error);
            res.status(500).json({ error: 'Gagal mengirim pesan' });
        }
    });

    // 3. Endpoint untuk Logout Session WA
    router.post('/end-session', async (req, res) => {
        const { phoneNumber } = req.body;
        const sock = sessions.get(phoneNumber);

        // 1. Coba logout dengan aman
        if (sock) {
            try {
                await sock.logout();
            } catch (error) {
                console.log(`⚠️ Gagal logout resmi, mencoba pembersihan paksa untuk ${phoneNumber}`);
            }
        }

        // 2. PEMBEBASAN PAKSA (Force Cleanup)
        // Tanpa mempedulikan apakah sock.logout() berhasil atau tidak,
        // kita bersihkan semua data terkait agar user bisa pairing ulang.
        try {
            // Hapus dari memori
            if (sessions.has(phoneNumber)) {
                try { sessions.get(phoneNumber).end(); } catch (e) { }
                sessions.delete(phoneNumber);
            }

            // Hapus dari database sesi (Baileys)
            await SessionModel.deleteMany({ sessionId: phoneNumber });

            // Hapus dari database Device (DeviceModel) agar status di UI update
            // Pastikan Anda sudah import DeviceModel di file ini
            await DeviceModel.deleteOne({ phoneNumber });

            res.json({ message: 'Sesi telah dibersihkan dari sistem.' });
        } catch (error) {
            console.error('Error saat force cleanup:', error);
            res.status(500).json({ error: 'Gagal membersihkan sesi.' });
        }
    });

    // 4. Endpoint untuk ambil semua device milik user yang sedang login (berdasarkan token JWT)
    router.get('/devices', async (req, res) => {
        try {
            const userId = req.user.id;
            const devices = await DeviceModel.find({ userId: userId });

            res.json(devices);
        } catch (error) {
            res.status(500).json({ error: 'Gagal mengambil data perangkat' });
        }
    });

    // 5. Endpoint untuk ambil semua grup
    // 5. Endpoint untuk ambil semua grup
    router.get('/groups', async (req, res) => {
        try {
            const { userId } = req.query; // Parameter dari frontend (bisa berupa phoneNumber atau userId)

            if (!userId) {
                return res.status(400).json({ success: false, message: 'Parameter perangkat tidak boleh kosong.' });
            }

            // 1. Cek langsung di Map berdasarkan key (misal parameter yang dikirim adalah phoneNumber)
            let sock = sessions.get(userId);

            // 2. Jika tidak ketemu langsung di Map, kemungkinan `userId` yang dikirim adalah ID Database / User ID. 
            // Mari kita cari data Device di MongoDB berdasarkan userId atau phoneNumber.
            if (!sock) {
                const device = await DeviceModel.findOne({
                    $or: [{ userId: userId }, { phoneNumber: userId }]
                });

                if (device) {
                    // Cek kembali menggunakan nomor telepon dari data database yang ditemukan
                    sock = sessions.get(device.phoneNumber);
                }
            }

            // Jika setelah dicari tetap tidak ada socket yang aktif di memori
            if (!sock) {
                return res.status(404).json({
                    success: false,
                    message: `Sesi untuk perangkat '${userId}' tidak ditemukan di memori server atau belum terhubung.`
                });
            }

            // Ambil daftar grup menggunakan fungsi bawaan Baileys
            const fetchedGroups = await sock.groupFetchAllParticipating();
            const groupsArray = Object.values(fetchedGroups);

            res.json({ success: true, groups: groupsArray });

        } catch (error) {
            console.error('❌ Gagal mengambil data grup:', error);
            res.status(500).json({ success: false, message: 'Gagal mengambil data grup dari WhatsApp.' });
        }
    });

    return router;
}

module.exports = createApiRoutes;