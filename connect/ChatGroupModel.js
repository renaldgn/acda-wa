const mongoose = require('mongoose');

const chatSchema = new mongoose.Schema({
    phoneNumber: { type: String, required: true }, // Nomor bot penerima
    groupJid: { type: String, required: true },    // JID Grup (berakhiran @g.us)
    senderJid: { type: String, required: true },   // Pengirim pesan di dalam grup
    messageId: { type: String, unique: true, required: true }, // ID Pesan unik untuk cegah duplikasi
    message: { type: String },                     // Isi teks pesan
    timestamp: { type: Date, default: Date.now }   // Waktu pesan diterima
});

module.exports = mongoose.model('Chat_group', chatSchema);