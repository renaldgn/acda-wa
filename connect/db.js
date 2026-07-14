// db.js
const mongoose = require('mongoose');

// Definisi Struktur Data untuk sesi Baileys
const SessionSchema = new mongoose.Schema({
    sessionId: { type: String, required: true }, // Untuk menyimpan nomor WA sebagai ID
    id: { type: String, required: true },        // Kategori key (creds, app-state, dll)
    data: { type: String, required: true }       // Data Baileys berupa string JSON
});

// Indexing agar proses pencarian (baca/tulis) saat login sangat cepat
SessionSchema.index({ sessionId: 1, id: 1 }, { unique: true });

const SessionModel = mongoose.model('whatsapp_sessions', SessionSchema);

// Fungsi untuk koneksi ke Database
async function connectDB() {
    try {
        // Ganti URL ini jika kamu pakai MongoDB Atlas (Cloud)
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('✅ Terhubung ke database MongoDB');
    } catch (err) {
        console.error('❌ Gagal terhubung ke MongoDB:', err);
    }
}

module.exports = { SessionModel, connectDB };