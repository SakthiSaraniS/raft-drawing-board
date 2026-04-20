const express = require('express');
const fs      = require('fs');
const LOG_PATH = '/data/raft-log.json';

// ─── PERSISTENCE ───────────────────────────────────────────────
function loadLog() {
  try {
    if (fs.existsSync(LOG_PATH)) {
      const saved = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
      const all = saved.log || [];
      // Only restore committed entries — uncommitted ones may be from a diverged term
      log = all.filter(e => e.committed);
      commitIndex = log.length - 1;
      currentTerm = saved.currentTerm || 0;
      console.log(`[${REPLICA_ID}] 📂 Restored ${log.length} committed entries (discarded ${all.length - log.length} uncommitted)`);
    }
  } catch (e) {
    console.error(`[${REPLICA_ID}] ⚠️  Could not restore log:`, e.message);
  }
}

function persistLog() {
  try {
    fs.mkdirSync('/data', { recursive: true });
    fs.writeFileSync(LOG_PATH, JSON.stringify({ log, commitIndex, currentTerm }));
  } catch (e) {
    console.error(`[${REPLICA_ID}] ⚠️  Could not persist log:`, e.message);
  }
}

const axios   = require('axios');
const crypto  = require('crypto');
const app     = express();
app.use(express.json());

const REPLICA_ID = process.env.REPLICA_ID;
const PORT       = parseInt(process.env.PORT);
const PEERS      = process.env.PEERS.split(',');
const QUORUM     = parseInt(process.env.QUORUM_SIZE) || Math.floor(PEERS.length / 2) + 1;

// ─── RAFT STATE ────────────────────────────────────────────────
let state       = 'follower';
let currentTerm = 0;
let votedFor    = null;
let log         = [];
let commitIndex = -1;
let leaderId    = null;
let electionTimer = null;
const blocked   = new Set(); // peer URLs this replica won't talk to

// NOTE: No in-memory undoStack/redoStack — both are derived from the
// replicated log on demand, so undo/redo survives leader failover.

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
  console.log(`[${REPLICA_ID}] Votes received: ${votes} (quorum: ${QUORUM})`);

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

// ─── REPLICATION HELPER ────────────────────────────────────────
// Appends entry to local log, replicates to peers, commits if quorum reached.
// Returns { committed, index } — used by /stroke, /undo, /redo.
async function replicateEntry(entry) {
  const index = log.length;
  log.push({ term: currentTerm, entry, committed: false });

  let acks = 1;
  await Promise.all(
    // Bug fix: filter blocked peers so partitioned replicas don't eat
    // 400ms timeouts on every write — same filter used in heartbeats/votes
    PEERS.filter(p => !blocked.has(p)).map(peer =>
      axios.post(`${peer}/append-entries`, {
        term: currentTerm, leaderId: REPLICA_ID,
        entry, prevLogIndex: index - 1
      }, { timeout: 400 })
      .then(r => { if (r.data.success) acks++; })
      .catch(() => {})
    )
  );

  if (acks >= QUORUM) {
    log[index].committed = true;
    commitIndex = index;
    persistLog();
    console.log(`[${REPLICA_ID}] ✅ Committed entry #${index} type=${entry.type || 'stroke'} (acks: ${acks})`);
    // Commit broadcast goes to ALL peers (fire-and-forget, ok if some miss it)
    PEERS.forEach(peer =>
      axios.post(`${peer}/commit`, { index }, { timeout: 300 }).catch(() => {})
    );
    return { committed: true, index };
  } else {
    log[index].committed = false;
    console.log(`[${REPLICA_ID}] ❌ Entry failed — not enough acks (${acks}/${QUORUM})`);
    return { committed: false };
  }
}

// ─── LOG-DERIVED UNDO/REDO STATE ───────────────────────────────
// Scans the committed log to reconstruct what is currently undoable
// and redoable. Because this reads from the replicated log (not
// in-memory stacks), it works correctly after a leader failover.
function getUndoRedoState() {
  const cancelledIds = new Set();
  const recentlyCancelled = []; // ordered list of { id, stroke } for redo

  for (const entry of log) {
    if (!entry.committed) continue;

    if (entry.entry?.type === 'cancel') {
      const targetId = entry.entry.targetId;
      cancelledIds.add(targetId);
      // Find the original stroke so redo can re-apply it
      const original = log.find(
        e => e.committed && e.entry?.id === targetId && e.entry?.type !== 'cancel'
      );
      if (original) recentlyCancelled.push({ id: targetId, stroke: original.entry });

    } else if (entry.entry?.id) {
      // A new stroke (including a redo) clears it from the cancelled list
      const idx = recentlyCancelled.findIndex(r => r.id === entry.entry.id);
      if (idx !== -1) recentlyCancelled.splice(idx, 1);
      cancelledIds.delete(entry.entry.id);
    }
  }

  // Last active stroke = what undo will cancel next
  const activeStrokes = log.filter(
    e => e.committed && e.entry?.type !== 'cancel' && !cancelledIds.has(e.entry?.id)
  );
  const lastActive = activeStrokes.length > 0
    ? activeStrokes[activeStrokes.length - 1]
    : null;

  // Last entry in recentlyCancelled = what redo will restore next
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
  console.log(`[${REPLICA_ID}] Vote request from ${candidateId} term ${term}: ${grant ? 'GRANTED' : 'DENIED'}`);
  res.json({ voteGranted: grant, term: currentTerm });
});

app.post('/heartbeat', (req, res) => {
  const { term, leaderId: lid } = req.body;
  if (term >= currentTerm) {
    currentTerm = term;
    if (state !== 'follower') console.log(`[${REPLICA_ID}] Reverting to follower (term ${term})`);
    state    = 'follower';
    leaderId = lid;
    resetElectionTimer();
  }
  res.json({ success: true });
});

app.post('/append-entries', (req, res) => {
  const { term, leaderId: lid, entry, prevLogIndex } = req.body;
  if (term < currentTerm) return res.json({ success: false, reason: 'stale term' });
  currentTerm = term; state = 'follower'; leaderId = lid;
  resetElectionTimer();

  if (prevLogIndex !== undefined && prevLogIndex > log.length - 1) {
    return res.json({ success: false, logLength: log.length });
  }
  if (entry) {
    log.push({ term, entry, committed: false });
    console.log(`[${REPLICA_ID}] Appended entry #${log.length - 1} type=${entry.type || 'stroke'}`);
  }
  res.json({ success: true });
});

app.post('/commit', (req, res) => {
  const { index } = req.body;
  if (log[index]) {
    log[index].committed = true;
    commitIndex = index;
    persistLog();
    console.log(`[${REPLICA_ID}] ✅ Committed entry #${index}`);
  }
  res.json({ success: true });
});

app.get('/sync-log', (req, res) => {
  const from = parseInt(req.query.fromIndex) || 0;
  const missing = log.slice(from).filter(e => e.committed);
  console.log(`[${REPLICA_ID}] Sync-log from index ${from}: sending ${missing.length} entries`);
  res.json({ entries: missing });
});

// Emergency log reset — called by gateway after chaos heal when logs have diverged
app.post('/reset-log', (req, res) => {
  const { entries = [], term = currentTerm } = req.body;
  log = entries.map(e => ({ term: e.term || term, entry: e.entry || e, committed: true }));
  commitIndex = log.length - 1;
  currentTerm = term;
  state = 'follower';
  votedFor = null;
  persistLog();
  resetElectionTimer();
  console.log(`[${REPLICA_ID}] 🔄 Log reset to ${log.length} entries`);
  res.json({ ok: true, logLength: log.length });
});

app.get('/status', (req, res) => {
  // Re-use getUndoRedoState so active stroke count is consistent
  const { cancelledIds } = getUndoRedoState();
  const activeStrokes = log.filter(
    e => e.committed && e.entry?.type !== 'cancel' && !cancelledIds.has(e.entry?.id)
  ).length;

  res.json({
    id: REPLICA_ID, state, term: currentTerm,
    leaderId, logLength: log.length, commitIndex,
    activeStrokes, quorum: QUORUM,
    blocked: [...blocked]
  });
});

// ─── PARTITION CONTROL ─────────────────────────────────────────
app.post('/set-block', (req, res) => {
  const { peers } = req.body; // array of full URLs e.g. ["http://replica2:4002"]
  blocked.clear();
  peers.forEach(p => blocked.add(p));
  console.log(`[${REPLICA_ID}] 🚧 Blocking peers: ${peers.join(', ') || 'none'}`);
  res.json({ ok: true, blocked: [...blocked] });
});

// ─── STROKE HANDLER (leader only) ──────────────────────────────
app.post('/stroke', async (req, res) => {
  if (state !== 'leader') {
    return res.status(302).json({ redirect: leaderId });
  }
  const { stroke } = req.body;

  // Assign stable ID — needed so undo/redo can reference this stroke by ID
  stroke.id = stroke.id || crypto.randomUUID();

  // No need to manually clear a redo stack — getUndoRedoState() derives
  // redo eligibility from the log, so new strokes automatically collapse it

  const result = await replicateEntry(stroke);
  if (result.committed) {
    res.json({ success: true, committed: true, stroke });
  } else {
    res.json({ success: false, reason: 'No majority' });
  }
});

// ─── UNDO HANDLER (leader only) ────────────────────────────────
// Appends a 'cancel' compensation entry — never truncates the log.
// This preserves Raft's append-only guarantee.
app.post('/undo', async (req, res) => {
  if (state !== 'leader') {
    return res.status(302).json({ redirect: leaderId });
  }

  // Derive from log — works even after a leader failover
  const { lastActive } = getUndoRedoState();
  if (!lastActive) {
    return res.json({ committed: false, reason: 'Nothing to undo' });
  }

  const targetId = lastActive.entry.id;
  const result = await replicateEntry({ type: 'cancel', targetId });

  if (result.committed) {
    console.log(`[${REPLICA_ID}] ↩  Undo committed — cancelled stroke ${targetId}`);
    res.json({ committed: true, targetId });
  } else {
    res.json({ committed: false, reason: 'No majority for undo' });
  }
});

// ─── REDO HANDLER (leader only) ────────────────────────────────
// Re-appends the stroke with its original ID so the frontend can reconcile.
app.post('/redo', async (req, res) => {
  if (state !== 'leader') {
    return res.status(302).json({ redirect: leaderId });
  }

  // Derive from log — works even after a leader failover
  const { redoStack } = getUndoRedoState();
  const last = redoStack[redoStack.length - 1]; // most recently cancelled
  if (!last) {
    return res.json({ committed: false, reason: 'Nothing to redo' });
  }

  const result = await replicateEntry(last.stroke);
  if (result.committed) {
    console.log(`[${REPLICA_ID}] ↪  Redo committed — restored stroke ${last.id}`);
    res.json({ committed: true, stroke: last.stroke });
  } else {
    res.json({ committed: false, reason: 'No majority for redo' });
  }
});

app.listen(PORT, () => {
  console.log(`[${REPLICA_ID}] 🚀 Listening on port ${PORT} | peers: ${PEERS.length} | quorum: ${QUORUM}`);
  loadLog();
  resetElectionTimer();
});