const express = require('express');
const { WebSocketServer } = require('ws');
const axios   = require('axios');
const http    = require('http');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });
app.use(express.json());
app.use(express.static('/frontend'));

const REPLICAS = [
  process.env.REPLICA1_URL,
  process.env.REPLICA2_URL,
  process.env.REPLICA3_URL,
].filter(Boolean);

let currentLeader = null;
const clients = new Set();

// ─── LEADER DISCOVERY ──────────────────────────────────────────
async function findLeader() {
  for (const url of REPLICAS) {
    try {
      const r = await axios.get(`${url}/status`, { timeout: 500 });
      if (r.data.state === 'leader') {
        if (currentLeader !== url) {
          console.log(`[Gateway] 👑 Leader is now: ${url}`);
        }
        currentLeader = url;
        return;
      }
    } catch (_) {}
  }
  currentLeader = null;
}

setInterval(findLeader, 300);
findLeader();

// ─── WEBSOCKET ─────────────────────────────────────────────────
wss.on('connection', ws => {
  clients.add(ws);
  console.log(`[Gateway] Client connected. Total: ${clients.size}`);

  ws.on('message', async data => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'stroke') {
        if (!currentLeader) {
          await findLeader();
          if (!currentLeader) return;
        }
        try {
          const r = await axios.post(
            `${currentLeader}/stroke`,
            { stroke: msg.data },
            { timeout: 1000 }
          );
          if (r.data.committed) {
            const out = JSON.stringify({ type: 'stroke', data: r.data.stroke });
            clients.forEach(c => {
              if (c.readyState === 1) c.send(out);
            });
          }
        } catch (err) {
          console.log('[Gateway] Leader unreachable, rediscovering...');
          await findLeader();
        }
      }
    } catch (e) {
      console.error('[Gateway] Message parse error:', e.message);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[Gateway] Client disconnected. Total: ${clients.size}`);
  });

  ws.on('error', () => clients.delete(ws));
});

// ─── DIAGNOSTICS API ───────────────────────────────────────────
app.get('/api/cluster-status', async (req, res) => {
  const statuses = await Promise.all(
    REPLICAS.map(url =>
      axios.get(`${url}/status`, { timeout: 500 })
        .then(r => r.data)
        .catch(() => ({
          id: url,
          state: 'unreachable',
          term: null,
          leaderId: null,
          logLength: 0,
          commitIndex: -1
        }))
    )
  );
  res.json({ leader: currentLeader, replicas: statuses, clients: clients.size });
});

server.listen(3000, () => console.log('[Gateway] 🚀 Running on http://localhost:3000'));