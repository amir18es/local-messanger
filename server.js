import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import helmet from 'helmet';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import { fileTypeFromFile } from 'file-type';
import { rateLimit } from 'express-rate-limit';
import { Server as SocketServer } from 'socket.io';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DATA_FILE = path.join(DATA_DIR, 'messenger.json');
const SESSION_FILE = path.join(DATA_DIR, 'sessions.json');
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads'));
const PORT = Number(process.env.PORT || 3000);
const parsedMaxFileMb = Number(process.env.MAX_FILE_MB || 15);
const MAX_FILE_MB = Number.isFinite(parsedMaxFileMb) ? Math.min(30, Math.max(1, parsedMaxFileMb)) : 15;
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const DUMMY_PASSWORD_HASH = await bcrypt.hash('deliberately-invalid-login-password', 12);

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32 || /^(replace-with-|paste-)/i.test(process.env.SESSION_SECRET)) {
  throw new Error('SESSION_SECRET باید یک کلید تصادفی واقعی با حداقل ۳۲ نویسه باشد؛ مقدار نمونه را تغییر بده.');
}
if (IS_PRODUCTION && process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.length < 12) {
  throw new Error('رمز عبور اولیه مدیر در production باید حداقل ۱۲ نویسه داشته باشد.');
}

mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });

const EMPTY_STATE = () => ({
  schemaVersion: 1,
  counters: { user: 1, group: 1, message: 1 },
  users: [],
  groups: [],
  messages: []
});

async function atomicWriteJson(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const json = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await fs.writeFile(tempPath, json, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}

let dbState;
let dbMutationQueue = Promise.resolve();
async function initializeFileDatabase() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.users) || !Array.isArray(parsed.groups) || !Array.isArray(parsed.messages) || !parsed.counters) {
      throw new Error('ساختار فایل داده‌ها معتبر نیست؛ فایل را پاک یا بازنویسی نکن. نسخه پشتیبان را بررسی کن.');
    }
    dbState = parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    dbState = EMPTY_STATE();
    await atomicWriteJson(DATA_FILE, dbState);
  }

  const envUsername = String(process.env.ADMIN_USERNAME || '').trim().toLowerCase();
  const envPassword = process.env.ADMIN_PASSWORD || '';
  if (envUsername && envPassword) {
    if (/^(replace-|change_to_|paste_)/i.test(envPassword)) {
      throw new Error('ADMIN_PASSWORD هنوز مقدار نمونه دارد. یک رمز اختصاصی و قوی انتخاب کن.');
    }
    if (!isValidUsername(envUsername)) {
      throw new Error('ADMIN_USERNAME باید ۳ تا ۳۲ نویسه و فقط شامل حروف انگلیسی، عدد، نقطه، _ یا - باشد.');
    }
    if (!isValidPassword(envPassword)) {
      throw new Error('ADMIN_PASSWORD باید حداقل ۱۲ نویسه، حداکثر ۱۲۸ نویسه و حداکثر ۷۲ بایت UTF-8 باشد.');
    }
    const alreadyExists = dbState.users.some((user) => user.username === envUsername);
    if (!alreadyExists) {
      const passwordHash = await bcrypt.hash(envPassword, 12);
      await updateDatabase((draft) => {
        // Re-check after entering the serialized write queue to avoid duplicate users.
        if (draft.users.some((user) => user.username === envUsername)) return null;
        const now = new Date().toISOString();
        const user = {
          id: draft.counters.user++, username: envUsername,
          display_name: String(process.env.ADMIN_DISPLAY_NAME || 'مدیر سیستم').trim().slice(0, 80) || 'مدیر سیستم',
          password_hash: passwordHash, role: 'admin', is_active: true,
          avatar_name: null, created_at: now, updated_at: now
        };
        draft.users.push(user);
        if (draft.groups.length === 0) {
          draft.groups.push({
            id: draft.counters.group++, name: 'عمومی', description: 'گفت‌وگوی عمومی کاربران',
            created_by: user.id, created_at: now, member_ids: [user.id]
          });
        } else {
          for (const group of draft.groups) {
            if (!group.member_ids.includes(user.id)) group.member_ids.push(user.id);
          }
        }
        return user.id;
      });
      console.log(`Admin account '${envUsername}' was created from environment variables.`);
    }
  }

  if (!dbState.users.some((user) => user.role === 'admin' && user.is_active)) {
    throw new Error('هیچ مدیر فعالی در فایل داده‌ها وجود ندارد. ADMIN_USERNAME و ADMIN_PASSWORD را تنظیم کن.');
  }
  if (dbState.groups.length === 0) {
    const firstAdmin = dbState.users.find((user) => user.role === 'admin' && user.is_active);
    await updateDatabase((draft) => {
      if (draft.groups.length) return;
      const now = new Date().toISOString();
      draft.groups.push({ id: draft.counters.group++, name: 'عمومی', description: 'گفت‌وگوی عمومی کاربران', created_by: firstAdmin.id, created_at: now, member_ids: [firstAdmin.id] });
    });
  }
}

function updateDatabase(mutator) {
  const operation = dbMutationQueue.then(async () => {
    const draft = structuredClone(dbState);
    const result = mutator(draft);
    await atomicWriteJson(DATA_FILE, draft);
    dbState = draft;
    return result;
  });
  dbMutationQueue = operation.catch(() => {});
  return operation;
}

// A small file-backed express-session store. It is intentionally for one Node.js instance.
class JsonSessionStore extends session.Store {
  constructor(filePath) {
    super();
    this.filePath = filePath;
    this.entries = {};
    this.writeQueue = Promise.resolve();
    this.ready = this.load();
  }

  async load() {
    try {
      this.entries = JSON.parse(await fs.readFile(this.filePath, 'utf8')) || {};
      if (typeof this.entries !== 'object' || Array.isArray(this.entries)) this.entries = {};
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.entries = {};
        await atomicWriteJson(this.filePath, this.entries);
      } else {
        throw new Error(`فایل نشست‌ها خوانده نشد: ${error.message}`);
      }
    }
    let changed = false;
    for (const [sid, sess] of Object.entries(this.entries)) {
      const expires = sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : null;
      if (expires && expires <= Date.now()) { delete this.entries[sid]; changed = true; }
    }
    if (changed) await this.persist();
  }

  persist() {
    const operation = this.writeQueue.then(() => atomicWriteJson(this.filePath, this.entries));
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  get(sid, callback) {
    this.ready.then(async () => {
      const value = this.entries[sid];
      const expires = value?.cookie?.expires ? new Date(value.cookie.expires).getTime() : null;
      if (expires && expires <= Date.now()) {
        delete this.entries[sid];
        await this.persist();
        callback(null, null);
        return;
      }
      callback(null, value ? structuredClone(value) : null);
    }).catch(callback);
  }

  set(sid, sess, callback = () => {}) {
    this.ready.then(() => {
      this.entries[sid] = structuredClone(sess);
      return this.persist();
    }).then(() => callback(null)).catch(callback);
  }

  destroy(sid, callback = () => {}) {
    this.ready.then(() => {
      delete this.entries[sid];
      return this.persist();
    }).then(() => callback(null)).catch(callback);
  }

  touch(sid, sess, callback = () => {}) {
    this.ready.then(() => {
      // Do not recreate sessions removed after a password change or account deactivation.
      if (this.entries[sid]) this.entries[sid] = structuredClone(sess);
      return this.persist();
    }).then(() => callback(null)).catch(callback);
  }

  async destroyForUser(userId) {
    await this.ready;
    const wanted = Number(userId);
    let changed = false;
    for (const [sid, sess] of Object.entries(this.entries)) {
      if (Number(sess?.userId) === wanted) { delete this.entries[sid]; changed = true; }
    }
    if (changed) await this.persist();
  }
}

const sessionStore = new JsonSessionStore(SESSION_FILE);
const sessionMiddleware = session({
  store: sessionStore,
  name: 'messenger.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'strict',
    maxAge: 8 * 60 * 60 * 1000,
    path: '/'
  }
});

const app = express();
const server = http.createServer(app);
app.disable('x-powered-by');
app.set('trust proxy', IS_PRODUCTION ? 1 : false);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"], baseUri: ["'self'"], fontSrc: ["'self'", 'data:'],
      imgSrc: ["'self'", 'data:'], styleSrc: ["'self'"], scriptSrc: ["'self'"],
      connectSrc: ["'self'", 'ws:', 'wss:'], objectSrc: ["'none'"],
      frameAncestors: ["'none'"], formAction: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'no-referrer' }
}));
app.use(express.json({ limit: '64kb', strict: true }));
app.use(express.urlencoded({ extended: false, limit: '8kb' }));
app.use(sessionMiddleware);
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

// Same-origin protection for state-changing API requests.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return res.status(403).json({ error: 'درخواست بدون Origin معتبر پذیرفته نمی‌شود.' });
  try {
    const parsedOrigin = new URL(origin).origin;
    const expectedOrigin = process.env.APP_ORIGIN
      ? new URL(process.env.APP_ORIGIN).origin
      : `${req.protocol}://${req.get('host')}`;
    if (parsedOrigin !== expectedOrigin) return res.status(403).json({ error: 'Origin درخواست معتبر نیست.' });
  } catch {
    return res.status(403).json({ error: 'Origin درخواست نامعتبر است.' });
  }
  return next();
});

app.use(express.static(PUBLIC_DIR, {
  index: 'index.html', dotfiles: 'deny', etag: true,
  maxAge: IS_PRODUCTION ? '1h' : 0,
  setHeaders(res, filePath) { if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store'); }
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'تعداد تلاش‌های ورود زیاد است. ۱۵ دقیقه بعد دوباره تلاش کن.' }
});
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 180, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'تعداد درخواست‌ها زیاد است. کمی بعد دوباره تلاش کن.' }
});
const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'تعداد بارگذاری فایل زیاد است. کمی بعد دوباره تلاش کن.' }
});
app.use('/api', apiLimiter);

const allowedBinaryTypes = new Map([
  ['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/gif', 'gif'], ['image/webp', 'webp'],
  ['application/pdf', 'pdf'], ['application/zip', 'zip'], ['application/x-zip-compressed', 'zip'],
  ['application/gzip', 'gz'], ['audio/mpeg', 'mp3'], ['audio/ogg', 'ogg'], ['audio/wav', 'wav'],
  ['video/mp4', 'mp4'], ['video/webm', 'webm']
]);
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, _file, cb) => cb(null, `${randomUUID()}.upload`)
  }),
  limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 8, fieldSize: 10_000 }
});

const io = new SocketServer(server, { serveClient: true, maxHttpBufferSize: 1e6, cors: { origin: false } });
io.engine.use(sessionMiddleware);
io.use((socket, next) => {
  try {
    const origin = socket.handshake.headers.origin;
    const forwardedProto = String(socket.request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const protocol = forwardedProto || (socket.request.socket.encrypted ? 'https' : 'http');
    const expectedOrigin = process.env.APP_ORIGIN
      ? new URL(process.env.APP_ORIGIN).origin
      : `${protocol}://${socket.request.headers.host}`;
    if (!origin || new URL(origin).origin !== expectedOrigin) return next(new Error('ORIGIN_NOT_ALLOWED'));
    const userId = Number(socket.request.session?.userId);
    const user = dbState.users.find((item) => item.id === userId);
    if (!user || !user.is_active) return next(new Error('AUTH_REQUIRED'));
    socket.userId = userId;
    return next();
  } catch {
    return next(new Error('AUTH_REQUIRED'));
  }
});
io.on('connection', (socket) => {
  socket.join(`user:${socket.userId}`);
  const groups = dbState.groups.filter((group) => group.member_ids.includes(socket.userId));
  for (const group of groups) socket.join(`group:${group.id}`);
  socket.on('group:join', (groupId) => {
    const id = Number(groupId);
    if (!isValidId(id) || !hasGroupAccess(socket.userId, id)) return;
    socket.join(`group:${id}`);
  });
});

function safeUser(row) {
  return {
    id: Number(row.id), username: row.username, displayName: row.display_name,
    role: row.role, isActive: row.is_active,
    avatarUrl: row.avatar_name ? `/api/avatars/${encodeURIComponent(row.avatar_name)}` : null,
    createdAt: row.created_at
  };
}
function requireAuth(req, res, next) {
  const userId = Number(req.session?.userId);
  const user = dbState.users.find((item) => item.id === userId);
  if (!userId || !user || !user.is_active) {
    if (req.session) req.session.destroy(() => {});
    res.clearCookie('messenger.sid', { path: '/', sameSite: 'strict', secure: IS_PRODUCTION, httpOnly: true });
    return res.status(401).json({ error: 'ابتدا وارد حساب کاربری شو یا نشست دوباره منقضی شده است.' });
  }
  req.user = user;
  return next();
}
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'فقط مدیر سیستم به این بخش دسترسی دارد.' });
  return next();
}
function isValidUsername(value) { return typeof value === 'string' && /^[a-zA-Z0-9_.-]{3,32}$/.test(value); }
function isValidPassword(value) { return typeof value === 'string' && value.length >= 12 && value.length <= 128 && Buffer.byteLength(value, 'utf8') <= 72; }
function isValidId(value) { return Number.isSafeInteger(Number(value)) && Number(value) > 0; }
function groupRoom(groupId) { return `group:${Number(groupId)}`; }
function hasGroupAccess(userId, groupId) {
  return dbState.groups.some((group) => group.id === Number(groupId) && group.member_ids.includes(Number(userId)));
}
function requireGroupAccess(req, res, next) {
  const groupId = Number(req.params.groupId);
  if (!isValidId(groupId)) return res.status(400).json({ error: 'شناسه گروه معتبر نیست.' });
  if (!hasGroupAccess(req.user.id, groupId)) return res.status(404).json({ error: 'گروه پیدا نشد یا به آن دسترسی نداری.' });
  req.groupId = groupId;
  return next();
}
function publicMessage(message) {
  const user = dbState.users.find((item) => item.id === Number(message.user_id));
  if (!user) return null;
  const deleted = Boolean(message.deleted_at);
  return {
    id: Number(message.id), groupId: Number(message.group_id), type: message.type,
    content: deleted ? 'این پیام حذف شده است.' : message.content,
    isDeleted: deleted,
    user: { id: Number(user.id), username: user.username, displayName: user.display_name,
      avatarUrl: user.avatar_name ? `/api/avatars/${encodeURIComponent(user.avatar_name)}` : null },
    attachment: !deleted && message.stored_name ? {
      url: `/api/files/${encodeURIComponent(message.stored_name)}`,
      inlineUrl: `/api/files/${encodeURIComponent(message.stored_name)}?inline=1`,
      name: message.original_name, mimeType: message.mime_type, size: Number(message.file_size || 0)
    } : null,
    createdAt: message.created_at, editedAt: message.edited_at
  };
}
function readMessage(id) {
  const row = dbState.messages.find((message) => message.id === Number(id));
  return row ? publicMessage(row) : null;
}
async function broadcastGroupsChanged(userIds) {
  for (const id of new Set(userIds.map(Number))) io.to(`user:${id}`).emit('groups:changed');
}
async function classifyAndMoveUpload(file, { imagesOnly = false } = {}) {
  if (!file) throw new Error('فایلی انتخاب نشده است.');
  let detected;
  try { detected = await fileTypeFromFile(file.path); } catch { detected = undefined; }
  let extension;
  let mimeType;
  if (detected && allowedBinaryTypes.has(detected.mime)) {
    mimeType = detected.mime;
    extension = allowedBinaryTypes.get(detected.mime);
  } else if (!detected) {
    const originalExt = path.extname(file.originalname || '').toLowerCase();
    if (imagesOnly) throw new Error('فرمت تصویر معتبر نیست. فقط JPG، PNG و WebP پذیرفته می‌شود.');
    if (!['.txt', '.csv'].includes(originalExt)) throw new Error('نوع فایل قابل تشخیص یا مجاز نیست.');
    const buffer = await fs.readFile(file.path);
    if (buffer.includes(0)) throw new Error('فایل متنی نامعتبر است.');
    mimeType = originalExt === '.csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8';
    extension = originalExt.slice(1);
  } else {
    throw new Error('این نوع فایل برای ارسال مجاز نیست.');
  }
  if (imagesOnly && !['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
    throw new Error('برای عکس پروفایل فقط JPG، PNG یا WebP مجاز است.');
  }
  const storedName = `${randomUUID()}.${extension}`;
  const fullPath = path.join(UPLOAD_DIR, storedName);
  await fs.rename(file.path, fullPath);
  return { storedName, mimeType, size: file.size, fullPath };
}
async function safeRemove(filePath) { if (filePath) await fs.unlink(filePath).catch(() => {}); }

app.get('/healthz', (_req, res) => res.json({ ok: true, storage: 'file' }));

app.post('/api/auth/login', loginLimiter, async (req, res, next) => {
  try {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!username || !password || username.length > 32 || password.length > 128 || Buffer.byteLength(password, 'utf8') > 72) {
      return res.status(400).json({ error: 'نام کاربری یا رمز عبور معتبر نیست.' });
    }
    const user = dbState.users.find((item) => item.username === username);
    const matches = await bcrypt.compare(password, user?.password_hash || DUMMY_PASSWORD_HASH);
    if (!user || !user.is_active || !matches) return res.status(401).json({ error: 'نام کاربری یا رمز عبور اشتباه است.' });
    await new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
    req.session.userId = Number(user.id);
    await new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
    return res.json({ user: safeUser(user) });
  } catch (error) { return next(error); }
});

app.post('/api/auth/logout', requireAuth, (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie('messenger.sid', { path: '/', sameSite: 'strict', secure: IS_PRODUCTION, httpOnly: true });
    return res.json({ ok: true });
  });
});
app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: safeUser(req.user) }));

app.get('/api/groups', requireAuth, (_req, res) => {
  const groups = dbState.groups
    .filter((group) => group.member_ids.includes(Number(_req.user.id)))
    .sort((a, b) => a.id - b.id)
    .map((group) => ({
      id: Number(group.id), name: group.name, description: group.description,
      memberCount: group.member_ids.length,
      messageCount: dbState.messages.filter((message) => message.group_id === group.id && !message.deleted_at).length,
      createdAt: group.created_at
    }));
  return res.json({ groups });
});

app.get('/api/groups/:groupId/members', requireAuth, requireGroupAccess, (req, res) => {
  const group = dbState.groups.find((item) => item.id === req.groupId);
  const members = group.member_ids
    .map((id) => dbState.users.find((user) => user.id === id && user.is_active))
    .filter(Boolean).sort((a, b) => a.display_name.localeCompare(b.display_name, 'fa'))
    .map(safeUser);
  return res.json({ members });
});

app.get('/api/groups/:groupId/messages', requireAuth, requireGroupAccess, (req, res) => {
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
  const before = req.query.before && isValidId(req.query.before) ? Number(req.query.before) : null;
  let messages = dbState.messages.filter((message) => message.group_id === req.groupId && (!before || message.id < before));
  messages = messages.sort((a, b) => b.id - a.id).slice(0, limit).reverse().map(publicMessage).filter(Boolean);
  return res.json({ messages });
});

app.post('/api/groups/:groupId/messages', requireAuth, requireGroupAccess, async (req, res, next) => {
  try {
    const type = req.body?.type === 'sticker' ? 'sticker' : 'text';
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!content || content.length > (type === 'sticker' ? 24 : 5000)) return res.status(400).json({ error: 'متن پیام خالی است یا بیش از حد مجاز طول دارد.' });
    let messageId;
    await updateDatabase((draft) => {
      messageId = draft.counters.message++;
      draft.messages.push({
        id: messageId, group_id: req.groupId, user_id: Number(req.user.id), type, content,
        stored_name: null, original_name: null, mime_type: null, file_size: null,
        created_at: new Date().toISOString(), edited_at: null, deleted_at: null
      });
    });
    const message = readMessage(messageId);
    io.to(groupRoom(req.groupId)).emit('message:new', message);
    return res.status(201).json({ message });
  } catch (error) { return next(error); }
});

app.post('/api/groups/:groupId/files', requireAuth, requireGroupAccess, uploadLimiter, (req, res, next) => {
  upload.single('file')(req, res, async (error) => {
    if (error) {
      const tooLarge = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE';
      return res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? `حجم فایل نباید بیشتر از ${MAX_FILE_MB} مگابایت باشد.` : 'بارگذاری فایل ناموفق بود.' });
    }
    let moved;
    try {
      moved = await classifyAndMoveUpload(req.file);
      const originalName = path.basename(String(req.file.originalname || 'file')).replace(/[\r\n\0]/g, '').slice(0, 255) || 'file';
      const caption = typeof req.body?.caption === 'string' ? req.body.caption.trim().slice(0, 500) : '';
      let messageId;
      await updateDatabase((draft) => {
        messageId = draft.counters.message++;
        draft.messages.push({
          id: messageId, group_id: req.groupId, user_id: Number(req.user.id), type: 'file', content: caption,
          stored_name: moved.storedName, original_name: originalName, mime_type: moved.mimeType, file_size: moved.size,
          created_at: new Date().toISOString(), edited_at: null, deleted_at: null
        });
      });
      const message = readMessage(messageId);
      io.to(groupRoom(req.groupId)).emit('message:new', message);
      return res.status(201).json({ message });
    } catch (caught) {
      await safeRemove(moved?.fullPath);
      await safeRemove(req.file?.path);
      if (caught.message && !caught.code) return res.status(400).json({ error: caught.message });
      return next(caught);
    }
  });
});

app.patch('/api/messages/:messageId', requireAuth, async (req, res, next) => {
  try {
    if (!isValidId(req.params.messageId)) return res.status(400).json({ error: 'شناسه پیام معتبر نیست.' });
    const id = Number(req.params.messageId);
    const row = dbState.messages.find((message) => message.id === id);
    if (!row || row.deleted_at) return res.status(404).json({ error: 'پیام پیدا نشد.' });
    if (!hasGroupAccess(req.user.id, row.group_id)) return res.status(404).json({ error: 'پیام پیدا نشد.' });
    if (Number(row.user_id) !== Number(req.user.id) && req.user.role !== 'admin') return res.status(403).json({ error: 'فقط نویسنده پیام یا مدیر می‌تواند آن را ویرایش کند.' });
    if (row.type === 'file') return res.status(400).json({ error: 'ویرایش پیام دارای فایل پشتیبانی نمی‌شود؛ می‌توانی کپشن جداگانه ارسال کنی.' });
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!content || content.length > 5000) return res.status(400).json({ error: 'متن پیام باید بین ۱ تا ۵۰۰۰ نویسه باشد.' });
    let groupId;
    await updateDatabase((draft) => {
      const target = draft.messages.find((message) => message.id === id);
      if (!target || target.deleted_at) throw Object.assign(new Error('پیام پیدا نشد.'), { statusCode: 404 });
      target.content = content;
      target.edited_at = new Date().toISOString();
      groupId = target.group_id;
    });
    const message = readMessage(id);
    io.to(groupRoom(groupId)).emit('message:updated', message);
    return res.json({ message });
  } catch (error) { return next(error); }
});

app.delete('/api/messages/:messageId', requireAuth, async (req, res, next) => {
  try {
    if (!isValidId(req.params.messageId)) return res.status(400).json({ error: 'شناسه پیام معتبر نیست.' });
    const id = Number(req.params.messageId);
    const row = dbState.messages.find((message) => message.id === id);
    if (!row || row.deleted_at) return res.status(404).json({ error: 'پیام پیدا نشد.' });
    if (!hasGroupAccess(req.user.id, row.group_id)) return res.status(404).json({ error: 'پیام پیدا نشد.' });
    if (Number(row.user_id) !== Number(req.user.id) && req.user.role !== 'admin') return res.status(403).json({ error: 'فقط نویسنده پیام یا مدیر می‌تواند آن را حذف کند.' });
    const oldStoredName = row.stored_name;
    const groupId = row.group_id;
    await updateDatabase((draft) => {
      const target = draft.messages.find((message) => message.id === id);
      if (!target || target.deleted_at) throw Object.assign(new Error('پیام پیدا نشد.'), { statusCode: 404 });
      target.content = '';
      target.deleted_at = new Date().toISOString();
      target.stored_name = null; target.original_name = null; target.mime_type = null; target.file_size = null;
    });
    if (oldStoredName) await safeRemove(path.join(UPLOAD_DIR, oldStoredName));
    const message = readMessage(id);
    io.to(groupRoom(groupId)).emit('message:updated', message);
    return res.json({ ok: true, message });
  } catch (error) { return next(error); }
});

app.get('/api/files/:storedName', requireAuth, (req, res, next) => {
  try {
    const storedName = String(req.params.storedName || '');
    if (!/^[0-9a-f-]{36}\.(jpg|png|gif|webp|pdf|zip|gz|mp3|ogg|wav|mp4|webm|txt|csv)$/.test(storedName)) return res.status(404).end();
    const message = dbState.messages.find((item) => item.stored_name === storedName && !item.deleted_at);
    if (!message || !hasGroupAccess(req.user.id, message.group_id)) return res.status(404).json({ error: 'فایل پیدا نشد.' });
    const filePath = path.join(UPLOAD_DIR, storedName);
    if (!existsSync(filePath)) return res.status(404).json({ error: 'فایل روی سرور موجود نیست.' });
    const inlineRequested = req.query.inline === '1' && /^image\/(jpeg|png|gif|webp)$/.test(message.mime_type || '');
    res.setHeader('Content-Type', message.mime_type || 'application/octet-stream');
    const safeHeaderName = encodeURIComponent(path.basename(message.original_name || 'download')).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    res.setHeader('Content-Disposition', `${inlineRequested ? 'inline' : 'attachment'}; filename*=UTF-8''${safeHeaderName}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    return res.sendFile(filePath);
  } catch (error) { return next(error); }
});

app.get('/api/avatars/:storedName', requireAuth, (req, res) => {
  const storedName = String(req.params.storedName || '');
  if (!/^[0-9a-f-]{36}\.(jpg|png|webp)$/.test(storedName)) return res.status(404).end();
  const owner = dbState.users.find((user) => user.avatar_name === storedName && user.is_active);
  const filePath = path.join(UPLOAD_DIR, storedName);
  if (!owner || !existsSync(filePath)) return res.status(404).end();
  res.setHeader('Content-Type', storedName.endsWith('.jpg') ? 'image/jpeg' : storedName.endsWith('.png') ? 'image/png' : 'image/webp');
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Cache-Control', 'private, max-age=300');
  return res.sendFile(filePath);
});

app.post('/api/profile/avatar', requireAuth, uploadLimiter, (req, res, next) => {
  upload.single('file')(req, res, async (error) => {
    if (error) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: `بارگذاری تصویر ناموفق بود. حداکثر حجم ${MAX_FILE_MB} مگابایت است.` });
    let moved;
    try {
      moved = await classifyAndMoveUpload(req.file, { imagesOnly: true });
      const oldUser = dbState.users.find((user) => user.id === Number(req.user.id));
      const previous = oldUser?.avatar_name;
      await updateDatabase((draft) => {
        const target = draft.users.find((user) => user.id === Number(req.user.id));
        if (!target) throw new Error('کاربر پیدا نشد.');
        target.avatar_name = moved.storedName;
        target.updated_at = new Date().toISOString();
      });
      if (previous) await safeRemove(path.join(UPLOAD_DIR, previous));
      io.to(`user:${req.user.id}`).emit('profile:changed');
      const updated = dbState.users.find((user) => user.id === Number(req.user.id));
      return res.json({ user: safeUser(updated) });
    } catch (caught) {
      await safeRemove(moved?.fullPath);
      await safeRemove(req.file?.path);
      if (caught.message && !caught.code) return res.status(400).json({ error: caught.message });
      return next(caught);
    }
  });
});

// Admin APIs: user and group management.
app.get('/api/admin/users', requireAuth, requireAdmin, (_req, res) => {
  const users = [...dbState.users].sort((a, b) => a.id - b.id).map(safeUser);
  return res.json({ users });
});

app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
    const displayName = typeof req.body?.displayName === 'string' ? req.body.displayName.trim() : '';
    const password = req.body?.password;
    const role = req.body?.role === 'admin' ? 'admin' : 'user';
    if (!isValidUsername(username)) return res.status(400).json({ error: 'نام کاربری باید ۳ تا ۳۲ نویسه و شامل حروف انگلیسی، عدد، نقطه، _ یا - باشد.' });
    if (displayName.length < 1 || displayName.length > 80) return res.status(400).json({ error: 'نام نمایشی باید بین ۱ تا ۸۰ نویسه باشد.' });
    if (!isValidPassword(password)) return res.status(400).json({ error: 'رمز عبور باید حداقل ۱۲ نویسه، حداکثر ۱۲۸ نویسه و حداکثر ۷۲ بایت UTF-8 باشد.' });
    if (dbState.users.some((user) => user.username === username)) return res.status(409).json({ error: 'این نام کاربری قبلاً ثبت شده است.' });
    const hash = await bcrypt.hash(password, 12);
    let userId;
    await updateDatabase((draft) => {
      if (draft.users.some((user) => user.username === username)) throw Object.assign(new Error('این نام کاربری قبلاً ثبت شده است.'), { statusCode: 409 });
      const now = new Date().toISOString();
      userId = draft.counters.user++;
      draft.users.push({ id: userId, username, display_name: displayName, password_hash: hash, role, is_active: true, avatar_name: null, created_at: now, updated_at: now });
    });
    return res.status(201).json({ user: safeUser(dbState.users.find((user) => user.id === userId)) });
  } catch (error) { return next(error); }
});

app.patch('/api/admin/users/:userId', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    if (!isValidId(req.params.userId)) return res.status(400).json({ error: 'شناسه کاربر معتبر نیست.' });
    const id = Number(req.params.userId);
    const old = dbState.users.find((user) => user.id === id);
    if (!old) return res.status(404).json({ error: 'کاربر پیدا نشد.' });
    const username = req.body?.username === undefined ? old.username : String(req.body.username).trim().toLowerCase();
    const displayName = req.body?.displayName === undefined ? old.display_name : String(req.body.displayName).trim();
    const role = req.body?.role === undefined ? old.role : req.body.role;
    const active = req.body?.isActive === undefined ? old.is_active : req.body.isActive;
    const password = req.body?.password;
    if (!isValidUsername(username)) return res.status(400).json({ error: 'نام کاربری معتبر نیست.' });
    if (!displayName || displayName.length > 80) return res.status(400).json({ error: 'نام نمایشی معتبر نیست.' });
    if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'نقش کاربر معتبر نیست.' });
    if (typeof active !== 'boolean') return res.status(400).json({ error: 'وضعیت فعال بودن باید درست یا نادرست باشد.' });
    if (password !== undefined && password !== '' && !isValidPassword(password)) return res.status(400).json({ error: 'رمز جدید باید حداقل ۱۲ نویسه، حداکثر ۱۲۸ نویسه و حداکثر ۷۲ بایت UTF-8 باشد.' });
    if (id === Number(req.user.id) && (role !== 'admin' || active === false)) return res.status(400).json({ error: 'مدیر واردشده نمی‌تواند خودش را از نقش مدیر خارج یا غیرفعال کند.' });
    if (old.role === 'admin' && (role !== 'admin' || active === false)) {
      const activeAdmins = dbState.users.filter((user) => user.role === 'admin' && user.is_active).length;
      if (activeAdmins <= 1) return res.status(400).json({ error: 'حداقل یک مدیر فعال باید باقی بماند.' });
    }
    if (dbState.users.some((user) => user.id !== id && user.username === username)) return res.status(409).json({ error: 'این نام کاربری قبلاً ثبت شده است.' });
    const passwordChanged = typeof password === 'string' && password.length > 0;
    const hash = passwordChanged ? await bcrypt.hash(password, 12) : old.password_hash;
    await updateDatabase((draft) => {
      const target = draft.users.find((user) => user.id === id);
      if (!target) throw Object.assign(new Error('کاربر پیدا نشد.'), { statusCode: 404 });
      if (draft.users.some((user) => user.id !== id && user.username === username)) throw Object.assign(new Error('این نام کاربری قبلاً ثبت شده است.'), { statusCode: 409 });
      if (target.role === 'admin' && (role !== 'admin' || active === false) && draft.users.filter((user) => user.role === 'admin' && user.is_active).length <= 1) {
        throw Object.assign(new Error('حداقل یک مدیر فعال باید باقی بماند.'), { statusCode: 400 });
      }
      target.username = username; target.display_name = displayName; target.role = role; target.is_active = active;
      target.password_hash = hash; target.updated_at = new Date().toISOString();
    });
    if (passwordChanged || !active) {
      await sessionStore.destroyForUser(id);
      for (const socket of io.sockets.sockets.values()) if (socket.userId === id) socket.disconnect(true);
      if (id === Number(req.user.id)) {
        req.session.destroy(() => {});
        res.clearCookie('messenger.sid', { path: '/', sameSite: 'strict', secure: IS_PRODUCTION, httpOnly: true });
      }
    } else {
      io.to(`user:${id}`).emit('profile:changed');
    }
    return res.json({ user: safeUser(dbState.users.find((user) => user.id === id)) });
  } catch (error) { return next(error); }
});

app.get('/api/admin/groups', requireAuth, requireAdmin, (_req, res) => {
  const groups = [...dbState.groups].sort((a, b) => a.id - b.id).map((group) => ({
    id: Number(group.id), name: group.name, description: group.description,
    memberIds: group.member_ids.map(Number), createdAt: group.created_at
  }));
  return res.json({ groups });
});

app.post('/api/admin/groups', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const description = typeof req.body?.description === 'string' ? req.body.description.trim().slice(0, 300) : '';
    const memberIds = Array.isArray(req.body?.memberIds) ? [...new Set(req.body.memberIds.map(Number))] : [];
    if (!name || name.length > 80) return res.status(400).json({ error: 'نام گروه باید بین ۱ تا ۸۰ نویسه باشد.' });
    if (memberIds.length > 500 || memberIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) return res.status(400).json({ error: 'فهرست اعضا معتبر نیست.' });
    let groupId;
    let actualIds = [];
    await updateDatabase((draft) => {
      actualIds = [...new Set([...memberIds, Number(req.user.id)])]
        .filter((id) => draft.users.some((user) => user.id === id && user.is_active));
      const now = new Date().toISOString();
      groupId = draft.counters.group++;
      draft.groups.push({ id: groupId, name, description, created_by: req.user.id, created_at: now, member_ids: actualIds });
    });
    await broadcastGroupsChanged(actualIds);
    const group = dbState.groups.find((item) => item.id === groupId);
    return res.status(201).json({ group: { id: group.id, name: group.name, description: group.description, createdAt: group.created_at, memberIds: group.member_ids } });
  } catch (error) { return next(error); }
});

app.patch('/api/admin/groups/:groupId', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    if (!isValidId(req.params.groupId)) return res.status(400).json({ error: 'شناسه گروه معتبر نیست.' });
    const id = Number(req.params.groupId);
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const description = typeof req.body?.description === 'string' ? req.body.description.trim().slice(0, 300) : '';
    const memberIds = Array.isArray(req.body?.memberIds) ? [...new Set(req.body.memberIds.map(Number))] : null;
    if (!name || name.length > 80 || !memberIds || memberIds.length > 500 || memberIds.some((num) => !Number.isSafeInteger(num) || num <= 0)) {
      return res.status(400).json({ error: 'اطلاعات گروه یا اعضا معتبر نیست.' });
    }
    const oldGroup = dbState.groups.find((group) => group.id === id);
    if (!oldGroup) return res.status(404).json({ error: 'گروه پیدا نشد.' });
    const previousIds = [...oldGroup.member_ids];
    let actualIds = [];
    await updateDatabase((draft) => {
      const group = draft.groups.find((item) => item.id === id);
      if (!group) throw Object.assign(new Error('گروه پیدا نشد.'), { statusCode: 404 });
      actualIds = [...new Set([...memberIds, Number(req.user.id)])]
        .filter((memberId) => draft.users.some((user) => user.id === memberId && user.is_active));
      group.name = name; group.description = description; group.member_ids = actualIds;
    });
    for (const socket of io.sockets.sockets.values()) {
      if (socket.rooms.has(groupRoom(id)) && !actualIds.includes(socket.userId)) socket.leave(groupRoom(id));
    }
    await broadcastGroupsChanged([...previousIds, ...actualIds]);
    return res.json({ group: { id, name, description, memberIds: actualIds } });
  } catch (error) { return next(error); }
});

app.delete('/api/admin/groups/:groupId', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    if (!isValidId(req.params.groupId)) return res.status(400).json({ error: 'شناسه گروه معتبر نیست.' });
    const id = Number(req.params.groupId);
    const group = dbState.groups.find((item) => item.id === id);
    if (!group) return res.status(404).json({ error: 'گروه پیدا نشد.' });
    const memberIds = [...group.member_ids];
    const files = dbState.messages.filter((message) => message.group_id === id && message.stored_name).map((message) => message.stored_name);
    await updateDatabase((draft) => {
      draft.groups = draft.groups.filter((item) => item.id !== id);
      draft.messages = draft.messages.filter((message) => message.group_id !== id);
    });
    for (const storedName of files) await safeRemove(path.join(UPLOAD_DIR, storedName));
    for (const socket of io.sockets.sockets.values()) socket.leave(groupRoom(id));
    await broadcastGroupsChanged(memberIds);
    return res.json({ ok: true });
  } catch (error) { return next(error); }
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'مسیر پیدا نشد.' });
  return res.status(404).send('صفحه پیدا نشد.');
});
app.use((error, req, res, _next) => {
  console.error('Request failed:', error?.message || 'unknown error');
  if (res.headersSent) return;
  if (error instanceof multer.MulterError) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: 'فایل یا درخواست بارگذاری معتبر نیست.' });
  if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) return res.status(error.statusCode).json({ error: error.message });
  return res.status(500).json({ error: 'خطای داخلی سرور رخ داد. جزئیات برای امنیت نمایش داده نمی‌شود.' });
});

async function main() {
  await initializeFileDatabase();
  await sessionStore.ready;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Messenger is listening on port ${PORT}`);
    console.log(`File data: ${DATA_FILE}`);
    console.log(`Uploads: ${UPLOAD_DIR}`);
    console.log(`Local URL: http://localhost:${PORT}`);
  });
}
main().catch((error) => {
  console.error('Startup failed:', error.message);
  process.exit(1);
});

async function shutdown() {
  server.close(() => {});
  await new Promise((resolve) => io.close(resolve));
  await dbMutationQueue.catch(() => {});
  await sessionStore.writeQueue.catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
