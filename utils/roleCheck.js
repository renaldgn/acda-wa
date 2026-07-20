// utils/roleCheck.js

const verifyRole = (requiredRole) => {
    return (req, res, next) => {
        // Pastikan req.user sudah diisi oleh middleware verifyToken sebelumnya
        if (!req.user) {
            return res.status(401).json({ error: 'Akses ditolak. Token tidak ditemukan.' });
        }

        // Cek apakah role user saat ini sesuai dengan role yang dibutuhkan
        if (req.user.role !== requiredRole) {
            return res.status(403).json({
                error: 'Akses dilarang! Anda tidak memiliki izin untuk tindakan ini.'
            });
        }

        next(); // Lolos, lanjutkan ke fungsi berikutnya
    };
};

module.exports = verifyRole;