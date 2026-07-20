const fs = require('fs');
const util = require('util');
const path = require('path');

// Simpan fungsi console bawaan
const logStdout = process.stdout;
const logStderr = process.stderr;

// Fungsi untuk mendapatkan path file log sesuai waktu saat ini
function getLogFilePath() {
    const now = new Date();
    const year = now.getFullYear().toString();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');

    // Buat struktur path folder di luar folder utils (naik 1 level)
    const logDir = path.join(__dirname, '..', 'logs', year, month);

    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }

    return path.join(logDir, `${year}-${month}-${day}.log`);
}

function initLogger() {
    // Timpa console.log
    console.log = function () {
        const timestamp = new Date().toLocaleString('id-ID');
        const message = util.format.apply(null, arguments);
        const logMessage = `[${timestamp}] ${message}\n`;

        fs.appendFileSync(getLogFilePath(), logMessage);
        logStdout.write(logMessage);
    };

    // Timpa console.error
    console.error = function () {
        const timestamp = new Date().toLocaleString('id-ID');
        const message = util.format.apply(null, arguments);
        const logMessage = `[${timestamp}] ERROR: ${message}\n`;

        fs.appendFileSync(getLogFilePath(), logMessage);
        logStderr.write(logMessage);
    };
}

module.exports = initLogger;