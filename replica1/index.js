const express = require('express');
const fs      = require('fs');
const axios   = require('axios');
const crypto  = require('crypto');
const app     = express();
app.use(express.json());

// Suppress MaxListenersExceededWarning from axios keep-alive sockets
require('events').EventEmitter.defaultMaxListeners = 30;

const REPLICA_ID = process.env.REPLICA_ID;
const PORT       = parseInt(process.env.PORT);
const PEERS      = process.env.PEERS.split(',');
const QUORUM     = parseInt(process.env.QUORUM_SIZE) || Math.floor(PEERS.length / 2) + 1;

// ─── MULTI-ROOM LOG STORAGE ────────────────────────────────────
// Each room has its own independent log. This lets the gateway shard
// drawing operations by room — conceptually identical to Kafka topics
// or database table partitioning.
//
// roomLogs: Map<roomId, LogEntry[]>
// roomCommitIndex: Map<roomId, number>
//
// The RAFT consensus state (term, voted-for, leader election) is still
// cluster-wide — rooms share a single consensus layer. What changes is
// the *data* layer: each room is an independent ordered log of strokes.

const DEFAULT_ROOM = 'default';
const roomLogs        = new Map([[DEFAULT_ROOM, []]]);
const roomCommitIndex = new Map([[DEFAULT_ROOM, -1]]);

function getLog(roomId = DEFAULT_ROOM) {
  if (!roomLogs.has(roomId)) {
    roomLogs.set(roomId, []);
    roomCommitIndex.set(roomId, -1);
  }
  return roomLogs.get(roomId);
}

function getCommitIndex(roomId = DEFAULT_ROOM) {
  return roomCommitIndex.get(roomId) ?? -1;
}

function setCommitIndex(roomId, idx) {
  roomCommitIndex.set(roomId, idx);
}

// ─── PERSISTENCE (per-room) ─────────────────────────────────────
const DATA_DIR = '/data';

function logPath(roomId) {
  // Sanitize room ID for use as a filename
  const safe = roomId.replace(/[^a-z0-9-]/g, '_');
  return `${DATA_DIR}/raft-log-${safe}.json`;
}

function loadAllLogs() {
  try {
    if (!fs.existsSync(DATA_DIR)) return;
    const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('raft-log-') && f.endsWith('.json'));
    for (const file of files) {
      try {
        const roomId = file.replace('raft-log-', '').replace('.json', '').replace(/_/g, '-');
        const saved  = JSON.parse(fs.readFileSync(`${DATA_DIR}/${file}`, 'utf8'));
        const all    = saved.log || [];
        const committed = all.filter(e => e.committed);
        roomLogs.set(roomId, committed);
        roomCommitIndex.set(roomId, committed.length - 1);
        if (saved.currentTerm) currentTerm = Math.max(currentTerm, saved.currentTerm);
        console.log(`[${REPLICA_ID}] 📂 Restored room "${roomId}": ${committed.length} entries`);
      } catch (e) {
        console.error(`[${REPLICA_ID}] ⚠️  Could not restore ${file}:`, e.message);
      }
    }
  } catch (e) {
    console.error(`[${REPLICA_ID}] ⚠️  Could not scan data dir:`, e.message);
  }
}

function persistLog(roomId) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const log = getLog(roomId);
    fs.writeFileSync(logPath(roomId), JSON.stringify({
      log,
      commitIndex: getCommitIndex(roomId),
      currentTerm
    }));
  } catch (e) {
    console.error(`[${REPLICA_ID}] ⚠️  Could not persist log for room "${roomId}":`, e.message);
  }
}

// ─── RAFT STATE ────────────────────────────────────────────────
let state       = 'follower';
let currentTerm = 0;
let votedFor    = null;
let leaderId    = null;
let electionTimer = null;
const blocked   = new Set();

// ─── ELECTION TIMER ────────────────────────────────────────────
function resetElectionTimer() {
  clearTimeout(electionTimer);
  const delay = 500 + Math.random() * 300;
  electionTimer = setTimeout(startElection, delay);
}

async function startElection() {
  state = 'candidate';
  currentTerm++;
  votedFor = REPLICA_ID;
  let votes = 1;
  console.log(`[${REPLICA_ID}] 🗳  Starting election for term ${currentTerm}`);

  const results = await Promise.all(
    PEERS.filter(p => !blocked.has(p)).map(peer =>
      axios.post(`${peer}/request-vote`,
        { term: currentTerm, candidateId: REPLICA_ID },
        { timeout: 400 }
      ).catch(() => ({ data: { voteGranted: false } }))
    )
  );

  results.forEach(r => { if (r.data.voteGranted) votes++; });

  if (votes >= QUORUM && state === 'candidate') {
    becomeLeader();
  } else {
    state = 'follower';
    resetElectionTimer();
  }
}

function becomeLeader() {
  state    = 'leader';
  leaderId = REPLICA_ID;
  console.log(`[${REPLICA_ID}] 👑 Became LEADER for term ${currentTerm}`);
  sendHeartbeats();
}

function sendHeartbeats() {
  if (state !== 'leader') return;
  PEERS.filter(p => !blocked.has(p)).forEach(peer =>
    axios.post(`${peer}/heartbeat`,
      { term: currentTerm, leaderId: REPLICA_ID },
      { timeout: 300 }
    ).catch(() => {})
  );
  setTimeout(sendHeartbeats, 150);
}

// ─── REPLICATION HELPER (room-aware) ──────────────────────────
async function replicateEntry(entry, roomId = DEFAULT_ROOM) {
  const log   = getLog(roomId);
  const index = log.length;
  log.push({ term: currentTerm, entry, committed: false });

  let acks = 1;
  await Promise.all(
    PEERS.filter(p => !blocked.has(p)).map(peer =>
      axios.post(`${peer}/append-entries`, {
        term: currentTerm, leaderId: REPLICA_ID,
        entry, prevLogIndex: index - 1,
        room: roomId,                          // ← pass room to followers
      }, { timeout: 400 })
      .then(r => { if (r.data.success) acks++; })
      .catch(() => {})
    )
  );

  if (acks >= QUORUM) {
    log[index].committed = true;
    setCommitIndex(roomId, index);
    persistLog(roomId);
    console.log(`[${REPLICA_ID}] ✅ Committed entry #${index} room="${roomId}" type=${entry.type || 'stroke'} (acks: ${acks})`);
    PEERS.forEach(peer =>
      axios.post(`${peer}/commit`, { index, room: roomId }, { timeout: 300 }).catch(() => {})
    );
    return { committed: true, index };
  } else {
    log[index].committed = false;
    return { committed: false };
  }
}

// ─── LOG-DERIVED UNDO/REDO STATE (room-aware) ──────────────────
function getUndoRedoState(roomId = DEFAULT_ROOM) {
  const log = getLog(roomId);
  const cancelledIds = new Set();
  const recentlyCancelled = [];

  for (const entry of log) {
    if (!entry.committed) continue;
    if (entry.entry?.type === 'cancel') {
      const targetId = entry.entry.targetId;
      cancelledIds.add(targetId);
      const original = log.find(
        e => e.committed && e.entry?.id === targetId && e.entry?.type !== 'cancel'
      );
      if (original) recentlyCancelled.push({ id: targetId, stroke: original.entry });
    } else if (entry.entry?.id) {
      const idx = recentlyCancelled.findIndex(r => r.id === entry.entry.id);
      if (idx !== -1) recentlyCancelled.splice(idx, 1);
      cancelledIds.delete(entry.entry.id);
    }
  }

  const activeStrokes = log.filter(
    e => e.committed && e.entry?.type !== 'cancel' && !cancelledIds.has(e.entry?.id)
  );
  const lastActive = activeStrokes.length > 0
    ? activeStrokes[activeStrokes.length - 1]
    : null;

  return { lastActive, redoStack: recentlyCancelled, cancelledIds };
}

// ─── RPC ENDPOINTS ─────────────────────────────────────────────

app.post('/request-vote', (req, res) => {
  const { term, candidateId } = req.body;
  if (term > currentTerm) {
    currentTerm = term; state = 'follower'; votedFor = null;
  }
  const grant = term >= currentTerm &&
    (votedFor === null || votedFor === candidateId);
  if (grant) { votedFor = candidateId; resetElectionTimer(); }
  res.json({ voteGranted: grant, term: currentTerm });
});

app.post('/heartbeat', (req, res) => {
  const { term, leaderId: lid } = req.body;
  if (term >= currentTerm) {
    currentTerm = term;
    state       = 'follower';
    leaderId    = lid;
    resetElectionTimer();
  }
  res.json({ ok: true });
});

// ── append-entries: room-aware ──────────────────────────────────
app.post('/append-entries', (req, res) => {
  const { term, leaderId: lid, entry, room = DEFAULT_ROOM } = req.body;
  if (term >= currentTerm) {
    currentTerm = term;
    state       = 'follower';
    leaderId    = lid;
    resetElectionTimer();
  }
  const log = getLog(room);
  log.push({ term, entry, committed: false });
  res.json({ success: true });
});

// ── commit: room-aware ──────────────────────────────────────────
app.post('/commit', (req, res) => {
  const { index, room = DEFAULT_ROOM } = req.body;
  const log = getLog(room);
  if (log[index]) {
    log[index].committed = true;
    setCommitIndex(room, index);
    persistLog(room);
  }
  res.json({ ok: true });
});

// ─── STATUS ────────────────────────────────────────────────────
app.get('/status', (req, res) => {
  // Total log entries across all rooms (for the diagnostics panel)
  let totalLogLength = 0;
  let totalActiveStrokes = 0;
  roomLogs.forEach((log, roomId) => {
    totalLogLength += log.length;
    const { cancelledIds } = getUndoRedoState(roomId);
    totalActiveStrokes += log.filter(
      e => e.committed && e.entry?.type !== 'cancel' && !cancelledIds.has(e.entry?.id)
    ).length;
  });

  res.json({
    id: REPLICA_ID, state, term: currentTerm,
    leaderId, logLength: totalLogLength, commitIndex: Math.max(...[...roomCommitIndex.values()], -1),
    activeStrokes: totalActiveStrokes, quorum: QUORUM,
    blocked: [...blocked],
    rooms: [...roomLogs.keys()].map(id => ({
      id,
      logLength: getLog(id).length,
      commitIndex: getCommitIndex(id),
    })),
  });
});

// ─── PARTITION CONTROL ─────────────────────────────────────────
app.post('/set-block', (req, res) => {
  const { peers } = req.body;
  blocked.clear();
  peers.forEach(p => blocked.add(p));
  res.json({ ok: true, blocked: [...blocked] });
});

// ─── STROKE HANDLER (room-aware, leader only) ──────────────────
app.post('/stroke', async (req, res) => {
  if (state !== 'leader') {
    return res.status(302).json({ redirect: leaderId });
  }
  const { stroke, room = DEFAULT_ROOM } = req.body;
  stroke.id = stroke.id || crypto.randomUUID();

  const result = await replicateEntry(stroke, room);
  if (result.committed) {
    res.json({ success: true, committed: true, stroke });
  } else {
    res.json({ success: false, reason: 'No majority' });
  }
});

// ─── UNDO HANDLER (room-aware, leader only) ────────────────────
app.post('/undo', async (req, res) => {
  if (state !== 'leader') {
    return res.status(302).json({ redirect: leaderId });
  }
  const { room = DEFAULT_ROOM } = req.body;
  const { lastActive } = getUndoRedoState(room);
  if (!lastActive) {
    return res.json({ committed: false, reason: 'Nothing to undo' });
  }

  const targetId = lastActive.entry.id;
  const result = await replicateEntry({ type: 'cancel', targetId }, room);
  if (result.committed) {
    res.json({ committed: true, targetId });
  } else {
    res.json({ committed: false, reason: 'No majority for undo' });
  }
});

// ─── REDO HANDLER (room-aware, leader only) ────────────────────
app.post('/redo', async (req, res) => {
  if (state !== 'leader') {
    return res.status(302).json({ redirect: leaderId });
  }
  const { room = DEFAULT_ROOM } = req.body;
  const { redoStack } = getUndoRedoState(room);
  const last = redoStack[redoStack.length - 1];
  if (!last) {
    return res.json({ committed: false, reason: 'Nothing to redo' });
  }

  const result = await replicateEntry(last.stroke, room);
  if (result.committed) {
    res.json({ committed: true, stroke: last.stroke });
  } else {
    res.json({ committed: false, reason: 'No majority for redo' });
  }
});

// ─── SYNC LOG (room-aware) ─────────────────────────────────────
app.get('/sync-log', (req, res) => {
  const fromIndex = parseInt(req.query.fromIndex) || 0;
  const roomId    = req.query.room || DEFAULT_ROOM;
  const log       = getLog(roomId);
  const entries   = log
    .slice(fromIndex)
    .filter(e => e.committed);
  res.json({ entries, room: roomId });
});

// ─── RESET LOG (room-aware) ────────────────────────────────────
app.post('/reset-log', (req, res) => {
  const { entries = [], term, room = DEFAULT_ROOM } = req.body;
  roomLogs.set(room, entries);
  roomCommitIndex.set(room, entries.length - 1);
  if (term) currentTerm = Math.max(currentTerm, term);
  persistLog(room);
  console.log(`[${REPLICA_ID}] 🔄 Log reset for room "${room}": ${entries.length} entries`);
  res.json({ ok: true, room, entries: entries.length });
});

app.listen(PORT, () => {
  console.log(`[${REPLICA_ID}] 🚀 Listening on port ${PORT} | peers: ${PEERS.length} | quorum: ${QUORUM}`);
  loadAllLogs();
  resetElectionTimer();
});
