// mongoAuthState.js
const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const { SessionModel } = require('./db');

async function useMongoDBAuthState(sessionId) {
    // Membaca data dari MongoDB
    const readData = async (id) => {
        try {
            const doc = await SessionModel.findOne({ sessionId, id });
            if (doc) {
                // BufferJSON.reviver wajib dipakai karena Baileys menggunakan tipe data Buffer
                return JSON.parse(doc.data, BufferJSON.reviver);
            }
            return null;
        } catch (error) {
            console.error('Error membaca data:', error);
            return null;
        }
    };

    // Menulis/Update data ke MongoDB
    const writeData = async (id, data) => {
        try {
            const dataString = JSON.stringify(data, BufferJSON.replacer);
            await SessionModel.updateOne(
                { sessionId, id },
                { $set: { data: dataString } },
                { upsert: true } // Buat baru jika belum ada
            );
        } catch (error) {
            console.error('Error menulis data:', error);
        }
    };

    // Menghapus data dari MongoDB
    const removeData = async (id) => {
        try {
            await SessionModel.deleteOne({ sessionId, id });
        } catch (error) {
            console.error('Error menghapus data:', error);
        }
    };

    // 1. Cek apakah pengguna sudah punya 'creds' di database
    let creds = await readData('creds');
    if (!creds) {
        creds = initAuthCreds();
        await writeData('creds', creds);
    }

    // 2. Kembalikan format state yang dipahami oleh Baileys
    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            // Khusus app-state-sync-key harus di-convert menggunakan proto
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const bulkOps = [];

                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;

                            if (value) {
                                // Persiapkan data untuk ditambahkan/diupdate
                                const dataString = JSON.stringify(value, BufferJSON.replacer);
                                bulkOps.push({
                                    updateOne: {
                                        filter: { sessionId, id: key },
                                        update: { $set: { data: dataString } },
                                        upsert: true
                                    }
                                });
                            } else {
                                // Persiapkan data untuk dihapus
                                bulkOps.push({
                                    deleteOne: {
                                        filter: { sessionId, id: key }
                                    }
                                });
                            }
                        }
                    }

                    // Eksekusi semua operasi sekaligus (SANGAT CEPAT)
                    if (bulkOps.length > 0) {
                        try {
                            await SessionModel.bulkWrite(bulkOps);
                        } catch (error) {
                            console.error('Error saat bulkWrite:', error);
                        }
                    }
                }
            }
        },
        saveCreds: () => writeData('creds', creds)
    };
}

module.exports = useMongoDBAuthState;