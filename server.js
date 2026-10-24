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
import connectPgSimple from 'connect-pg-simple';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import { fileTypeFromFile } from 'file-type';
import { Pool } from 'pg';
import { rateLimit } from 'express-rate-limit';
import { Server as SocketServer } from 'socket.io';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, 'uploads'));
const PORT = Number(process.env.PORT || 3000);
const parsedMaxFileMb = Number(process.env.MAX_FILE_MB || 15);
const MAX_FILE_MB = Number.isFinite(parsedMaxFileMb) ? Math.min(30, Math.max(1, parsedMaxFileMb)) : 15;
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const DUMMY_PASSWORD_HASH = await bcrypt.hash('deliberately-invalid-login-password', 12);

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL تنظیم نشده است. فایل .env را بررسی کن.');
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  throw new Error('SESSION_SECRET باید حداقل ۳۲ نویسه تصادفی داشته باشد.');
}
if (IS_PRODUCTION && (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD)) {
  throw new Error('در محیط production باید ADMIN_USERNAME و ADMIN_PASSWORD تنظیم شوند.');
}
if (IS_PRODUCTION && process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.length < 12) {
  throw new Error('رمز عبور اولیه مدیر در production باید حداقل ۱۲ نویسه داشته باشد.');
}

mkdirSync(UPLOAD_DIR, { recursive: true });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ...(process.env.PGSSL === 'true' ? { ssl: { rejectUnauthorized: true } } : {})
});
pool.on('error', (error) => console.error('PostgreSQL pool error:', error.message));

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      username VARCHAR(32) NOT NULL UNIQUE,
      display_name VARCHAR(80) NOT NULL,
      password_hash TEXT NOT NULL,
      role VARCHAR(16) NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      avatar_name VARCHAR(100),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS chat_groups (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(80) NOT NULL,
      description VARCHAR(300) NOT NULL DEFAULT '',
      created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS group_members (
      group_id BIGINT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (group_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      group_id BIGINT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type VARCHAR(16) NOT NULL DEFAULT 'text' CHECK (type IN ('text', 'file', 'sticker')),
      content TEXT NOT NULL DEFAULT '',
      stored_name VARCHAR(120),
      original_name VARCHAR(255),
      mime_type VARCHAR(120),
      file_size BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      edited_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_messages_group_id_id ON messages(group_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_members_user_id ON group_members(user_id);
    CREATE TABLE IF NOT EXISTS user_sessions (
      sid VARCHAR NOT NULL PRIMARY KEY,
      sess JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_sessions_expire ON user_sessions(expire);
  `);

  const adminUsername = String(process.env.ADMIN_USERNAME || '').trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD || '';
  if (adminUsername && adminPassword) {
    if (!/^[a-z0-9_.-]{3,32}$/.test(adminUsername)) {
      throw new Error('ADMIN_USERNAME باید ۳ تا ۳۲ نویسه و فقط شامل حروف انگلیسی کوچک، عدد، نقطه، _ یا - باشد.');
    }
    if (adminPassword.length < 12 || Buffer.byteLength(adminPassword, 'utf8') > 72) {
      throw new Error('رمز مدیر باید حداقل ۱۲ نویسه و حداکثر ۷۲ بایت UTF-8 باشد.');
    }
    const existing = await pool.query('SELECT id FROM users WHERE username = $1', [adminUsername]);
    if (existing.rowCount === 0) {
      const hash = await bcrypt.hash(adminPassword, 12);
      const displayName = String(process.env.ADMIN_DISPLAY_NAME || 'مدیر سیستم').slice(0, 80);
      const created = await pool.query(
        `INSERT INTO users (username, display_name, password_hash, role)
         VALUES ($1, $2, $3, 'admin') RETURNING id`,
        [adminUsername, displayName, hash]
      );
      await pool.query(
        `INSERT INTO chat_groups (name, description, created_by) VALUES ($1, $2, $3)`,
        ['عمومی', 'گفت‌وگوی عمومی کاربران', created.rows[0].id]
      );
      await pool.query(`INSERT INTO group_members (group_id, user_id) SELECT id, $1 FROM chat_groups`, [created.rows[0].id]);
      console.log(`Admin account '${adminUsername}' was created from environment variables.`);
    }
  }
}

const app = express();
const server = http.createServer(app);
app.disable('x-powered-by');
app.set('trust proxy', IS_PRODUCTION ? 1 : false);

const PgSession = connectPgSimple(session);
const sessionStore = new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: false });
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

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      fontSrc: ["'self'", 'data:'],
      imgSrc: ["'self'", 'data:'],
      styleSrc: ["'self'"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"]
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

// Mutating browser requests must originate from the same origin (or the explicitly configured APP_ORIGIN).
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
  index: 'index.html',
  dotfiles: 'deny',
  etag: true,
  maxAge: IS_PRODUCTION ? '1h' : 0,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
  }
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'تعداد تلاش‌های ورود زیاد است. ۱۵ دقیقه بعد دوباره تلاش کن.' }
});
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 180,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'تعداد درخواست‌ها زیاد است. کمی بعد دوباره تلاش کن.' }
});
const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
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

const io = new SocketServer(server, {
  serveClient: true,
  maxHttpBufferSize: 1e6,
  cors: { origin: false }
});
io.engine.use(sessionMiddleware);
io.use(async (socket, next) => {
  try {
    const origin = socket.handshake.headers.origin;
    const forwardedProto = String(socket.request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const protocol = forwardedProto || (socket.request.socket.encrypted ? 'https' : 'http');
    const expectedOrigin = process.env.APP_ORIGIN
      ? new URL(process.env.APP_ORIGIN).origin
      : `${protocol}://${socket.request.headers.host}`;
    if (!origin || new URL(origin).origin !== expectedOrigin) return next(new Error('ORIGIN_NOT_ALLOWED'));
    const userId = socket.request.session?.userId;
    if (!userId) return next(new Error('AUTH_REQUIRED'));
    const result = await pool.query('SELECT id, is_active FROM users WHERE id = $1', [userId]);
    if (!result.rows[0]?.is_active) return next(new Error('AUTH_REQUIRED'));
    socket.userId = Number(userId);
    return next();
  } catch {
    return next(new Error('AUTH_REQUIRED'));
  }
});
io.on('connection', async (socket) => {
  socket.join(`user:${socket.userId}`);
  const memberships = await pool.query('SELECT group_id FROM group_members WHERE user_id = $1', [socket.userId]);
  for (const row of memberships.rows) socket.join(`group:${row.group_id}`);
  socket.on('group:join', async (groupId) => {
    const id = Number(groupId);
    if (!Number.isSafeInteger(id) || id <= 0) return;
    const access = await pool.query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [id, socket.userId]);
    if (access.rowCount) socket.join(`group:${id}`);
  });
  socket.on('disconnect', () => {});
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
  const userId = req.session?.userId;
  if (!userId) return res.status(401).json({ error: 'ابتدا وارد حساب کاربری شو.' });
  pool.query('SELECT id, username, display_name, role, is_active, avatar_name, created_at FROM users WHERE id = $1', [userId])
    .then(({ rows }) => {
      if (!rows[0] || !rows[0].is_active) {
        req.session.destroy(() => {});
        res.clearCookie('messenger.sid', { path: '/', sameSite: 'strict', secure: IS_PRODUCTION });
        return res.status(401).json({ error: 'حساب کاربری غیرفعال است یا نشست پایان یافته است.' });
      }
      req.user = rows[0];
      return next();
    })
    .catch(next);
}
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'فقط مدیر سیستم به این بخش دسترسی دارد.' });
  return next();
}
function isValidUsername(value) { return typeof value === 'string' && /^[a-zA-Z0-9_.-]{3,32}$/.test(value); }
function isValidPassword(value) { return typeof value === 'string' && value.length >= 12 && value.length <= 128 && Buffer.byteLength(value, 'utf8') <= 72; }
function isValidId(value) { return Number.isSafeInteger(Number(value)) && Number(value) > 0; }
function groupRoom(groupId) { return `group:${Number(groupId)}`; }
async function hasGroupAccess(userId, groupId) {
  const { rowCount } = await pool.query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, userId]);
  return rowCount > 0;
}
async function requireGroupAccess(req, res, next) {
  const groupId = Number(req.params.groupId);
  if (!isValidId(groupId)) return res.status(400).json({ error: 'شناسه گروه معتبر نیست.' });
  try {
    if (!(await hasGroupAccess(req.user.id, groupId))) return res.status(404).json({ error: 'گروه پیدا نشد یا به آن دسترسی نداری.' });
    req.groupId = groupId;
    return next();
  } catch (error) { return next(error); }
}
function publicMessage(row) {
  return {
    id: Number(row.id), groupId: Number(row.group_id), type: row.type,
    content: row.deleted_at ? 'این پیام حذف شده است.' : row.content,
    isDeleted: Boolean(row.deleted_at),
    user: { id: Number(row.user_id), username: row.username, displayName: row.display_name,
      avatarUrl: row.avatar_name ? `/api/avatars/${encodeURIComponent(row.avatar_name)}` : null },
    attachment: !row.deleted_at && row.stored_name ? {
      url: `/api/files/${encodeURIComponent(row.stored_name)}`,
      inlineUrl: `/api/files/${encodeURIComponent(row.stored_name)}?inline=1`,
      name: row.original_name, mimeType: row.mime_type, size: Number(row.file_size || 0)
    } : null,
    createdAt: row.created_at, editedAt: row.edited_at
  };
}
async function readMessage(id) {
  const { rows } = await pool.query(
    `SELECT m.*, u.username, u.display_name, u.avatar_name
       FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = $1`, [id]);
  return rows[0] ? publicMessage(rows[0]) : null;
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
  const id = randomUUID();
  const storedName = `${id}.${extension}`;
  const newPath = path.join(UPLOAD_DIR, storedName);
  await fs.rename(file.path, newPath);
  return { storedName, mimeType, size: file.size, fullPath: newPath };
}
async function safeRemove(filePath) {
  if (filePath) await fs.unlink(filePath).catch(() => {});
}

app.get('/healthz', async (_req, res) => {
  try { await pool.query('SELECT 1'); return res.json({ ok: true }); }
  catch { return res.status(503).json({ ok: false }); }
});

app.post('/api/auth/login', loginLimiter, async (req, res, next) => {
  try {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!username || !password || username.length > 32 || password.length > 128 || Buffer.byteLength(password, 'utf8') > 72) return res.status(400).json({ error: 'نام کاربری یا رمز عبور معتبر نیست.' });
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = rows[0];
    const matches = await bcrypt.compare(password, user?.password_hash || DUMMY_PASSWORD_HASH);
    if (!user || !user.is_active || !matches) return res.status(401).json({ error: 'نام کاربری یا رمز عبور اشتباه است.' });
    await new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
    req.session.userId = Number(user.id);
    await new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
    return res.json({ user: safeUser(user) });
  } catch (error) { return next(error); }
});

app.post('/api/auth/logout', requireAuth, async (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie('messenger.sid', { path: '/', sameSite: 'strict', secure: IS_PRODUCTION, httpOnly: true });
    return res.json({ ok: true });
  });
});
app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: safeUser(req.user) }));

app.get('/api/groups', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT g.id, g.name, g.description, g.created_at,
              (SELECT COUNT(*)::int FROM group_members gm2 WHERE gm2.group_id = g.id) AS member_count,
              (SELECT COUNT(*)::int FROM messages m WHERE m.group_id = g.id AND m.deleted_at IS NULL) AS message_count
         FROM chat_groups g JOIN group_members gm ON gm.group_id = g.id
        WHERE gm.user_id = $1 ORDER BY g.id`, [req.user.id]);
    return res.json({ groups: rows.map(r => ({ id: Number(r.id), name: r.name, description: r.description,
      memberCount: r.member_count, messageCount: r.message_count, createdAt: r.created_at })) });
  } catch (error) { return next(error); }
});

app.get('/api/groups/:groupId/members', requireAuth, requireGroupAccess, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.display_name, u.role, u.avatar_name
         FROM users u JOIN group_members gm ON gm.user_id = u.id
        WHERE gm.group_id = $1 AND u.is_active = TRUE ORDER BY u.display_name`, [req.groupId]);
    return res.json({ members: rows.map(safeUser) });
  } catch (error) { return next(error); }
});

app.get('/api/groups/:groupId/messages', requireAuth, requireGroupAccess, async (req, res, next) => {
  try {
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    const before = req.query.before && isValidId(req.query.before) ? Number(req.query.before) : null;
    const params = [req.groupId, limit];
    let cursorSql = '';
    if (before) { params.push(before); cursorSql = 'AND m.id < $3'; }
    const { rows } = await pool.query(
      `SELECT m.*, u.username, u.display_name, u.avatar_name
         FROM messages m JOIN users u ON u.id = m.user_id
        WHERE m.group_id = $1 ${cursorSql} ORDER BY m.id DESC LIMIT $2`, params);
    return res.json({ messages: rows.reverse().map(publicMessage) });
  } catch (error) { return next(error); }
});

app.post('/api/groups/:groupId/messages', requireAuth, requireGroupAccess, async (req, res, next) => {
  try {
    const type = req.body?.type === 'sticker' ? 'sticker' : 'text';
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!content || content.length > (type === 'sticker' ? 24 : 5000)) return res.status(400).json({ error: 'متن پیام خالی است یا بیش از حد مجاز طول دارد.' });
    const { rows } = await pool.query(
      `INSERT INTO messages (group_id, user_id, type, content) VALUES ($1, $2, $3, $4) RETURNING id`,
      [req.groupId, req.user.id, type, content]);
    const message = await readMessage(rows[0].id);
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
      const { rows } = await pool.query(
        `INSERT INTO messages (group_id, user_id, type, content, stored_name, original_name, mime_type, file_size)
         VALUES ($1, $2, 'file', $3, $4, $5, $6, $7) RETURNING id`,
        [req.groupId, req.user.id, caption, moved.storedName, originalName, moved.mimeType, moved.size]);
      const message = await readMessage(rows[0].id);
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
    const { rows } = await pool.query('SELECT * FROM messages WHERE id = $1', [id]);
    const messageRow = rows[0];
    if (!messageRow || messageRow.deleted_at) return res.status(404).json({ error: 'پیام پیدا نشد.' });
    if (!(await hasGroupAccess(req.user.id, messageRow.group_id))) return res.status(404).json({ error: 'پیام پیدا نشد.' });
    if (Number(messageRow.user_id) !== Number(req.user.id) && req.user.role !== 'admin') return res.status(403).json({ error: 'فقط نویسنده پیام یا مدیر می‌تواند آن را ویرایش کند.' });
    if (messageRow.type === 'file') return res.status(400).json({ error: 'ویرایش پیام دارای فایل پشتیبانی نمی‌شود؛ می‌توانی کپشن جداگانه ارسال کنی.' });
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!content || content.length > 5000) return res.status(400).json({ error: 'متن پیام باید بین ۱ تا ۵۰۰۰ نویسه باشد.' });
    await pool.query('UPDATE messages SET content = $1, edited_at = NOW() WHERE id = $2', [content, id]);
    const message = await readMessage(id);
    io.to(groupRoom(message.groupId)).emit('message:updated', message);
    return res.json({ message });
  } catch (error) { return next(error); }
});

app.delete('/api/messages/:messageId', requireAuth, async (req, res, next) => {
  try {
    if (!isValidId(req.params.messageId)) return res.status(400).json({ error: 'شناسه پیام معتبر نیست.' });
    const id = Number(req.params.messageId);
    const { rows } = await pool.query('SELECT * FROM messages WHERE id = $1', [id]);
    const row = rows[0];
    if (!row || row.deleted_at) return res.status(404).json({ error: 'پیام پیدا نشد.' });
    if (!(await hasGroupAccess(req.user.id, row.group_id))) return res.status(404).json({ error: 'پیام پیدا نشد.' });
    if (Number(row.user_id) !== Number(req.user.id) && req.user.role !== 'admin') return res.status(403).json({ error: 'فقط نویسنده پیام یا مدیر می‌تواند آن را حذف کند.' });
    await pool.query('UPDATE messages SET content = $1, deleted_at = NOW(), stored_name = NULL, original_name = NULL, mime_type = NULL, file_size = NULL WHERE id = $2', ['', id]);
    if (row.stored_name) await safeRemove(path.join(UPLOAD_DIR, row.stored_name));
    const message = await readMessage(id);
    io.to(groupRoom(message.groupId)).emit('message:updated', message);
    return res.json({ ok: true, message });
  } catch (error) { return next(error); }
});

app.get('/api/files/:storedName', requireAuth, async (req, res, next) => {
  try {
    const storedName = String(req.params.storedName || '');
    if (!/^[0-9a-f-]{36}\.(jpg|png|gif|webp|pdf|zip|gz|mp3|ogg|wav|mp4|webm|txt|csv)$/.test(storedName)) return res.status(404).end();
    const { rows } = await pool.query(
      `SELECT m.group_id, m.mime_type, m.original_name FROM messages m
        WHERE m.stored_name = $1 AND m.deleted_at IS NULL`, [storedName]);
    const file = rows[0];
    if (!file || !(await hasGroupAccess(req.user.id, file.group_id))) return res.status(404).json({ error: 'فایل پیدا نشد.' });
    const filePath = path.join(UPLOAD_DIR, storedName);
    if (!existsSync(filePath)) return res.status(404).json({ error: 'فایل روی سرور موجود نیست.' });
    const inlineRequested = req.query.inline === '1' && /^image\/(jpeg|png|gif|webp)$/.test(file.mime_type || '');
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    const safeHeaderName = encodeURIComponent(path.basename(file.original_name || 'download')).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    res.setHeader('Content-Disposition', `${inlineRequested ? 'inline' : 'attachment'}; filename*=UTF-8''${safeHeaderName}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    return res.sendFile(filePath);
  } catch (error) { return next(error); }
});

app.get('/api/avatars/:storedName', requireAuth, async (req, res, next) => {
  try {
    const storedName = String(req.params.storedName || '');
    if (!/^[0-9a-f-]{36}\.(jpg|png|webp)$/.test(storedName)) return res.status(404).end();
    const { rowCount } = await pool.query('SELECT 1 FROM users WHERE avatar_name = $1 AND is_active = TRUE', [storedName]);
    const filePath = path.join(UPLOAD_DIR, storedName);
    if (!rowCount || !existsSync(filePath)) return res.status(404).end();
    res.setHeader('Content-Type', storedName.endsWith('.jpg') ? 'image/jpeg' : storedName.endsWith('.png') ? 'image/png' : 'image/webp');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.sendFile(filePath);
  } catch (error) { return next(error); }
});

app.post('/api/profile/avatar', requireAuth, uploadLimiter, (req, res, next) => {
  upload.single('file')(req, res, async (error) => {
    if (error) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: `بارگذاری تصویر ناموفق بود. حداکثر حجم ${MAX_FILE_MB} مگابایت است.` });
    let moved;
    try {
      moved = await classifyAndMoveUpload(req.file, { imagesOnly: true });
      const previous = req.user.avatar_name;
      await pool.query('UPDATE users SET avatar_name = $1, updated_at = NOW() WHERE id = $2', [moved.storedName, req.user.id]);
      if (previous) await safeRemove(path.join(UPLOAD_DIR, previous));
      const { rows } = await pool.query('SELECT id, username, display_name, role, is_active, avatar_name, created_at FROM users WHERE id = $1', [req.user.id]);
      io.to(`user:${req.user.id}`).emit('profile:changed');
      return res.json({ user: safeUser(rows[0]) });
    } catch (caught) {
      await safeRemove(moved?.fullPath);
      await safeRemove(req.file?.path);
      if (caught.message && !caught.code) return res.status(400).json({ error: caught.message });
      return next(caught);
    }
  });
});

// Admin APIs: user and group management.
app.get('/api/admin/users', requireAuth, requireAdmin, async (_req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT id, username, display_name, role, is_active, avatar_name, created_at FROM users ORDER BY id');
    return res.json({ users: rows.map(safeUser) });
  } catch (error) { return next(error); }
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
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      `INSERT INTO users (username, display_name, password_hash, role) VALUES ($1, $2, $3, $4)
       RETURNING id, username, display_name, role, is_active, avatar_name, created_at`,
      [username, displayName, hash, role]);
    return res.status(201).json({ user: safeUser(rows[0]) });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'این نام کاربری قبلاً ثبت شده است.' });
    return next(error);
  }
});
app.patch('/api/admin/users/:userId', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    if (!isValidId(req.params.userId)) return res.status(400).json({ error: 'شناسه کاربر معتبر نیست.' });
    const id = Number(req.params.userId);
    const { rows: oldRows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    const old = oldRows[0];
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
    if (Number(req.user.id) === id && (role !== 'admin' || active === false)) return res.status(400).json({ error: 'مدیر واردشده نمی‌تواند خودش را از نقش مدیر خارج یا غیرفعال کند.' });
    if (old.role === 'admin' && (role !== 'admin' || active === false)) {
      const { rows: admins } = await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin' AND is_active = TRUE");
      if (admins[0].n <= 1) return res.status(400).json({ error: 'حداقل یک مدیر فعال باید باقی بماند.' });
    }
    let hash = old.password_hash;
    const passwordChanged = typeof password === 'string' && password.length > 0;
    if (passwordChanged) hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      `UPDATE users SET username = $1, display_name = $2, role = $3, is_active = $4, password_hash = $5, updated_at = NOW()
       WHERE id = $6 RETURNING id, username, display_name, role, is_active, avatar_name, created_at`,
      [username, displayName, role, active, hash, id]);
    if (passwordChanged || !active) {
      await pool.query("DELETE FROM user_sessions WHERE sess->>'userId' = $1", [String(id)]);
      for (const socket of io.sockets.sockets.values()) if (socket.userId === id) socket.disconnect(true);
    } else {
      io.to(`user:${id}`).emit('profile:changed');
    }
    return res.json({ user: safeUser(rows[0]) });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'این نام کاربری قبلاً ثبت شده است.' });
    return next(error);
  }
});

app.get('/api/admin/groups', requireAuth, requireAdmin, async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT g.id, g.name, g.description, g.created_at,
              COALESCE(array_agg(gm.user_id) FILTER (WHERE gm.user_id IS NOT NULL), '{}') AS member_ids
         FROM chat_groups g LEFT JOIN group_members gm ON gm.group_id = g.id
        GROUP BY g.id ORDER BY g.id`);
    return res.json({ groups: rows.map(r => ({ id: Number(r.id), name: r.name, description: r.description,
      memberIds: r.member_ids.map(Number), createdAt: r.created_at })) });
  } catch (error) { return next(error); }
});
app.post('/api/admin/groups', requireAuth, requireAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const description = typeof req.body?.description === 'string' ? req.body.description.trim().slice(0, 300) : '';
    const memberIds = Array.isArray(req.body?.memberIds) ? [...new Set(req.body.memberIds.map(Number))] : [];
    if (!name || name.length > 80) return res.status(400).json({ error: 'نام گروه باید بین ۱ تا ۸۰ نویسه باشد.' });
    if (memberIds.length > 500 || memberIds.some(id => !Number.isSafeInteger(id) || id <= 0)) return res.status(400).json({ error: 'فهرست اعضا معتبر نیست.' });
    await client.query('BEGIN');
    const inserted = await client.query('INSERT INTO chat_groups (name, description, created_by) VALUES ($1, $2, $3) RETURNING id, name, description, created_at', [name, description, req.user.id]);
    const group = inserted.rows[0];
    const allMemberIds = [...new Set([...memberIds, Number(req.user.id)])];
    if (allMemberIds.length) {
      const actual = await client.query('SELECT id FROM users WHERE id = ANY($1::bigint[]) AND is_active = TRUE', [allMemberIds]);
      for (const user of actual.rows) await client.query('INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [group.id, user.id]);
    }
    await client.query('COMMIT');
    await broadcastGroupsChanged(allMemberIds);
    return res.status(201).json({ group: { id: Number(group.id), name: group.name, description: group.description, createdAt: group.created_at, memberIds: allMemberIds } });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    return next(error);
  } finally { client.release(); }
});
app.patch('/api/admin/groups/:groupId', requireAuth, requireAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (!isValidId(req.params.groupId)) return res.status(400).json({ error: 'شناسه گروه معتبر نیست.' });
    const id = Number(req.params.groupId);
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const description = typeof req.body?.description === 'string' ? req.body.description.trim().slice(0, 300) : '';
    const memberIds = Array.isArray(req.body?.memberIds) ? [...new Set(req.body.memberIds.map(Number))] : null;
    if (!name || name.length > 80 || !memberIds || memberIds.length > 500 || memberIds.some(n => !Number.isSafeInteger(n) || n <= 0)) return res.status(400).json({ error: 'اطلاعات گروه یا اعضا معتبر نیست.' });
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id FROM chat_groups WHERE id = $1', [id]);
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'گروه پیدا نشد.' }); }
    const { rows: previousMembers } = await client.query('SELECT user_id FROM group_members WHERE group_id = $1', [id]);
    const previousIds = previousMembers.map(r => Number(r.user_id));
    const actual = await client.query('SELECT id FROM users WHERE id = ANY($1::bigint[]) AND is_active = TRUE', [[...new Set([...memberIds, Number(req.user.id)])]]);
    const actualIds = actual.rows.map(r => Number(r.id));
    await client.query('UPDATE chat_groups SET name = $1, description = $2 WHERE id = $3', [name, description, id]);
    await client.query('DELETE FROM group_members WHERE group_id = $1', [id]);
    for (const userId of actualIds) await client.query('INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, userId]);
    await client.query('COMMIT');
    // Force users whose access was removed to leave this Socket.IO room.
    for (const socket of io.sockets.sockets.values()) {
      if (socket.rooms.has(groupRoom(id)) && !actualIds.includes(socket.userId)) socket.leave(groupRoom(id));
    }
    await broadcastGroupsChanged([...previousIds, ...actualIds]);
    return res.json({ group: { id, name, description, memberIds: actualIds } });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); return next(error); }
  finally { client.release(); }
});
app.delete('/api/admin/groups/:groupId', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    if (!isValidId(req.params.groupId)) return res.status(400).json({ error: 'شناسه گروه معتبر نیست.' });
    const id = Number(req.params.groupId);
    const members = await pool.query('SELECT user_id FROM group_members WHERE group_id = $1', [id]);
    const files = await pool.query('SELECT stored_name FROM messages WHERE group_id = $1 AND stored_name IS NOT NULL', [id]);
    const { rowCount } = await pool.query('DELETE FROM chat_groups WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'گروه پیدا نشد.' });
    for (const file of files.rows) await safeRemove(path.join(UPLOAD_DIR, file.stored_name));
    for (const socket of io.sockets.sockets.values()) socket.leave(groupRoom(id));
    await broadcastGroupsChanged(members.rows.map(r => Number(r.user_id)));
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
  return res.status(500).json({ error: 'خطای داخلی سرور رخ داد. جزئیات برای امنیت نمایش داده نمی‌شود.' });
});

async function main() {
  await initializeDatabase();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Messenger is listening on port ${PORT}`);
    console.log(`Local URL: http://localhost:${PORT}`);
  });
}
main().catch(async (error) => {
  console.error('Startup failed:', error.message);
  await pool.end().catch(() => {});
  process.exit(1);
});

async function shutdown() {
  server.close(() => {});
  await new Promise((resolve) => io.close(resolve));
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
