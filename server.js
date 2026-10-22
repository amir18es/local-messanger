'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Socket.IO is served from this app's own origin; no cross-origin setup is needed.
  maxHttpBufferSize: 1e6,
  pingInterval: 25_000,
  pingTimeout: 20_000
});

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_HISTORY = 100;
const MAX_MESSAGE_LENGTH = 1000;
const MAX_USERNAME_LENGTH = 24;
const RATE_WINDOW_MS = 5_000;
const MAX_MESSAGES_PER_WINDOW = 8;

const history = [];
const users = new Map(); // socket.id -> username
const messageWindows = new Map(); // socket.id -> { startedAt, count }

app.disable('x-powered-by');

// Render and other hosting providers can use this endpoint to check the app.
app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use(express.static(PUBLIC_DIR, {
  index: 'index.html',
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0
}));

function onlineUsers() {
  return [...users.values()].sort((a, b) => a.localeCompare(b, 'fa'));
}

function broadcastUsers() {
  io.emit('users:update', onlineUsers());
}

function addToHistory(message) {
  history.push(message);
  if (history.length > MAX_HISTORY) history.shift();
}

function systemMessage(text) {
  const message = {
    type: 'system',
    text,
    time: new Date().toISOString()
  };
  addToHistory(message);
  io.emit('chat:message', message);
}

function joinUser(socket, rawName, callback) {
  const name = String(rawName ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, MAX_USERNAME_LENGTH);

  if (!name) {
    if (typeof callback === 'function') {
      callback({ ok: false, error: 'نام کاربری را وارد کنید.' });
    }
    return;
  }

  if (users.has(socket.id)) {
    if (typeof callback === 'function') {
      callback({ ok: true, name: users.get(socket.id) });
    }
    return;
  }

  users.set(socket.id, name);
  if (typeof callback === 'function') callback({ ok: true, name });
  broadcastUsers();
  systemMessage(`${name} وارد گفتگو شد.`);
}

io.on('connection', (socket) => {
  socket.emit('chat:history', history);

  socket.on('user:join', (rawName, callback) => {
    joinUser(socket, rawName, callback);
  });

  socket.on('chat:send', (rawText) => {
    const name = users.get(socket.id);
    if (!name) return;

    const text = String(rawText ?? '').trim().slice(0, MAX_MESSAGE_LENGTH);
    if (!text) return;

    const now = Date.now();
    let window = messageWindows.get(socket.id);
    if (!window || now - window.startedAt >= RATE_WINDOW_MS) {
      window = { startedAt: now, count: 0 };
    }
    window.count += 1;
    messageWindows.set(socket.id, window);

    if (window.count > MAX_MESSAGES_PER_WINDOW) {
      socket.emit('chat:error', 'تعداد پیام‌ها زیاد است؛ چند لحظه صبر کن.');
      return;
    }

    const message = {
      type: 'user',
      name,
      text,
      time: new Date().toISOString()
    };
    addToHistory(message);
    io.emit('chat:message', message);
  });

  socket.on('disconnect', () => {
    const name = users.get(socket.id);
    users.delete(socket.id);
    messageWindows.delete(socket.id);
    if (name) {
      broadcastUsers();
      systemMessage(`${name} از گفتگو خارج شد.`);
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`\nمسنجر اجرا شد روی پورت ${PORT}`);
  if (process.env.RENDER_EXTERNAL_URL) {
    console.log(`آدرس آنلاین: ${process.env.RENDER_EXTERNAL_URL}`);
  } else {
    console.log(`آدرس محلی: http://localhost:${PORT}`);
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const net of entries || []) {
        if (net.family === 'IPv4' && !net.internal) {
          console.log(`آدرس شبکه داخلی: http://${net.address}:${PORT}`);
        }
      }
    }
  }
  console.log('برای توقف سرور Ctrl + C را بزنید.\n');
});

function shutdown(signal) {
  console.log(`${signal} دریافت شد؛ سرور در حال توقف است...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
