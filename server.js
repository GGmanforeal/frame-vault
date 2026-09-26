import express from 'express';
import multer from 'multer';
import helmet from 'helmet';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const videoDir = path.join(dataDir, 'videos');
const coverDir = path.join(dataDir, 'covers');
for (const dir of [dataDir, videoDir, coverDir]) fs.mkdirSync(dir, { recursive: true });

const password = process.env.APP_PASSWORD || '';
const secret = process.env.SESSION_SECRET || '';
if (Boolean(password) !== Boolean(secret)) throw new Error('Set APP_PASSWORD and SESSION_SECRET together.');
const protectedMode = Boolean(password);
const db = new Database(path.join(dataDir, 'library.db'));
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  cover TEXT,
  duration REAL,
  favorite INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '50kb' }));

const cookieName = 'framevault_session';
function sessionValue() {
  const payload = 'framevault-v1';
  return `${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;
}
function authenticated(req) {
  if (!protectedMode) return true;
  const raw = (req.headers.cookie || '').split('; ').find(x => x.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  if (!raw) return false;
  const expected = Buffer.from(sessionValue());
  const actual = Buffer.from(raw);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
function requireAuth(req, res, next) {
  if (authenticated(req)) return next();
  res.status(401).json({ error: 'Sign in to access your library.' });
}

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/api/session', (req, res) => res.json({ protected: protectedMode, authenticated: authenticated(req) }));
app.post('/api/login', (req, res) => {
  if (!protectedMode) return res.json({ ok: true });
  const input = Buffer.from(String(req.body.password || ''));
  const expected = Buffer.from(password);
  if (input.length !== expected.length || !crypto.timingSafeEqual(input, expected)) return res.status(401).json({ error: 'Incorrect password.' });
  res.cookie(cookieName, sessionValue(), { httpOnly: true, secure: req.secure || req.headers['x-forwarded-proto'] === 'https', sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000, path: '/' });
  res.json({ ok: true });
});
app.post('/api/logout', (_req, res) => { res.clearCookie(cookieName); res.json({ ok: true }); });

const allowed = new Map([['video/mp4', '.mp4'], ['video/webm', '.webm'], ['video/quicktime', '.mov'], ['video/x-m4v', '.m4v'], ['video/ogg', '.ogv']]);
const upload = multer({
  storage: multer.diskStorage({ destination: videoDir, filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${allowed.get(file.mimetype) || '.bin'}`) }),
  limits: { fileSize: 1024 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, allowed.has(file.mimetype))
});
const coverUpload = multer({ storage: multer.diskStorage({ destination: coverDir, filename: (_req, _file, cb) => cb(null, `${crypto.randomUUID()}.jpg`) }), limits: { fileSize: 3 * 1024 * 1024 }, fileFilter: (_req, file, cb) => cb(null, file.mimetype === 'image/jpeg') });

app.get('/api/videos', requireAuth, (_req, res) => {
  res.json(db.prepare('SELECT id, title, original_name AS originalName, size, duration, favorite, created_at AS createdAt, cover IS NOT NULL AS hasCover FROM videos ORDER BY created_at DESC').all());
});
app.post('/api/videos', requireAuth, upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose an MP4, WebM, MOV, M4V, or OGG video.' });
  const id = crypto.randomUUID();
  const original = path.basename(req.file.originalname).slice(0, 255);
  const title = String(req.body.title || original.replace(/\.[^.]+$/, '')).trim().slice(0, 160) || 'Untitled video';
  const duration = Number(req.body.duration);
  db.prepare('INSERT INTO videos (id, title, filename, original_name, mime, size, duration) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, title, req.file.filename, original, req.file.mimetype, req.file.size, Number.isFinite(duration) && duration >= 0 ? duration : null);
  res.status(201).json({ id });
});
app.patch('/api/videos/:id', requireAuth, (req, res) => {
  const video = db.prepare('SELECT id FROM videos WHERE id = ?').get(req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found.' });
  if (typeof req.body.title === 'string') {
    const title = req.body.title.trim().slice(0, 160);
    if (!title) return res.status(400).json({ error: 'Title cannot be empty.' });
    db.prepare('UPDATE videos SET title = ? WHERE id = ?').run(title, video.id);
  }
  if (typeof req.body.favorite === 'boolean') db.prepare('UPDATE videos SET favorite = ? WHERE id = ?').run(Number(req.body.favorite), video.id);
  res.json({ ok: true });
});
app.post('/api/videos/:id/cover', requireAuth, coverUpload.single('cover'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'JPEG cover required.' });
  const previous = db.prepare('SELECT cover FROM videos WHERE id = ?').get(req.params.id);
  if (!previous) { fs.unlinkSync(req.file.path); return res.status(404).json({ error: 'Video not found.' }); }
  db.prepare('UPDATE videos SET cover = ? WHERE id = ?').run(req.file.filename, req.params.id);
  if (previous.cover) fs.rmSync(path.join(coverDir, previous.cover), { force: true });
  res.json({ ok: true });
});
app.get('/api/videos/:id/cover', requireAuth, (req, res) => {
  const row = db.prepare('SELECT cover FROM videos WHERE id = ?').get(req.params.id);
  if (!row?.cover) return res.sendStatus(404);
  res.set('Cache-Control', 'private, max-age=3600');
  res.sendFile(path.join(coverDir, row.cover));
});
app.get('/api/videos/:id/stream', requireAuth, (req, res) => {
  const row = db.prepare('SELECT filename, mime, size FROM videos WHERE id = ?').get(req.params.id);
  if (!row) return res.sendStatus(404);
  const file = path.join(videoDir, row.filename);
  if (!fs.existsSync(file)) return res.sendStatus(404);
  const range = req.headers.range;
  res.set({ 'Accept-Ranges': 'bytes', 'Content-Type': row.mime, 'Cache-Control': 'private, no-store' });
  if (!range) { res.set('Content-Length', row.size); return fs.createReadStream(file).pipe(res); }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) return res.status(416).set('Content-Range', `bytes */${row.size}`).end();
  const start = match[1] ? Number(match[1]) : Math.max(0, row.size - Number(match[2]));
  const end = match[1] ? Math.min(match[2] ? Number(match[2]) : row.size - 1, row.size - 1) : row.size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= row.size) return res.status(416).set('Content-Range', `bytes */${row.size}`).end();
  res.status(206).set({ 'Content-Range': `bytes ${start}-${end}/${row.size}`, 'Content-Length': end - start + 1 });
  fs.createReadStream(file, { start, end }).pipe(res);
});
app.delete('/api/videos/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT filename, cover FROM videos WHERE id = ?').get(req.params.id);
  if (!row) return res.sendStatus(404);
  db.prepare('DELETE FROM videos WHERE id = ?').run(req.params.id);
  fs.rmSync(path.join(videoDir, row.filename), { force: true });
  if (row.cover) fs.rmSync(path.join(coverDir, row.cover), { force: true });
  res.json({ ok: true });
});

app.use(express.static(path.join(root, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(root, 'public', 'index.html')));
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File is too large. Maximum size is 1 GB.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, '0.0.0.0', () => console.log(`Frame Vault listening on ${port}`));
