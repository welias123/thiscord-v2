'use strict';

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

const JWT_SECRET = process.env.JWT_SECRET || 'thiscord-secret-change-in-prod-2026';
const PORT       = process.env.PORT || 3002;
const DATA_FILE  = path.join(__dirname, 'data.json');

// ── In-memory store ───────────────────────────────────────────────────
let users = [], channels = [], messages = [], friendships = [], dms = [];
let ids   = { users: 1, channels: 1, messages: 1, friendships: 1, dms: 1 };

function nextId(table) { return ids[table]++; }

function loadData() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    users       = d.users       || [];
    channels    = d.channels    || [];
    messages    = d.messages    || [];
    friendships = d.friendships || [];
    dms         = d.dms         || [];
    ids.users       = (users.at(-1)?.id       || 0) + 1;
    ids.channels    = (channels.at(-1)?.id    || 0) + 1;
    ids.messages    = (messages.at(-1)?.id    || 0) + 1;
    ids.friendships = (friendships.at(-1)?.id || 0) + 1;
    ids.dms         = (dms.at(-1)?.id         || 0) + 1;
    console.log(`Loaded: ${users.length} users, ${messages.length} messages`);
  } catch { /* first run */ }
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ users, channels, messages, friendships, dms }));
}

loadData();

// Default channels
['general','announcements','off-topic','gaming','music'].forEach(name => {
  if (!channels.find(c => c.name === name)) {
    channels.push({ id: nextId('channels'), name, description: '' });
  }
});

// Save every 15s + on shutdown
setInterval(saveData, 15000);
process.on('SIGTERM', () => { saveData(); process.exit(0); });
process.on('SIGINT',  () => { saveData(); process.exit(0); });

// ── Middleware ────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ── Auth ──────────────────────────────────────────────────────────────
const AVATAR_COLORS = ['#7c3aed','#a855f7','#ec4899','#06b6d4','#10b981','#f59e0b','#ef4444','#3b82f6'];

app.post('/api/auth/register', (req, res) => {
  const { username, email, password } = req.body || {};
  if (!username?.trim() || !email?.trim() || !password) return res.status(400).json({ error: 'Alle Felder ausfüllen' });
  if (username.length < 2 || username.length > 32) return res.status(400).json({ error: 'Benutzername: 2–32 Zeichen' });
  if (password.length < 6) return res.status(400).json({ error: 'Passwort: mindestens 6 Zeichen' });
  if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) return res.status(400).json({ error: 'Ungültige E-Mail' });
  const uname = username.trim();
  const uemail = email.trim().toLowerCase();
  if (users.find(u => u.username.toLowerCase() === uname.toLowerCase())) return res.status(400).json({ error: 'Benutzername vergeben' });
  if (users.find(u => u.email === uemail)) return res.status(400).json({ error: 'E-Mail bereits registriert' });
  const hash  = bcrypt.hashSync(password, 10);
  const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
  const user  = { id: nextId('users'), username: uname, email: uemail, password_hash: hash, avatar_color: color, bio: '', created_at: Math.floor(Date.now()/1000) };
  users.push(user);
  saveData();
  const token = jwt.sign({ id: user.id, username: uname }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: safeUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const { login, password } = req.body || {};
  if (!login || !password) return res.status(400).json({ error: 'Felder ausfüllen' });
  const user = users.find(u => u.email === login.trim().toLowerCase() || u.username.toLowerCase() === login.trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Falsches Passwort oder Benutzername' });
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: safeUser(user) });
});

function safeUser(u) {
  return { id: u.id, username: u.username, email: u.email, avatar_color: u.avatar_color, bio: u.bio, created_at: u.created_at };
}

// ── User ──────────────────────────────────────────────────────────────
app.get('/api/me', auth, (req, res) => {
  const u = users.find(u => u.id === req.user.id);
  if (!u) return res.status(404).json({ error: 'Nicht gefunden' });
  res.json(safeUser(u));
});

app.put('/api/me', auth, (req, res) => {
  const { username, bio, avatar_color } = req.body || {};
  const u = users.find(u => u.id === req.user.id);
  if (!u) return res.status(404).json({ error: 'Nicht gefunden' });
  const newName = (username || u.username).trim().slice(0,32);
  if (newName !== u.username && users.find(x => x.id !== u.id && x.username.toLowerCase() === newName.toLowerCase())) {
    return res.status(400).json({ error: 'Benutzername vergeben' });
  }
  u.username     = newName;
  u.bio          = (bio || '').slice(0,200);
  u.avatar_color = avatar_color || u.avatar_color;
  saveData();
  res.json({ success: true, username: newName });
});

app.put('/api/me/password', auth, (req, res) => {
  const { current, newPassword } = req.body || {};
  const u = users.find(u => u.id === req.user.id);
  if (!u || !bcrypt.compareSync(current, u.password_hash)) return res.status(401).json({ error: 'Falsches aktuelles Passwort' });
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Mindestens 6 Zeichen' });
  u.password_hash = bcrypt.hashSync(newPassword, 10);
  saveData();
  res.json({ success: true });
});

// ── Channels & Messages ───────────────────────────────────────────────
app.get('/api/channels', auth, (req, res) => res.json(channels));

app.get('/api/messages/:channelId', auth, (req, res) => {
  const chId = Number(req.params.channelId);
  const msgs = messages.filter(m => m.channel_id === chId).slice(-60);
  const enriched = msgs.map(m => {
    const u = users.find(u => u.id === m.user_id) || {};
    return { ...m, username: u.username || 'Unknown', avatar_color: u.avatar_color || '#7c3aed' };
  });
  res.json(enriched);
});

// ── Friends ───────────────────────────────────────────────────────────
app.get('/api/friends', auth, (req, res) => {
  const myId = req.user.id;
  const rows = friendships
    .filter(f => (f.sender_id === myId || f.receiver_id === myId) && f.status !== 'rejected')
    .map(f => {
      const otherId = f.sender_id === myId ? f.receiver_id : f.sender_id;
      const u = users.find(u => u.id === otherId) || {};
      return { id: f.id, status: f.status, sender_id: f.sender_id, receiver_id: f.receiver_id, uid: otherId, username: u.username, avatar_color: u.avatar_color };
    });
  res.json(rows);
});

app.post('/api/friends/add', auth, (req, res) => {
  const { username } = req.body || {};
  const target = users.find(u => u.username.toLowerCase() === (username||'').trim().toLowerCase());
  if (!target) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'Kannst dich nicht selbst hinzufügen' });
  const exists = friendships.find(f =>
    (f.sender_id===req.user.id && f.receiver_id===target.id) ||
    (f.sender_id===target.id   && f.receiver_id===req.user.id)
  );
  if (exists) return res.status(400).json({ error: 'Bereits befreundet oder Anfrage ausstehend' });
  const f = { id: nextId('friendships'), sender_id: req.user.id, receiver_id: target.id, status: 'pending', created_at: Math.floor(Date.now()/1000) };
  friendships.push(f);
  saveData();
  const me = users.find(u => u.id === req.user.id);
  io.to(`user:${target.id}`).emit('friend-request', { from: { id: req.user.id, username: me.username, avatar_color: me.avatar_color } });
  res.json({ success: true });
});

app.post('/api/friends/accept', auth, (req, res) => {
  const f = friendships.find(x => x.id === req.body.id && x.receiver_id === req.user.id && x.status === 'pending');
  if (!f) return res.status(404).json({ error: 'Anfrage nicht gefunden' });
  f.status = 'accepted';
  saveData();
  const me = users.find(u => u.id === req.user.id);
  io.to(`user:${f.sender_id}`).emit('friend-accepted', { by: { id: req.user.id, username: me.username } });
  res.json({ success: true });
});

app.post('/api/friends/reject', auth, (req, res) => {
  const i = friendships.findIndex(x => x.id === req.body.id && x.receiver_id === req.user.id);
  if (i !== -1) { friendships.splice(i,1); saveData(); }
  res.json({ success: true });
});

app.delete('/api/friends/:id', auth, (req, res) => {
  const i = friendships.findIndex(x => x.id === Number(req.params.id) && (x.sender_id===req.user.id || x.receiver_id===req.user.id));
  if (i !== -1) { friendships.splice(i,1); saveData(); }
  res.json({ success: true });
});

// ── DMs ───────────────────────────────────────────────────────────────
app.get('/api/dm/:userId', auth, (req, res) => {
  const myId = req.user.id, otherId = Number(req.params.userId);
  const msgs = dms.filter(m =>
    (m.sender_id===myId && m.receiver_id===otherId) ||
    (m.sender_id===otherId && m.receiver_id===myId)
  ).slice(-60).map(m => {
    const u = users.find(u => u.id === m.sender_id) || {};
    return { ...m, username: u.username, avatar_color: u.avatar_color };
  });
  res.json(msgs);
});

// ── Socket.io ─────────────────────────────────────────────────────────
const onlineUsers = new Map();

io.use((socket, next) => {
  try { socket.user = jwt.verify(socket.handshake.auth.token, JWT_SECRET); next(); }
  catch { next(new Error('Unauthorized')); }
});

io.on('connection', (socket) => {
  const uid = socket.user.id;
  onlineUsers.set(uid, socket.id);
  socket.join(`user:${uid}`);
  io.emit('user-status', { userId: uid, online: true });

  socket.on('join-channel',  (chId) => socket.join(`ch:${chId}`));
  socket.on('leave-channel', (chId) => socket.leave(`ch:${chId}`));

  socket.on('message', ({ channelId, content }) => {
    if (!content?.trim() || content.length > 2000) return;
    const u = users.find(u => u.id === uid);
    if (!u) return;
    const msg = { id: nextId('messages'), channel_id: Number(channelId), user_id: uid, content: content.trim(), created_at: Math.floor(Date.now()/1000) };
    messages.push(msg);
    if (messages.length % 20 === 0) saveData();
    io.to(`ch:${channelId}`).emit('message', { ...msg, username: u.username, avatar_color: u.avatar_color });
  });

  socket.on('dm', ({ toUserId, content }) => {
    if (!content?.trim() || content.length > 2000) return;
    const u = users.find(u => u.id === uid);
    if (!u) return;
    const msg = { id: nextId('dms'), sender_id: uid, receiver_id: Number(toUserId), content: content.trim(), created_at: Math.floor(Date.now()/1000) };
    dms.push(msg);
    if (dms.length % 20 === 0) saveData();
    const out = { ...msg, username: u.username, avatar_color: u.avatar_color };
    socket.emit('dm', out);
    io.to(`user:${toUserId}`).emit('dm', out);
  });

  socket.on('typing',    ({ channelId }) => socket.to(`ch:${channelId}`).emit('typing', { username: socket.user.username, channelId }));
  socket.on('dm-typing', ({ toUserId })  => io.to(`user:${toUserId}`).emit('dm-typing', { from: socket.user.username }));

  socket.on('disconnect', () => {
    onlineUsers.delete(uid);
    io.emit('user-status', { userId: uid, online: false });
  });
});

server.listen(PORT, () => console.log(`ThisCord running → http://localhost:${PORT}`));
