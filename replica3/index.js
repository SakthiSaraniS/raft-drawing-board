const express = require('express');
const axios   = require('axios');
const app     = express();
app.use(express.json());

const REPLICA_ID = process.env.REPLICA_ID;
const PORT       = parseInt(process.env.PORT);
const PEERS      = process.env.PEERS.split(',');

// ─── RAFT STATE ────────────────────────────────────────────────
let state       = 'follower';
let currentTerm = 0;
let votedFor    = null;
let log         = [];
let commitIndex = -1;
let leaderId    = null;
let electionTimer = null;

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
    PEERS.map(peer =>
      axios.post(`${peer}/request-vote`,
        { term: currentTerm, candidateId: REPLICA_ID },
        { timeout: 400 }
      ).catch(() => ({ data: { voteGranted: false } }))
    )
  );

  results.forEach(r => { if (r.data.voteGranted) votes++; });
  console.log(`[${REPLICA_ID}] Votes received: ${votes}`);

  if (votes >= 2 && state === 'candidate') {
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
  PEERS.forEach(peer =>
    axios.post(`${peer}/heartbeat`,
      { term: currentTerm, leaderId: REPLICA_ID },
      { timeout: 300 }
    ).catch(() => {})
  );
  setTimeout(sendHeartbeats, 150);
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
    console.log(`[${REPLICA_ID}] Appended entry #${log.length - 1}`);
  }
  res.json({ success: true });
});

app.post('/commit', (req, res) => {
  const { index } = req.body;
  if (log[index]) {
    log[index].committed = true;
    commitIndex = index;
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

app.get('/status', (req, res) => {
  res.json({
    id: REPLICA_ID, state, term: currentTerm,
    leaderId, logLength: log.length, commitIndex
  });
});

// ─── STROKE HANDLER (leader only) ──────────────────────────────
app.post('/stroke', async (req, res) => {
  if (state !== 'leader') {
    return res.status(302).json({ redirect: leaderId });
  }
  const { stroke } = req.body;
  const index = log.length;
  log.push({ term: currentTerm, entry: stroke, committed: false });

  let acks = 1;
  await Promise.all(
    PEERS.map(peer =>
      axios.post(`${peer}/append-entries`, {
        term: currentTerm, leaderId: REPLICA_ID,
        entry: stroke, prevLogIndex: index - 1
      }, { timeout: 400 })
      .then(r => { if (r.data.success) acks++; })
      .catch(() => {})
    )
  );

  if (acks >= 2) {
    log[index].committed = true;
    commitIndex = index;
    console.log(`[${REPLICA_ID}] ✅ Stroke committed at index ${index} (acks: ${acks})`);
    PEERS.forEach(peer =>
      axios.post(`${peer}/commit`, { index }, { timeout: 300 }).catch(() => {})
    );
    res.json({ success: true, committed: true, stroke });
  } else {
    log[index].committed = false;
    console.log(`[${REPLICA_ID}] ❌ Stroke failed — not enough acks (${acks})`);
    res.json({ success: false, reason: 'No majority' });
  }
});

app.listen(PORT, () => {
  console.log(`[${REPLICA_ID}] 🚀 Listening on port ${PORT}`);
  resetElectionTimer();
});