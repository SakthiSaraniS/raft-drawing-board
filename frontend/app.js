// ─── ROOM STATE ────────────────────────────────────────────────
// currentRoom is set from the URL hash: /#design-sprint
// If no hash is present, we fall back to 'default'.
let currentRoom = (location.hash.slice(1) || 'default').toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'default';

function setRoomFromHash() {
  const raw = location.hash.slice(1) || 'default';
  return raw.toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'default';
}

// ─── CANVAS ────────────────────────────────────────────────────
const canvas = document.getElementById('board');
const ctx    = canvas.getContext('2d');
let drawing  = false;
let color    = '#38BDF8';
let brushSz  = 4;
let path     = [];
let strokes  = []; // all committed strokes for current room

// ─── CURSOR PRESENCE (ephemeral, gossip channel) ────────────────
// remoteCursors: Map<clientId, { name, color, x, y, lastSeen }>
// These are NOT stored in the Raft log — they live only in-memory.
const remoteCursors = new Map();
let myClientId  = null; // assigned by the server on connect
let myPresenceColor = '#38BDF8';
let myPresenceName  = 'Me';

// Cursor overlay canvas sits on top of the drawing canvas
const cursorCanvas = document.getElementById('cursor-overlay');
const cursorCtx    = cursorCanvas ? cursorCanvas.getContext('2d') : null;

// Throttle cursor sends: one update per ~30ms (~33 fps)
let lastCursorSend = 0;
const CURSOR_THROTTLE_MS = 30;

// Stale cursor cleanup: remove cursors we haven't heard from in 5s
setInterval(() => {
  const now = Date.now();
  let changed = false;
  remoteCursors.forEach((cur, id) => {
    if (now - cur.lastSeen > 5000) {
      remoteCursors.delete(id);
      changed = true;
    }
  });
  if (changed) drawCursors();
}, 1000);

function resize() {
  const wrap = document.getElementById('canvas-wrap');
  canvas.width  = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
  if (cursorCanvas) {
    cursorCanvas.width  = wrap.clientWidth;
    cursorCanvas.height = wrap.clientHeight;
  }
  redraw();
  drawCursors();
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

// ─── CURSOR RENDERING ──────────────────────────────────────────
function drawCursors() {
  if (!cursorCtx || !cursorCanvas) return;
  cursorCtx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);

  remoteCursors.forEach(cur => {
    const px = cur.x * cursorCanvas.width;
    const py = cur.y * cursorCanvas.height;

    // Arrow pointer
    cursorCtx.save();
    cursorCtx.translate(px, py);

    // Shadow for contrast
    cursorCtx.shadowColor = 'rgba(0,0,0,0.4)';
    cursorCtx.shadowBlur  = 4;

    // Draw arrow
    cursorCtx.beginPath();
    cursorCtx.moveTo(0, 0);
    cursorCtx.lineTo(0, 16);
    cursorCtx.lineTo(4, 12);
    cursorCtx.lineTo(8, 20);
    cursorCtx.lineTo(10, 19);
    cursorCtx.lineTo(6, 11);
    cursorCtx.lineTo(11, 11);
    cursorCtx.closePath();
    cursorCtx.fillStyle   = cur.color;
    cursorCtx.strokeStyle = '#fff';
    cursorCtx.lineWidth   = 1.5;
    cursorCtx.fill();
    cursorCtx.stroke();
    cursorCtx.shadowBlur  = 0;

    // Name label
    const label = cur.name;
    const pad   = 5;
    cursorCtx.font         = 'bold 11px system-ui, sans-serif';
    const tw = cursorCtx.measureText(label).width;
    const lx = 13;
    const ly = 3;
    const lw = tw + pad * 2;
    const lh = 18;
    const r  = 4;

    // Pill background
    cursorCtx.beginPath();
    cursorCtx.moveTo(lx + r, ly);
    cursorCtx.lineTo(lx + lw - r, ly);
    cursorCtx.quadraticCurveTo(lx + lw, ly, lx + lw, ly + r);
    cursorCtx.lineTo(lx + lw, ly + lh - r);
    cursorCtx.quadraticCurveTo(lx + lw, ly + lh, lx + lw - r, ly + lh);
    cursorCtx.lineTo(lx + r, ly + lh);
    cursorCtx.quadraticCurveTo(lx, ly + lh, lx, ly + lh - r);
    cursorCtx.lineTo(lx, ly + r);
    cursorCtx.quadraticCurveTo(lx, ly, lx + r, ly);
    cursorCtx.closePath();
    cursorCtx.fillStyle = cur.color;
    cursorCtx.fill();

    // Label text
    cursorCtx.fillStyle    = '#fff';
    cursorCtx.textBaseline = 'middle';
    cursorCtx.fillText(label, lx + pad, ly + lh / 2);

    cursorCtx.restore();
  });
}

// ─── CURSOR SEND (throttled, gossip — bypasses Raft) ───────────
function sendCursorPosition(x, y) {
  const now = Date.now();
  if (now - lastCursorSend < CURSOR_THROTTLE_MS) return;
  lastCursorSend = now;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'cursor', x, y }));
  }
}

canvas.addEventListener('pointerdown', e => {
  drawing = true; path = [];
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', e => {
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top)  / rect.height;

  // Always broadcast cursor position (even when not drawing)
  sendCursorPosition(x, y);

  if (!drawing) return;
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
      room: currentRoom,
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
  // Send a clear command through the Raft log so all clients in the room
  // see the clear — including new joiners who replay the log on connect.
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'clear', room: currentRoom }));
  } else {
    // Fallback: local-only clear if WS is down
    strokes = [];
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

// ─── UNDO / REDO ───────────────────────────────────────────────
function sendUndo() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'undo', room: currentRoom }));
  }
}

function sendRedo() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'redo', room: currentRoom }));
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
  // Pass the current room as a query param so the gateway
  // immediately syncs this room's log on connection.
  const wsUrl = `ws://${location.host}/?room=${encodeURIComponent(currentRoom)}`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    dot.classList.remove('offline');
    label.textContent = `Connected · #${currentRoom}`;
    addEvent(`WebSocket connected (room: ${currentRoom})`, 'commit');
    updateRoomBadge();
  };

  ws.onclose = () => {
    dot.classList.add('offline');
    label.textContent = 'Reconnecting...';
    addEvent('WebSocket lost — retrying', 'failover');
    // Wipe remote cursors — they'll be re-established on reconnect
    remoteCursors.clear();
    drawCursors();
    setTimeout(connectWS, 1500);
  };

  ws.onerror = () => {
    dot.classList.add('offline');
    label.textContent = 'Error';
  };

  ws.onmessage = e => {
    try {
      const msg = JSON.parse(e.data);

      // Only process messages for the current room
      // (server also filters, but guard here for safety)
      // NOTE: 'room-joined' and 'sync' must NEVER be filtered — they are
      // the messages that establish the new room context itself.
      const roomScopedTypes = ['stroke', 'undo', 'redo', 'clear'];
      if (roomScopedTypes.includes(msg.type) &&
          msg.room && msg.room !== currentRoom) {
        return;
      }

      // ── self-identity (server tells us our clientId/color/name) ─
      if (msg.type === 'self-identity') {
        myClientId       = msg.clientId;
        myPresenceColor  = msg.color;
        myPresenceName   = msg.name;
        // Show our own identity in the status bar
        const selfEl = document.getElementById('presence-self');
        if (selfEl) {
          selfEl.textContent = msg.name;
          selfEl.style.color = msg.color;
        }
      }

      // ── presence-snapshot (all cursors already in room) ──────
      if (msg.type === 'presence-snapshot') {
        (msg.cursors || []).forEach(c => {
          if (!remoteCursors.has(c.clientId)) {
            remoteCursors.set(c.clientId, {
              name: c.name, color: c.color,
              x: -1, y: -1, lastSeen: Date.now()
            });
          }
        });
        drawCursors();
      }

      // ── cursor-join (a new peer appeared in our room) ────────
      if (msg.type === 'cursor-join') {
        remoteCursors.set(msg.clientId, {
          name: msg.name, color: msg.color,
          x: -1, y: -1, lastSeen: Date.now()
        });
        addEvent(`🖱 ${msg.name} joined the room`, 'commit');
        drawCursors();
      }

      // ── cursor (live position update — presence gossip) ──────
      if (msg.type === 'cursor') {
        const existing = remoteCursors.get(msg.clientId);
        if (existing) {
          existing.x        = msg.x;
          existing.y        = msg.y;
          existing.lastSeen = Date.now();
        } else {
          // Saw a cursor before its join message — create entry
          remoteCursors.set(msg.clientId, {
            name: msg.name || msg.clientId,
            color: msg.color || '#fff',
            x: msg.x, y: msg.y, lastSeen: Date.now()
          });
        }
        drawCursors();
      }

      // ── cursor-leave (peer disconnected or switched room) ────
      if (msg.type === 'cursor-leave') {
        const cur = remoteCursors.get(msg.clientId);
        if (cur) {
          addEvent(`🖱 ${cur.name} left the room`, 'failover');
          remoteCursors.delete(msg.clientId);
          drawCursors();
        }
      }

      // ── sync (initial canvas state on connect) ─────────────
      if (msg.type === 'sync') {
        const cancelledIds = new Set();
        let syncedStrokes = [];
        for (const entry of msg.entries) {
          if (entry.type === 'clear') {
            // Clear wipes everything committed before it
            syncedStrokes = [];
            cancelledIds.clear();
          } else if (entry.type === 'cancel') {
            cancelledIds.add(entry.targetId);
          } else if (entry.id && !cancelledIds.has(entry.id)) {
            syncedStrokes.push(entry);
          }
        }
        strokes = syncedStrokes;
        redraw();
        addEvent(`Synced ${syncedStrokes.length} strokes for room "${msg.room || currentRoom}"`, 'commit');
      }

      // ── room-joined (after a join-room message) ─────────────
      if (msg.type === 'room-joined') {
        currentRoom = msg.room;
        updateRoomBadge();
        label.textContent = `Connected · #${currentRoom}`;

        const cancelledIds = new Set();
        let syncedStrokes = [];
        for (const entry of msg.entries) {
          if (entry.type === 'clear') {
            syncedStrokes = [];
            cancelledIds.clear();
          } else if (entry.type === 'cancel') {
            cancelledIds.add(entry.targetId);
          } else if (entry.id && !cancelledIds.has(entry.id)) {
            syncedStrokes.push(entry);
          }
        }
        strokes = syncedStrokes;
        redraw();
        addEvent(`Joined room "${currentRoom}" — ${syncedStrokes.length} strokes`, 'commit');
        refreshRoomList();
      }

      // ── stroke ─────────────────────────────────────────────
      if (msg.type === 'stroke') {
        strokes.push(msg.data);
        drawFullStroke(msg.data);
      }

      // ── undo ───────────────────────────────────────────────
      if (msg.type === 'undo') {
        strokes = strokes.filter(s => s.id !== msg.targetId);
        redraw();
        addEvent(`↩ Undo — stroke ${(msg.targetId || '').slice(0, 8)} removed`, 'failover');
      }

      // ── redo ───────────────────────────────────────────────
      if (msg.type === 'redo') {
        strokes.push(msg.data);
        drawFullStroke(msg.data);
        addEvent(`↪ Redo — stroke ${(msg.data?.id || '').slice(0, 8)} restored`, 'commit');
      }

      // ── clear ──────────────────────────────────────────────
      if (msg.type === 'clear') {
        strokes = [];
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        addEvent('🗑 Canvas cleared', 'failover');
      }

      // ── cluster events (not room-scoped) ───────────────────
      if (msg.type === 'leaderIsolated') {
        addEvent(`🔴 Leader isolated: ${msg.leader}`, 'failover');
      }

      if (msg.type === 'clusterChanged') {
        addEvent(`🔵🟢 Cluster ${msg.event}: ${msg.replica} (size: ${msg.size})`, 'bluegreen');
      }

    } catch (_) {}
  };
}
connectWS();

// ─── ROOM SWITCHER ─────────────────────────────────────────────

function updateRoomBadge() {
  const badge = document.getElementById('room-badge');
  if (badge) badge.textContent = `# ${currentRoom}`;
  document.title = `RAFT Board · #${currentRoom}`;
  location.hash = currentRoom === 'default' ? '' : currentRoom;
}

// Switch to a different room (mid-connection, no WS reconnect needed)
function switchRoom(roomId) {
  if (!roomId || roomId === currentRoom) return;
  const clean = roomId.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 32) || 'default';
  if (clean === currentRoom) return;

  // Update currentRoom IMMEDIATELY so:
  // (a) the badge shows the new room right away
  // (b) incoming stroke/undo/redo for the new room aren't filtered out
  // (c) outgoing stroke messages carry the correct room
  currentRoom = clean;
  updateRoomBadge();

  if (ws && ws.readyState === WebSocket.OPEN) {
    // Clear canvas immediately for responsive UX
    strokes = [];
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Clear remote cursors — they belong to the old room
    remoteCursors.clear();
    drawCursors();
    addEvent(`Switching to room "${clean}"...`, 'commit');
    ws.send(JSON.stringify({ type: 'join-room', room: clean }));
  } else {
    // If WS is down, reconnect with the new room
    connectWS();
  }
  window.closeRoomModal();
}

// Create a new room and immediately switch to it
async function createAndSwitchRoom(roomId) {
  const clean = (roomId || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 32);
  if (!clean) return;
  try {
    await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: clean })
    });
    switchRoom(clean);
  } catch (e) {
    addEvent(`Failed to create room: ${e.message}`, 'failover');
  }
}

// ─── ROOM MODAL ────────────────────────────────────────────────

// Expose to window so onclick= attributes in HTML can reach these functions
window.openRoomModal = function() {
  document.getElementById('room-modal').classList.add('active');
  refreshRoomList();
  setTimeout(() => document.getElementById('room-input').focus(), 50);
};

window.closeRoomModal = function() {
  document.getElementById('room-modal').classList.remove('active');
};

window.handleRoomCreate = function() {
  var input = document.getElementById('room-input');
  var val = (input ? input.value : '').trim();
  if (val) {
    createAndSwitchRoom(val);
    if (input) input.value = '';
  }
};

async function refreshRoomList() {
  try {
    const r    = await fetch('/api/rooms');
    const data = await r.json();
    const list = document.getElementById('room-list');
    list.innerHTML = '';
    (data.rooms || []).forEach(room => {
      const isActive = room.id === currentRoom;
      const div = document.createElement('div');
      div.className = `room-item${isActive ? ' active' : ''}`;
      div.innerHTML = `
        <span class="room-item-name"># ${room.id}</span>
        <span class="room-item-clients">${room.clients} online</span>
      `;
      if (!isActive) {
        div.onclick = () => switchRoom(room.id);
      }
      list.appendChild(div);
    });
  } catch (_) {}
}

// Wire room input + button after DOM is fully ready
document.addEventListener('DOMContentLoaded', function() {
  var input = document.getElementById('room-input');
  var btn   = document.getElementById('room-create-btn');
  var modal = document.getElementById('room-modal');

  function doCreate() {
    var val = (input ? input.value : '').trim();
    if (val) {
      createAndSwitchRoom(val);
      if (input) input.value = '';
    }
  }

  if (input) {
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') doCreate();
    });
  }

  if (btn) {
    btn.addEventListener('click', doCreate);
  }

  if (modal) {
    modal.addEventListener('click', function(e) {
      if (e.target === modal) window.closeRoomModal();
    });
  }
});

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

    const leaderShort = data.leaderShort
      ?? (data.leader ? data.leader.replace('http://','').split(':')[0] : null);

    // Update dashboard bar
    const barLeader   = document.getElementById('bar-leader');
    const barTerm     = document.getElementById('bar-term');
    const barClients  = document.getElementById('bar-clients');
    const barReplicas = document.getElementById('bar-replicas');
    if (barLeader)   barLeader.textContent   = leaderShort ?? '—';
    if (barTerm)     barTerm.textContent     = data.term   ?? '—';
    if (barClients)  barClients.textContent  = data.clients ?? '?';
    const barPresence = document.getElementById('bar-presence');
    if (barPresence) barPresence.textContent = remoteCursors.size;
    if (barReplicas) barReplicas.textContent = `${data.registeredReplicas?.length ?? '?'} nodes`;

    const partWrap = document.getElementById('bar-partition-wrap');
    const partVal  = document.getElementById('bar-partition');
    if (data.partitioned?.length) {
      if (partWrap) partWrap.style.display = '';
      if (partVal)  partVal.textContent = `⚠ Partitioned: ${data.partitioned.join('  |  ')}`;
    } else {
      if (partWrap) partWrap.style.display = 'none';
    }

    // ── room status in diag panel ──────────────────────────────
    const roomsEl = document.getElementById('rooms-summary');
    if (roomsEl && data.rooms) {
      roomsEl.innerHTML = data.rooms.map(rm =>
        `<span class="room-stat${rm.id === currentRoom ? ' room-stat-active' : ''}">
          #${rm.id} <strong>${rm.clients}</strong>
        </span>`
      ).join('');
    }

    // ── diag panel ─────────────────────────────────────────────
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

    // ── term bump event ───────────────────────────────────────
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
          ${r.rooms?.length ? `<br><span style="color:#a78bfa;font-size:0.75rem">Rooms: ${r.rooms.map(rm => `#${rm.id}(${rm.logLength})`).join(' ')}</span>` : ''}
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

      if (r.state === 'candidate') {
        addEvent(`${shortId} started election (term ${r.term})`, 'election');
      }
    });

  } catch (_) {}
}

setInterval(pollStatus, 1500);
pollStatus();

// Refresh room list periodically when modal is open
setInterval(() => {
  if (document.getElementById('room-modal')?.classList.contains('active')) {
    refreshRoomList();
  }
}, 3000);

// Initialize room badge on load
updateRoomBadge();