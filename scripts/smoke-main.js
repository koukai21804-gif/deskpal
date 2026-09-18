// 冒烟辅助入口：隔离 userData，避免与正在运行的正式实例争单实例锁
const { app } = require('electron');
const path = require('path');
const os = require('os');
app.setPath('userData', path.join(os.tmpdir(), 'deskpal-smoke-' + Date.now()));
require(path.join(__dirname, '..', 'src', 'main', 'main.js'));
