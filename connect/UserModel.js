const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true } // Akan kita hash
});

const UserModel = mongoose.model('User', userSchema);
module.exports = UserModel;