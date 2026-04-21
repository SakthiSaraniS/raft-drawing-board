const express = require('express');
const { WebSocketServer } = require('ws');
const axios   = require('axios');
const http    = require('http');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

wss.setMaxListeners(50);
server.setMaxListeners(50);

app.use(express.json());
app.use(express.static('/frontend'));

// ─── REPLICA REGISTRY ──────────────────────────────────────────
const REPLICAS = [
  process.env.REPLICA1_URL,
  process.env.REPLICA2_URL,
  process.env.REPLICA3_URL,
  process.env.REPLICA4_URL,
].filter(Boolean);

function shortName(url) {
  return (url || '').replace('http://', '').split(':')[0];
}

// ─── ROOM REGISTRY ─────────────────────────────────────────────
// Each room is a logical namespace with its own log on every replica.
// Rooms are created on first use — no pre-registration needed.
// DEFAULT_ROOM is always available so existing behaviour is unchanged.
const DEFAULT_ROOM = 'default';
const roomRegistry = new Set([DEFAULT_ROOM]);
const MAX_ROOMS = 20;  // safety limit

function normalizeRoom(roomId) {
  if (!roomId || typeof roomId !== 'string') return DEFAULT_ROOM;
  // Sanitize: lowercase, alphanumeric + hyphens only, max 32 chars
  const clean = roomId.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 32);
  return clean || DEFAULT_ROOM;
}

function ensureRoom(roomId) {
  if (roomRegistry.has(roomId)) return;
  if (roomRegistry.size >= MAX_ROOMS) {
    throw new Error(`Room limit (${MAX_ROOMS}) reached`);
  }
  roomRegistry.add(roomId);
  console.log(`[Gateway] 🏠 New room created: "${roomId}" (total: ${roomRegistry.size})`);
}

// ─── PARTITION STATE ───────────────────────────────────────────
const partitioned = new Set();

async function applyPartition(a, b) {
  const urlA = REPLICAS.find(u => shortName(u) === a);
  const urlB = REPLICAS.find(u => shortName(u) === b);
  if (!urlA || !urlB) return;

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

async function healAll() {
  await Promise.allSettled(
    REPLICAS.map(url =>
      axios.post(`${url}/set-block`, { peers: [] }, { timeout: 500 })
    )
  );
}

// ─── LEADER STATE ──────────────────────────────────────────────
let currentLeader = null;
// Map: clientWs → roomId (so we know which room each client is in)
const clientRooms = new Map();

// ─── PRESENCE STATE (ephemeral — never touches Raft) ───────────
// clientId is assigned on connection; cursors are keyed by clientId.
// This lives ONLY in the gateway process and is lost on restart — by design.
// Map: clientWs → { clientId, name, color, room }
const clientPresence = new Map();

// Stable palette: each new client gets the next color, cycling.
const CURSOR_COLORS = [
  '#f87171', // red-400
  '#fb923c', // orange-400
  '#facc15', // yellow-400
  '#4ade80', // green-400
  '#34d399', // emerald-400
  '#22d3ee', // cyan-400
  '#818cf8', // indigo-400
  '#e879f9', // fuchsia-400
  '#f472b6', // pink-400
  '#a78bfa', // violet-400
];
let colorCursor = 0;
let clientSeq   = 0;

function assignPresence(ws) {
  const clientId = `c${++clientSeq}`;
  const color    = CURSOR_COLORS[colorCursor++ % CURSOR_COLORS.length];
  const name     = `User ${clientSeq}`;
  clientPresence.set(ws, { clientId, name, color });
  return { clientId, name, color };
}

// Broadcast presence msg to all OTHER clients in the same room.
// This is a direct O(n) fan-out — no Raft, no disk, no quorum.
function broadcastCursor(senderWs, msg) {
  const room = clientRooms.get(senderWs);
  if (!room) return;
  const out = JSON.stringify(msg);
  clientRooms.forEach((cRoom, ws) => {
    if (ws === senderWs) return;
    if (cRoom !== room) return;
    if (ws.readyState === 1) ws.send(out);
  });
}

// Send the full current presence list to a single newly-joined client
// so it immediately sees all cursors that are already on screen.
function sendPresenceSnapshot(toWs) {
  const myRoom = clientRooms.get(toWs);
  const cursors = [];
  clientPresence.forEach((info, ws) => {
    if (ws === toWs) return;
    const room = clientRooms.get(ws);
    if (room !== myRoom) return;
    cursors.push({ clientId: info.clientId, name: info.name, color: info.color });
  });
  if (cursors.length === 0) return;
  if (toWs.readyState === 1) {
    toWs.send(JSON.stringify({ type: 'presence-snapshot', cursors }));
  }
}

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

// ─── BROADCAST HELPER (room-aware) ─────────────────────────────
// Broadcasts only to clients in the given room (or all if room is null)
function broadcast(msg, roomId = null) {
  const out = JSON.stringify(msg);
  clientRooms.forEach((cRoom, ws) => {
    if (roomId && cRoom !== roomId) return; // different room — skip
    if (ws.readyState === 1) {
      ws.send(out);
    } else if (ws.readyState === 0) {
      ws.once('open', () => { if (ws.readyState === 1) ws.send(out); });
    }
  });
}

// ─── ROOM LIST API ─────────────────────────────────────────────
app.get('/api/rooms', (req, res) => {
  const roomCounts = {};
  clientRooms.forEach(roomId => {
    roomCounts[roomId] = (roomCounts[roomId] || 0) + 1;
  });

  res.json({
    rooms: [...roomRegistry].map(id => ({
      id,
      clients: roomCounts[id] || 0,
    })),
    total: roomRegistry.size,
  });
});

app.post('/api/rooms', (req, res) => {
  const rawId = req.body.roomId || req.body.id;
  if (!rawId) return res.status(400).json({ error: 'roomId required' });
  const roomId = normalizeRoom(rawId);
  try {
    ensureRoom(roomId);
    res.json({ ok: true, roomId });
  } catch (e) {
    res.status(429).json({ error: e.message });
  }
});

// ─── WEBSOCKET ─────────────────────────────────────────────────
wss.on('connection', async (ws, req) => {
  // Room is passed as query param: ws://host/?room=design-sprint
  const url   = new URL(req.url, `http://${req.headers.host}`);
  const rawRoom = url.searchParams.get('room') || DEFAULT_ROOM;
  const roomId  = normalizeRoom(rawRoom);

  try {
    ensureRoom(roomId);
  } catch (e) {
    ws.close(1008, e.message);
    return;
  }

  clientRooms.set(ws, roomId);

  // ── Assign ephemeral presence identity ──────────────────────
  const { clientId, name, color } = assignPresence(ws);
  console.log(`[Gateway] Client connected → room="${roomId}" id=${clientId} (total: ${clientRooms.size})`);

  // Tell this client their own identity so they can label themselves
  ws.send(JSON.stringify({ type: 'self-identity', clientId, name, color }));

  // Tell everyone else in the room that this client joined (so they can
  // show a cursor for them even before the first mousemove arrives).
  broadcastCursor(ws, { type: 'cursor-join', clientId, name, color, room: roomId });

  // Send this new client a snapshot of all cursors already in the room
  sendPresenceSnapshot(ws);

  // ── Sync existing room state to newly connected client ────────
  try {
    if (!currentLeader) await findLeader();
    if (currentLeader) {
      const r = await axios.get(`${currentLeader}/sync-log`, {
        params: { fromIndex: 0, room: roomId },
        timeout: 1000
      });
      const entries = r.data.entries || [];
      if (entries.length > 0 && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'sync', entries: entries.map(e => e.entry), room: roomId }));
        console.log(`[Gateway] Sent ${entries.length} entries to new client in room "${roomId}"`);
      }
    }
  } catch (e) {
    console.error('[Gateway] Sync on connect failed:', e.message);
  }

  ws.on('message', async data => {
    try {
      const msg = JSON.parse(data);
      // Always read the live room from clientRooms — this is updated by
      // join-room messages. The closure variable `roomId` is the connection-time
      // room and goes stale after a room switch.
      const liveRoom = clientRooms.get(ws) || roomId;
      const msgRoom = normalizeRoom(msg.room) || liveRoom;

      // ── cursor (presence gossip — bypasses Raft entirely) ───
      // This is the key architectural point: cursor positions are
      // broadcast directly to peers without touching the consensus log.
      // Presence data is ephemeral; it doesn't need durability or ordering.
      if (msg.type === 'cursor') {
        const presence = clientPresence.get(ws);
        if (presence) {
          broadcastCursor(ws, {
            type: 'cursor',
            clientId: presence.clientId,
            name: presence.name,
            color: presence.color,
            x: msg.x,
            y: msg.y,
            room: clientRooms.get(ws),
          });
        }
        return; // Don't fall through — no Raft involvement
      }

      // ── stroke ──────────────────────────────────────────────
      if (msg.type === 'stroke') {
        if (!currentLeader) { await findLeader(); if (!currentLeader) return; }
        try {
          const r = await axios.post(
            `${currentLeader}/stroke`,
            { stroke: msg.data, room: msgRoom },
            { timeout: 1000 }
          );
          if (r.data.committed) {
            broadcast({ type: 'stroke', data: r.data.stroke, room: msgRoom }, msgRoom);
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
          const r = await axios.post(`${currentLeader}/undo`, { room: msgRoom }, { timeout: 1000 });
          if (r.data.committed) {
            broadcast({ type: 'undo', targetId: r.data.targetId, room: msgRoom }, msgRoom);
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
          const r = await axios.post(`${currentLeader}/redo`, { room: msgRoom }, { timeout: 1000 });
          if (r.data.committed) {
            broadcast({ type: 'redo', data: r.data.stroke, room: msgRoom }, msgRoom);
          }
        } catch (err) {
          console.log('[Gateway] Redo failed:', err.message);
          await findLeader();
        }
      }

      // ── clear ────────────────────────────────────────────────
      // Committed to the Raft log so all current clients see it AND
      // future joiners replaying the log also get the clear applied.
      if (msg.type === 'clear') {
        if (!currentLeader) { await findLeader(); if (!currentLeader) return; }
        try {
          const r = await axios.post(
            `${currentLeader}/stroke`,
            { stroke: { type: 'clear', id: `clear-${Date.now()}` }, room: msgRoom },
            { timeout: 1000 }
          );
          if (r.data.committed) {
            broadcast({ type: 'clear', room: msgRoom }, msgRoom);
            console.log(`[Gateway] 🗑  Canvas cleared in room "${msgRoom}"`);
          }
        } catch (err) {
          console.log('[Gateway] Clear failed:', err.message);
          await findLeader();
        }
      }

      // ── join-room ───────────────────────────────────────────
      if (msg.type === 'join-room') {
        const newRoom = normalizeRoom(msg.room);
        try {
          ensureRoom(newRoom);

          // Notify the OLD room that this cursor is leaving
          const oldRoom = clientRooms.get(ws);
          const presence = clientPresence.get(ws);
          if (presence && oldRoom) {
            broadcastCursor(ws, { type: 'cursor-leave', clientId: presence.clientId, room: oldRoom });
          }

          clientRooms.set(ws, newRoom);
          console.log(`[Gateway] Client switched to room "${newRoom}"`);

          // Notify the NEW room that this cursor arrived
          if (presence) {
            broadcastCursor(ws, { type: 'cursor-join', clientId: presence.clientId, name: presence.name, color: presence.color, room: newRoom });
          }
          // Give this client a snapshot of cursors already in the new room
          sendPresenceSnapshot(ws);

          if (!currentLeader) await findLeader();
          let entries = [];
          if (currentLeader) {
            const r = await axios.get(`${currentLeader}/sync-log`, {
              params: { fromIndex: 0, room: newRoom },
              timeout: 1000
            });
            entries = r.data.entries || [];
          }
          // Always send room-joined (even for empty rooms) so the
          // client can confirm the switch and clear/populate the canvas
          ws.send(JSON.stringify({
            type: 'room-joined',
            room: newRoom,
            entries: entries.map(e => e.entry),
          }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'error', message: e.message }));
        }
      }

    } catch (e) {
      console.error('[Gateway] Message parse error:', e.message);
    }
  });

  ws.on('close', () => {
    // Broadcast departure to room peers before cleanup
    const presence = clientPresence.get(ws);
    if (presence) {
      broadcastCursor(ws, { type: 'cursor-leave', clientId: presence.clientId });
    }
    clientRooms.delete(ws);
    clientPresence.delete(ws);
    console.log(`[Gateway] Client disconnected. Total: ${clientRooms.size}`);
  });

  ws.on('error', () => { clientRooms.delete(ws); clientPresence.delete(ws); });
});

// ─── CHAOS EVENT LOGGING API ───────────────────────────────────
// The frontend POSTs here at every narrative step during Chaos Mode.
// This proves to any observer watching `docker compose logs -f gateway`
// that the tests are executing real backend operations — not canned visuals.

const CHAOS_COLORS = {
  PHASE:  '\x1b[35m',   // magenta
  INFO:   '\x1b[36m',   // cyan
  ACTION: '\x1b[33m',   // yellow
  WARN:   '\x1b[33;1m', // bold yellow
  PASS:   '\x1b[32;1m', // bold green
  FAIL:   '\x1b[31;1m', // bold red
};
const CHAOS_ICONS = {
  PHASE:  '━━',
  INFO:   '  ',
  ACTION: '▶ ',
  WARN:   '⚠ ',
  PASS:   '✓ ',
  FAIL:   '✗ ',
};
const RESET = '\x1b[0m';
const DIM   = '\x1b[2m';

app.post('/api/chaos-event', (req, res) => {
  const { level = 'INFO', text = '' } = req.body;
  const color = CHAOS_COLORS[level] || '\x1b[37m';
  const icon  = CHAOS_ICONS[level]  || '  ';
  const now   = new Date();
  const ts    = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}:${now.getSeconds().toString().padStart(2,'0')}.${now.getMilliseconds().toString().padStart(3,'0')}`;

  if (level === 'PHASE') {
    const bar = '═'.repeat(60);
    console.log(`\n${color}${bar}${RESET}`);
    console.log(`${color}${DIM}[${ts}]${RESET} ${color}☢  ${text}${RESET}`);
    console.log(`${color}${bar}${RESET}`);
  } else {
    console.log(`${DIM}[${ts}]${RESET} ${color}${icon}${text}${RESET}`);
  }

  res.json({ ok: true });
});

// ─── PARTITION API ─────────────────────────────────────────────
app.post('/api/partition', async (req, res) => {
  const { a, b } = req.body;
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

  const noResync = req.body?.noResync === true;

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

  if (stabilized && leaderUrl && !noResync) {
    try {
      for (const roomId of roomRegistry) {
        const syncRes = await axios.get(`${leaderUrl}/sync-log`,
          { params: { fromIndex: 0, room: roomId }, timeout: 1000 }
        );
        const canonicalEntries = syncRes.data.entries || [];
        const leaderTerm = (await axios.get(`${leaderUrl}/status`, { timeout: 500 })).data.term;
        await Promise.allSettled(
          REPLICAS
            .filter(url => url !== leaderUrl)
            .map(url =>
              axios.post(`${url}/reset-log`,
                { entries: canonicalEntries, term: leaderTerm, room: roomId },
                { timeout: 1000 }
              )
            )
        );
      }
      console.log(`[Gateway] 🔄 Resynced all rooms after heal`);
    } catch (e) {
      console.error('[Gateway] Log resync failed:', e.message);
    }
  }

  res.json({ ok: true, stabilized });
});

app.get('/api/partitions', (req, res) => {
  res.json({ partitioned: [...partitioned] });
});

// ─── CLUSTER STATUS API ────────────────────────────────────────
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

  const leaderStatus = statuses.find(s => s.state === 'leader');
  const currentTerm  = leaderStatus?.term
    ?? Math.max(...statuses.map(s => s.term ?? 0));

  const roomCounts = {};
  clientRooms.forEach(roomId => {
    roomCounts[roomId] = (roomCounts[roomId] || 0) + 1;
  });

  res.json({
    leader: currentLeader,
    leaderShort: currentLeader ? shortName(currentLeader) : null,
    term: currentTerm,
    replicas: statuses,
    clients: clientRooms.size,
    presenceCount: clientPresence.size,
    rooms: [...roomRegistry].map(id => ({ id, clients: roomCounts[id] || 0 })),
    partitioned: [...partitioned],
    registeredReplicas: REPLICAS.map(shortName),
  });
});

// ─── CHAOS STROKE API ──────────────────────────────────────────
app.post('/api/chaos-stroke', async (req, res) => {
  if (!currentLeader) await findLeader();
  if (!currentLeader) return res.json({ committed: false, reason: 'No leader' });
  try {
    const { index = 0, room = DEFAULT_ROOM } = req.body;
    const roomId = normalizeRoom(room);
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
    const r = await axios.post(`${currentLeader}/stroke`, { stroke, room: roomId }, { timeout: 1500 });
    if (r.data.committed) {
      broadcast({ type: 'stroke', data: r.data.stroke, room: roomId }, roomId);
    }
    res.json(r.data);
  } catch (e) {
    res.json({ committed: false, reason: e.message });
  }
});

// ─── LEADER ISOLATION API ──────────────────────────────────────
app.post('/api/isolate-leader', async (req, res) => {
  if (!currentLeader) await findLeader();
  if (!currentLeader) {
    return res.status(503).json({ error: 'No leader elected yet — try again in a moment' });
  }

  const leaderName = shortName(currentLeader);
  const followerNames = REPLICAS
    .filter(u => u !== currentLeader)
    .map(shortName);

  const pairs = followerNames.map(f => `${leaderName}:${f}`);
  pairs.forEach(p => partitioned.add(p));

  await Promise.allSettled(
    followerNames.map(f => applyPartition(leaderName, f))
  );

  console.log(`[Gateway] 🔴 Leader ${leaderName} isolated`);
  broadcast({ type: 'leaderIsolated', leader: leaderName });

  res.json({ ok: true, isolated: leaderName, followers: followerNames });
});

// ─── BLUE-GREEN REPLACEMENT API ────────────────────────────────
app.post('/api/blue-green/promote', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  if (REPLICAS.includes(url)) {
    return res.status(409).json({ error: `${url} is already in the registry` });
  }

  try {
    await axios.get(`${url}/status`, { timeout: 1500 });
  } catch (e) {
    return res.status(503).json({ error: `Cannot reach ${url}`, detail: e.message });
  }

  REPLICAS.push(url);

  let synced = false;
  let syncedEntries = 0;
  try {
    if (!currentLeader) await findLeader();
    if (currentLeader) {
      for (const roomId of roomRegistry) {
        const syncRes = await axios.get(`${currentLeader}/sync-log`,
          { params: { fromIndex: 0, room: roomId }, timeout: 1000 }
        );
        const canonicalEntries = syncRes.data.entries || [];
        const statusRes = await axios.get(`${currentLeader}/status`, { timeout: 500 });
        await axios.post(`${url}/reset-log`,
          { entries: canonicalEntries, term: statusRes.data.term, room: roomId },
          { timeout: 2000 }
        );
        syncedEntries += canonicalEntries.length;
      }
      synced = true;
    }
  } catch (e) {
    console.warn(`[Blue-Green] Log push failed (non-fatal): ${e.message}`);
  }

  broadcast({
    type: 'clusterChanged',
    event: 'promoted',
    replica: shortName(url),
    size: REPLICAS.length,
    registeredReplicas: REPLICAS.map(shortName),
  });

  res.json({ ok: true, promoted: shortName(url), logSynced: synced, syncedEntries, clusterSize: REPLICAS.length });
});

app.post('/api/blue-green/retire', async (req, res) => {
  const { replica } = req.body;
  if (!replica) return res.status(400).json({ error: 'replica (short name) required' });

  const url = REPLICAS.find(u => shortName(u) === replica);
  if (!url) return res.status(404).json({ error: `${replica} not found` });

  if (REPLICAS.length <= 4) {
    return res.status(400).json({ error: 'Promote a replacement first' });
  }

  if (currentLeader === url) {
    return res.status(409).json({ error: `${replica} is the leader — isolate first` });
  }

  REPLICAS.splice(REPLICAS.indexOf(url), 1);

  for (const pair of [...partitioned]) {
    const [a, b] = pair.split(':');
    if (a === replica || b === replica) partitioned.delete(pair);
  }

  broadcast({ type: 'clusterChanged', event: 'retired', replica, size: REPLICAS.length, registeredReplicas: REPLICAS.map(shortName) });
  res.json({ ok: true, retired: replica, clusterSize: REPLICAS.length });
});

// ─── SNAPSHOT API (Feature 4) ──────────────────────────────────
// POST /api/snapshot  → forwards to the current leader's /snapshot endpoint.
// The leader serialises the canvas state, commits it as a special log entry,
// truncates all preceding entries, then pushes the compacted log to followers.
app.post('/api/snapshot', async (req, res) => {
  if (!currentLeader) await findLeader();
  if (!currentLeader) return res.status(503).json({ error: 'No leader available' });

  const roomId = normalizeRoom(req.body?.room);
  try {
    const r = await axios.post(`${currentLeader}/snapshot`, { room: roomId }, { timeout: 3000 });
    if (r.data.ok) {
      console.log(`[Gateway] 📸 Snapshot created for room "${roomId}" — ${r.data.entriesCompacted} → ${r.data.newLogLength} entries`);
      // Broadcast snapshot event so connected clients refresh their log view
      broadcast({ type: 'snapshot', room: roomId, ...r.data }, roomId);
    }
    res.json(r.data);
  } catch (e) {
    console.error('[Gateway] Snapshot failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── FULL LOG API (Feature 3 - time travel) ────────────────────
// GET /api/full-log?room=xxx  → returns every committed log entry,
// allowing the UI scrubber to replay the canvas to any past state.
app.get('/api/full-log', async (req, res) => {
  if (!currentLeader) await findLeader();
  if (!currentLeader) return res.status(503).json({ error: 'No leader available' });

  const roomId = normalizeRoom(req.query.room);
  try {
    const r = await axios.get(`${currentLeader}/full-log`, {
      params: { room: roomId },
      timeout: 2000,
    });
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── HEALTH CHECK ───────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    leader: currentLeader ? shortName(currentLeader) : null,
    replicas: REPLICAS.length,
    clients: clientRooms.size,
    rooms: [...roomRegistry],
  });
});

server.listen(3000, () =>
  console.log(`[Gateway] 🚀 Running on http://localhost:3000 | replicas: ${REPLICAS.length}`)
);