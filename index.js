require('dotenv').config();

// Inisialisasi Logger Custom (Harus dipanggil paling atas)
const initLogger = require('./utils/logger');
initLogger();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cookieParser = require('cookie-parser');

const { connectDB } = require('./connect/db');
const migrateUserRoles = require('./migrations/Users');

const { sessions, setSocketIO, initSessions, connectToWhatsApp } = require('./services/whatsappService');

const createApiRoutes = require('./routes/api');
const { authRouter, verifyToken } = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const verifyRole = require('./utils/roleCheck');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Hubungkan Socket.io ke layanan WhatsApp kita
setSocketIO(io);

// Middleware Server
app.use(express.static('public'));
app.use(express.json());
app.use(cookieParser());

// Routing
app.use('/api/auth', authRouter);
const apiRoutes = createApiRoutes(sessions, connectToWhatsApp);
app.use('/api', verifyToken, apiRoutes);
app.use('/api/admin', verifyToken, verifyRole('admin'), adminRoutes);

const PORT = process.env.PORT || 3000;

// Jalankan Server & Inisialisasi Database + WhatsApp
server.listen(PORT, async () => {
    console.log(`🚀 Server berjalan di http://localhost:${PORT}`);

    // Koneksi ke Database lalu pulihkan sesi
    await connectDB();
    await migrateUserRoles();
    await initSessions();
});