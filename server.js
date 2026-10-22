const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT) || 3000;
const MAX_HISTORY = 100;
const history = [];
const users = new Map(); // socket.id -> username

app.use(express.static('public'));

function onlineUsers() {
  return [...users.values()].sort((a, b) => a.localeCompare(b, 'fa'));
}
function broadcastUsers() {
  io.emit('users:update', onlineUsers());
}
function systemMessage(text) {
  io.emit('chat:message', {
    type: 'system',
    text,
    time: new Date().toISOString()
  });
}

io.on('connection', (socket) => {
  socket.emit('chat:history', history);

  socket.on('user:join', (rawName, callback) => {
    const name = String(rawName ?? '').trim().replace(/\s+/g, ' ').slice(0, 24);
    if (!name) {
      if (typeof callback === 'function') callback({ ok: false, error: 'نام کاربری را وارد کنید.' });
      return;
    }
    if (users.has(socket.id)) {
      if (typeof callback === 'function') callback({ ok: true, name: users.get(socket.id) });
      return;
    }
    users.set(socket.id, name);
    if (typeof callback === 'function') callback({ ok: true, name });
    broadcastUsers();
    systemMessage(`${name} وارد گفتگو شد.`);
  });

  socket.on('chat:send', (rawText) => {
    const name = users.get(socket.id);
    if (!name) return;
    const text = String(rawText ?? '').trim().slice(0, 1000);
    if (!text) return;
    const message = {
      type: 'user',
      name,
      text,
      time: new Date().toISOString()
    };
    history.push(message);
    if (history.length > MAX_HISTORY) history.shift();
    io.emit('chat:message', message);
  });

  socket.on('disconnect', () => {
    const name = users.get(socket.id);
    if (name) {
      users.delete(socket.id);
      broadcastUsers();
      systemMessage(`${name} از گفتگو خارج شد.`);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nمسنجر اجرا شد: http://localhost:${PORT}`);
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets)) {
    for (const net of entries || []) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`دسترسی در شبکه: http://${net.address}:${PORT}`);
      }
    }
  }
  console.log('\nبرای توقف سرور Ctrl + C را بزنید.\n');
});
