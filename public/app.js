(() => {
  const socket = io();
  const loginPanel = document.getElementById('loginPanel');
  const chatPanel = document.getElementById('chatPanel');
  const loginForm = document.getElementById('loginForm');
  const usernameInput = document.getElementById('username');
  const loginError = document.getElementById('loginError');
  const messageForm = document.getElementById('messageForm');
  const messageInput = document.getElementById('messageInput');
  const messages = document.getElementById('messages');
  const userList = document.getElementById('userList');
  const userCount = document.getElementById('userCount');
  const connectionText = document.getElementById('connectionText');
  let myName = '';
  let requestedName = '';

  socket.on('connect', () => {
    connectionText.textContent = 'متصل به سرور';
    // When the network reconnects, restore the user's room membership.
    if (requestedName) join(requestedName, true);
  });

  socket.on('disconnect', () => {
    connectionText.textContent = 'ارتباط قطع شد؛ تلاش برای اتصال مجدد…';
  });

  socket.on('connect_error', () => {
    connectionText.textContent = 'اتصال برقرار نشد؛ در حال تلاش مجدد…';
  });

  loginForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!socket.connected) {
      loginError.textContent = 'اتصال به سرور برقرار نیست؛ چند لحظه صبر کن.';
      return;
    }
    const name = usernameInput.value.trim();
    requestedName = name;
    join(name, false);
  });

  function join(name, isReconnect) {
    socket.emit('user:join', name, (result) => {
      if (!result?.ok) {
        if (!isReconnect) {
          requestedName = '';
          loginError.textContent = result?.error || 'ورود انجام نشد. دوباره تلاش کن.';
        }
        return;
      }
      myName = result.name;
      loginError.textContent = '';
      loginPanel.hidden = true;
      chatPanel.hidden = false;
      if (!isReconnect) messageInput.focus();
    });
  }

  messageForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = messageInput.value.trim();
    if (!text) return;
    if (!socket.connected) {
      connectionText.textContent = 'اتصال قطع است؛ پیام هنوز ارسال نشده.';
      return;
    }
    socket.emit('chat:send', text);
    messageInput.value = '';
    messageInput.focus();
  });

  socket.on('users:update', (names) => {
    userCount.textContent = String(names.length);
    userList.replaceChildren();
    for (const name of names) {
      const item = document.createElement('li');
      const avatar = document.createElement('span');
      avatar.className = 'user-avatar';
      avatar.textContent = name.slice(0, 1);
      const label = document.createElement('span');
      label.textContent = name + (name === myName ? ' (شما)' : '');
      item.append(avatar, label);
      userList.append(item);
    }
  });

  socket.on('chat:history', (items) => {
    messages.replaceChildren();
    items.forEach(renderMessage);
    scrollToBottom();
  });

  socket.on('chat:message', (message) => {
    renderMessage(message);
    scrollToBottom();
  });

  socket.on('chat:error', (text) => {
    renderMessage({ type: 'system', text, time: new Date().toISOString() });
    scrollToBottom();
  });

  function renderMessage(message) {
    if (message.type === 'system') {
      const note = document.createElement('div');
      note.className = 'system-message';
      note.textContent = message.text;
      messages.append(note);
      return;
    }
    const article = document.createElement('article');
    article.className = 'message' + (message.name === myName ? ' own' : '');
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const name = document.createElement('span');
    name.className = 'message-name';
    name.textContent = message.name;
    const time = document.createElement('time');
    const date = new Date(message.time);
    time.dateTime = date.toISOString();
    time.textContent = date.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
    meta.append(name, time);
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = message.text;
    article.append(meta, bubble);
    messages.append(article);
  }

  function scrollToBottom() {
    messages.scrollTop = messages.scrollHeight;
  }
})();
