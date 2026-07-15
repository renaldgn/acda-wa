const mongoose = require('mongoose');

const deviceSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    phoneNumber: {
        type: String,
        required: true,
        unique: true // 1 nomor WA hanya boleh terdaftar 1 kali
    },
    status: {
        type: String,
        default: 'Disconnected'
    },
    connectedAt: {
        type: Date
    }
}, { timestamps: true });

const DeviceModel = mongoose.model('Device', deviceSchema);
module.exports = DeviceModel;