import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || 50;
const WORLD = 395;          // half-size of playable area
const TICK_MS = 1000 / 15;  // broadcast rate
const MAX_SPEED = 14;       // units/sec (run = 10, plus margin for lag)

const players = new Map();  // id -> player state

const app = express();
app.use(express.static(PUBLIC_DIR, { maxAge: '1h', index: false }));
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/healthz', (_req, res) => res.status(200).send('ok'));
app.get('/status', (_req, res) => res.json({ players: players.size, max: MAX_PLAYERS }));
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2048 });

// ---------- helpers ----------
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, n);
const validColor = (c) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : '#4fa3ff');
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clampW = (v) => Math.max(-WORLD, Math.min(WORLD, v));
const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
function broadcast(m, exceptId) {
  const s = JSON.stringify(m);
  for (const [id, p] of players) if (id !== exceptId && p.ws.readyState === 1) p.ws.send(s);
}
const pub = (id, p) => ({ id, name: p.name, color: p.color, hat: p.hat, x: p.x, y: p.y, z: p.z, ry: p.ry, anim: p.anim });

// ---------- connections ----------
wss.on('connection', (ws) => {
  let id = null;
  let msgCount = 0, windowStart = Date.now();
  ws.alive = true;
  ws.on('pong', () => (ws.alive = true));

  ws.on('message', (raw) => {
    const now = Date.now();
    if (now - windowStart > 1000) { windowStart = now; msgCount = 0; }
    if (++msgCount > 40) return;                       // flood guard
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'join' && !id) {
      if (players.size >= MAX_PLAYERS) {
        send(ws, { t: 'full', max: MAX_PLAYERS });
        return ws.close(4001, 'full');
      }
      id = randomUUID();
      // Reconnecting clients may resume their position (bounded); new ones spawn in the village.
      const resume = Number.isFinite(m.x) && Number.isFinite(m.z);
      const p = {
        ws, name: clean(m.name, 16) || 'Traveler', color: validColor(m.color), hat: m.hat ? 1 : 0,
        x: resume ? clampW(m.x) : (Math.random() - 0.5) * 16,
        z: resume ? clampW(m.z) : (Math.random() - 0.5) * 16,
        y: 2, ry: 0, anim: 0, last: now, chat: [], dirty: true,
      };
      players.set(id, p);
      send(ws, {
        t: 'welcome', id, spawn: { x: p.x, z: p.z }, max: MAX_PLAYERS,
        players: [...players].filter(([k]) => k !== id).map(([k, v]) => pub(k, v)),
      });
      broadcast({ t: 'join', p: pub(id, p) }, id);
      broadcast({ t: 'sys', text: `${p.name} joined the world` });
      return;
    }

    const p = id && players.get(id);
    if (!p) return;

    if (m.t === 'move') {
      const dt = Math.max((now - p.last) / 1000, 0.05);
      let x = num(m.x, p.x), z = num(m.z, p.z);
      const dx = x - p.x, dz = z - p.z, d = Math.hypot(dx, dz);
      const maxD = MAX_SPEED * dt + 0.5;
      if (d > maxD) {                                   // speed hack / teleport -> clamp & correct
        x = p.x + (dx / d) * maxD; z = p.z + (dz / d) * maxD;
        send(ws, { t: 'correct', x, z });
      }
      p.x = clampW(x); p.z = clampW(z);
      p.y = Math.max(-5, Math.min(140, num(m.y, p.y)));
      p.ry = num(m.ry, 0);
      p.anim = [0, 1, 2, 3].includes(m.anim) ? m.anim : 0;
      p.last = now; p.dirty = true;
    } else if (m.t === 'chat') {
      const text = clean(m.text, 200);
      if (!text) return;
      p.chat = p.chat.filter((t) => now - t < 10000);
      if (p.chat.length >= 5) return send(ws, { t: 'sys', text: 'Slow down: max 5 messages per 10 seconds.' });
      p.chat.push(now);
      broadcast({ t: 'chat', name: p.name, color: p.color, text, ts: now });
    }
  });

  ws.on('close', () => {
    if (id && players.has(id)) {
      const name = players.get(id).name;
      players.delete(id);
      broadcast({ t: 'leave', id });
      broadcast({ t: 'sys', text: `${name} left the world` });
    }
  });
});

// ---------- world tick: broadcast changed players ----------
setInterval(() => {
  const s = [];
  for (const [id, p] of players) {
    if (!p.dirty) continue;
    s.push([id, +p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2), +p.ry.toFixed(2), p.anim]);
    p.dirty = false;
  }
  broadcast({ t: 'state', s, n: players.size });
}, TICK_MS);

// ---------- heartbeat: drop dead connections ----------
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false; ws.ping();
  }
}, 15000);

server.listen(PORT, () => console.log(`INFINITE WORLD server on :${PORT}`));
