const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  user: null,
  groups: [],
  activeGroupId: null,
  socket: null,
  messages: new Map(),
  users: [],
  adminGroups: [],
  toastTimer: null
};

const EMOJIS = ['😀','😄','😁','😂','🥹','😊','😍','😘','😎','🤔','😅','😭','😴','👍','👎','👏','🙏','❤️','💚','💙','🔥','🎉','✅','💯','🌹','☕','🚀','✨'];
const STICKERS = ['🐱','🐼','🐸','🦊','🐻','🐧','🌈','🎉','❤️','👍','🙏','😂','🤗','🥳','💯','☕','🍕','🌻','✨','🚀'];

function toast(message, kind = 'success') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

async function api(url, options = {}) {
  const config = { credentials: 'same-origin', ...options, headers: { ...(options.headers || {}) } };
  if (options.body && !(options.body instanceof FormData) && typeof options.body !== 'string') {
    config.headers['Content-Type'] = 'application/json';
    config.body = JSON.stringify(options.body);
  }
  const response = await fetch(url, config);
  let data = {};
  try { data = await response.json(); } catch { /* non-JSON response */ }
  if (!response.ok) {
    const error = new Error(data.error || `درخواست ناموفق بود (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function initials(name) {
  const value = String(name || '?').trim();
  return value ? [...value].slice(0, 1).join('') : '؟';
}

function setAvatar(img, fallback, user) {
  if (user?.avatarUrl) {
    img.src = user.avatarUrl;
    img.hidden = false;
    fallback.hidden = true;
    img.onerror = () => { img.hidden = true; fallback.hidden = false; };
  } else {
    img.removeAttribute('src');
    img.hidden = true;
    fallback.textContent = initials(user?.displayName);
    fallback.hidden = false;
  }
}

function updateAccountHeader() {
  if (!state.user) return;
  $('#current-display-name').textContent = state.user.displayName;
  $('#current-username').textContent = `@${state.user.username}`;
  setAvatar($('#top-avatar'), $('#top-avatar-fallback'), state.user);
  const isAdmin = state.user.role === 'admin';
  $('#admin-open').hidden = !isAdmin;
  $('#sidebar-create-group').hidden = !isAdmin;
}

function showLogin() {
  $('#login-view').hidden = false;
  $('#app-view').hidden = true;
  $('#admin-modal').hidden = true;
}

function showApp() {
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  updateAccountHeader();
}

function connectSocket() {
  if (state.socket) state.socket.disconnect();
  state.socket = io({ withCredentials: true });
  state.socket.on('connect', () => {
    state.groups.forEach(group => state.socket.emit('group:join', group.id));
  });
  state.socket.on('connect_error', (error) => {
    if (error.message === 'AUTH_REQUIRED') {
      state.socket?.disconnect();
      state.socket = null;
      showLogin();
    }
  });
  state.socket.on('message:new', (message) => {
    if (Number(message.groupId) !== Number(state.activeGroupId)) return;
    addMessage(message);
  });
  state.socket.on('message:updated', (message) => {
    if (Number(message.groupId) !== Number(state.activeGroupId)) return;
    state.messages.set(Number(message.id), message);
    const old = $(`[data-message-id="${Number(message.id)}"]`, $('#messages'));
    if (old) old.replaceWith(renderMessage(message));
  });
  state.socket.on('groups:changed', async () => {
    await loadGroups();
    if (state.socket?.connected) state.groups.forEach(group => state.socket.emit('group:join', group.id));
  });
  state.socket.on('profile:changed', async () => {
    try {
      const result = await api('/api/auth/me');
      state.user = result.user;
      updateAccountHeader();
    } catch { /* another session may have been revoked */ }
  });
}

async function enterApp(user) {
  state.user = user;
  showApp();
  await loadGroups();
  connectSocket();
}

async function checkSession() {
  try {
    const result = await api('/api/auth/me');
    await enterApp(result.user);
  } catch {
    showLogin();
  }
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('button[type="submit"]', event.currentTarget);
  const errorEl = $('#login-error');
  errorEl.hidden = true;
  button.disabled = true;
  try {
    const result = await api('/api/auth/login', {
      method: 'POST',
      body: { username: $('#login-username').value.trim(), password: $('#login-password').value }
    });
    $('#login-password').value = '';
    await enterApp(result.user);
  } catch (error) {
    errorEl.textContent = error.message;
    errorEl.hidden = false;
  } finally { button.disabled = false; }
});

$('#logout-button').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* we still clear local state */ }
  state.socket?.disconnect();
  state.socket = null;
  state.user = null;
  state.groups = [];
  state.activeGroupId = null;
  showLogin();
});

async function loadGroups() {
  try {
    const result = await api('/api/groups');
    state.groups = result.groups;
    renderGroups();
    if (state.activeGroupId && !state.groups.some(g => g.id === Number(state.activeGroupId))) {
      state.activeGroupId = null;
      $('#active-chat').hidden = true;
      $('#chat-empty').hidden = false;
    }
    if (!state.activeGroupId && state.groups.length) await openGroup(state.groups[0].id);
    if (state.socket?.connected) state.groups.forEach(group => state.socket.emit('group:join', group.id));
  } catch (error) { toast(error.message, 'error'); }
}

function renderGroups() {
  const list = $('#group-list');
  list.replaceChildren();
  if (!state.groups.length) {
    const empty = document.createElement('p');
    empty.className = 'muted empty-sidebar';
    empty.textContent = state.user?.role === 'admin' ? 'هنوز گروهی ساخته نشده است.' : 'مدیر هنوز تو را به گروهی اضافه نکرده است.';
    list.append(empty);
    return;
  }
  for (const group of state.groups) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `group-item${Number(group.id) === Number(state.activeGroupId) ? ' active' : ''}`;
    const icon = document.createElement('span'); icon.className = 'group-icon'; icon.textContent = '#';
    const info = document.createElement('span'); info.className = 'group-info';
    const name = document.createElement('strong'); name.textContent = group.name;
    const desc = document.createElement('small'); desc.textContent = group.description || `${group.memberCount} عضو`;
    info.append(name, desc);
    const count = document.createElement('span'); count.className = 'group-count'; count.textContent = String(group.memberCount);
    button.append(icon, info, count);
    button.addEventListener('click', () => openGroup(group.id));
    list.append(button);
  }
}

async function openGroup(groupId) {
  const group = state.groups.find(g => Number(g.id) === Number(groupId));
  if (!group) return;
  state.activeGroupId = Number(group.id);
  state.messages.clear();
  renderGroups();
  $('#chat-empty').hidden = true;
  $('#active-chat').hidden = false;
  $('#active-group-name').textContent = group.name;
  $('#active-group-meta').textContent = `${group.memberCount} عضو · ${group.description || 'گفت‌وگوی گروهی'}`;
  $('#messages').replaceChildren();
  $('#message-input').focus();
  if (state.socket?.connected) state.socket.emit('group:join', group.id);
  try {
    const result = await api(`/api/groups/${group.id}/messages?limit=75`);
    if (Number(state.activeGroupId) !== Number(group.id)) return;
    // Socket events can arrive during fetch; merge and render by monotonically increasing message ID.
    for (const message of result.messages) state.messages.set(Number(message.id), message);
    renderAllMessages();
  } catch (error) { toast(error.message, 'error'); }
}

function formatTime(value) {
  try { return new Intl.DateTimeFormat('fa-IR', { hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }
  catch { return ''; }
}
function formatFileSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} بایت`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} کیلوبایت`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} مگابایت`;
}
function createAvatar(user, className = 'message-avatar') {
  const holder = document.createElement('span');
  holder.className = className;
  if (user?.avatarUrl) {
    const img = document.createElement('img');
    img.src = user.avatarUrl; img.alt = ''; img.loading = 'lazy';
    img.onerror = () => { img.remove(); holder.textContent = initials(user?.displayName); };
    holder.append(img);
  } else holder.textContent = initials(user?.displayName);
  return holder;
}

function renderMessage(message) {
  const wrapper = document.createElement('article');
  wrapper.className = `message-row${Number(message.user.id) === Number(state.user?.id) ? ' mine' : ''}${message.isDeleted ? ' deleted' : ''}`;
  wrapper.dataset.messageId = String(message.id);
  wrapper.append(createAvatar(message.user));

  const body = document.createElement('div'); body.className = 'message-body';
  const head = document.createElement('div'); head.className = 'message-meta';
  const author = document.createElement('strong'); author.textContent = message.user.displayName;
  const time = document.createElement('time'); time.textContent = formatTime(message.createdAt); time.dateTime = message.createdAt;
  head.append(author, time);
  if (message.editedAt && !message.isDeleted) {
    const edited = document.createElement('span'); edited.className = 'edited-label'; edited.textContent = 'ویرایش‌شده'; head.append(edited);
  }
  body.append(head);

  const content = document.createElement('div');
  content.className = `message-content${message.type === 'sticker' && !message.isDeleted ? ' sticker-content' : ''}`;
  if (message.attachment && !message.isDeleted) {
    if (message.attachment.mimeType?.startsWith('image/')) {
      const img = document.createElement('img');
      img.className = 'message-image'; img.src = message.attachment.inlineUrl; img.alt = message.attachment.name || 'تصویر'; img.loading = 'lazy';
      img.addEventListener('click', () => window.open(message.attachment.inlineUrl, '_blank', 'noopener,noreferrer'));
      content.append(img);
      if (message.content) { const caption = document.createElement('p'); caption.textContent = message.content; content.append(caption); }
    } else {
      const link = document.createElement('a'); link.className = 'file-card'; link.href = message.attachment.url;
      link.append(document.createTextNode('▤ '));
      const fileDetails = document.createElement('span');
      const fileName = document.createElement('strong'); fileName.textContent = message.attachment.name || 'دریافت فایل';
      const fileSize = document.createElement('small'); fileSize.textContent = formatFileSize(message.attachment.size);
      fileDetails.append(fileName, fileSize); link.append(fileDetails); content.append(link);
      if (message.content) { const caption = document.createElement('p'); caption.textContent = message.content; content.append(caption); }
    }
  } else {
    const text = document.createElement('p'); text.textContent = message.content;
    content.append(text);
  }
  body.append(content);

  if (!message.isDeleted && (Number(message.user.id) === Number(state.user?.id) || state.user?.role === 'admin')) {
    const actions = document.createElement('div'); actions.className = 'message-actions';
    if (message.type !== 'file') {
      const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = 'ویرایش';
      edit.addEventListener('click', () => editMessage(message)); actions.append(edit);
    }
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'حذف'; remove.className = 'delete-message-btn';
    remove.addEventListener('click', () => deleteMessage(message)); actions.append(remove);
    body.append(actions);
  }
  wrapper.append(body);
  return wrapper;
}

function renderAllMessages() {
  const container = $('#messages');
  container.replaceChildren();
  [...state.messages.values()].sort((a, b) => Number(a.id) - Number(b.id)).forEach(message => container.append(renderMessage(message)));
  container.scrollTop = container.scrollHeight;
}
function addMessage(message) {
  const id = Number(message.id);
  if (state.messages.has(id)) return;
  state.messages.set(id, message);
  const container = $('#messages');
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 160;
  container.append(renderMessage(message));
  if (nearBottom) container.scrollTop = container.scrollHeight;
}

async function sendMessage(content, type = 'text') {
  if (!state.activeGroupId) return toast('ابتدا یک گروه را انتخاب کن.', 'error');
  try {
    const result = await api(`/api/groups/${state.activeGroupId}/messages`, { method: 'POST', body: { content, type } });
    if (Number(result.message.groupId) === Number(state.activeGroupId)) addMessage(result.message);
    $('#message-input').focus();
  } catch (error) { toast(error.message, 'error'); }
}

$('#composer-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#message-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.style.height = 'auto';
  await sendMessage(text);
});
$('#message-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('#composer-form').requestSubmit();
  }
});
$('#message-input').addEventListener('input', (event) => {
  event.currentTarget.style.height = 'auto';
  event.currentTarget.style.height = `${Math.min(120, event.currentTarget.scrollHeight)}px`;
});

async function editMessage(message) {
  const value = window.prompt('متن جدید پیام:', message.content);
  if (value === null || value.trim() === '' || value.trim() === message.content) return;
  try {
    const result = await api(`/api/messages/${message.id}`, { method: 'PATCH', body: { content: value.trim() } });
    state.messages.set(Number(message.id), result.message);
    const old = $(`[data-message-id="${Number(message.id)}"]`, $('#messages'));
    if (old) old.replaceWith(renderMessage(result.message));
  } catch (error) { toast(error.message, 'error'); }
}
async function deleteMessage(message) {
  if (!window.confirm('این پیام حذف شود؟')) return;
  try {
    const result = await api(`/api/messages/${message.id}`, { method: 'DELETE' });
    state.messages.set(Number(message.id), result.message);
    const old = $(`[data-message-id="${Number(message.id)}"]`, $('#messages'));
    if (old) old.replaceWith(renderMessage(result.message));
  } catch (error) { toast(error.message, 'error'); }
}

$('#attach-button').addEventListener('click', () => {
  if (!state.activeGroupId) return toast('ابتدا یک گروه انتخاب کن.', 'error');
  $('#file-input').click();
});
$('#file-input').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file || !state.activeGroupId) return;
  const form = new FormData(); form.append('file', file);
  try {
    const result = await api(`/api/groups/${state.activeGroupId}/files`, { method: 'POST', body: form });
    // The server emits the message too; addMessage deduplicates by ID.
    if (Number(result.message.groupId) === Number(state.activeGroupId)) addMessage(result.message);
    toast('فایل ارسال شد.');
  } catch (error) { toast(error.message, 'error'); }
  finally { event.target.value = ''; }
});

function togglePicker(type) {
  const area = $('#picker-area');
  const current = area.dataset.type;
  if (!area.hidden && current === type) { area.hidden = true; area.replaceChildren(); return; }
  area.hidden = false; area.dataset.type = type; area.replaceChildren();
  const list = type === 'emoji' ? EMOJIS : STICKERS;
  for (const symbol of list) {
    const button = document.createElement('button'); button.type = 'button';
    button.className = type === 'emoji' ? 'picker-emoji' : 'picker-sticker'; button.textContent = symbol;
    button.addEventListener('click', async () => {
      if (type === 'emoji') {
        const input = $('#message-input'); const start = input.selectionStart ?? input.value.length; const end = input.selectionEnd ?? input.value.length;
        input.setRangeText(symbol, start, end, 'end'); input.focus(); input.dispatchEvent(new Event('input'));
      } else { await sendMessage(symbol, 'sticker'); area.hidden = true; }
      if (type === 'emoji') area.hidden = true;
    });
    area.append(button);
  }
}
$('#emoji-button').addEventListener('click', () => togglePicker('emoji'));
$('#sticker-button').addEventListener('click', () => togglePicker('sticker'));

$('#avatar-button').addEventListener('click', () => $('#avatar-input').click());
$('#avatar-input').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const form = new FormData(); form.append('file', file);
  try {
    const result = await api('/api/profile/avatar', { method: 'POST', body: form });
    state.user = result.user; updateAccountHeader(); toast('عکس پروفایل تغییر کرد.');
  } catch (error) { toast(error.message, 'error'); }
  finally { event.target.value = ''; }
});

// Admin modal helpers.
function openAdminModal(tab = 'users') {
  if (state.user?.role !== 'admin') return;
  $('#admin-modal').hidden = false;
  document.body.classList.add('modal-open');
  switchAdminTab(tab);
  loadAdminData();
}
function closeAdminModal() { $('#admin-modal').hidden = true; document.body.classList.remove('modal-open'); }
function switchAdminTab(tab) {
  $$('.tab-btn').forEach(btn => btn.classList.toggle('selected', btn.dataset.tab === tab));
  $('#admin-users-pane').hidden = tab !== 'users';
  $('#admin-groups-pane').hidden = tab !== 'groups';
}
$('#admin-open').addEventListener('click', () => openAdminModal('users'));
$('#sidebar-create-group').addEventListener('click', () => openAdminModal('groups'));
$('#admin-close').addEventListener('click', closeAdminModal);
$('#admin-modal').addEventListener('click', (event) => { if (event.target === $('#admin-modal')) closeAdminModal(); });
$$('.tab-btn').forEach(btn => btn.addEventListener('click', () => switchAdminTab(btn.dataset.tab)));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('#admin-modal').hidden) closeAdminModal(); });

async function loadAdminData() {
  try {
    const [usersData, groupsData] = await Promise.all([api('/api/admin/users'), api('/api/admin/groups')]);
    state.users = usersData.users;
    state.adminGroups = groupsData.groups;
    renderAdminUsers(); renderAdminGroups(); renderMemberChecks([]);
  } catch (error) { toast(error.message, 'error'); }
}

function renderAdminUsers() {
  const container = $('#users-list'); container.replaceChildren();
  for (const user of state.users) {
    const row = document.createElement('div'); row.className = 'admin-list-item';
    const info = document.createElement('div'); info.className = 'admin-item-info';
    const name = document.createElement('strong'); name.textContent = user.displayName;
    const detail = document.createElement('small'); detail.textContent = `@${user.username} · ${user.role === 'admin' ? 'مدیر' : 'کاربر'} · ${user.isActive ? 'فعال' : 'غیرفعال'}`;
    info.append(name, detail);
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'secondary-btn tiny-btn'; edit.textContent = 'ویرایش'; edit.addEventListener('click', () => fillUserForm(user));
    row.append(info, edit); container.append(row);
  }
}

function resetUserForm() {
  $('#user-form').reset(); $('#user-id').value = ''; $('#user-role').value = 'user'; $('#user-active').checked = true;
  $('#user-form-title').textContent = 'افزودن کاربر'; $('#user-password').required = true; $('#user-password').placeholder = 'حداقل ۱۲ نویسه';
  $('#user-form-error').hidden = true;
}
function fillUserForm(user) {
  $('#user-id').value = user.id; $('#user-username').value = user.username; $('#user-display-name').value = user.displayName;
  $('#user-role').value = user.role; $('#user-active').checked = user.isActive; $('#user-password').value = '';
  $('#user-password').required = false; $('#user-password').placeholder = 'برای تغییر رمز وارد کن';
  $('#user-form-title').textContent = `ویرایش ${user.displayName}`; $('#user-form-error').hidden = true;
}
$('#new-user-button').addEventListener('click', resetUserForm);
$('#user-form-reset').addEventListener('click', resetUserForm);
$('#user-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorEl = $('#user-form-error'); errorEl.hidden = true;
  const id = $('#user-id').value;
  const body = { username: $('#user-username').value.trim(), displayName: $('#user-display-name').value.trim(), role: $('#user-role').value, isActive: $('#user-active').checked };
  if ($('#user-password').value) body.password = $('#user-password').value;
  try {
    if (id) await api(`/api/admin/users/${id}`, { method: 'PATCH', body });
    else await api('/api/admin/users', { method: 'POST', body });
    const changedOwnPassword = Boolean(id && Number(id) === Number(state.user?.id) && body.password);
    if (changedOwnPassword) {
      toast('رمز مدیر تغییر کرد. برای ادامه با رمز جدید دوباره وارد شو.');
      state.socket?.disconnect(); state.socket = null; state.user = null; showLogin();
      return;
    }
    toast(id ? 'اطلاعات کاربر ویرایش شد.' : 'کاربر جدید ساخته شد.');
    resetUserForm(); await loadAdminData(); await loadGroups();
  } catch (error) { errorEl.textContent = error.message; errorEl.hidden = false; }
});

function renderAdminGroups() {
  const container = $('#admin-groups-list'); container.replaceChildren();
  for (const group of state.adminGroups) {
    const row = document.createElement('div'); row.className = 'admin-list-item';
    const info = document.createElement('div'); info.className = 'admin-item-info';
    const name = document.createElement('strong'); name.textContent = group.name;
    const detail = document.createElement('small'); detail.textContent = `${group.memberIds.length} عضو · ${group.description || 'بدون توضیحات'}`;
    info.append(name, detail);
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'secondary-btn tiny-btn'; edit.textContent = 'ویرایش'; edit.addEventListener('click', () => fillGroupForm(group));
    row.append(info, edit); container.append(row);
  }
}

function renderMemberChecks(selected = []) {
  const box = $('#group-member-checks'); box.replaceChildren();
  const activeUsers = state.users.filter(user => user.isActive);
  if (!activeUsers.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'کاربر فعالی برای افزودن وجود ندارد.'; box.append(p); return; }
  for (const user of activeUsers) {
    const label = document.createElement('label'); label.className = 'member-check';
    const input = document.createElement('input'); input.type = 'checkbox'; input.value = String(user.id); input.checked = selected.map(Number).includes(Number(user.id));
    const text = document.createElement('span'); text.textContent = `${user.displayName} (@${user.username})`;
    label.append(input, text); box.append(label);
  }
}
function resetGroupForm() {
  $('#admin-group-form').reset(); $('#admin-group-id').value = ''; $('#group-form-title').textContent = 'ساخت گروه';
  $('#delete-group-button').hidden = true; $('#group-form-error').hidden = true; renderMemberChecks([]);
}
function fillGroupForm(group) {
  $('#admin-group-id').value = group.id; $('#admin-group-name').value = group.name; $('#admin-group-description').value = group.description || '';
  $('#group-form-title').textContent = `ویرایش ${group.name}`; $('#delete-group-button').hidden = false; $('#group-form-error').hidden = true;
  renderMemberChecks(group.memberIds);
}
$('#new-group-button').addEventListener('click', resetGroupForm);
$('#group-form-reset').addEventListener('click', resetGroupForm);
$('#admin-group-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorEl = $('#group-form-error'); errorEl.hidden = true;
  const id = $('#admin-group-id').value;
  const body = {
    name: $('#admin-group-name').value.trim(),
    description: $('#admin-group-description').value.trim(),
    memberIds: $$('#group-member-checks input:checked').map(input => Number(input.value))
  };
  try {
    if (id) await api(`/api/admin/groups/${id}`, { method: 'PATCH', body });
    else await api('/api/admin/groups', { method: 'POST', body });
    toast(id ? 'گروه ویرایش شد.' : 'گروه جدید ساخته شد.');
    resetGroupForm(); await loadAdminData(); await loadGroups();
  } catch (error) { errorEl.textContent = error.message; errorEl.hidden = false; }
});
$('#delete-group-button').addEventListener('click', async () => {
  const id = $('#admin-group-id').value;
  if (!id || !window.confirm('گروه و تمام پیام‌ها و فایل‌های وابسته به آن حذف می‌شوند. ادامه می‌دهی؟')) return;
  try {
    await api(`/api/admin/groups/${id}`, { method: 'DELETE' });
    toast('گروه حذف شد.'); resetGroupForm(); await loadAdminData(); await loadGroups();
  } catch (error) { $('#group-form-error').textContent = error.message; $('#group-form-error').hidden = false; }
});

checkSession();
