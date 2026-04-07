# RAFT Drawing Board

A distributed real-time collaborative drawing board built with Mini-RAFT consensus.

## Team
- Member 1 — RAFT Lead
- Member 2 — Replication Lead  
- Member 3 — Gateway + Frontend
- Member 4 — DevOps + Integration

## Architecture
- 1 Gateway (WebSocket server)
- 3 Replica nodes (Mini-RAFT consensus)
- 1 Frontend (HTML5 Canvas)
- Docker + docker-compose

## How to Run
Prerequisites: Docker Desktop, Node.js
```bash
git clone https://github.com/SakthiSaraniS/raft-drawing-board.git
cd raft-drawing-board
docker compose up --build
```

Open http://localhost:3000

## Testing Failover
```bash
docker compose stop replica1   # Kill leader
docker compose start replica1  # Rejoin and catch up
```

## Features
- Leader election (500-800ms timeout)
- Log replication with majority commit
- Zero-downtime hot reload
- Automatic failover
- Live diagnostics panel
- Multi-user real-time sync
