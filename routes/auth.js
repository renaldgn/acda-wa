const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const UserModel = require('../connect/UserModel');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;

// --- MIDDLEWARE PELINDUNG ---
// Gunakan ini di rute mana pun yang ingin Anda lindungi
const verifyToken = (req, res, next) => {
    // Ambil token dari cookie
    const token = req.cookies.token;

    if (!token || !JWT_SECRET) {
        return res.status(401).json({ error: 'Akses ditolak. Silakan login terlebih dahulu.' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded; // Simpan data user ke request
        next(); // Lanjut ke proses berikutnya
    } catch (err) {
        return res.status(403).json({ error: 'Sesi tidak valid atau telah kedaluwarsa.' });
    }
};

// --- ENDPOINT REGISTER ---
router.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username dan password wajib diisi' });

    try {
        // Cek apakah user sudah ada
        const existingUser = await UserModel.findOne({ username });
        if (existingUser) return res.status(400).json({ error: 'Username sudah digunakan' });

        // Enkripsi password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Simpan ke database
        const newUser = new UserModel({ username, password: hashedPassword });
        await newUser.save();

        res.status(201).json({ message: 'Registrasi berhasil!' });
    } catch (error) {
        res.status(500).json({ error: 'Terjadi kesalahan pada server' });
    }
});

// --- ENDPOINT LOGIN ---
router.post('/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        // Cari user
        const user = await UserModel.findOne({ username });
        if (!user) return res.status(400).json({ error: 'Username atau password salah' });

        // Cek password
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(400).json({ error: 'Username atau password salah' });

        // Buat JWT Token (Berlaku 1 Hari)
        const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '1d' });

        // Set token ke dalam HttpOnly Cookie
        res.cookie('token', token, {
            httpOnly: true, // Tidak bisa diakses via JavaScript (Aman dari XSS)
            secure: process.env.NODE_ENV === 'production', // True jika pakai HTTPS
            maxAge: 24 * 60 * 60 * 1000 // 1 Hari
        });

        res.json({ message: 'Login berhasil', username: user.username });
    } catch (error) {
        res.status(500).json({ error: 'Terjadi kesalahan pada server' });
    }
});

// --- ENDPOINT LOGOUT ---
router.post('/logout', (req, res) => {
    res.clearCookie('token');
    res.json({ message: 'Logout berhasil' });
});

// --- ENDPOINT CEK SESI (Untuk UI) ---
router.get('/me', verifyToken, (req, res) => {
    res.json({ user: req.user });
});

module.exports = { authRouter: router, verifyToken };