const User = require('../connect/UserModel'); // Sesuaikan path model Anda

async function migrateUserRoles() {
    try {
        // Cari user yang field 'role'-nya belum ada ($exists: false)
        // dan set menjadi 'user'
        const result = await User.updateMany(
            { role: { $exists: false } },
            { $set: { role: 'user' } }
        );

        if (result.modifiedCount > 0) {
            console.log(`✅ Berhasil melakukan migrasi: ${result.modifiedCount} user lama telah diupdate menjadi 'user'.`);
        }
    } catch (error) {
        console.error('❌ Gagal melakukan migrasi role:', error);
    }
}

module.exports = migrateUserRoles;