// ─── CANVAS ────────────────────────────────────────────────────
const canvas = document.getElementById('board');
const ctx    = canvas.getContext('2d');
let drawing  = false;
let color    = '#38BDF8';
let brushSz  = 4;
let path     = [];
let strokes  = []; // all committed strokes, used for full redraw on undo

function resize() {
  const wrap = document.getElementById('canvas-wrap');
  canvas.width  = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
  redraw(); // re-render after resize so strokes aren't wiped
}
window.addEventListener('resize', resize);
resize();

function setColor(c, el) {
  color = c;
  document.querySelectorAll('.color-swatch').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
}

document.getElementById('brushSize').addEventListener('input', e => {
  brushSz = parseInt(e.target.value);
});

canvas.addEventListener('pointerdown', e => {
  drawing = true; path = [];
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', e => {
  if (!drawing) return;
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top)  / rect.height;
  path.push({ x, y });
  if (path.length >= 2) {
    drawSegment(path[path.length-2], path[path.length-1], color, brushSz);
  }
});

canvas.addEventListener('pointerup', () => {
  if (!drawing || path.length === 0) return;
  drawing = false;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'stroke',
      data: { path, color, size: brushSz }
    }));
  }
  path = [];
});

function drawSegment(p1, p2, c, s) {
  ctx.strokeStyle = c;
  ctx.lineWidth   = s;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.beginPath();
  ctx.moveTo(p1.x * canvas.width, p1.y * canvas.height);
  ctx.lineTo(p2.x * canvas.width, p2.y * canvas.height);
  ctx.stroke();
}

function drawFullStroke(stroke) {
  if (!stroke.path || stroke.path.length < 2) return;
  for (let i = 1; i < stroke.path.length; i++) {
    drawSegment(stroke.path[i-1], stroke.path[i], stroke.color, stroke.size);
  }
}

function redraw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  strokes.forEach(drawFullStroke);
}

function clearCanvas() {
  strokes = [];
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// ─── UNDO / REDO ───────────────────────────────────────────────
function sendUndo() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'undo' }));
  }
}

function sendRedo() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'redo' }));
  }
}

document.addEventListener('keydown', e => {
  if (e.ctrlKey && !e.shiftKey && e.key === 'z') { e.preventDefault(); sendUndo(); }
  if (e.ctrlKey && e.shiftKey  && e.key === 'z') { e.preventDefault(); sendRedo(); }
  if (e.ctrlKey && !e.shiftKey && e.key === 'y') { e.preventDefault(); sendRedo(); }
});

// ─── WEBSOCKET ─────────────────────────────────────────────────
let ws;
const dot   = document.getElementById('ws-dot');
const label = document.getElementById('ws-label');

function connectWS() {
  ws = new WebSocket(`ws://${location.host}`);

  ws.onopen = () => {
    dot.classList.remove('offline');
    label.textContent = 'Connected';
    addEvent('WebSocket connected', 'commit');
  };

  ws.onclose = () => {
    dot.classList.add('offline');
    label.textContent = 'Reconnecting...';
    addEvent('WebSocket lost — retrying', 'failover');
    setTimeout(connectWS, 1500);
  };

  ws.onerror = () => {
    dot.classList.add('offline');
    label.textContent = 'Error';
  };

  ws.onmessage = e => {
    try {
      const msg = JSON.parse(e.data);

      if (msg.type === 'sync') {
        // Two-pass replay matching replica's getUndoRedoState() logic:
        // Pass 1 — find net-cancelled IDs (cancel entries that were not
        //           subsequently overwritten by a redo of the same stroke)
        const cancelledIds = new Set();
        for (const entry of msg.entries) {
          if (entry.type === 'cancel') {
            cancelledIds.add(entry.targetId);
          } else if (entry.id) {
            // A stroke re-appearing (redo) removes it from cancelled set
            cancelledIds.delete(entry.id);
          }
        }
        // Pass 2 — collect visible strokes in order, skipping cancelled ones
        const syncedStrokes = [];
        for (const entry of msg.entries) {
          if (entry.type !== 'cancel' && entry.id && !cancelledIds.has(entry.id)) {
            syncedStrokes.push(entry);
          }
        }
        strokes = syncedStrokes;
        redraw();
      }

      if (msg.type === 'stroke') {
        strokes.push(msg.data);
        drawFullStroke(msg.data);
      }

      if (msg.type === 'undo') {
        // Remove the cancelled stroke by ID and redraw from scratch
        strokes = strokes.filter(s => s.id !== msg.targetId);
        redraw();
        addEvent(`↩ Undo — stroke ${(msg.targetId || '').slice(0, 8)} removed`, 'failover');
      }

      if (msg.type === 'redo') {
        // Re-add the restored stroke (already carries its original ID)
        strokes.push(msg.data);
        drawFullStroke(msg.data);
        addEvent(`↪ Redo — stroke ${(msg.data?.id || '').slice(0, 8)} restored`, 'commit');
      }

    } catch (_) {}
  };
}
connectWS();

// ─── PARTITION CONTROLS ────────────────────────────────────────
const REPLICA_NAMES = ['replica1', 'replica2', 'replica3', 'replica4'];

async function partitionReplicas(a, b) {
  if (!a || !b || a === b) return;
  if (!REPLICA_NAMES.includes(b)) {
    addEvent(`Unknown replica: ${b}`, 'failover');
    return;
  }
  try {
    await fetch('/api/partition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a, b })
    });
    addEvent(`🚧 Partitioned ${a} ↔ ${b}`, 'failover');
  } catch (_) {
    addEvent('Partition request failed', 'failover');
  }
}

async function healAll() {
  try {
    await fetch('/api/heal', { method: 'POST' });
    addEvent('✅ Network healed — all replicas reconnected', 'commit');
  } catch (_) {
    addEvent('Heal request failed', 'failover');
  }
}

function promptPartition(fromReplica) {
  if (!fromReplica || fromReplica === '—' || !REPLICA_NAMES.includes(fromReplica)) {
    addEvent('Select a valid replica to partition from', 'failover');
    return;
  }
  const peer = prompt(
    `Partition ${fromReplica} away from which replica?\n\n` +
    REPLICA_NAMES.filter(n => n !== fromReplica).join(', ')
  );
  if (peer) partitionReplicas(fromReplica, peer.trim());
}

function promptPartitionFull() {
  const a = prompt('Partition which replica?\n\nreplica1, replica2, replica3, replica4');
  if (!a || !REPLICA_NAMES.includes(a.trim())) {
    addEvent('Invalid replica name', 'failover');
    return;
  }
  const b = prompt(
    `Partition ${a.trim()} away from which replica?\n\n` +
    REPLICA_NAMES.filter(n => n !== a.trim()).join(', ')
  );
  if (b && REPLICA_NAMES.includes(b.trim())) {
    partitionReplicas(a.trim(), b.trim());
  }
}

// ─── DIAGNOSTICS PANEL ─────────────────────────────────────────
let diagOpen = false;
let lastLeader = null;
let lastTermSeen = null;

function toggleDiag() {
  diagOpen = !diagOpen;
  document.getElementById('diag-panel').classList.toggle('open', diagOpen);
  document.getElementById('diag-toggle').textContent =
    diagOpen ? '✕ Hide Status' : '⚙ Backend Status';
}

function addEvent(text, type = '') {
  const log = document.getElementById('event-log');
  const now  = new Date().toLocaleTimeString();
  const div  = document.createElement('div');
  div.className = `event ${type}`;
  div.textContent = `[${now}] ${text}`;
  log.prepend(div);
  while (log.children.length > 40) log.removeChild(log.lastChild);
}

// ─── DASHBOARD POLL ────────────────────────────────────────────
async function pollStatus() {
  try {
    const r    = await fetch('/api/cluster-status');
    const data = await r.json();

    // ── cluster summary bar ────────────────────────────────────
    const leaderShort = data.leaderShort
      ?? (data.leader ? data.leader.replace('http://','').split(':')[0] : null);

    document.getElementById('gw-stats').innerHTML =
      `Leader: <strong style="color:#38BDF8">${leaderShort ?? 'None'}</strong>` +
      ` &nbsp;|&nbsp; Term: <strong style="color:#a78bfa">${data.term ?? '—'}</strong>` +
      ` &nbsp;|&nbsp; Clients: <strong>${data.clients ?? '?'}</strong>` +
      (data.partitioned?.length
        ? `<br><span style="color:#f87171">⚠ Partitioned: ${data.partitioned.join('  |  ')}</span>`
        : '');

    // ── leader change event ────────────────────────────────────
    if (data.leader !== lastLeader) {
      if (lastLeader !== null) {
        addEvent(`👑 Failover → new leader: ${leaderShort ?? 'none'}`, 'failover');
      }
      lastLeader = data.leader;
    }

    // ── term bump event (election happened) ───────────────────
    if (data.term != null && data.term !== lastTermSeen) {
      if (lastTermSeen !== null) {
        addEvent(`🗳 Election — term bumped to ${data.term}`, 'election');
      }
      lastTermSeen = data.term;
    }

    // ── replica cards ──────────────────────────────────────────
    const list   = document.getElementById('replica-list');
    const maxLog = Math.max(...(data.replicas || []).map(r => r.logLength || 0), 1);

    list.innerHTML = '';
    (data.replicas || []).forEach(r => {
      const pct      = Math.round((r.logLength || 0) / maxLog * 100);
      const shortId  = (r.id || '').replace('http://','').split(':')[0] || r.id;
      const isBlocked = r.blocked?.length > 0;
      const card     = document.createElement('div');

      card.className = `replica-card ${r.state || 'unreachable'}`;
      card.innerHTML = `
        <div class="card-title">
          <span class="replica-name">${shortId}</span>
          <span class="badge badge-${r.state || 'unreachable'}">
            ${(r.state || 'unreachable').toUpperCase()}
          </span>
          ${isBlocked ? '<span class="badge badge-partition">ISOLATED</span>' : ''}
        </div>
        <div class="card-stats">
          Term: <strong>${r.term ?? '—'}</strong>
          &nbsp;|&nbsp;
          Log: <strong>${r.logLength ?? 0}</strong> entries
          &nbsp;|&nbsp;
          Committed: <strong>${r.commitIndex ?? -1}</strong>
          &nbsp;|&nbsp;
          Active strokes: <strong>${r.activeStrokes ?? '—'}</strong>
          ${r.quorum   ? `<br>Quorum: <strong>${r.quorum}</strong>` : ''}
          ${r.leaderId ? `<br>Follows: <strong>${r.leaderId}</strong>` : ''}
          ${isBlocked  ? `<br><span style="color:#f87171">Blocking: ${r.blocked.join(', ')}</span>` : ''}
        </div>
        <div class="log-track" title="Log fill relative to busiest replica">
          <div class="log-fill" style="width:${pct}%"></div>
        </div>
        <div class="card-actions">
          <button onclick="promptPartition('${shortId}')">Split from peer</button>
          <button onclick="healAll()">Heal all</button>
          <button onclick="sendUndo()">↩ Undo</button>
          <button onclick="sendRedo()">↪ Redo</button>
        </div>`;

      list.appendChild(card);

      // election in progress
      if (r.state === 'candidate') {
        addEvent(`${shortId} started election (term ${r.term})`, 'election');
      }
    });

  } catch (_) {}
}

setInterval(pollStatus, 1500);
pollStatus();