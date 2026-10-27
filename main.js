import {
  KINDS, kindName, countsFromTiles, canWinHand, waitingTiles, makeWall, shuffle
} from './mahjong.js';

/* ================= 画布 ================= */

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const DPR = Math.min(window.devicePixelRatio || 1, 2);

let W = 0, H = 0;
let TABLE_X, TABLE_W, TABLE_Y, TABLE_H, HAND_Y, HAND_H, HAND_W, BTN_Y, BTN_H, TILE_W, TILE_H, M;

function layout() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // 以横屏为基准，保证宽高比不低于 1.6
  W = vw; H = vh;
  canvas.width = Math.round(vw * DPR);
  canvas.height = Math.round(vh * DPR);
  canvas.style.width = vw + 'px';
  canvas.style.height = vh + 'px';
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

  M = Math.round(W * 0.009);
  TABLE_X = Math.round(W * 0.155);
  TABLE_W = W - TABLE_X * 2;
  TABLE_Y = Math.round(H * 0.11);
  TABLE_H = Math.round(H * 0.585);
  HAND_Y = Math.round(H * 0.805);
  HAND_H = Math.round(H * 0.145);
  HAND_W = Math.round(W * 0.047);
  BTN_Y = Math.round(H * 0.715);
  BTN_H = Math.round(H * 0.07);
  TILE_W = Math.round(W * 0.021);
  TILE_H = Math.round(H * 0.062);
}

/* ================= 状态 ================= */

const NAMES = ['你', '下家', '对家', '上家'];
const COLORS = ['#f2b179', '#6fb2f2', '#b58cf2', '#5fd0a8'];
const SEAT_TINT = ['#8a5a33', '#2b4f7a', '#4a3a6b', '#2b6b52'];
const NUM_CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];

let seats = [];
let wall = [];
let active = [0, 1, 2, 3];
let turn = 0;
let phase = 'lobby'; // lobby | hostWait | joinWait | playing | over
let lastDiscard = null;
let pendingClaims = [];
let winner = null;
let winInfo = null;
let message = '';
let hits = [];
let lastDiscardT = 0;
let winT = 0;

let me = 0;
let isHost = false;
let isOnline = false;
let peer = null;
let conns = [];       // [{conn, seat}]
let roomCode = '';
let debugLog = [];
let stateVersion = 0;
let lastSentVersion = -1;
let hostReady = false;

/* ================= 音效 ================= */

let actx = null;
let muted = false;

function audio() {
  if (muted) return null;
  if (!actx) {
    try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { actx = null; }
  }
  if (actx && actx.state === 'suspended') actx.resume();
  return actx;
}

function beep(freq, dur, type, vol) {
  const c = audio();
  if (!c) return;
  try {
    const t0 = c.currentTime;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    const v = vol == null ? 0.05 : vol;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(v, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  } catch (e) {}
}

const sfx = {
  tile() { beep(880, 0.035, 'square', 0.035); beep(220, 0.05, 'triangle', 0.04); },
  draw() { beep(520, 0.03, 'triangle', 0.02); },
  peng() { beep(520, 0.08, 'square', 0.045); setTimeout(() => beep(680, 0.09, 'square', 0.04), 70); },
  gang() { beep(420, 0.1, 'sawtooth', 0.04); setTimeout(() => beep(620, 0.12, 'sawtooth', 0.035), 90); },
  win() { [660, 880, 1046, 1320].forEach((f, i) => setTimeout(() => beep(f, 0.22, 'triangle', 0.055), i * 110)); },
  shuffle() { for (let i = 0; i < 8; i++) setTimeout(() => beep(300 + Math.random() * 500, 0.025, 'square', 0.02), i * 45); }
};

/* ================= 游戏逻辑 ================= */

function nextSeat(i) {
  const idx = active.indexOf(i);
  if (idx < 0) return active[0];
  return active[(idx + 1) % active.length];
}

function sortHand(i) {
  seats[i].hand.sort((a, b) => a - b);
}

function newGame() {
  seats = [];
  for (let i = 0; i < 4; i++) {
    seats.push({ hand: [], melds: [], discards: [], score: 0, ai: i !== 0, name: NAMES[i] });
  }
  active = [0, 1, 2, 3];
  wall = shuffle(makeWall());
  turn = 0;
  phase = 'playing';
  winner = null;
  winInfo = null;
  lastDiscard = null;
  pendingClaims = [];
  message = '你的回合';
  me = 0;
  sfx.shuffle();

  for (let round = 0; round < 13; round++) active.forEach(i => seats[i].hand.push(wall.pop()));
  seats[0].hand.push(wall.pop());
  seats.forEach((s, i) => sortHand(i));
  stateVersion++;
}

function drawFor(i) {
  if (!wall.length) {
    phase = 'over';
    winner = -1;
    message = '牌墙摸完，流局';
    return false;
  }
  seats[i].hand.push(wall.pop());
  sortHand(i);
  return true;
}

function canSelfWin(i) {
  return canWinHand(countsFromTiles(seats[i].hand), seats[i].melds.length);
}

function claimOptions(p, tile, canChi) {
  const s = seats[p];
  const counts = countsFromTiles(s.hand);
  const opts = [];
  counts[tile]++;
  if (canWinHand(counts, s.melds.length)) opts.push({ type: 'win' });
  counts[tile]--;
  if (counts[tile] >= 2) opts.push({ type: 'peng' });
  if (counts[tile] >= 3) opts.push({ type: 'gang' });
  if (canChi && tile < 27) {
    const r = tile % 9;
    if (r >= 2 && counts[tile - 2] > 0 && counts[tile - 1] > 0) opts.push({ type: 'chi', seq: [tile - 2, tile - 1, tile] });
    if (r >= 1 && r <= 7 && counts[tile - 1] > 0 && counts[tile + 1] > 0) opts.push({ type: 'chi', seq: [tile - 1, tile, tile + 1] });
    if (r <= 6 && counts[tile + 1] > 0 && counts[tile + 2] > 0) opts.push({ type: 'chi', seq: [tile, tile + 1, tile + 2] });
  }
  return opts;
}

function discardTile(i, idx) {
  const s = seats[i];
  const tile = s.hand.splice(idx, 1)[0];
  s.discards.push(tile);
  lastDiscard = { tile, from: i };
  lastDiscardT = Date.now();
  sfx.tile();

  const claims = [];
  const base = active.indexOf(i);
  for (let k = 1; k < active.length; k++) {
    const p = active[(base + k) % active.length];
    const opts = claimOptions(p, tile, k === 1);
    if (opts.length) claims.push({ seat: p, opts });
  }

  const aiClaims = claims.filter(c => seats[c.seat].ai);
  const humanClaims = claims.filter(c => !seats[c.seat].ai);

  if (aiClaims.length) {
    const order = { win: 0, gang: 1, peng: 2 };
    let best = null;
    aiClaims.forEach(c => c.opts.forEach(o => {
      if (o.type === 'chi') return;
      if (!best || order[o.type] < order[best.opt.type]) best = { seat: c.seat, opt: o };
    }));
    if (best) {
      applyClaim(best.seat, best.opt, tile, i);
      return;
    }
  }

  if (humanClaims.length) {
    pendingClaims = humanClaims;
    phase = 'claim';
    message = '等待玩家操作…';
    stateVersion++;
    return;
  }

  pendingClaims = [];
  nextTurn(i);
}

function applyClaim(seat, opt, tile, from) {
  const s = seats[seat];
  if (opt.type === 'win') { doWin(seat, from, false); return; }

  if (opt.type === 'peng') {
    s.hand.splice(s.hand.indexOf(tile), 1);
    s.hand.splice(s.hand.indexOf(tile), 1);
    s.melds.push({ type: 'peng', tiles: [tile, tile, tile], from });
    seats[from].discards.pop();
    sfx.peng();
    message = (seat === me ? '你' : s.name) + ' 碰 ' + kindName(tile);
  } else if (opt.type === 'gang') {
    for (let k = 0; k < 3; k++) s.hand.splice(s.hand.indexOf(tile), 1);
    s.melds.push({ type: 'gang', tiles: [tile, tile, tile, tile], from });
    seats[from].discards.pop();
    sfx.gang();
    message = (seat === me ? '你' : s.name) + ' 杠 ' + kindName(tile);
    drawFor(seat);
  } else if (opt.type === 'chi') {
    opt.seq.forEach(t => {
      if (t === tile) return;
      const j = s.hand.indexOf(t);
      if (j >= 0) s.hand.splice(j, 1);
    });
    s.melds.push({ type: 'chi', tiles: opt.seq.slice(), from });
    seats[from].discards.pop();
    sfx.peng();
    message = (seat === me ? '你' : s.name) + ' 吃 ' + opt.seq.map(kindName).join('');
  }

  lastDiscard = null;
  sortHand(seat);
  turn = seat;
  phase = 'playing';
  stateVersion++;

  if (s.ai) setTimeout(() => aiDiscard(seat), 450);
}

function doWin(seat, from, selfDraw) {
  phase = 'over';
  winner = seat;
  const s = seats[seat];
  const info = fanOf(seat, selfDraw);
  const deltas = {};
  active.forEach(i => { deltas[i] = 0; });
  active.forEach(i => {
    if (i === seat) return;
    const pay = selfDraw ? info.fan : i === from ? info.fan * 2 : info.fan;
    deltas[i] -= pay;
    deltas[seat] += pay;
    seats[i].score -= pay;
  });
  seats[seat].score += deltas[seat];
  winInfo = { fan: info.fan, name: info.name, selfDraw, deltas };
  message = selfDraw
    ? (seat === me ? '你自摸！' : s.name + ' 自摸')
    : (seat === me ? '你胡了 ' + kindName(lastDiscard.tile) : s.name + ' 胡了 ' + kindName(lastDiscard.tile));
  winT = Date.now();
  sfx.win();
  stateVersion++;
}

function fanOf(seat, selfDraw) {
  const s = seats[seat];
  const tiles = s.hand.slice();
  s.melds.forEach(m => m.tiles.forEach(t => tiles.push(t)));
  const honors = tiles.filter(k => k >= 27).length;
  const suitSet = {};
  tiles.forEach(k => { if (k < 27) suitSet[Math.floor(k / 9)] = 1; });
  const pure = honors === 0 && Object.keys(suitSet).length === 1;

  let sevenPairs = false;
  if (!s.melds.length) {
    const c = countsFromTiles(s.hand);
    let pairs = 0, ok = true;
    for (let i = 0; i < 34; i++) {
      if (c[i] === 0) continue;
      if (c[i] === 2) pairs++;
      else if (c[i] === 4) pairs += 2;
      else { ok = false; break; }
    }
    sevenPairs = ok && pairs === 7;
  }

  const c2 = countsFromTiles(s.hand);
  let tripletOk = true, pairCount = 0;
  for (let i = 0; i < 34; i++) {
    if (c2[i] === 0) continue;
    if (c2[i] === 2) pairCount++;
    else if (c2[i] !== 3) tripletOk = false;
  }
  const allPeng = s.melds.every(m => m.type !== 'chi');
  const pengPeng = tripletOk && pairCount === 1 && allPeng;

  let fan = 1, name = '平胡';
  if (pure) { fan = 3; name = '清一色'; }
  else if (sevenPairs) { fan = 2; name = '七对'; }
  else if (pengPeng) { fan = 2; name = '碰碰胡'; }
  if (!s.melds.length) { fan += 1; name += '·门清'; }
  if (selfDraw) { fan += 1; name += '·自摸'; }
  return { fan, name };
}

function nextTurn(from) {
  turn = nextSeat(from);
  lastDiscard = null;
  phase = 'playing';
  const s = seats[turn];
  if (!drawFor(turn)) return;
  stateVersion++;
  if (s.ai) {
    message = s.name + ' 摸牌…';
    setTimeout(() => aiTurn(turn), 340);
  } else {
    message = turn === me ? '你的回合' : s.name + ' 回合';
  }
}

function aiTurn(i) {
  if (phase === 'over') return;
  if (canSelfWin(i)) { doWin(i, i, true); return; }
  const counts = countsFromTiles(seats[i].hand);
  for (let k = 0; k < 34; k++) {
    if (counts[k] === 4) { concealedGang(i, k); return; }
  }
  aiDiscard(i);
}

function concealedGang(i, k) {
  const s = seats[i];
  for (let n = 0; n < 4; n++) s.hand.splice(s.hand.indexOf(k), 1);
  s.melds.push({ type: 'gang', tiles: [k, k, k, k], from: -1, concealed: true });
  sfx.gang();
  message = (i === me ? '你' : s.name) + ' 暗杠 ' + kindName(k);
  drawFor(i);
  turn = i;
  phase = 'playing';
  stateVersion++;
  if (s.ai) setTimeout(() => aiDiscard(i), 420);
}

function aiDiscard(i) {
  if (phase === 'over') return;
  const s = seats[i];
  if (!s.hand.length) return;
  discardTile(i, pickAiDiscard(s));
}

function pickAiDiscard(s) {
  const counts = countsFromTiles(s.hand);
  let bestIdx = 0, bestScore = Infinity;
  for (let idx = 0; idx < s.hand.length; idx++) {
    const k = s.hand[idx];
    let score = (counts[k] - 1) * 4;
    if (k < 27) {
      const r = k % 9;
      if (r >= 1 && counts[k - 1]) score += 2;
      if (r <= 7 && counts[k + 1]) score += 2;
      if (r >= 2 && counts[k - 2]) score += 1;
      if (r <= 6 && counts[k + 2]) score += 1;
      if (r === 0 || r === 8) score -= 1;
    } else if (counts[k] === 1) score -= 2;
    score += Math.random() * 0.4;
    if (score < bestScore) { bestScore = score; bestIdx = idx; }
  }
  return bestIdx;
}

/* ================= 联机 ================= */

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

function log(msg) {
  const d = new Date();
  const t = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  debugLog.push(t + ' ' + msg);
  if (debugLog.length > 5) debugLog.shift();
}

function startHost() {
  roomCode = makeCode();
  peer = new Peer('mj4-' + roomCode, { debug: 0 });
  peer.on('open', () => {
    isHost = true;
    isOnline = true;
    me = 0;
    conns = [];
    hostReady = true;
    phase = 'hostWait';
    log('房间号 ' + roomCode);
    setTimeout(() => {
      if (conns.length === 0) log('等待玩家加入…');
    }, 8000);
  });
  peer.on('connection', (conn) => {
    conn.on('open', () => {
      if (conns.length >= 3) { conn.send({ t: 'full' }); return; }
      const seat = conns.length + 1;
      conns.push({ conn, seat });
      conn.send({ t: 'welcome', seat });
      log('玩家加入 → ' + NAMES[seat]);
      broadcastLobby();
    });
    conn.on('data', (msg) => onHostData(conn, msg));
    conn.on('close', () => {
      conns = conns.filter(c => c.conn !== conn);
      log('玩家离开');
    });
  });
  peer.on('error', (e) => log('错误: ' + e.type));
}

function broadcastLobby() {
  conns.forEach(c => c.conn.send({ t: 'lobby', n: conns.length + 1 }));
}

function onHostData(conn, msg) {
  const c = conns.find(x => x.conn === conn);
  if (!c) return;
  if (msg.t === 'act') hostApply(c.seat, msg);
}

function hostApply(seat, msg) {
  if (phase === 'over') return;
  if (msg.a === 'discard') {
    if (phase !== 'playing' || turn !== seat) return;
    const idx = seats[seat].hand.indexOf(msg.k);
    if (idx >= 0) discardTile(seat, idx);
  } else if (msg.a === 'pass') {
    if (phase === 'claim') { pendingClaims = []; nextTurn(lastDiscard.from); }
  } else {
    if (phase !== 'claim' || !lastDiscard) return;
    const mine = pendingClaims.find(c => c.seat === seat);
    if (!mine) return;
    const opt = mine.opts.find(o => o.type === msg.a && (o.type !== 'chi' || (msg.seq && o.seq.join() === msg.seq.join())));
    if (!opt) return;
    if (opt.type === 'win') doWin(seat, lastDiscard.from, false);
    else applyClaim(seat, opt, lastDiscard.tile, lastDiscard.from);
  }
}

function startHostGame() {
  newGame();
  conns.forEach(c => {
    if (seats[c.seat]) { seats[c.seat].ai = false; seats[c.seat].name = '玩家' + c.seat; }
  });
  phase = 'playing';
  conns.forEach(c => c.conn.send({ t: 'start', seat: c.seat }));
  stateVersion++;
  log('开局 · 真人 ' + (conns.length + 1) + ' 人');
}

function startJoin(code) {
  roomCode = code.toUpperCase();
  peer = new Peer({ debug: 0 });
  peer.on('open', () => {
    conn = peer.connect('mj4-' + roomCode, { reliable: true });
    conn.on('open', () => {
      isOnline = true;
      isHost = false;
      phase = 'joinWait';
      log('已连接 ' + roomCode);
    });
    conn.on('data', (msg) => onClientData(msg));
    conn.on('close', () => log('与房主断开'));
    window.__conn = conn;
  });
  peer.on('error', (e) => {
    log('错误: ' + (e.type === 'peer-unavailable' ? '房间不存在' : e.type));
    phase = 'lobby';
  });
}

function onClientData(msg) {
  if (msg.t === 'welcome') { me = msg.seat; log('入座 ' + NAMES[me]); return; }
  if (msg.t === 'lobby') { return; }
  if (msg.t === 'start') { if (msg.seat) me = msg.seat; phase = 'playing'; log('开局！'); return; }
  if (msg.t === 'state') { applyView(msg.v); return; }
  if (msg.t === 'full') { log('房间已满'); phase = 'lobby'; return; }
}

function viewFor(seat) {
  return {
    seats: seats.map(s => ({
      name: s.name, score: s.score, melds: s.melds, discards: s.discards,
      handCount: s.hand.length, ai: s.ai
    })),
    hand: seat >= 0 && seats[seat] ? seats[seat].hand : [],
    turn, phase, wallCount: wall.length, lastDiscard, message, winner, winInfo, active
  };
}

function broadcastState() {
  if (!isHost || !isOnline) return;
  conns.forEach(c => c.conn.send({ t: 'state', v: viewFor(c.seat) }));
  lastSentVersion = stateVersion;
}

function applyView(v) {
  seats = v.seats.map(s => ({
    name: s.name, score: s.score, melds: s.melds, discards: s.discards,
    hand: new Array(s.handCount).fill(-1), ai: s.ai
  }));
  if (seats[me]) seats[me].hand = v.hand;
  turn = v.turn;
  phase = v.phase;
  wall = new Array(v.wallCount).fill(-1);
  lastDiscard = v.lastDiscard;
  message = v.message;
  winner = v.winner;
  winInfo = v.winInfo;
  active = v.active;
}

/* ================= 绘制工具 ================= */

function rr(c, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + rad, y);
  c.arcTo(x + w, y, x + w, y + h, rad);
  c.arcTo(x + w, y + h, x, y + h, rad);
  c.arcTo(x, y + h, x, y, rad);
  c.arcTo(x, y, x + w, y, rad);
  c.closePath();
}

function pipLayout(n) {
  switch (n) {
    case 1: return [[0, 0]];
    case 2: return [[0, -1], [0, 1]];
    case 3: return [[-1, -1], [0, 0], [1, 1]];
    case 4: return [[-1, -1], [1, -1], [-1, 1], [1, 1]];
    case 5: return [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]];
    case 6: return [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]];
    case 7: return [[-1, -1.35], [1, -1.35], [0, -0.6], [-1, 0.25], [1, 0.25], [-1, 1.1], [1, 1.1]];
    case 8: return [[-1, -1.4], [1, -1.4], [-1, -0.47], [1, -0.47], [-1, 0.47], [1, 0.47], [-1, 1.4], [1, 1.4]];
    default: return [[-1, -1], [0, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
  }
}

const faceGradCache = {};
function faceGrad(w, h) {
  const key = Math.round(w) + '_' + Math.round(h);
  if (!faceGradCache[key]) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#fffefb');
    g.addColorStop(0.42, '#fdf7e8');
    g.addColorStop(1, '#efe2c6');
    faceGradCache[key] = g;
  }
  return faceGradCache[key];
}

function inkText(txt, x, y, size, color) {
  ctx.font = 'bold ' + Math.round(size) + 'px "Songti SC", "SimSun", "STSong", serif';
  ctx.fillStyle = 'rgba(92,54,32,0.20)';
  ctx.fillText(txt, x + 1, y + 1.6);
  ctx.fillStyle = color;
  ctx.fillText(txt, x, y);
}

function drawDots(cx, cy, w, h, n) {
  const pts = pipLayout(n);
  const base = Math.min(w, h);
  const rad = base * (n === 1 ? 0.27 : n <= 2 ? 0.18 : n <= 6 ? 0.12 : 0.098);
  pts.forEach(p => {
    const x = cx + p[0] * w * 0.22;
    const y = cy + p[1] * h * 0.26;
    ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fillStyle = '#0f4c86'; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, rad * 0.76, 0, Math.PI * 2); ctx.fillStyle = '#f8fbff'; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, rad * 0.48, 0, Math.PI * 2); ctx.fillStyle = n === 1 ? '#b8302a' : '#1b6cb5'; ctx.fill();
  });
}

function drawBamboo(cx, cy, w, h, n) {
  const pts = pipLayout(n);
  const bw = w * 0.155, bh = h * 0.2;
  pts.forEach((p, i) => {
    const x = cx + p[0] * w * 0.22;
    const y = cy + p[1] * h * 0.25;
    const color = n === 1 || i === 0 ? '#b8302a' : '#177a45';
    ctx.fillStyle = color;
    rr(ctx, x - bw / 2, y - bh / 2, bw, bh, bw * 0.5);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.22)';
    ctx.lineWidth = Math.max(1, bw * 0.12);
    ctx.beginPath();
    ctx.moveTo(x - bw / 2 + 1, y);
    ctx.lineTo(x + bw / 2 - 1, y);
    ctx.stroke();
  });
}

function drawTileFace(x, y, w, h, k, opt) {
  opt = opt || {};
  const r = Math.max(2.5, Math.min(w, h) * 0.12);
  const faceH = h - Math.max(2, h * 0.05);

  ctx.fillStyle = '#c2ab82';
  rr(ctx, x, y + 2, w, faceH, r);
  ctx.fill();

  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = faceGrad(w, faceH);
  rr(ctx, 0, 0, w, faceH, r);
  ctx.fill();
  ctx.strokeStyle = 'rgba(198,176,132,0.5)';
  ctx.lineWidth = 1;
  rr(ctx, 2.5, 2.5, w - 5, faceH - 5, r * 0.72);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  rr(ctx, 1.5, 1.5, w - 3, Math.max(2, faceH * 0.1), r * 0.6);
  ctx.fill();
  ctx.restore();

  if (opt.hl) {
    ctx.strokeStyle = '#ffb64d';
    ctx.lineWidth = 2;
    rr(ctx, x + 1, y + 1, w - 2, faceH - 1, r);
    ctx.stroke();
  }

  const cx = x + w / 2;
  const cy = y + faceH / 2;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (k < 0) return;

  if (k >= 27) {
    const names = ['东', '南', '西', '北', '中', '发', '白'];
    const nm = names[k - 27];
    if (nm === '白') {
      const s = Math.min(w, faceH) * 0.52;
      ctx.strokeStyle = '#1b5fa8';
      ctx.lineWidth = Math.max(1.6, w * 0.06);
      ctx.strokeRect(cx - s / 2, cy - s / 2, s, s);
    } else {
      inkText(nm, cx, cy + 1, faceH * 0.58, nm === '中' ? '#b3261e' : nm === '发' ? '#14703f' : '#233449');
    }
    return;
  }

  const suit = Math.floor(k / 9);
  const num = (k % 9) + 1;
  if (suit === 0) {
    inkText(NUM_CN[num - 1], cx, y + faceH * 0.3, faceH * 0.34, '#b3261e');
    inkText('萬', cx, y + faceH * 0.7, faceH * 0.36, '#b3261e');
  } else if (suit === 1) {
    drawDots(cx, cy, w, faceH, num);
  } else {
    drawBamboo(cx, cy, w, faceH, num);
  }
}

function drawTileBack(x, y, w, h) {
  ctx.fillStyle = '#2f6b4f';
  rr(ctx, x, y, w, h, Math.max(2, w * 0.12));
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.3)';
  ctx.lineWidth = 1;
  rr(ctx, x + 0.5, y + 0.5, w - 1, h - 1, Math.max(2, w * 0.12));
  ctx.stroke();
}

/* ================= 绘制：牌桌 ================= */

function getGrad(key, factory) {
  if (!window.__grads) window.__grads = {};
  if (!window.__grads[key]) window.__grads[key] = factory();
  return window.__grads[key];
}

function drawTable() {
  const x = TABLE_X, y = TABLE_Y, w = TABLE_W, h = TABLE_H;

  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  rr(ctx, x + 2, y + 12, w, h, 18);
  ctx.fill();

  const side = getGrad('side', () => {
    const g = ctx.createLinearGradient(0, y + h - 6, 0, y + h + 10);
    g.addColorStop(0, '#4a3018');
    g.addColorStop(1, '#1d1207');
    return g;
  });
  ctx.fillStyle = side;
  rr(ctx, x, y + 8, w, h, 18);
  ctx.fill();

  const wood = getGrad('wood', () => {
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, '#8a6339');
    g.addColorStop(0.12, '#69492a');
    g.addColorStop(0.55, '#432d18');
    g.addColorStop(1, '#2a1a0c');
    return g;
  });
  ctx.fillStyle = wood;
  rr(ctx, x, y, w, h, 18);
  ctx.fill();

  ctx.strokeStyle = 'rgba(255,226,182,0.35)';
  ctx.lineWidth = 2;
  rr(ctx, x + 2, y + 2, w - 4, h - 4, 16);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(212,175,110,0.45)';
  ctx.lineWidth = 1;
  rr(ctx, x + 7, y + 7, w - 14, h - 14, 13);
  ctx.stroke();

  const cx = x + w / 2, cy = y + h / 2;
  const felt = getGrad('felt', () => {
    const g = ctx.createRadialGradient(cx, cy - 14, 24, cx, cy, w * 0.6);
    g.addColorStop(0, '#2f855f');
    g.addColorStop(0.5, '#1d5c43');
    g.addColorStop(1, '#0d3022');
    return g;
  });
  ctx.fillStyle = felt;
  rr(ctx, x + 10, y + 10, w - 20, h - 20, 12);
  ctx.fill();

  ctx.save();
  rr(ctx, x + 10, y + 10, w - 20, h - 20, 12);
  ctx.clip();
  ctx.globalAlpha = 0.055;
  ctx.strokeStyle = '#fff';
  for (let i = 0; i < 24; i++) {
    const a = (Math.PI * 2 * i) / 24;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * W, cy + Math.sin(a) * H);
    ctx.stroke();
  }
  const gloss = getGrad('gloss', () => {
    const g = ctx.createRadialGradient(cx, cy - h * 0.42, 8, cx, cy, w * 0.48);
    g.addColorStop(0, 'rgba(255,255,255,0.13)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    return g;
  });
  ctx.globalAlpha = 1;
  ctx.fillStyle = gloss;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

function seatZone(i) {
  const left = TABLE_X + 10;
  const right = TABLE_X + TABLE_W - 10;
  const top = TABLE_Y + 8;
  const bottom = TABLE_Y + TABLE_H - 8;
  if (i === 2) return { x: W / 2, y: top, anchor: 'top', perRow: 8 };
  if (i === 3) return { x: left, y: (top + bottom) / 2, anchor: 'left', perRow: 4 };
  if (i === 1) return { x: right, y: (top + bottom) / 2, anchor: 'right', perRow: 4 };
  return { x: W / 2, y: bottom, anchor: 'bottom', perRow: 8 };
}

function seatAnchor(i) {
  if (i === 2) return { x: W / 2, y: 6 };
  if (i === 3) return { x: 50, y: TABLE_Y + TABLE_H / 2 };
  if (i === 1) return { x: W - 50, y: TABLE_Y + TABLE_H / 2 };
  return { x: W / 2, y: HAND_Y + 10 };
}

function drawDiscards(now) {
  const tw = TILE_W, th = TILE_H, gap = 2;
  const animT = now - lastDiscardT;

  active.forEach(i => {
    const s = seats[i];
    if (!s || !s.discards.length) return;
    const z = seatZone(i);
    const rows = Math.ceil(s.discards.length / z.perRow);

    s.discards.forEach((k, idx) => {
      const row = Math.floor(idx / z.perRow);
      const col = idx % z.perRow;
      const rowCount = Math.min(z.perRow, s.discards.length - row * z.perRow);
      let x, y;

      if (z.anchor === 'top') {
        const totalW = rowCount * (tw + gap) - gap;
        x = z.x - totalW / 2 + col * (tw + gap);
        y = z.y + row * (th + gap);
      } else if (z.anchor === 'bottom') {
        const totalW = rowCount * (tw + gap) - gap;
        x = z.x - totalW / 2 + col * (tw + gap);
        y = z.y - (rows - row) * (th + gap);
      } else if (z.anchor === 'left') {
        x = z.x + row * (tw + gap);
        y = z.y - (Math.min(z.perRow, s.discards.length) * (th + gap) - gap) / 2 + col * (th + gap);
      } else {
        x = z.x - row * (tw + gap) - tw;
        y = z.y - (Math.min(z.perRow, s.discards.length) * (th + gap) - gap) / 2 + col * (th + gap);
      }

      const isLast = lastDiscard && lastDiscard.from === i && idx === s.discards.length - 1;
      let scale = 1;
      if (isLast && animT < 190) {
        const p = 1 - Math.pow(1 - animT / 190, 3);
        const a = seatAnchor(i);
        const f = (1 - p) * 0.5;
        x += (a.x - x) * f;
        y += (a.y - y) * f;
        scale = 0.82 + 0.18 * p;
      }

      ctx.save();
      ctx.translate(x + tw / 2, y + th / 2);
      ctx.scale(scale, scale);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      rr(ctx, -tw / 2 + 1, -th / 2 + 2, tw, th, 3);
      ctx.fill();
      drawTileFace(-tw / 2, -th / 2, tw, th, k, { hl: isLast });
      ctx.restore();
    });
  });
}

function drawWall() {
  const remain = wall.length;
  const cx = W / 2;
  const cy = TABLE_Y + TABLE_H / 2 + 6;
  const stacks = Math.min(14, Math.ceil(remain / 4));
  const bw = Math.round(W * 0.0105), bh = Math.round(H * 0.036);
  const startX = cx - (stacks * (bw + 1)) / 2;

  for (let i = 0; i < stacks; i++) {
    drawTileBack(startX + i * (bw + 1), cy - bh - 2, bw, bh);
    drawTileBack(startX + i * (bw + 1), cy + 2, bw, bh);
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#e9e3d4';
  ctx.font = 'bold ' + Math.round(H * 0.033) + 'px -apple-system, "PingFang SC", sans-serif';
  ctx.fillText('剩 ' + remain + ' 张', cx, cy + bh + 8);

  if (message) {
    ctx.fillStyle = '#9fd8b8';
    ctx.font = Math.round(H * 0.028) + 'px -apple-system, "PingFang SC", sans-serif';
    ctx.fillText(message, cx, cy + bh + 26);
  }
}

function drawAvatar(x, y, r, seat) {
  const g = ctx.createLinearGradient(x - r, y - r, x + r, y + r);
  g.addColorStop(0, COLORS[seat]);
  g.addColorStop(1, SEAT_TINT[seat]);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.arc(x, y - r * 0.22, r * 0.28, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y + r * 0.55, r * 0.45, Math.PI, 0);
  ctx.fill();

  if (turn === seat && phase === 'playing' && seat !== me) {
    const t = Date.now();
    const pulse = 0.5 + 0.5 * Math.sin(t / 260);
    ctx.beginPath();
    ctx.arc(x, y, r + 3 + pulse * 2.5, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,208,138,' + (0.35 + 0.55 * pulse).toFixed(3) + ')';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function drawSeats() {
  const cards = [
    { i: 2, x: W / 2 - W * 0.12, y: 2, w: W * 0.24, h: H * 0.1, v: false },
    { i: 3, x: W * 0.05, y: TABLE_Y + 34, w: W * 0.098, h: H * 0.26, v: true },
    { i: 1, x: W - W * 0.148, y: TABLE_Y + 34, w: W * 0.098, h: H * 0.26, v: true }
  ];

  cards.forEach(c => {
    if (active.indexOf(c.i) < 0 || !seats[c.i]) return;
    const s = seats[c.i];
    const isTurn = turn === c.i && phase === 'playing';

    ctx.fillStyle = isTurn ? 'rgba(242,177,121,0.22)' : 'rgba(255,255,255,0.06)';
    rr(ctx, c.x, c.y, c.w, c.h, 10);
    ctx.fill();
    ctx.strokeStyle = isTurn ? 'rgba(255,208,138,0.6)' : 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    rr(ctx, c.x + 0.5, c.y + 0.5, c.w - 1, c.h - 1, 10);
    ctx.stroke();

    if (c.v) {
      drawAvatar(c.x + c.w / 2, c.y + 20, 13, c.i);
      ctx.textAlign = 'center';
      ctx.fillStyle = COLORS[c.i];
      ctx.font = 'bold 11px -apple-system, "PingFang SC", sans-serif';
      ctx.fillText(s.name, c.x + c.w / 2, c.y + 40);
      ctx.fillStyle = '#e7e2d6';
      ctx.font = '10px -apple-system, "PingFang SC", sans-serif';
      ctx.fillText(s.hand.length + ' 张', c.x + c.w / 2, c.y + 58);
      ctx.fillText((s.score > 0 ? '+' : '') + s.score + ' 分', c.x + c.w / 2, c.y + 73);
    } else {
      drawAvatar(c.x + 19, c.y + 19, 12, c.i);
      ctx.textAlign = 'left';
      ctx.fillStyle = COLORS[c.i];
      ctx.font = 'bold 11px -apple-system, "PingFang SC", sans-serif';
      ctx.fillText(s.name, c.x + 36, c.y + 8);
      ctx.fillStyle = '#e7e2d6';
      ctx.font = '10px -apple-system, "PingFang SC", sans-serif';
      ctx.fillText(s.hand.length + ' 张 · ' + (s.score > 0 ? '+' : '') + s.score + ' 分', c.x + 36, c.y + 24);
    }
  });
}

function drawHumanArea() {
  const s = seats[me];
  if (!s) return;
  hits = hits.filter(h => h.action !== 'tile');

  let mx = W * 0.01;
  const my = BTN_Y + 2;
  s.melds.forEach(m => {
    m.tiles.forEach((k, i) => {
      if (m.concealed && (i === 0 || i === 3)) drawTileBack(mx, my, TILE_W * 0.85, TILE_H * 0.9);
      else drawTileFace(mx, my, TILE_W * 0.85, TILE_H * 0.9, k, {});
      mx += TILE_W * 0.9;
    });
    mx += 5;
  });

  const n = s.hand.length;
  const totalW = n * (HAND_W + 2);
  const hx0 = (W - totalW) / 2;
  for (let i = 0; i < n; i++) {
    const x = hx0 + i * (HAND_W + 2);
    drawTileFace(x, HAND_Y, HAND_W, HAND_H, s.hand[i], {});
    hits.push({ x, y: HAND_Y, w: HAND_W, h: HAND_H, action: 'tile', idx: i });
  }

  drawAvatar(26, HAND_Y + 26, 15, me);
  ctx.textAlign = 'left';
  ctx.fillStyle = COLORS[me];
  ctx.font = 'bold 12px -apple-system, "PingFang SC", sans-serif';
  ctx.fillText('你', 46, HAND_Y + 10);
  ctx.fillStyle = '#e7e2d6';
  ctx.font = 'bold 12px -apple-system, "PingFang SC", sans-serif';
  ctx.fillText((s.score > 0 ? '+' : '') + s.score + ' 分', 46, HAND_Y + 26);

  if (phase === 'playing' && turn === me && !canSelfWin(me)) {
    const waits = waitingTiles(countsFromTiles(s.hand), s.melds.length);
    if (waits.length) {
      ctx.fillStyle = '#7fd6a0';
      ctx.font = '11px -apple-system, "PingFang SC", sans-serif';
      ctx.fillText('听 ' + waits.map(kindName).join('/'), 46, HAND_Y + 42);
    }
  }
}

function drawButtons() {
  const btns = [];
  const canAct = !isOnline || isHost || !isHost;

  if (phase === 'playing' && turn === me) {
    if (canSelfWin(me)) btns.push({ label: '自摸胡', action: 'win', color: '#d94a34', w: 76 });
    const counts = countsFromTiles(seats[me].hand);
    for (let k = 0; k < 34; k++) {
      if (counts[k] === 4) { btns.push({ label: '暗杠 ' + kindName(k), action: 'angang', color: '#7a4fd0', w: 84, payload: k }); break; }
    }
  }

  if (phase === 'claim' && lastDiscard) {
    const opts = isHost ? (pendingClaims.find(c => c.seat === me) || { opts: [] }).opts
                        : claimOptions(me, lastDiscard.tile, nextSeat(lastDiscard.from) === me);
    opts.forEach(o => {
      if (o.type === 'win') btns.push({ label: '胡', action: 'discardWin', color: '#d94a34', w: 56 });
      if (o.type === 'peng') btns.push({ label: '碰', action: 'peng', color: '#2f7dd0', w: 56 });
      if (o.type === 'gang') btns.push({ label: '杠', action: 'gang', color: '#7a4fd0', w: 56 });
      if (o.type === 'chi') btns.push({ label: '吃', action: 'chi', color: '#2f9d6a', w: 56, payload: o.seq });
    });
    if (btns.length) btns.push({ label: '过', action: 'pass', color: '#4a4a4a', w: 56 });
  }

  const gap = 8;
  let total = btns.reduce((a, b) => a + b.w + gap, 0);
  if (total) total -= gap;
  let x = (W - total) / 2;

  btns.forEach(b => {
    ctx.fillStyle = b.color;
    rr(ctx, x, BTN_Y, b.w, BTN_H, 8);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 13px -apple-system, "PingFang SC", sans-serif';
    ctx.fillText(b.label, x + b.w / 2, BTN_Y + BTN_H / 2);
    ctx.textBaseline = 'top';
    hits.push({ x, y: BTN_Y, w: b.w, h: BTN_H, action: b.action, payload: b.payload });
    x += b.w + gap;
  });
}

function drawOver(now) {
  const t = Math.min(1, (now - winT) / 280);
  const ease = 1 - Math.pow(1 - t, 3);
  ctx.fillStyle = 'rgba(8,10,12,' + (0.82 * ease).toFixed(3) + ')';
  ctx.fillRect(0, 0, W, H);

  const slide = (1 - ease) * 14;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = winner === me ? '#f2b179' : '#f3f1ea';
  ctx.font = 'bold ' + Math.round(H * 0.062) + 'px -apple-system, "PingFang SC", sans-serif';
  ctx.fillText(winner === me ? '你胡了 🎉' : winner > 0 ? NAMES[winner] + ' 胡了' : '流局', W / 2, H * 0.06 + slide);

  if (winInfo) {
    ctx.fillStyle = '#ffd08a';
    ctx.font = 'bold ' + Math.round(H * 0.038) + 'px -apple-system, "PingFang SC", sans-serif';
    ctx.fillText(winInfo.name + ' · ' + winInfo.fan + ' 番', W / 2, H * 0.14 + slide);
  }

  ctx.fillStyle = '#c9c3b7';
  ctx.font = Math.round(H * 0.033) + 'px -apple-system, "PingFang SC", sans-serif';
  ctx.fillText(message, W / 2, H * 0.2 + slide);

  active.forEach((i, idx) => {
    const s = seats[i];
    if (!s) return;
    const d = winInfo && winInfo.deltas ? winInfo.deltas[i] : 0;
    ctx.fillStyle = i === me ? '#f2b179' : '#9b968b';
    ctx.font = (i === me ? 'bold ' : '') + Math.round(H * 0.035) + 'px -apple-system, "PingFang SC", sans-serif';
    ctx.fillText(s.name + '  ' + (d > 0 ? '+' : '') + d + '  （总 ' + s.score + '）', W / 2, H * 0.28 + idx * H * 0.06 + slide);
  });

  const bw = W * 0.155, bh = H * 0.095;
  const bx = (W - bw) / 2;
  const by = H * 0.28 + active.length * H * 0.06 + H * 0.04 + slide;
  ctx.fillStyle = '#f2b179';
  rr(ctx, bx, by, bw, bh, 10);
  ctx.fill();
  ctx.fillStyle = '#241a10';
  ctx.font = 'bold ' + Math.round(H * 0.038) + 'px -apple-system, "PingFang SC", sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText('返回', W / 2, by + bh / 2);
  ctx.textBaseline = 'top';
  hits.push({ x: bx, y: by, w: bw, h: bh, action: 'back' });
}

/* ================= 大厅 ================= */

let inputCode = '';
let showInput = false;

function drawLobby(now) {
  ctx.fillStyle = '#0b1410';
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#f2b179';
  ctx.font = 'bold ' + Math.round(H * 0.11) + 'px -apple-system, "PingFang SC", sans-serif';
  ctx.fillText('四人麻将', W / 2, H * 0.12);

  ctx.fillStyle = '#9b968b';
  ctx.font = Math.round(H * 0.04) + 'px -apple-system, "PingFang SC", sans-serif';
  const sub = phase === 'hostWait'
    ? '房间号 ' + roomCode + ' · 已加入 ' + (conns.length + 1) + '/4'
    : phase === 'joinWait'
      ? '正在连接 ' + roomCode + '…'
      : '联机版 · 同一房间 4 人，空位自动补电脑';
  ctx.fillText(sub, W / 2, H * 0.2);

  if (phase === 'hostWait') {
    ctx.fillStyle = '#ffd08a';
    ctx.font = 'bold ' + Math.round(H * 0.2) + 'px monospace';
    ctx.fillText(roomCode, W / 2, H * 0.3);
  }

  const btns = [];
  if (phase === 'lobby') {
    btns.push({ label: '创建房间', action: 'host', color: '#f2b179', dark: true });
    btns.push({ label: '加入房间', action: 'joinInput', color: '#2f7dd0' });
  } else if (phase === 'hostWait') {
    btns.push({ label: '开始游戏', action: 'startGame', color: '#f2b179', dark: true });
    btns.push({ label: '返回', action: 'back', color: '#3a3a3a' });
  } else if (phase === 'joinWait') {
    btns.push({ label: '取消', action: 'back', color: '#3a3a3a' });
  }

  const bw = W * 0.16, bh = H * 0.11, gap = W * 0.02;
  const total = btns.length * bw + (btns.length - 1) * gap;
  let x = (W - total) / 2;
  const y = H * 0.58;

  btns.forEach(b => {
    ctx.fillStyle = b.color;
    rr(ctx, x, y, bw, bh, 10);
    ctx.fill();
    ctx.fillStyle = b.dark ? '#241a10' : '#fff';
    ctx.font = 'bold ' + Math.round(H * 0.042) + 'px -apple-system, "PingFang SC", sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(b.label, x + bw / 2, y + bh / 2);
    ctx.textBaseline = 'top';
    hits.push({ x, y, w: bw, h: bh, action: b.action });
    x += bw + gap;
  });

  if (showInput) {
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#f3f1ea';
    ctx.font = 'bold ' + Math.round(H * 0.05) + 'px -apple-system, "PingFang SC", sans-serif';
    ctx.fillText('输入房间号', W / 2, H * 0.25);
    ctx.font = 'bold ' + Math.round(H * 0.14) + 'px monospace';
    ctx.fillStyle = '#f2b179';
    ctx.fillText(inputCode || '____', W / 2, H * 0.35);
    ctx.fillStyle = '#9b968b';
    ctx.font = Math.round(H * 0.035) + 'px -apple-system, "PingFang SC", sans-serif';
    ctx.fillText('点击下方按钮用键盘输入', W / 2, H * 0.55);
  }

  // 调试日志
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(160,200,175,0.7)';
  ctx.font = Math.round(H * 0.028) + 'px monospace';
  debugLog.forEach((line, i) => ctx.fillText(line, W * 0.02, H * 0.8 + i * H * 0.035));
}

/* ================= 主绘制 ================= */

function draw(now) {
  hits = [];

  if (phase === 'lobby' || phase === 'hostWait' || phase === 'joinWait') {
    drawLobby(now);
    return;
  }

  const bg = getGrad('bg', () => {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#11201a');
    g.addColorStop(1, '#0a120e');
    return g;
  });
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  if (seats.length) {
    drawTable();
    drawDiscards(now);
    drawWall();
    drawSeats();
    drawHumanArea();
    drawButtons();
    if (phase === 'over') drawOver(now);
  }

  const vig = getGrad('screenVig', () => {
    const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.2, W / 2, H / 2, W * 0.72);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.5)');
    return g;
  });
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, W, H);
}

/* ================= 输入 ================= */

function onTap(x, y) {
  for (const h of hits) {
    if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) {
      handle(h);
      return;
    }
  }
}

function handle(h) {
  if (h.action === 'tile') {
    if (phase !== 'playing' || turn !== me) return;
    const k = seats[me].hand[h.idx];
    if (isHost || !isOnline) discardTile(me, h.idx);
    else sendAct('discard', { k });
    return;
  }
  if (h.action === 'host') { startHost(); return; }
  if (h.action === 'joinInput') {
    const code = prompt('输入 4 位房间号');
    if (code && code.trim().length >= 3) startJoin(code.trim());
    return;
  }
  if (h.action === 'startGame') { startHostGame(); return; }
  if (h.action === 'back') { location.reload(); return; }

  if (!isHost && isOnline) {
    if (h.action === 'win') return;
    if (h.action === 'angang') return;
    sendAct(h.action === 'discardWin' ? 'win' : h.action, h.action === 'chi' ? { seq: h.payload } : null);
    return;
  }

  if (h.action === 'win') doWin(me, me, true);
  else if (h.action === 'discardWin') doWin(me, lastDiscard.from, false);
  else if (h.action === 'peng') applyClaim(me, { type: 'peng' }, lastDiscard.tile, lastDiscard.from);
  else if (h.action === 'gang') applyClaim(me, { type: 'gang' }, lastDiscard.tile, lastDiscard.from);
  else if (h.action === 'chi') applyClaim(me, { type: 'chi', seq: h.payload }, lastDiscard.tile, lastDiscard.from);
  else if (h.action === 'angang') concealedGang(me, h.payload);
  else if (h.action === 'pass') { pendingClaims = pendingClaims.filter(c => c.seat !== me); if (!pendingClaims.length) nextTurn(lastDiscard.from); }
}

function sendAct(a, extra) {
  const c = window.__conn;
  if (!c) return;
  const msg = { t: 'act', a };
  if (extra) Object.assign(msg, extra);
  c.send(msg);
}

canvas.addEventListener('pointerdown', (e) => {
  audio();
  const r = canvas.getBoundingClientRect();
  onTap(e.clientX - r.left, e.clientY - r.top);
});

window.addEventListener('resize', () => {
  layout();
});

/* ================= 启动 ================= */

layout();
phase = 'lobby';

function loop() {
  const now = Date.now();
  if (isHost && isOnline && phase === 'playing' && stateVersion !== lastSentVersion) {
    broadcastState();
  }
  draw(now);
  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
