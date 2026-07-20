// routes/admin.js
const express = require('express');
const fs = require('fs');
// const util = require('util');
const path = require('path');
const User = require('../connect/UserModel');
const DeviceModel = require('../connect/DeviceModel');
const { SessionModel } = require('../connect/db');
const { sessions } = require('../services/whatsappService'); // <-- Import sessions Map dari service
const router = express.Router();

// 1. LIHAT SEMUA USER (Hanya Admin)
router.get('/users', async (req, res) => {
    try {
        const users = await User.find({}, '-password');
        res.json({ success: true, data: users });
    } catch (error) {
        res.status(500).json({ error: 'Gagal mengambil data user.' });
    }
});

// 2. UBAH ROLE USER (Hanya Admin)
router.put('/users/:id/role', async (req, res) => {
    const { role } = req.body;

    if (!['user', 'admin'].includes(role)) {
        return res.status(400).json({ error: 'Role tidak valid!' });
    }

    try {
        const updatedUser = await User.findByIdAndUpdate(
            req.params.id,
            { role },
            { new: true }
        ).select('-password');

        if (!updatedUser) {
            return res.status(404).json({ error: 'User tidak ditemukan.' });
        }

        res.json({ success: true, message: 'Role berhasil diubah!', data: updatedUser });
    } catch (error) {
        res.status(500).json({ error: 'Gagal mengubah role user.' });
    }
});

// 3. AMBIL SEMUA PERANGKAT (GLOBAL)
router.get('/devices', async (req, res) => {
    try {
        const devices = await DeviceModel.find({});
        res.json({ success: true, data: devices });
    } catch (error) {
        res.status(500).json({ error: 'Gagal mengambil data perangkat.' });
    }
});

// 4. HAPUS / FORCE LOGOUT PERANGKAT & SESI WHATSAPP (DENGAN AUTO-LOGOUT)
router.delete('/devices/:phoneNumber', async (req, res) => {
    const { phoneNumber } = req.params;
    try {
        // A. Jika sesi masih aktif di memori RAM server, paksa logout ke WhatsApp
        if (sessions.has(phoneNumber)) {
            const sock = sessions.get(phoneNumber);
            try {
                await sock.logout(); // Memerintahkan HP untuk mencabut sesi tertaut
                console.log(`🔌 Sinyal logout berhasil dikirim ke perangkat +${phoneNumber}`);
            } catch (err) {
                console.log(`⚠️ Gagal mengirim sinyal logout Baileys untuk +${phoneNumber}, melanjutkan pembersihan database...`);
            }

            try {
                sock.end();
            } catch (e) { }

            sessions.delete(phoneNumber);
        }

        // B. Hapus data dari koleksi DeviceModel & SessionModel (whatsapp_sessions)
        await DeviceModel.deleteOne({ phoneNumber });
        await SessionModel.deleteMany({ sessionId: phoneNumber });

        res.json({ success: true, message: `Perangkat +${phoneNumber} berhasil diputus dan dihapus dari database.` });
    } catch (error) {
        console.error('Error saat force delete device:', error);
        res.status(500).json({ error: 'Gagal menghapus perangkat.' });
    }
});

// 5. AMBIL LIST FOLDER/FILE LOG YANG TERSEDIA (Disesuaikan untuk struktur nested)
router.get('/logs/list', async (req, res) => {
    try {
        // Arahkan ke root folder 'logs' di luar folder routes
        const logsRootDir = path.join(__dirname, '..', 'logs');

        if (!fs.existsSync(logsRootDir)) {
            return res.json({ success: true, data: [] });
        }

        let logFiles = [];

        // Fungsi rekursif untuk masuk ke dalam folder (misal: 2026 -> 07 -> file.log)
        function walkDir(currentPath) {
            const entries = fs.readdirSync(currentPath, { withFileTypes: true });
            for (let entry of entries) {
                const fullPath = path.join(currentPath, entry.name);
                if (entry.isDirectory()) {
                    walkDir(fullPath);
                } else if (entry.isFile() && entry.name.endsWith('.log')) {
                    // Ambil path relatif agar menjadi '2026/07/namanya.log'
                    const relativePath = path.relative(logsRootDir, fullPath).replace(/\\/g, '/');
                    logFiles.push(relativePath);
                }
            }
        }

        walkDir(logsRootDir);
        // Urutkan dari file terbaru
        logFiles.sort().reverse();

        res.json({ success: true, data: logFiles });
    } catch (error) {
        console.error('Error membaca list log:', error);
        res.status(500).json({ error: 'Gagal mengambil daftar file log.' });
    }
});

// 6. BACA ISI FILE LOG TERTENTU
router.get('/logs/read', async (req, res) => {
    try {
        let { file } = req.query; // Contoh: 2026/07/2026-07-20.log
        if (!file) {
            return res.status(400).json({ error: 'Parameter file log wajib diisi.' });
        }

        // Normalisasi path untuk keamanan
        file = file.replace(/\\/g, '/');
        const logsRootDir = path.join(__dirname, '..', 'logs');
        const fullPath = path.join(logsRootDir, file);

        // Validasi agar path tetap berada di dalam direktori logs
        if (!fullPath.startsWith(logsRootDir) || !fs.existsSync(fullPath)) {
            return res.status(404).json({ error: 'File log tidak ditemukan.' });
        }

        const logContent = fs.readFileSync(fullPath, 'utf8');
        res.json({ success: true, content: logContent });
    } catch (error) {
        console.error('Error membaca isi log:', error);
        res.status(500).json({ error: 'Gagal membaca isi file log.' });
    }
});

module.exports = router;