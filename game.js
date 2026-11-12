import * as THREE from 'three';

const $ = (id) => document.getElementById(id);
// Storage can be unavailable or contain malformed data (for example after an interrupted save).
function loadJSON(key, fallback) {
  try { const value = JSON.parse(localStorage.getItem(key) || 'null'); return value && typeof value === 'object' ? value : fallback; }
  catch { return fallback; }
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, k) => a + (b - a) * k;
const lerpAngle = (a, b, k) => { const d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI; return a + d * k; };
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
if (isTouch) document.body.classList.add('touch');
const WORLD = 395, WALK = 5, RUN = 10, GRAVITY = -25, JUMP_V = 9, SEND_MS = 66, INTERP_DELAY = 110;

/* ================= TERRAIN (procedural) ================= */
function hash(x, z) { const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453; return s - Math.floor(s); }
function vnoise(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = hash(xi, zi), b = hash(xi + 1, zi), c = hash(xi, zi + 1), d = hash(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, z) { let t = 0, a = 1, f = 1; for (let i = 0; i < 5; i++) { t += vnoise(x * f, z * f) * a; a *= 0.5; f *= 2; } return t / 1.94; }
const riverZ = (x) => Math.sin(x * 0.012) * 50 + 110;
const onRoad = (x, z) => (Math.abs(z) < 2.5 && Math.abs(x) < 300 && Math.abs(x) > 8) || (Math.abs(x) < 2.5 && z > 8 && z < 260);
const BRIDGE = { x: 0, z0: riverZ(0) - 22, z1: riverZ(0) + 22, y: 1.6 };

function heightAt(x, z) {
  let h = (fbm(x * 0.006 + 10, z * 0.006 + 10) - 0.42) * 40;
  const r = Math.hypot(x, z);
  const m = Math.max(0, r - 220) / 180; h += m * m * 110 * fbm(x * 0.01, z * 0.01);   // mountains at edges
  if (z > 290) h -= (z - 290) * 0.35;                                                 // southern beach/sea
  const dr = Math.abs(z - riverZ(x)); if (dr < 18) h = lerp(-4, h, dr / 18);         // river carve
  if (onRoad(x, z)) h = Math.max(h, 1.0);
  if (r < 40) h = lerp(2, h, Math.pow(r / 40, 3));                                    // flat village
  return h;
}
function groundAt(x, z) {
  let h = heightAt(x, z);
  if (Math.abs(x - BRIDGE.x) < 3.5 && z > BRIDGE.z0 && z < BRIDGE.z1) h = Math.max(h, BRIDGE.y);
  return Math.max(h, -1.1);                    // deep water: wade/swim at surface
}

/* ================= RENDERER / SCENE ================= */
const renderer = new THREE.WebGLRenderer({ antialias: !isTouch, powerPreference: 'high-performance' });
renderer.domElement.id = 'game';
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xa8d0ff, 60, 300);
const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.3, 900);
const hemi = new THREE.HemisphereLight(0xcfe8ff, 0x4a6b3a, 0.8);
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -50, right: 50, top: 50, bottom: -50, near: 1, far: 400 });
scene.add(hemi, sun, sun.target);

// Terrain mesh
{
  const geo = new THREE.PlaneGeometry(800, 800, 200, 200); geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position, colors = new Float32Array(pos.count * 3), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i), h = heightAt(x, z); pos.setY(i, h);
    if (onRoad(x, z) && h > 0.5) c.setRGB(0.55, 0.45, 0.32);
    else if (h < 1.3) c.setRGB(0.86, 0.8, 0.6);
    else if (h > 60) c.setRGB(0.95, 0.96, 0.98);
    else if (h > 30) c.setRGB(0.45, 0.43, 0.4);
    else { const n = fbm(x * 0.05, z * 0.05); c.setRGB(0.22 + n * 0.12, 0.48 + n * 0.15, 0.18); }
    c.toArray(colors, i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3)); geo.computeVertexNormals();
  const terrain = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  terrain.receiveShadow = true; scene.add(terrain);
  const water = new THREE.Mesh(new THREE.PlaneGeometry(1600, 1600).rotateX(-Math.PI / 2),
    new THREE.MeshPhongMaterial({ color: 0x2f86d0, transparent: true, opacity: 0.8, shininess: 80 }));
  water.position.y = -0.2; scene.add(water);
}

/* ---------- colliders (spatial grid) ---------- */
const CELL = 20, grid = new Map();
const cellKey = (x, z) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
function addCollider(x, z, r) { const k = cellKey(x, z); if (!grid.has(k)) grid.set(k, []); grid.get(k).push({ x, z, r }); }
function resolveCollisions(p) {
  const cx = Math.floor(p.x / CELL), cz = Math.floor(p.z / CELL);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const list = grid.get(`${cx + i},${cz + j}`); if (!list) continue;
    for (const c of list) {
      const dx = p.x - c.x, dz = p.z - c.z, d = Math.hypot(dx, dz), min = c.r + 0.4;
      if (d < min && d > 0.0001) { p.x = c.x + (dx / d) * min; p.z = c.z + (dz / d) * min; }
    }
  }
}

/* ---------- buildings, bridge, landmarks ---------- */
const solids = new THREE.Group(); scene.add(solids);  // used for camera collision
const wallMats = [0xe8d8b8, 0xd9c0a0, 0xf0e6d2].map((c) => new THREE.MeshLambertMaterial({ color: c }));
const roofMat = new THREE.MeshLambertMaterial({ color: 0xa0412d });
const stoneMat = new THREE.MeshLambertMaterial({ color: 0x8a8a8a });
const woodMat = new THREE.MeshLambertMaterial({ color: 0x7a5232 });
function house(x, z, rot = 0) {
  const g = new THREE.Group(), y = heightAt(x, z);
  const walls = new THREE.Mesh(new THREE.BoxGeometry(6, 4, 6), wallMats[Math.floor(hash(x, z) * 3)]); walls.position.y = 2;
  const roof = new THREE.Mesh(new THREE.ConeGeometry(4.8, 3, 4), roofMat); roof.position.y = 5.5; roof.rotation.y = Math.PI / 4;
  const door = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2, 0.1), woodMat); door.position.set(0, 1, 3.01);
  g.add(walls, roof, door); g.position.set(x, y - 0.3, z); g.rotation.y = rot;
  g.traverse((o) => { o.castShadow = o.receiveShadow = true; }); solids.add(g); addCollider(x, z, 4.2);
}
for (let i = 0; i < 8; i++) { const a = (i + 0.5) * Math.PI / 4; house(Math.cos(a) * 22, Math.sin(a) * 22, -a - Math.PI / 2); }
[[-200, -150], [-215, -140], [-190, -165], [-208, -170]].forEach(([x, z]) => house(x, z, hash(x, z) * 6));
{ // well in village center
  const well = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 1, 12), stoneMat); well.position.set(0, 2.3, 0); well.castShadow = true;
  solids.add(well); addCollider(0, 0, 1.4);
}
{ // bridge
  const len = BRIDGE.z1 - BRIDGE.z0;
  const deck = new THREE.Mesh(new THREE.BoxGeometry(6, 0.4, len), woodMat); deck.position.set(0, BRIDGE.y - 0.2, (BRIDGE.z0 + BRIDGE.z1) / 2);
  const railG = new THREE.BoxGeometry(0.2, 1, len);
  const r1 = new THREE.Mesh(railG, woodMat), r2 = r1.clone(); r1.position.set(-3, BRIDGE.y + 0.5, deck.position.z); r2.position.x = 3; r2.position.y = r1.position.y; r2.position.z = deck.position.z;
  [deck, r1, r2].forEach((m) => { m.castShadow = m.receiveShadow = true; scene.add(m); });
}
const landmarks = [
  { name: 'Old Watchtower', x: 250, z: -230 },
  { name: 'Stone Circle', x: -150, z: 170 },
  { name: 'Lighthouse Point', x: 120, z: 285 },
  { name: 'Hermit Hamlet', x: -200, z: -155 },
];
function tower(x, z, h, mat, top) {
  const y = Math.max(heightAt(x, z), 0);
  const t = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 3, h, 10), mat); t.position.set(x, y + h / 2, z);
  const c = new THREE.Mesh(new THREE.ConeGeometry(3.2, 3, 10), top); c.position.set(x, y + h + 1.5, z);
  [t, c].forEach((m) => { m.castShadow = true; solids.add(m); }); addCollider(x, z, 3);
}
tower(250, -230, 14, stoneMat, roofMat);
tower(120, 285, 18, new THREE.MeshLambertMaterial({ color: 0xffffff }), new THREE.MeshLambertMaterial({ color: 0xd03030 }));
for (let i = 0; i < 9; i++) {
  const a = i / 9 * Math.PI * 2, x = -150 + Math.cos(a) * 10, z = 170 + Math.sin(a) * 10;
  const s = new THREE.Mesh(new THREE.BoxGeometry(1.4, 4, 0.8), stoneMat); s.position.set(x, heightAt(x, z) + 1.8, z); s.rotation.y = -a;
  s.castShadow = true; solids.add(s); addCollider(x, z, 1);
}

/* ---------- trees (instanced, chunked for culling/LOD) ---------- */
const treeChunks = [];
{
  const trunkGeo = new THREE.CylinderGeometry(0.25, 0.35, 2, 6).translate(0, 1, 0);
  const crownGeo = new THREE.ConeGeometry(1.6, 4.5, 7).translate(0, 4, 0);
  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6b4a2b });
  const crownMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const CH = 100, buckets = new Map(); let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const target = isTouch ? 1800 : 3200;
  for (let i = 0, placed = 0; i < target * 6 && placed < target; i++) {
    const x = (rnd() - 0.5) * 780, z = (rnd() - 0.5) * 780, h = heightAt(x, z);
    if (h < 1.8 || h > 34 || onRoad(x, z) || Math.hypot(x, z) < 45 || fbm(x * 0.012 + 50, z * 0.012) < 0.42) continue;
    if (Math.abs(x) < 6 && z > BRIDGE.z0 - 5 && z < BRIDGE.z1 + 5) continue;
    const k = `${Math.floor(x / CH)},${Math.floor(z / CH)}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push([x, h, z, 0.7 + rnd() * 0.7, rnd()]); placed++;
    addCollider(x, z, 0.5);
  }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color(), up = new THREE.Vector3(0, 1, 0);
  for (const list of buckets.values()) {
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, list.length);
    const crowns = new THREE.InstancedMesh(crownGeo, crownMat, list.length);
    let cx = 0, cz = 0;
    list.forEach(([x, h, z, sc, r], i) => {
      q.setFromAxisAngle(up, r * 6); s.set(sc, sc, sc); p.set(x, h - 0.2, z); m4.compose(p, q, s);
      trunks.setMatrixAt(i, m4); crowns.setMatrixAt(i, m4);
      crowns.setColorAt(i, col.setHSL(0.27 + r * 0.08, 0.5, 0.25 + r * 0.12)); cx += x; cz += z;
    });
    [trunks, crowns].forEach((m) => { m.castShadow = true; m.computeBoundingSphere(); scene.add(m); });
    treeChunks.push({ meshes: [trunks, crowns], x: cx / list.length, z: cz / list.length });
  }
}

/* ---------- sky: stars + shared day/night cycle ---------- */
const stars = (() => {
  const g = new THREE.BufferGeometry(), a = [];
  for (let i = 0; i < 800; i++) { const v = new THREE.Vector3().randomDirection(); if (v.y < 0.05) v.y = -v.y + 0.05; v.multiplyScalar(600); a.push(v.x, v.y, v.z); }
  g.setAttribute('position', new THREE.Float32BufferAttribute(a, 3));
  const p = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, fog: false }));
  scene.add(p); return p;
})();
const DAY_SECONDS = 600, skyDay = new THREE.Color(0x8ec9ff), skyNight = new THREE.Color(0x0a1028), skyDusk = new THREE.Color(0xf08a4b), sky = new THREE.Color();
function updateSky() {
  const t = (Date.now() / 1000 % DAY_SECONDS) / DAY_SECONDS, ang = t * Math.PI * 2, sy = Math.sin(ang), sx = Math.cos(ang);
  const day = clamp(sy * 2.5 + 0.3, 0, 1);
  sky.copy(skyNight).lerp(skyDay, day);
  if (Math.abs(sy) < 0.3) sky.lerp(skyDusk, (1 - Math.abs(sy) / 0.3) * 0.5);
  scene.background = sky; scene.fog.color.copy(sky);
  sun.position.set(player.x + sx * 150, Math.max(sy, 0.05) * 150, player.z + 40);
  sun.target.position.set(player.x, player.y, player.z);
  sun.intensity = 1.6 * day; hemi.intensity = 0.2 + 0.65 * day;
  stars.material.opacity = 1 - day; stars.position.set(player.x, 0, player.z);
}

/* ================= CHARACTERS ================= */
const skinMat = new THREE.MeshLambertMaterial({ color: 0xf1c27d });
const pantsMat = new THREE.MeshLambertMaterial({ color: 0x2f3447 });
const eyeMat = new THREE.MeshBasicMaterial({ color: 0x111111 });
function makeCharacter(color, hat) {
  const g = new THREE.Group(), mat = new THREE.MeshLambertMaterial({ color });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.33, 0.55, 4, 10), mat); body.position.y = 1.15;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.27, 14, 12), skinMat); head.position.y = 1.83;
  const e1 = new THREE.Mesh(new THREE.SphereGeometry(0.04, 6, 6), eyeMat); e1.position.set(-0.1, 1.87, 0.24);
  const e2 = e1.clone(); e2.position.x = 0.1;
  g.add(body, head, e1, e2);
  const limb = (w, h, m, x, y) => {
    const pivot = new THREE.Group(); pivot.position.set(x, y, 0);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), m); mesh.position.y = -h / 2; mesh.castShadow = true;
    pivot.add(mesh); g.add(pivot); return pivot;
  };
  const c = { group: g, body, phase: 0,
    armL: limb(0.15, 0.6, mat, -0.45, 1.45), armR: limb(0.15, 0.6, mat, 0.45, 1.45),
    legL: limb(0.19, 0.72, pantsMat, -0.16, 0.76), legR: limb(0.19, 0.72, pantsMat, 0.16, 0.76) };
  if (hat) {
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.05, 16), pantsMat); brim.position.y = 2.02;
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.26, 0.32, 16), pantsMat); top.position.y = 2.2;
    g.add(brim, top);
  }
  body.castShadow = head.castShadow = true;
  return c;
}
// anim: 0 idle, 1 walk, 2 run, 3 airborne
function animateCharacter(c, anim, dt) {
  const k = Math.min(1, dt * 12);
  c.phase += dt * (anim === 2 ? 13 : anim === 1 ? 8 : 2);
  let aL, aR, lL, lR;
  if (anim === 3) { aL = aR = -2.4; lL = 0.6; lR = -0.3; }
  else { const amp = anim === 2 ? 1.0 : anim === 1 ? 0.6 : 0.05, s = Math.sin(c.phase) * amp; aL = s; aR = -s; lL = -s; lR = s; }
  c.armL.rotation.x = lerp(c.armL.rotation.x, aL, k); c.armR.rotation.x = lerp(c.armR.rotation.x, aR, k);
  c.legL.rotation.x = lerp(c.legL.rotation.x, lL, k); c.legR.rotation.x = lerp(c.legR.rotation.x, lR, k);
  c.body.position.y = 1.15 + (anim === 0 ? Math.sin(c.phase) * 0.015 : Math.abs(Math.sin(c.phase)) * 0.05);
}
function makeLabel(text) {
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 64;
  const x = cv.getContext('2d'); x.font = 'bold 28px system-ui'; x.textAlign = 'center';
  const w = Math.min(250, x.measureText(text).width + 24);
  x.fillStyle = 'rgba(0,0,0,0.5)'; x.fillRect(128 - w / 2, 10, w, 44);
  x.fillStyle = '#fff'; x.fillText(text, 128, 42);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false, transparent: true }));
  sp.scale.set(2, 0.5, 1); sp.position.y = 2.6; sp.renderOrder = 999; return sp;
}

/* ================= STATE ================= */
const COLORS = ['#4fa3ff', '#ff5c5c', '#3fd18a', '#f5b041', '#b36bff', '#ff7ac8', '#f0f0f0', '#30c5c5'];
const profile = loadJSON('iw_profile', {});
let myName = profile.name || '', myColor = COLORS.includes(profile.color) ? profile.color : COLORS[0], myHat = !!profile.hat;
const rawSettings = loadJSON('iw_settings', {});
const settings = {
  sens: Number.isFinite(+rawSettings.sens) ? clamp(+rawSettings.sens, 0.3, 3) : 1,
  dist: Number.isFinite(+rawSettings.dist) ? clamp(+rawSettings.dist, 3, 14) : 7,
  quality: ['auto', '0', '1', '2'].includes(String(rawSettings.quality ?? 'auto')) ? String(rawSettings.quality ?? 'auto') : 'auto',
};
const player = { x: 0, y: 2, z: 0, vy: 0, yaw: 0, onGround: true, anim: 0 };
let me = null, camYaw = 0, camPitch = 0.35, playing = false, paused = false, chatting = false;
const keys = {}, joy = { x: 0, y: 0 }; let runToggle = false, jumpQueued = false;
const remotes = new Map();
const storedDiscoveries = loadJSON('iw_found', []);
const discovered = new Set(Array.isArray(storedDiscoveries) ? storedDiscoveries.filter((v) => typeof v === 'string') : []);

/* ================= NETWORK ================= */
let ws = null, myId = null, wantConnected = false, retryDelay = 1000, reconnectTimer = null, lastSend = 0, lastSent = '';
function setConn(state) {
  $('connDot').className = 'dot ' + state;
  $('menuDot').className = 'dot ' + state;
}
function connect() {
  if (!wantConnected || (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN))) return;
  setConn('warn');
  try { ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => {
    retryDelay = 1000; setConn('ok');
    const join = { t: 'join', name: myName, color: myColor, hat: myHat };
    if (myId) { join.x = player.x; join.z = player.z; }          // resume position on reconnect
    ws.send(JSON.stringify(join));
  };
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } handle(m); };
  ws.onclose = (e) => {
    clearRemotes();
    if (e.code === 4001) return;
    setConn('bad');
    if (wantConnected) {
      sysMsg(`Connection lost. Reconnecting in ${retryDelay / 1000}s…`);
      if (!reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 10000);
    }
  };
  ws.onerror = () => { setConn('bad'); };
  } catch {
    setConn('bad');
    if (wantConnected && !reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, retryDelay);
  }
}
function handle(m) {
  switch (m.t) {
    case 'welcome':
      if (!myId) { player.x = m.spawn.x; player.z = m.spawn.z; player.y = groundAt(player.x, player.z); }
      myId = m.id; clearRemotes(); m.players.forEach(addRemote);
      $('count').textContent = m.players.length + 1; sysMsg('Connected to the world.'); break;
    case 'join': addRemote(m.p); break;
    case 'leave': removeRemote(m.id); break;
    case 'state': {
      $('count').textContent = m.n; const now = performance.now();
      for (const [id, x, y, z, ry, anim] of m.s) {
        const r = remotes.get(id); if (!r) continue;
        r.buf.push({ t: now, x, y, z, ry, anim }); if (r.buf.length > 30) r.buf.shift();
      }
      break;
    }
    case 'correct': player.x = m.x; player.z = m.z; break;
    case 'chat': chatMsg(m); break;
    case 'sys': sysMsg(m.text); break;
    case 'full':
      wantConnected = false; $('fullMsg').textContent = `The world has reached its ${m.max}-player limit. Please try again shortly.`;
      $('full').classList.remove('hidden'); $('hud').classList.add('hidden'); playing = false; break;
  }
}
function addRemote(p) {
  if (p.id === myId || remotes.has(p.id)) return;
  const c = makeCharacter(p.color, p.hat); c.group.add(makeLabel(p.name));
  c.group.position.set(p.x, p.y, p.z); scene.add(c.group);
  remotes.set(p.id, { char: c, color: p.color, buf: [{ t: performance.now(), x: p.x, y: p.y, z: p.z, ry: p.ry, anim: p.anim }] });
}
function removeRemote(id) {
  const r = remotes.get(id); if (!r) return;
  scene.remove(r.char.group);
  r.char.group.traverse((o) => { o.geometry?.dispose(); if (o.material?.map) o.material.map.dispose(); });
  remotes.delete(id);
}
function clearRemotes() { [...remotes.keys()].forEach(removeRemote); }
function sendState(now) {
  if (!ws || ws.readyState !== 1 || !myId || now - lastSend < SEND_MS) return;
  const msg = { t: 'move', x: +player.x.toFixed(2), y: +player.y.toFixed(2), z: +player.z.toFixed(2), ry: +player.yaw.toFixed(2), anim: player.anim };
  const sig = `${msg.x},${msg.y},${msg.z},${msg.ry},${msg.anim}`;
  if (sig === lastSent && now - lastSend < 1000) return;         // idle: heartbeat once/sec
  ws.send(JSON.stringify(msg)); lastSent = sig; lastSend = now;
}
function updateRemotes(dt) {
  const rt = performance.now() - INTERP_DELAY;
  for (const r of remotes.values()) {
    const b = r.buf; let a = b[0], c = b[b.length - 1];
    for (let i = b.length - 1; i > 0; i--) if (b[i - 1].t <= rt) { a = b[i - 1]; c = b[i]; break; }
    const k = c.t === a.t ? 1 : clamp((rt - a.t) / (c.t - a.t), 0, 1);
    r.char.group.position.set(lerp(a.x, c.x, k), lerp(a.y, c.y, k), lerp(a.z, c.z, k));
    r.char.group.rotation.y = lerpAngle(a.ry, c.ry, k);
    animateCharacter(r.char, c.anim, dt);
  }
}

/* ================= CHAT ================= */
function addLine(build) {
  const log = $('log'), line = document.createElement('div'); build(line);
  log.appendChild(line); while (log.children.length > 60) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
}
function chatMsg(m) {
  addLine((line) => {
    const t = document.createElement('span'); t.className = 'time';
    t.textContent = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const n = document.createElement('b'); n.style.color = /^#[0-9a-f]{6}$/i.test(m.color) ? m.color : '#fff'; n.textContent = m.name + ': ';
    const tx = document.createElement('span'); tx.textContent = m.text;   // textContent = no HTML injection
    line.append(t, n, tx);
  });
}
function sysMsg(text) { addLine((line) => { line.className = 'sys'; line.textContent = text; }); }
function openChat() { chatting = true; document.exitPointerLock?.(); $('chat').classList.remove('hidden'); $('chatInput').focus(); }
$('chatInput').addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') {
    const text = e.target.value.trim();
    if (text && ws?.readyState === 1) ws.send(JSON.stringify({ t: 'chat', text: text.slice(0, 200) }));
    e.target.value = ''; e.target.blur();
  } else if (e.key === 'Escape') e.target.blur();
});
$('chatInput').addEventListener('focus', () => { chatting = true; });
$('chatInput').addEventListener('blur', () => { chatting = false; if (!isTouch && playing && !paused) renderer.domElement.requestPointerLock?.(); });
$('chatToggle').onclick = () => $('chat').classList.toggle('hidden');

/* ================= INPUT ================= */
addEventListener('keydown', (e) => {
  if (!playing || chatting) return;
  keys[e.code] = true;
  if (e.code === 'Space') { jumpQueued = true; e.preventDefault(); }
  if (e.code === 'Enter') openChat();
  if (e.code === 'Escape' && paused) resume();
});
addEventListener('keyup', (e) => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

renderer.domElement.addEventListener('click', () => { if (playing && !paused && !isTouch) renderer.domElement.requestPointerLock?.(); });
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement && playing && !chatting && !isTouch) pause();
});
document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== renderer.domElement) return;
  camYaw -= e.movementX * 0.0025 * settings.sens;
  camPitch = clamp(camPitch + e.movementY * 0.0025 * settings.sens, -0.35, 1.25);
});
addEventListener('wheel', (e) => { if (playing) { settings.dist = clamp(settings.dist + Math.sign(e.deltaY) * 0.7, 3, 14); $('dist').value = settings.dist; } }, { passive: true });

// Touch: joystick
let joyId = null;
const joyEl = $('joy'), knob = $('knob');
joyEl.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); joyId = e.changedTouches[0].identifier; moveJoy(e.changedTouches[0]); }, { passive: false });
joyEl.addEventListener('touchmove', (e) => { e.preventDefault(); e.stopPropagation(); for (const t of e.changedTouches) if (t.identifier === joyId) moveJoy(t); }, { passive: false });
const endJoy = (e) => { for (const t of e.changedTouches) if (t.identifier === joyId) { joyId = null; joy.x = joy.y = 0; knob.style.transform = ''; } };
joyEl.addEventListener('touchend', endJoy); joyEl.addEventListener('touchcancel', endJoy);
function moveJoy(t) {
  const r = joyEl.getBoundingClientRect(), R = r.width / 2;
  let dx = t.clientX - (r.left + R), dy = t.clientY - (r.top + R); const d = Math.hypot(dx, dy);
  if (d > R) { dx = dx / d * R; dy = dy / d * R; }
  joy.x = dx / R; joy.y = dy / R; knob.style.transform = `translate(${dx}px, ${dy}px)`;
}
// Touch: buttons
$('jumpBtn').addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); jumpQueued = true; }, { passive: false });
$('runBtn').addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); runToggle = !runToggle; $('runBtn').classList.toggle('on', runToggle); }, { passive: false });
// Touch: camera drag anywhere on the canvas
let camTouch = null;
renderer.domElement.addEventListener('touchstart', (e) => { if (camTouch === null) { const t = e.changedTouches[0]; camTouch = { id: t.identifier, x: t.clientX, y: t.clientY }; } }, { passive: true });
renderer.domElement.addEventListener('touchmove', (e) => {
  for (const t of e.changedTouches) if (camTouch && t.identifier === camTouch.id) {
    camYaw -= (t.clientX - camTouch.x) * 0.006 * settings.sens;
    camPitch = clamp(camPitch + (t.clientY - camTouch.y) * 0.006 * settings.sens, -0.35, 1.25);
    camTouch.x = t.clientX; camTouch.y = t.clientY;
  }
}, { passive: true });
const endCam = (e) => { for (const t of e.changedTouches) if (camTouch && t.identifier === camTouch.id) camTouch = null; };
renderer.domElement.addEventListener('touchend', endCam); renderer.domElement.addEventListener('touchcancel', endCam);

/* ================= PLAYER UPDATE ================= */
function updatePlayer(dt) {
  let f = 0, s = 0;
  if (!chatting && !paused) {
    f = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0) - joy.y;
    s = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0) + joy.x;
  }
  const mag = Math.min(1, Math.hypot(f, s));
  const running = (keys.ShiftLeft || keys.ShiftRight || runToggle) && mag > 0.1;
  const inWater = heightAt(player.x, player.z) < -0.6 && player.y < 0;
  const speed = (running ? RUN : WALK) * (inWater ? 0.5 : 1);
  if (mag > 0.1) {
    const fx = -Math.sin(camYaw), fz = -Math.cos(camYaw), rx = Math.cos(camYaw), rz = -Math.sin(camYaw);
    let mx = fx * f + rx * s, mz = fz * f + rz * s; const l = Math.hypot(mx, mz); mx /= l; mz /= l;
    player.x += mx * speed * mag * dt; player.z += mz * speed * mag * dt;
    player.yaw = lerpAngle(player.yaw, Math.atan2(mx, mz), Math.min(1, dt * 12));
  }
  player.x = clamp(player.x, -WORLD, WORLD); player.z = clamp(player.z, -WORLD, WORLD);
  resolveCollisions(player);

  const g = groundAt(player.x, player.z);
  if (jumpQueued && player.onGround) { player.vy = JUMP_V; player.onGround = false; }
  jumpQueued = false;
  player.vy += GRAVITY * dt; player.y += player.vy * dt;
  if (player.y <= g) { player.y = g; player.vy = 0; player.onGround = true; }
  else if (player.y - g > 0.3) player.onGround = false;      // walked off a ledge

  player.anim = !player.onGround ? 3 : mag > 0.1 ? (running ? 2 : 1) : 0;
  me.group.position.set(player.x, player.y, player.z); me.group.rotation.y = player.yaw;
}

/* ================= CAMERA ================= */
const camTarget = new THREE.Vector3(), camDesired = new THREE.Vector3(), ray = new THREE.Raycaster(), tmp = new THREE.Vector3();
function updateCamera(dt) {
  camTarget.set(player.x, player.y + 1.6, player.z);
  const cp = Math.cos(camPitch);
  tmp.set(Math.sin(camYaw) * cp, Math.sin(camPitch), Math.cos(camYaw) * cp);   // direction from player to camera
  let dist = settings.dist;
  ray.set(camTarget, tmp); ray.far = dist;                                       // collide with buildings
  const hit = ray.intersectObject(solids, true)[0]; if (hit) dist = Math.max(1.2, hit.distance - 0.3);
  for (let i = 1; i <= 8; i++) {                                                 // collide with terrain
    const d = dist * i / 8, px = camTarget.x + tmp.x * d, py = camTarget.y + tmp.y * d, pz = camTarget.z + tmp.z * d;
    if (py < groundAt(px, pz) + 0.4) { dist = Math.max(1.2, d - dist / 8); break; }
  }
  camDesired.copy(camTarget).addScaledVector(tmp, dist);
  camera.position.lerp(camDesired, Math.min(1, dt * 10));
  camera.lookAt(camTarget);
}

/* ================= MINIMAP ================= */
const mm = $('minimap'), mctx = mm.getContext('2d'), mmBase = document.createElement('canvas');
mmBase.width = mmBase.height = 160;
{
  const c = mmBase.getContext('2d'), img = c.createImageData(160, 160);
  for (let j = 0; j < 160; j++) for (let i = 0; i < 160; i++) {
    const x = i * 5 - 400, z = j * 5 - 400, h = heightAt(x, z), o = (j * 160 + i) * 4;
    const [r, g, b] = h < 0 ? [47, 134, 208] : onRoad(x, z) ? [140, 115, 80] : h < 1.3 ? [220, 205, 155] : h > 60 ? [240, 240, 245] : h > 30 ? [115, 110, 102] : [60, 125 + h * 2, 50];
    img.data.set([r, g, b, 255], o);
  }
  c.putImageData(img, 0, 0);
}
function drawMinimap() {
  mctx.drawImage(mmBase, 0, 0);
  const toMap = (v) => (v + 400) / 5;
  mctx.fillStyle = '#ffd700';
  for (const l of landmarks) if (discovered.has(l.name)) { mctx.fillRect(toMap(l.x) - 2, toMap(l.z) - 2, 5, 5); }
  for (const r of remotes.values()) { const p = r.char.group.position; mctx.fillStyle = r.color; mctx.beginPath(); mctx.arc(toMap(p.x), toMap(p.z), 3, 0, 7); mctx.fill(); }
  mctx.save(); mctx.translate(toMap(player.x), toMap(player.z)); mctx.rotate(-player.yaw + Math.PI);
  mctx.fillStyle = '#fff'; mctx.beginPath(); mctx.moveTo(0, -6); mctx.lineTo(4, 4); mctx.lineTo(-4, 4); mctx.fill(); mctx.restore();
}

/* ================= EXPLORATION ================= */
let toastTimer;
function toast(text) { const t = $('toast'); t.textContent = text; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3500); }
function checkDiscoveries() {
  for (const l of landmarks) if (!discovered.has(l.name) && Math.hypot(player.x - l.x, player.z - l.z) < 18) {
    discovered.add(l.name); localStorage.setItem('iw_found', JSON.stringify([...discovered]));
    toast(`Discovered: ${l.name} (${discovered.size}/${landmarks.length})`);
  }
}

/* ================= QUALITY / PERFORMANCE ================= */
let qLevel = settings.quality === 'auto' ? (isTouch ? 1 : 2) : +settings.quality, viewDist = 300;
function applyQuality(l) {
  qLevel = l;
  renderer.setPixelRatio(Math.min(devicePixelRatio, [0.75, isTouch ? 1.25 : 1.5, 2][l]));
  sun.castShadow = l >= 1; sun.shadow.mapSize.setScalar(l === 2 ? 2048 : 1024);
  if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
  viewDist = [150, 240, 340][l]; scene.fog.far = viewDist; scene.fog.near = viewDist * 0.3; camera.far = viewDist + 50; camera.updateProjectionMatrix();
}
function updateChunks() {
  for (const c of treeChunks) { const v = Math.hypot(c.x - player.x, c.z - player.z) < viewDist + 60; c.meshes.forEach((m) => (m.visible = v)); }
}
let fpsFrames = 0, fpsTime = 0;
function adaptQuality(dt) {
  fpsFrames++; fpsTime += dt;
  if (fpsTime < 3) return;
  const fps = fpsFrames / fpsTime; fpsFrames = 0; fpsTime = 0;
  if (settings.quality === 'auto' && fps < 28 && qLevel > 0) { applyQuality(qLevel - 1); toast('Graphics lowered for smoother play'); }
}

/* ================= MENU / PAUSE / SETTINGS ================= */
const colorsEl = $('colors');
COLORS.forEach((c) => {
  const d = document.createElement('div'); d.style.background = c; if (c === myColor) d.className = 'sel';
  d.onclick = () => { myColor = c; [...colorsEl.children].forEach((x) => x.classList.remove('sel')); d.className = 'sel'; };
  colorsEl.appendChild(d);
});
$('name').value = myName; $('hat').checked = myHat;
$('sens').value = settings.sens; $('dist').value = settings.dist; $('quality').value = settings.quality;
const saveSettings = () => localStorage.setItem('iw_settings', JSON.stringify(settings));
$('sens').oninput = (e) => { settings.sens = +e.target.value; saveSettings(); };
$('dist').oninput = (e) => { settings.dist = +e.target.value; saveSettings(); };
$('quality').onchange = (e) => { settings.quality = e.target.value; saveSettings(); applyQuality(e.target.value === 'auto' ? (isTouch ? 1 : 2) : +e.target.value); };

async function pollStatus() {
  if (playing) return;
  try {
    const s = await (await fetch('/status', { cache: 'no-store' })).json();
    $('menuStatus').textContent = `Server online · ${s.players}/${s.max} players`; setConn('ok');
  } catch { $('menuStatus').textContent = 'Server unreachable'; setConn('bad'); }
  setTimeout(pollStatus, 5000);
}
pollStatus();

$('play').onclick = () => {
  myName = $('name').value.replace(/[<>]/g, '').trim().slice(0, 16) || 'Traveler'; myHat = $('hat').checked;
  localStorage.setItem('iw_profile', JSON.stringify({ name: myName, color: myColor, hat: myHat }));
  me = makeCharacter(myColor, myHat); scene.add(me.group);
  $('hudName').textContent = myName;
  $('menu').classList.add('hidden'); $('hud').classList.remove('hidden');
  if (isTouch) { $('touch').classList.remove('hidden'); try { const fs = document.documentElement.requestFullscreen?.(); fs?.catch?.(() => {}); } catch {} }
  else renderer.domElement.requestPointerLock?.();
  playing = true; wantConnected = true; connect();
  sysMsg(isTouch ? 'Left stick to move, drag to look.' : 'WASD to move, Shift to run, Space to jump, Enter to chat, Esc to pause.');
};
function pause() {
  paused = true;
  $('discoveries').textContent = `Discoveries: ${discovered.size}/${landmarks.length}` + (discovered.size ? ` · ${[...discovered].join(', ')}` : '');
  $('pause').classList.remove('hidden');
}
function resume() { paused = false; $('pause').classList.add('hidden'); if (!isTouch) renderer.domElement.requestPointerLock?.(); }
$('settingsBtn').onclick = pause;
$('resume').onclick = resume;
$('leave').onclick = () => { wantConnected = false; if (reconnectTimer) clearTimeout(reconnectTimer); ws?.close(); location.reload(); };

addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

/* ================= MAIN LOOP ================= */
applyQuality(qLevel);
const clock = new THREE.Clock(); let slowTimer = 0;
camera.position.set(40, 30, 40); camera.lookAt(0, 0, 0);
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1), now = performance.now();
  if (playing && me) {
    updatePlayer(dt); animateCharacter(me, player.anim, dt); updateCamera(dt);
    sendState(now); updateRemotes(dt);
    slowTimer += dt;
    if (slowTimer > 0.25) { slowTimer = 0; updateChunks(); checkDiscoveries(); drawMinimap(); }
    adaptQuality(dt);
  } else {                                                   // menu: slow orbit over the village
    const t = now * 0.00005; camera.position.set(Math.cos(t) * 60, 35, Math.sin(t) * 60); camera.lookAt(0, 2, 0);
  }
  updateSky();
  renderer.render(scene, camera);
});
