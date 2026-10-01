// Колесо АЮ READY КВИЗ — сервер с общей памятью и живой синхронизацией (без зависимостей)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const BOOT_ID = crypto.randomBytes(6).toString('hex');

const EMPTY = () => ({ names: '', prize: '', autoRemove: false, history: [], undo: [], updatedAt: 0 });
let state = { rev: 0, fresh: true, data: EMPTY(), restoredAt: 0 };
try {
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (saved && saved.data) state = { rev: saved.rev || 0, fresh: false, data: clean(saved.data), restoredAt: 0 };
} catch (e) { /* файла нет — начинаем с пустого */ }

function str(v, max) { return typeof v === 'string' ? v.slice(0, max) : ''; }
function clean(d) {
  if (!d || typeof d !== 'object') return null;
  return {
    names: str(d.names, 60000),
    prize: str(d.prize, 300),
    autoRemove: !!d.autoRemove,
    history: (Array.isArray(d.history) ? d.history : []).slice(0, 100).map(h => ({
      name: str(h && h.name, 200), prize: str(h && h.prize, 300), time: Number(h && h.time) || 0,
    })),
    undo: (Array.isArray(d.undo) ? d.undo : []).slice(-30).map(u => str(u, 60000)),
    updatedAt: Number(d.updatedAt) || Date.now(),
  };
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(DATA_FILE, JSON.stringify({ rev: state.rev, data: state.data }), () => {}), 300);
}

const clients = new Set();
function publicState() { return { rev: state.rev, fresh: state.fresh, data: state.data, boot: BOOT_ID }; }
function sendAll(obj) {
  const msg = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of clients) { try { res.write(msg); } catch (e) {} }
}
setInterval(() => { for (const res of clients) { try { res.write(': ping\n\n'); } catch (e) {} } }, 25000);

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req, cb) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 3000000) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(body)); } catch (e) { cb(null); } });
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/logo.png': ['logo.png', 'image/png'],
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (req.method === 'GET' && STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname];
    return fs.readFile(path.join(__dirname, file), (err, buf) => err ? send(res, 404, 'Not found', 'text/plain') : send(res, 200, buf, type));
  }

  if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, publicState());

  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 2000\ndata: ${JSON.stringify({ type: 'state', state: publicState() })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // сохранить общие данные
  if (req.method === 'POST' && url.pathname === '/api/state') {
    return readBody(req, body => {
      const data = body && clean(body.data);
      if (!data) return send(res, 400, { error: 'bad_data' });
      if (body.restore) {
        // копия с устройства после «засыпания» сервера: берём, если на сервере пусто
        // или если эта копия новее той, что уже вернул кто-то другой
        if (!state.fresh && !(state.restoredAt && data.updatedAt > state.restoredAt)) return send(res, 200, { ok: false, skipped: true });
        state = { rev: state.rev + 1, fresh: false, data, restoredAt: data.updatedAt || 1 };
      } else {
        state = { rev: state.rev + 1, fresh: false, data, restoredAt: 0 };
      }
      persist();
      sendAll({ type: 'state', state: publicState(), by: str(body.by, 40) });
      send(res, 200, { ok: true, rev: state.rev });
    });
  }

  // команды в реальном времени: вращение и закрытие карточки победителя
  if (req.method === 'POST' && url.pathname === '/api/cast') {
    return readBody(req, body => {
      if (!body || !['spin', 'close'].includes(body.type)) return send(res, 400, { error: 'bad_cast' });
      const msg = { type: body.type, by: str(body.by, 40) };
      if (body.type === 'spin') {
        const p = body.p || {};
        msg.p = { start: Number(p.start) || 0, delta: Number(p.delta) || 0, win: Math.max(0, parseInt(p.win, 10) || 0), dur: Math.min(30000, Number(p.dur) || 10000) };
        msg.names = str(body.names, 60000);
        msg.prize = str(body.prize, 300);
      }
      sendAll(msg);
      send(res, 200, { ok: true });
    });
  }

  send(res, 404, 'Not found', 'text/plain; charset=utf-8');
});

server.listen(PORT, () => console.log(`Wheel server on :${PORT}`));
