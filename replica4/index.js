const express = require('express');
const fs      = require('fs');
const axios   = require('axios');
const crypto  = require('crypto');
const app     = express();
app.use(express.json());

require('events').EventEmitter.defaultMaxListeners = 30;

const REPLICA_ID = process.env.REPLICA_ID;
const PORT       = parseInt(process.env.PORT);
const PEERS      = process.env.PEERS.split(',');
const QUORUM     = parseInt(process.env.QUORUM_SIZE) || Math.floor(PEERS.length / 2) + 1;

const DEFAULT_ROOM = 'default';
const roomLogs        = new Map([[DEFAULT_ROOM, []]]);
const roomCommitIndex = new Map([[DEFAULT_ROOM, -1]]);

// Feature 4: per-room snapshot storage
const roomSnapshots = new Map();

function getLog(roomId = DEFAULT_ROOM) {
  if (!roomLogs.has(roomId)) {
    roomLogs.set(roomId, []);
    roomCommitIndex.set(roomId, -1);
  }
  return roomLogs.get(roomId);
}
function getCommitIndex(roomId = DEFAULT_ROOM) { return roomCommitIndex.get(roomId) ?? -1; }
function setCommitIndex(roomId, idx) { roomCommitIndex.set(roomId, idx); }

const DATA_DIR = '/data';
function logPath(roomId) { const s = roomId.replace(/[^a-z0-9-]/g,'_'); return `${DATA_DIR}/raft-log-${s}.json`; }
function snapshotPath(roomId) { const s = roomId.replace(/[^a-z0-9-]/g,'_'); return `${DATA_DIR}/raft-snapshot-${s}.json`; }

function loadAllLogs() {
  try {
    if (!fs.existsSync(DATA_DIR)) return;
    // Load snapshots first
    const snapFiles = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('raft-snapshot-') && f.endsWith('.json'));
    for (const file of snapFiles) {
      try {
        const roomId = file.replace('raft-snapshot-','').replace('.json','').replace(/_/g,'-');
        const snap = JSON.parse(fs.readFileSync(`${DATA_DIR}/${file}`,'utf8'));
        roomSnapshots.set(roomId, snap);
        console.log(`[${REPLICA_ID}] 📸 Restored snapshot for room "${roomId}" at index ${snap.index}`);
      } catch(e) { console.error(`[${REPLICA_ID}] ⚠️  snapshot restore error:`, e.message); }
    }
    const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('raft-log-') && f.endsWith('.json'));
    for (const file of files) {
      try {
        const roomId = file.replace('raft-log-','').replace('.json','').replace(/_/g,'-');
        const saved  = JSON.parse(fs.readFileSync(`${DATA_DIR}/${file}`,'utf8'));
        const all    = saved.log || [];
        const committed = all.filter(e => e.committed);
        roomLogs.set(roomId, committed);
        roomCommitIndex.set(roomId, committed.length - 1);
        if (saved.currentTerm) currentTerm = Math.max(currentTerm, saved.currentTerm);
        console.log(`[${REPLICA_ID}] 📂 Restored room "${roomId}": ${committed.length} entries`);
      } catch(e) { console.error(`[${REPLICA_ID}] ⚠️  log restore error:`, e.message); }
    }
  } catch(e) { console.error(`[${REPLICA_ID}] ⚠️  Could not scan data dir:`, e.message); }
}

function persistLog(roomId) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(logPath(roomId), JSON.stringify({ log: getLog(roomId), commitIndex: getCommitIndex(roomId), currentTerm }));
  } catch(e) { console.error(`[${REPLICA_ID}] ⚠️  persist log error:`, e.message); }
}

function persistSnapshot(roomId, snap) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(snapshotPath(roomId), JSON.stringify(snap));
  } catch(e) { console.error(`[${REPLICA_ID}] ⚠️  persist snapshot error:`, e.message); }
}

// ─── RAFT STATE ────────────────────────────────────────────────
let state       = 'follower';
let currentTerm = 0;
let votedFor    = null;
let leaderId    = null;
let electionTimer = null;
const blocked   = new Set();

function resetElectionTimer() {
  clearTimeout(electionTimer);
  electionTimer = setTimeout(startElection, 500 + Math.random() * 300);
}

async function startElection() {
  state = 'candidate'; currentTerm++; votedFor = REPLICA_ID; let votes = 1;
  console.log(`[${REPLICA_ID}] 🗳  Starting election for term ${currentTerm}`);
  const results = await Promise.all(
    PEERS.filter(p => !blocked.has(p)).map(peer =>
      axios.post(`${peer}/request-vote`, { term: currentTerm, candidateId: REPLICA_ID }, { timeout: 400 })
        .catch(() => ({ data: { voteGranted: false } }))
    )
  );
  results.forEach(r => { if (r.data.voteGranted) votes++; });
  if (votes >= QUORUM && state === 'candidate') { becomeLeader(); }
  else { state = 'follower'; resetElectionTimer(); }
}

function becomeLeader() {
  state = 'leader'; leaderId = REPLICA_ID;
  console.log(`[${REPLICA_ID}] 👑 Became LEADER for term ${currentTerm}`);
  sendHeartbeats();
}

function sendHeartbeats() {
  if (state !== 'leader') return;
  PEERS.filter(p => !blocked.has(p)).forEach(peer =>
    axios.post(`${peer}/heartbeat`, { term: currentTerm, leaderId: REPLICA_ID }, { timeout: 300 }).catch(() => {})
  );
  setTimeout(sendHeartbeats, 150);
}

async function replicateEntry(entry, roomId = DEFAULT_ROOM) {
  const log   = getLog(roomId);
  const index = log.length;
  log.push({ term: currentTerm, entry, committed: false });
  let acks = 1;
  await Promise.all(
    PEERS.filter(p => !blocked.has(p)).map(peer =>
      axios.post(`${peer}/append-entries`, {
        term: currentTerm, leaderId: REPLICA_ID, entry,
        prevLogIndex: index - 1, room: roomId,
      }, { timeout: 400 })
      .then(r => { if (r.data.success) acks++; })
      .catch(() => {})
    )
  );
  if (acks >= QUORUM) {
    log[index].committed = true;
    setCommitIndex(roomId, index);
    persistLog(roomId);
    console.log(`[${REPLICA_ID}] ✅ Committed #${index} room="${roomId}" type=${entry.type||'stroke'} (acks:${acks})`);
    PEERS.forEach(peer => axios.post(`${peer}/commit`, { index, room: roomId }, { timeout: 300 }).catch(() => {}));
    return { committed: true, index };
  } else {
    log[index].committed = false;
    return { committed: false };
  }
}

function getUndoRedoState(roomId = DEFAULT_ROOM) {
  const log = getLog(roomId);
  const cancelledIds = new Set();
  const recentlyCancelled = [];
  for (const entry of log) {
    if (!entry.committed) continue;
    if (entry.entry?.type === 'cancel') {
      const targetId = entry.entry.targetId;
      cancelledIds.add(targetId);
      const original = log.find(e => e.committed && e.entry?.id === targetId && e.entry?.type !== 'cancel');
      if (original) recentlyCancelled.push({ id: targetId, stroke: original.entry });
    } else if (entry.entry?.id) {
      const idx = recentlyCancelled.findIndex(r => r.id === entry.entry.id);
      if (idx !== -1) recentlyCancelled.splice(idx, 1);
      cancelledIds.delete(entry.entry.id);
    }
  }
  const activeStrokes = log.filter(e => e.committed && e.entry?.type !== 'cancel' && !cancelledIds.has(e.entry?.id));
  return { lastActive: activeStrokes.length ? activeStrokes[activeStrokes.length-1] : null, redoStack: recentlyCancelled, cancelledIds };
}

// ─── CANVAS STATE COMPUTATION (Feature 4) ─────────────────────
// Replays all committed log entries on top of the snapshot base.
function computeCanvasState(roomId = DEFAULT_ROOM) {
  const log  = getLog(roomId);
  const snap = roomSnapshots.get(roomId);
  let strokes     = snap ? [...snap.canvasState] : [];
  let cancelledIds = new Set();
  for (const logEntry of log) {
    if (!logEntry.committed) continue;
    const entry = logEntry.entry;
    if (!entry) continue;
    if (entry.type === 'snapshot') {
      strokes = entry.canvasState ? [...entry.canvasState] : [];
      cancelledIds = new Set();
    } else if (entry.type === 'clear') {
      strokes = []; cancelledIds = new Set();
    } else if (entry.type === 'cancel') {
      cancelledIds.add(entry.targetId);
      strokes = strokes.filter(s => s.id !== entry.targetId);
    } else if (entry.id) {
      cancelledIds.delete(entry.id);
      if (!strokes.find(s => s.id === entry.id)) strokes.push(entry);
    }
  }
  return strokes;
}

// ─── SNAPSHOT CREATION (Feature 4) ────────────────────────────
function createSnapshot(roomId = DEFAULT_ROOM) {
  const log = getLog(roomId).filter(e => e.committed);
  if (log.length === 0) return { skipped: true, reason: 'No committed entries to compact' };

  const canvasState     = computeCanvasState(roomId);
  const snapshotIndex   = log.length - 1;
  const snapshotTerm    = log[snapshotIndex]?.term ?? currentTerm;
  const entriesCompacted = log.length;

  const snap = { index: snapshotIndex, term: snapshotTerm, canvasState, createdAt: Date.now(), entriesCompacted };
  roomSnapshots.set(roomId, snap);
  persistSnapshot(roomId, snap);

  // Replace log with single synthetic snapshot entry
  const snapshotEntry = [{
    term: snapshotTerm, committed: true,
    entry: { type: 'snapshot', id: `snapshot-${Date.now()}`, canvasState, originalEntries: entriesCompacted, createdAt: snap.createdAt }
  }];
  roomLogs.set(roomId, snapshotEntry);
  setCommitIndex(roomId, 0);
  persistLog(roomId);

  console.log(`[${REPLICA_ID}] 📸 Snapshot created for room "${roomId}": ${entriesCompacted} → 1 entry`);
  return { ok: true, snapshotIndex, canvasStateSize: canvasState.length, entriesCompacted, newLogLength: 1 };
}

// ─── RPC ENDPOINTS ─────────────────────────────────────────────
app.post('/request-vote', (req, res) => {
  const { term, candidateId } = req.body;
  if (term > currentTerm) { currentTerm = term; state = 'follower'; votedFor = null; }
  const grant = term >= currentTerm && (votedFor === null || votedFor === candidateId);
  if (grant) { votedFor = candidateId; resetElectionTimer(); }
  res.json({ voteGranted: grant, term: currentTerm });
});

app.post('/heartbeat', (req, res) => {
  const { term, leaderId: lid } = req.body;
  if (term >= currentTerm) { currentTerm = term; state = 'follower'; leaderId = lid; resetElectionTimer(); }
  res.json({ ok: true });
});

app.post('/append-entries', (req, res) => {
  const { term, leaderId: lid, entry, room = DEFAULT_ROOM } = req.body;
  if (term >= currentTerm) { currentTerm = term; state = 'follower'; leaderId = lid; resetElectionTimer(); }
  getLog(room).push({ term, entry, committed: false });
  res.json({ success: true });
});

app.post('/commit', (req, res) => {
  const { index, room = DEFAULT_ROOM } = req.body;
  const log = getLog(room);
  if (log[index]) { log[index].committed = true; setCommitIndex(room, index); persistLog(room); }
  res.json({ ok: true });
});

app.get('/status', (req, res) => {
  let totalLogLength = 0, totalActiveStrokes = 0;
  roomLogs.forEach((log, roomId) => {
    totalLogLength += log.length;
    const { cancelledIds } = getUndoRedoState(roomId);
    totalActiveStrokes += log.filter(e => e.committed && e.entry?.type !== 'cancel' && !cancelledIds.has(e.entry?.id)).length;
  });
  const snapInfo = {};
  roomSnapshots.forEach((snap, roomId) => {
    snapInfo[roomId] = { index: snap.index, canvasStateSize: snap.canvasState?.length ?? 0, entriesCompacted: snap.entriesCompacted, createdAt: snap.createdAt };
  });
  res.json({
    id: REPLICA_ID, state, term: currentTerm, leaderId,
    logLength: totalLogLength, commitIndex: Math.max(...[...roomCommitIndex.values()], -1),
    activeStrokes: totalActiveStrokes, quorum: QUORUM, blocked: [...blocked],
    rooms: [...roomLogs.keys()].map(id => ({ id, logLength: getLog(id).length, commitIndex: getCommitIndex(id), hasSnapshot: roomSnapshots.has(id) })),
    snapshots: snapInfo,
  });
});

app.post('/set-block', (req, res) => {
  const { peers } = req.body;
  blocked.clear(); peers.forEach(p => blocked.add(p));
  res.json({ ok: true, blocked: [...blocked] });
});

app.post('/stroke', async (req, res) => {
  if (state !== 'leader') return res.status(302).json({ redirect: leaderId });
  const { stroke, room = DEFAULT_ROOM } = req.body;
  stroke.id = stroke.id || crypto.randomUUID();
  const result = await replicateEntry(stroke, room);
  if (result.committed) res.json({ success: true, committed: true, stroke });
  else res.json({ success: false, reason: 'No majority' });
});

app.post('/undo', async (req, res) => {
  if (state !== 'leader') return res.status(302).json({ redirect: leaderId });
  const { room = DEFAULT_ROOM } = req.body;
  const { lastActive } = getUndoRedoState(room);
  if (!lastActive) return res.json({ committed: false, reason: 'Nothing to undo' });
  const result = await replicateEntry({ type: 'cancel', targetId: lastActive.entry.id }, room);
  if (result.committed) res.json({ committed: true, targetId: lastActive.entry.id });
  else res.json({ committed: false, reason: 'No majority for undo' });
});

app.post('/redo', async (req, res) => {
  if (state !== 'leader') return res.status(302).json({ redirect: leaderId });
  const { room = DEFAULT_ROOM } = req.body;
  const { redoStack } = getUndoRedoState(room);
  const last = redoStack[redoStack.length - 1];
  if (!last) return res.json({ committed: false, reason: 'Nothing to redo' });
  const result = await replicateEntry(last.stroke, room);
  if (result.committed) res.json({ committed: true, stroke: last.stroke });
  else res.json({ committed: false, reason: 'No majority for redo' });
});

// ─── SYNC LOG ──────────────────────────────────────────────────
app.get('/sync-log', (req, res) => {
  const fromIndex = parseInt(req.query.fromIndex) || 0;
  const roomId    = req.query.room || DEFAULT_ROOM;
  const log       = getLog(roomId);
  const entries   = log.slice(fromIndex).filter(e => e.committed);
  const snap      = roomSnapshots.get(roomId);
  res.json({
    entries, room: roomId,
    snapshot: snap ? { index: snap.index, canvasStateSize: snap.canvasState?.length ?? 0, entriesCompacted: snap.entriesCompacted, createdAt: snap.createdAt } : null,
  });
});

// ─── FULL LOG (Feature 3 - time travel) ───────────────────────
// Returns every committed entry indexed for the scrubber, plus
// snapshot metadata so the client can bootstrap from a base state.
app.get('/full-log', (req, res) => {
  const roomId = req.query.room || DEFAULT_ROOM;
  const log    = getLog(roomId);
  const snap   = roomSnapshots.get(roomId);
  const entries = log.filter(e => e.committed).map((e, i) => ({ index: i, term: e.term, entry: e.entry }));
  res.json({
    entries,
    room: roomId,
    totalCommitted: entries.length,
    snapshot: snap ? {
      index: snap.index,
      canvasStateSize: snap.canvasState?.length ?? 0,
      entriesCompacted: snap.entriesCompacted,
      createdAt: snap.createdAt,
      canvasState: snap.canvasState,
    } : null,
  });
});

// ─── SNAPSHOT API (Feature 4) ──────────────────────────────────
app.post('/snapshot', async (req, res) => {
  if (state !== 'leader') return res.status(302).json({ redirect: leaderId });
  const { room = DEFAULT_ROOM } = req.body;
  const result = createSnapshot(room);
  if (result.skipped) return res.json({ ok: false, ...result });
  // Propagate compacted log + snapshot to all followers
  const newLog = getLog(room);
  const snap   = roomSnapshots.get(room);
  await Promise.allSettled(
    PEERS.filter(p => !blocked.has(p)).map(peer =>
      axios.post(`${peer}/reset-log`, { entries: newLog, term: currentTerm, room, snapshot: snap }, { timeout: 800 }).catch(() => {})
    )
  );
  console.log(`[${REPLICA_ID}] 📸 Snapshot propagated to followers for room "${room}"`);
  res.json({ ok: true, room, ...result });
});

// ─── RESET LOG ─────────────────────────────────────────────────
app.post('/reset-log', (req, res) => {
  const { entries = [], term, room = DEFAULT_ROOM, snapshot } = req.body;
  roomLogs.set(room, entries);
  roomCommitIndex.set(room, entries.length - 1);
  if (term) currentTerm = Math.max(currentTerm, term);
  if (snapshot) { roomSnapshots.set(room, snapshot); persistSnapshot(room, snapshot); }
  persistLog(room);
  console.log(`[${REPLICA_ID}] 🔄 Log reset for room "${room}": ${entries.length} entries${snapshot ? ' (with snapshot)' : ''}`);
  res.json({ ok: true, room, entries: entries.length });
});

app.listen(PORT, () => {
  console.log(`[${REPLICA_ID}] 🚀 Listening on port ${PORT} | peers: ${PEERS.length} | quorum: ${QUORUM}`);
  loadAllLogs();
  resetElectionTimer();
});