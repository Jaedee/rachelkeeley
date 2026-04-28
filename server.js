'use strict';

require('dotenv').config();
const express      = require('express');
const session      = require('express-session');
const FileStore    = require('session-file-store')(session);
const multer       = require('multer');
const bcrypt       = require('bcryptjs');
const path         = require('path');
const fs           = require('fs');

const app  = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// ── Directories ──────────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DATA_FILE   = path.join(__dirname, 'tracks.json');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
if (!fs.existsSync(DATA_FILE))   fs.writeFileSync(DATA_FILE, JSON.stringify({}));

// ── Track metadata helpers ────────────────────────────────────────────────────
function readTracks() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return {}; }
}
function writeTracks(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ── Multer (file uploads) ─────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const slot = req.params.slot;
    // Always overwrite the same filename per slot so old files don't accumulate
    cb(null, `track-${slot}.mp3`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'audio/mpeg' || file.originalname.endsWith('.mp3')) {
      cb(null, true);
    } else {
      cb(new Error('Only MP3 files are accepted.'));
    }
  },
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use(session({
  store: new FileStore({ path: path.join(__dirname, 'sessions'), ttl: 28800, retries: 0 }),
  secret: process.env.SESSION_SECRET || 'change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production', // true behind HTTPS
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
  },
}));

// Serve uploaded audio files publicly (front page needs them)
app.use('/audio', express.static(UPLOADS_DIR));

// Serve front-end public files
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

// ── Public API ────────────────────────────────────────────────────────────────

// Front page gets track metadata (titles + audio URLs, no secrets)
app.get('/api/tracks', (req, res) => {
  const tracks = readTracks();
  const out = {};
  [1, 2, 3, 4].forEach(n => {
    const t = tracks[n];
    if (t) {
      out[n] = {
        title: t.title || null,
        genre: t.genre || null,
        // Only expose the URL if the file actually exists
        url: fs.existsSync(path.join(UPLOADS_DIR, `track-${n}.mp3`))
          ? `/audio/track-${n}.mp3`
          : null,
      };
    }
  });
  res.json(out);
});

// ── Auth routes ───────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { password } = req.body;
  const hash = process.env.ADMIN_PASSWORD_HASH;

  if (!hash) {
    return res.status(500).json({ error: 'Server not configured (no password hash).' });
  }

  const ok = await bcrypt.compare(password, hash);
  if (ok) {
    req.session.authenticated = true;
    res.json({ ok: true });
  } else {
    // Small delay to slow brute-force attempts
    await new Promise(r => setTimeout(r, 500));
    res.status(401).json({ error: 'Incorrect password.' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

// ── Admin API (all require auth) ──────────────────────────────────────────────

// Upload an MP3 for a slot
app.post('/api/tracks/:slot', requireAuth, (req, res) => {
  const slot = parseInt(req.params.slot);
  if (![1, 2, 3, 4].includes(slot)) return res.status(400).json({ error: 'Invalid slot.' });

  upload.single('file')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file received.' });

    const tracks = readTracks();
    tracks[slot] = {
      ...( tracks[slot] || {} ),
      filename: req.file.filename,
      originalName: req.file.originalname,
      uploadedAt: new Date().toISOString(),
    };
    writeTracks(tracks);
    res.json({ ok: true, url: `/audio/track-${slot}.mp3` });
  });
});

// Update title/genre metadata for a slot
app.patch('/api/tracks/:slot', requireAuth, (req, res) => {
  const slot = parseInt(req.params.slot);
  if (![1, 2, 3, 4].includes(slot)) return res.status(400).json({ error: 'Invalid slot.' });

  const { title, genre } = req.body;
  const tracks = readTracks();
  tracks[slot] = { ...(tracks[slot] || {}), title, genre };
  writeTracks(tracks);
  res.json({ ok: true });
});

// Clear a slot (delete file + metadata)
app.delete('/api/tracks/:slot', requireAuth, (req, res) => {
  const slot = parseInt(req.params.slot);
  if (![1, 2, 3, 4].includes(slot)) return res.status(400).json({ error: 'Invalid slot.' });

  const filePath = path.join(UPLOADS_DIR, `track-${slot}.mp3`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  const tracks = readTracks();
  delete tracks[slot];
  writeTracks(tracks);
  res.json({ ok: true });
});

// Change password — generates a new bcrypt hash and writes it to .env
app.post('/api/change-password', requireAuth, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const hash = await bcrypt.hash(password, 12);

  // Read .env, replace the hash line
  const envPath = path.join(__dirname, '.env');
  let env = fs.readFileSync(envPath, 'utf8');
  if (env.includes('ADMIN_PASSWORD_HASH=')) {
    env = env.replace(/^ADMIN_PASSWORD_HASH=.*/m, `ADMIN_PASSWORD_HASH=${hash}`);
  } else {
    env += `\nADMIN_PASSWORD_HASH=${hash}`;
  }
  fs.writeFileSync(envPath, env);

  // Update process.env so it takes effect without restart
  process.env.ADMIN_PASSWORD_HASH = hash;

  res.json({ ok: true });
});

// Get full track metadata (admin view, includes upload timestamps)
app.get('/api/admin/tracks', requireAuth, (req, res) => {
  res.json(readTracks());
});

// ── Page routes ───────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Aria Voss server running on http://127.0.0.1:${PORT}`);
});
