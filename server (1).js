// Servidor para Dibuja y Adivina. Requiere Node.js 18 o superior.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROUND_MS = 90000;
const WORDS = ["gato","casa","árbol","pizza","bicicleta","sol","luna","pelota","avión","guitarra","helado","reloj","paraguas","tortuga","cohete","montaña","playa","robot","corazón","mariposa","castillo","dinosaurio","tijeras","plátano","volcán","fantasma","jirafa","teléfono","cámara","zapato","pingüino","arcoíris","escalera","tren","ballena","dragón","hamburguesa","lentes","payaso","sombrero"];
const rooms = new Map();
const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
const getRoom = code => {
  if (!rooms.has(code)) rooms.set(code, { players: new Map(), drawer: null, word: '', phase: 'idle', endsAt: 0, strokes: [], timer: null });
  return rooms.get(code);
};
const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const all = (room, event, data, except) => room.players.forEach(p => { if (p.id !== except) sse(p.res, event, data); });
const pub = room => ({
  players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, score: p.score })),
  drawer: room.drawer, phase: room.phase, left: Math.max(0, room.endsAt - Date.now()),
  hint: room.phase === 'draw' ? room.word.replace(/[^ ]/g, '_').split('').join(' ') : ''
});
function endRound(room, winner) {
  clearTimeout(room.timer);
  room.phase = 'end';
  all(room, 'end', { word: room.word, winner: winner ? winner.name : null });
  all(room, 'state', pub(room));
}
function startRound(room, id) {
  if (room.phase === 'draw' || !room.players.has(id)) return;
  room.word = WORDS[Math.floor(Math.random() * WORDS.length)];
  room.drawer = id; room.phase = 'draw'; room.endsAt = Date.now() + ROUND_MS; room.strokes = [];
  room.timer = setTimeout(() => endRound(room, null), ROUND_MS);
  all(room, 'clear', {});
  all(room, 'state', pub(room));
  const drawer = room.players.get(id);
  if (drawer) sse(drawer.res, 'word', { w: room.word });
}
function handle(room, player, body) {
  const drawing = room.phase === 'draw';
  if (body.type === 'start') startRound(room, player.id);
  else if (body.type === 'clear' && drawing && player.id === room.drawer) {
    room.strokes = []; all(room, 'clear', {}, player.id);
  } else if (body.type === 'stroke' && drawing && player.id === room.drawer && Array.isArray(body.p) && body.p.length <= 600) {
    const points = body.p.map(Number);
    if (points.some(n => !Number.isFinite(n))) return;
    const stroke = { c: String(body.c || '#222222').slice(0, 9), w: Math.max(1, Math.min(30, Number(body.w) || 6)), p: points };
    if (room.strokes.length < 3000) {
      room.strokes.push(stroke);
      all(room, 'stroke', stroke, player.id);
    }
  } else if (body.type === 'guess') {
    const guess = String(body.text || '').slice(0, 40).trim();
    if (!guess) return;
    if (drawing && player.id !== room.drawer && norm(guess) === norm(room.word)) {
      player.score += 10 + Math.floor(Math.max(0, room.endsAt - Date.now()) / 9000);
      const drawer = room.players.get(room.drawer);
      if (drawer) drawer.score += 5;
      endRound(room, player);
    } else if (!(drawing && player.id === room.drawer && norm(guess).includes(norm(room.word)))) {
      all(room, 'chat', { n: player.name, t: guess });
    }
  }
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('ok');
  }
  if (req.method === 'GET' && url.pathname === '/events') {
    const code = (url.searchParams.get('room') || 'sala').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'sala';
    const id = String(url.searchParams.get('id') || '').slice(0, 16);
    const name = String(url.searchParams.get('name') || 'Jugador').trim().slice(0, 16) || 'Jugador';
    const room = getRoom(code);
    if (!id || (room.players.size >= 12 && !room.players.has(id))) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('La sala está llena o falta el identificador.');
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no'
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    const player = { id, name, score: 0, res };
    room.players.set(id, player);
    sse(res, 'init', { ...pub(room), strokes: room.strokes });
    all(room, 'state', pub(room), id);
    const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': heartbeat\n\n'); }, 20000);
    req.on('close', () => {
      clearInterval(heartbeat);
      room.players.delete(id);
      if (!room.players.size) {
        clearTimeout(room.timer);
        rooms.delete(code);
        return;
      }
      if (room.phase === 'draw' && room.drawer === id) endRound(room, null);
      else all(room, 'state', pub(room));
    });
  } else if (req.method === 'POST' && url.pathname === '/api') {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 16000) req.destroy();
    });
    req.on('end', () => {
      try {
        const body = JSON.parse(raw);
        const room = rooms.get(String(body.room || ''));
        const player = room && room.players.get(String(body.id || ''));
        if (player) handle(room, player, body);
      } catch (_) {}
      res.writeHead(204); res.end();
    });
  } else if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const file = path.join(__dirname, 'public', 'index.html');
    fs.readFile(file, (error, html) => {
      if (error) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Falta public/index.html. Sube la carpeta public al repositorio.'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html);
    });
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('No encontrado');
  }
});
server.listen(PORT, '0.0.0.0', () => console.log(`Dibuja y Adivina activo en el puerto ${PORT}`));
