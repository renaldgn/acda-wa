const mongoose = require('mongoose');

// Skema untuk sesi WhatsApp
const sessionSchema = new mongoose.Schema({
    sessionId: { type: String, required: true },
    id: { type: String, required: true },
    data: { type: String, required: true }
});
const SessionModel = mongoose.model('whatsapp_sessions', sessionSchema);

const connectDB = () => {
    return new Promise((resolve) => {
        const connect = async () => {
            try {
                // Tambahkan opsi serverSelectionTimeoutMS
                await mongoose.connect(process.env.MONGODB_URI, {
                    serverSelectionTimeoutMS: 5000, // Coba koneksi selama 5 detik
                    socketTimeoutMS: 45000,
                });
                console.log('✅ MongoDB Terhubung!');
                resolve();
            } catch (error) {
                console.error('❌ Gagal terhubung ke MongoDB:', error.message);
                console.log('🔄 Mencoba menghubungkan ulang ke MongoDB dalam 5 detik...');
                // Jika gagal di awal, coba lagi setelah 5 detik
                setTimeout(connect, 5000);
            }
        };
        connect();
    });
};

// Event Listener jika MongoDB terputus di tengah jalan
mongoose.connection.on('disconnected', () => {
    console.log('⚠️ Koneksi MongoDB terputus! Mongoose akan mencoba reconnect otomatis...');
});

mongoose.connection.on('reconnected', () => {
    console.log('✅ Koneksi MongoDB berhasil dipulihkan!');
});

module.exports = { connectDB, SessionModel };