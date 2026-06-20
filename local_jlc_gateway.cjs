const http = require('http');
const { randomUUID } = require('crypto');
const { WebSocketServer } = require('ws');

const HOST = process.env.JLC_GATEWAY_HOST || '127.0.0.1';
const PORT = Number(process.env.JLC_GATEWAY_PORT || 18800);
let bridge = null;
let hello = null;
const pending = new Map();

function rejectPending(error) {
  for (const [, item] of pending) {
    clearTimeout(item.timer);
    item.reject(error);
  }
  pending.clear();
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function command(action, params = {}, timeoutMs = 60000) {
  if (!bridge || bridge.readyState !== bridge.OPEN) {
    return Promise.reject(new Error('jlc bridge is not connected'));
  }

  const id = randomUUID();
  const payload = { type: 'command', id, timestamp: Date.now(), payload: { action, params } };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`command timed out: ${action}`));
    }, timeoutMs);

    pending.set(id, { resolve, reject, timer });
    bridge.send(JSON.stringify(payload));
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      sendJson(res, 200, {
        ok: true,
        service: 'jlc-local-gateway',
        endpoints: {
          state: '/state',
          command: '/command',
          bridgeWebSocket: '/ws/bridge',
        },
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/state') {
      sendJson(res, 200, {
        ok: true,
        bridgeConnected: Boolean(bridge && bridge.readyState === bridge.OPEN),
        hello,
        pending: pending.size,
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/command') {
      const raw = await readBody(req);
      const input = raw ? JSON.parse(raw) : {};
      const result = await command(input.action, input.params || {}, input.timeoutMs || 60000);
      sendJson(res, 200, { ok: true, result });
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

const wss = new WebSocketServer({ server, path: '/ws/bridge' });

wss.on('connection', ws => {
  if (bridge && bridge.readyState === bridge.OPEN) {
    rejectPending(new Error('jlc bridge connection was replaced'));
    bridge.close(1012, 'replaced by a newer bridge connection');
  }
  bridge = ws;
  console.log(`[gateway] bridge connected ${new Date().toISOString()}`);

  ws.on('message', raw => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      console.log('[gateway] non-json message');
      return;
    }

    if (msg.type === 'hello') {
      hello = msg;
      console.log(`[gateway] hello ${JSON.stringify(msg)}`);
      return;
    }

    if (msg.type === 'result' && msg.payload && msg.payload.commandId) {
      const p = pending.get(msg.payload.commandId);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(msg.payload.commandId);
      if (msg.payload.success) p.resolve(msg.payload.data);
      else p.reject(new Error(msg.payload.error || 'bridge command failed'));
      return;
    }

    console.log(`[gateway] ${JSON.stringify(msg)}`);
  });

  ws.on('close', () => {
    if (bridge === ws) {
      bridge = null;
      hello = null;
      rejectPending(new Error('jlc bridge disconnected'));
    }
    console.log(`[gateway] bridge disconnected ${new Date().toISOString()}`);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[gateway] listening on http://${HOST}:${PORT}`);
});
