// ─── CANVAS ────────────────────────────────────────────────────
const canvas = document.getElementById('board');
const ctx    = canvas.getContext('2d');
let drawing  = false;
let color    = '#38BDF8';
let brushSz  = 4;
let path     = [];

function resize() {
  const wrap = document.getElementById('canvas-wrap');
  canvas.width  = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
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

function clearCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

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
      if (msg.type === 'stroke') {
        drawFullStroke(msg.data);
      }
    } catch (_) {}
  };
}
connectWS();

// ─── DIAGNOSTICS PANEL ─────────────────────────────────────────
let diagOpen = false;
let lastLeader = null;

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

async function pollStatus() {
  try {
    const r    = await fetch('/api/cluster-status');
    const data = await r.json();

    // Gateway stats
    document.getElementById('gw-stats').innerHTML =
      `Leader: <strong style="color:#38BDF8">${data.leader ? data.leader.replace('http://','') : 'None'}</strong><br>` +
      `Connected clients: ${data.clients ?? '?'}`;

    // Detect leader change
    if (data.leader !== lastLeader) {
      if (lastLeader !== null) {
        addEvent(`Failover! New leader: ${(data.leader||'none').replace('http://','').split(':')[0]}`, 'failover');
      }
      lastLeader = data.leader;
    }

    // Replica cards
    const list = document.getElementById('replica-list');
    const maxLog = Math.max(...(data.replicas||[]).map(r => r.logLength||0), 1);

    list.innerHTML = '';
    (data.replicas || []).forEach(r => {
      const pct  = Math.round((r.logLength||0) / maxLog * 100);
      const card = document.createElement('div');
      card.className = `replica-card ${r.state || 'unreachable'}`;
      const shortId = (r.id||r.id||'').replace('http://','').split(':')[0];
      card.innerHTML = `
        <div class="card-title">
          <span class="replica-name">${r.id || shortId}</span>
          <span class="badge badge-${r.state||'unreachable'}">${(r.state||'unreachable').toUpperCase()}</span>
        </div>
        <div class="card-stats">
          Term: <strong>${r.term ?? '—'}</strong> &nbsp;|&nbsp;
          Log: <strong>${r.logLength ?? 0}</strong> entries &nbsp;|&nbsp;
          Committed: <strong>${r.commitIndex ?? -1}</strong>
          ${r.leaderId ? `<br>Leader ID: ${r.leaderId}` : ''}
        </div>
        <div class="log-track">
          <div class="log-fill" style="width:${pct}%"></div>
        </div>`;
      list.appendChild(card);

      // Detect election events from state changes
      if (r.state === 'candidate') addEvent(`${r.id} started election (term ${r.term})`, 'election');
    });

  } catch (_) {}
}

setInterval(pollStatus, 1500);
pollStatus();