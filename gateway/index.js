const express = require('express');
const { WebSocketServer } = require('ws');
const axios   = require('axios');
const http    = require('http');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });
app.use(express.json());
app.use(express.static('/frontend'));

// ─── REPLICA REGISTRY ──────────────────────────────────────────
// Supports 3 or 4 replicas — REPLICA4_URL is optional
const REPLICAS = [
  process.env.REPLICA1_URL,
  process.env.REPLICA2_URL,
  process.env.REPLICA3_URL,
  process.env.REPLICA4_URL,
].filter(Boolean);

// Map from URL → short name e.g. "http://replica1:4001" → "replica1"
function shortName(url) {
  return (url || '').replace('http://', '').split(':')[0];
}

// ─── PARTITION STATE ───────────────────────────────────────────
// Stores pairs like "replica1:replica2" meaning those two cannot talk
const partitioned = new Set();

function isPartitioned(urlA, urlB) {
  const a = shortName(urlA), b = shortName(urlB);
  return partitioned.has(`${a}:${b}`) || partitioned.has(`${b}:${a}`);
}

// Tell both replicas to block each other
async function applyPartition(a, b) {
  const urlA = REPLICAS.find(u => shortName(u) === a);
  const urlB = REPLICAS.find(u => shortName(u) === b);
  if (!urlA || !urlB) return;

  // Collect ALL peers each replica should currently be blocking
  const blocksForA = [...partitioned]
    .flatMap(pair => {
      const [x, y] = pair.split(':');
      if (x === a) return [REPLICAS.find(u => shortName(u) === y)];
      if (y === a) return [REPLICAS.find(u => shortName(u) === x)];
      return [];
    }).filter(Boolean);

  const blocksForB = [...partitioned]
    .flatMap(pair => {
      const [x, y] = pair.split(':');
      if (x === b) return [REPLICAS.find(u => shortName(u) === y)];
      if (y === b) return [REPLICAS.find(u => shortName(u) === x)];
      return [];
    }).filter(Boolean);

  await Promise.allSettled([
    axios.post(`${urlA}/set-block`, { peers: blocksForA }, { timeout: 500 }),
    axios.post(`${urlB}/set-block`, { peers: blocksForB }, { timeout: 500 }),
  ]);
}

// Clear all blocks on all replicas
async function healAll() {
  await Promise.allSettled(
    REPLICAS.map(url =>
      axios.post(`${url}/set-block`, { peers: [] }, { timeout: 500 })
    )
  );
}

// ─── LEADER STATE ──────────────────────────────────────────────
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

// ─── BROADCAST HELPER ──────────────────────────────────────────
function broadcast(msg) {
  const out = JSON.stringify(msg);
  clients.forEach(c => { if (c.readyState === 1) c.send(out); });
}

// ─── WEBSOCKET ─────────────────────────────────────────────────
wss.on('connection', async ws => {
  clients.add(ws);
  console.log(`[Gateway] Client connected. Total: ${clients.size}`);

  // ── Sync existing canvas state to newly connected client ────
  try {
    if (!currentLeader) await findLeader();
    if (currentLeader) {
      const r = await axios.get(`${currentLeader}/sync-log`, {
        params: { fromIndex: 0 },
        timeout: 1000
      });
      const entries = r.data.entries || [];
      if (entries.length > 0 && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'sync', entries: entries.map(e => e.entry) }));
        console.log(`[Gateway] Sent ${entries.length} entries to new client`);
      }
    }
  } catch (e) {
    console.error('[Gateway] Sync on connect failed:', e.message);
  }

  ws.on('message', async data => {
    try {
      const msg = JSON.parse(data);

      // ── stroke ──────────────────────────────────────────────
      if (msg.type === 'stroke') {
        if (!currentLeader) { await findLeader(); if (!currentLeader) return; }
        try {
          const r = await axios.post(
            `${currentLeader}/stroke`,
            { stroke: msg.data },
            { timeout: 1000 }
          );
          if (r.data.committed) {
            broadcast({ type: 'stroke', data: r.data.stroke });
          }
        } catch (err) {
          console.log('[Gateway] Leader unreachable, rediscovering...');
          await findLeader();
        }
      }

      // ── undo ────────────────────────────────────────────────
      if (msg.type === 'undo') {
        if (!currentLeader) { await findLeader(); if (!currentLeader) return; }
        try {
          const r = await axios.post(`${currentLeader}/undo`, {}, { timeout: 1000 });
          if (r.data.committed) {
            broadcast({ type: 'undo', targetId: r.data.targetId });
          }
        } catch (err) {
          console.log('[Gateway] Undo failed:', err.message);
          await findLeader();
        }
      }

      // ── redo ────────────────────────────────────────────────
      if (msg.type === 'redo') {
        if (!currentLeader) { await findLeader(); if (!currentLeader) return; }
        try {
          const r = await axios.post(`${currentLeader}/redo`, {}, { timeout: 1000 });
          if (r.data.committed) {
            broadcast({ type: 'redo', data: r.data.stroke });
          }
        } catch (err) {
          console.log('[Gateway] Redo failed:', err.message);
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

// ─── PARTITION API ─────────────────────────────────────────────
app.post('/api/partition', async (req, res) => {
  const { a, b } = req.body; // short names e.g. { a: 'replica1', b: 'replica2' }
  if (!a || !b) return res.status(400).json({ error: 'a and b required' });
  partitioned.add(`${a}:${b}`);
  await applyPartition(a, b);
  console.log(`[Gateway] 🚧 Partitioned ${a} ↔ ${b}`);
  res.json({ ok: true, partitioned: [...partitioned] });
});

app.post('/api/heal', async (req, res) => {
  partitioned.clear();
  await healAll();
  console.log('[Gateway] ✅ Network healed');

  // noResync=true means chaos test is mid-sequence and doesn't want log reset
  const noResync = req.body?.noResync === true;

  // Step 1: Wait for single stable leader (up to 4s)
  let stabilized = false;
  let leaderUrl = null;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 200));
    const statuses = await Promise.allSettled(
      REPLICAS.map(url =>
        axios.get(`${url}/status`, { timeout: 300 }).then(r => r.data)
      )
    );
    const live = statuses.filter(s => s.status === 'fulfilled').map(s => s.value);
    const leaders = live.filter(s => s.state === 'leader');
    const allSameTerm = live.length > 0 && live.every(s => s.term === live[0]?.term);
    if (leaders.length === 1 && allSameTerm) {
      stabilized = true;
      leaderUrl = REPLICAS.find(u => u.includes(leaders[0].id));
      break;
    }
  }

  // Step 2: Resync follower logs from leader (only when not in mid-chaos sequence)
  if (stabilized && leaderUrl && !noResync) {
    try {
      const syncRes = await axios.get(`${leaderUrl}/sync-log`,
        { params: { fromIndex: 0 }, timeout: 1000 }
      );
      const canonicalEntries = syncRes.data.entries || [];
      const leaderTerm = (await axios.get(`${leaderUrl}/status`, { timeout: 500 })).data.term;
      await Promise.allSettled(
        REPLICAS
          .filter(url => url !== leaderUrl)
          .map(url =>
            axios.post(`${url}/reset-log`,
              { entries: canonicalEntries, term: leaderTerm },
              { timeout: 1000 }
            )
          )
      );
      console.log(`[Gateway] 🔄 Pushed ${canonicalEntries.length} canonical entries to all followers`);
    } catch (e) {
      console.error('[Gateway] Log resync failed:', e.message);
    }
  }

  console.log(`[Gateway] Cluster stabilized: ${stabilized}`);
  res.json({ ok: true, stabilized });
});

app.get('/api/partitions', (req, res) => {
  res.json({ partitioned: [...partitioned] });
});

// ─── CLUSTER STATUS API (dashboard) ────────────────────────────
app.get('/api/cluster-status', async (req, res) => {
  const statuses = await Promise.all(
    REPLICAS.map(url =>
      axios.get(`${url}/status`, { timeout: 500 })
        .then(r => r.data)
        .catch(() => ({
          id: shortName(url),
          state: 'unreachable',
          term: null,
          leaderId: null,
          logLength: 0,
          commitIndex: -1,
          activeStrokes: 0,
          quorum: null,
          blocked: [],
        }))
    )
  );

  // Derive term from leader or highest known term
  const leaderStatus = statuses.find(s => s.state === 'leader');
  const currentTerm  = leaderStatus?.term
    ?? Math.max(...statuses.map(s => s.term ?? 0));

  res.json({
    leader: currentLeader,
    leaderShort: currentLeader ? shortName(currentLeader) : null,
    term: currentTerm,
    replicas: statuses,
    clients: clients.size,
    partitioned: [...partitioned],
  });
});

// ─── CHAOS STROKE API (used by chaos mode stress test) ────────
app.post('/api/chaos-stroke', async (req, res) => {
  if (!currentLeader) await findLeader();
  if (!currentLeader) return res.json({ committed: false, reason: 'No leader' });
  try {
    const { index = 0 } = req.body;
    const stroke = {
      id: `chaos-${Date.now()}-${index}`,
      path: [
        { x: 50 + index * 10, y: 50 },
        { x: 60 + index * 10, y: 60 },
        { x: 70 + index * 10, y: 50 }
      ],
      color: '#EF4444',
      size: 3
    };
    const r = await axios.post(`${currentLeader}/stroke`, { stroke }, { timeout: 1500 });
    if (r.data.committed) {
      broadcast({ type: 'stroke', data: r.data.stroke });
    }
    res.json(r.data);
  } catch (e) {
    res.json({ committed: false, reason: e.message });
  }
});

// ─── HEALTH CHECK (useful for cloud deployment / load balancer) ─
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    leader: currentLeader ? shortName(currentLeader) : null,
    replicas: REPLICAS.length,
    clients: clients.size,
  });
});

server.listen(3000, () =>
  console.log(`[Gateway] 🚀 Running on http://localhost:3000 | replicas: ${REPLICAS.length}`)
);