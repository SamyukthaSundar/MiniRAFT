# MiniRaft — Distributed Drawing Board

A real-time collaborative drawing board powered by the **Raft consensus algorithm**. Multiple users can draw simultaneously while strokes are replicated across a 3-node Raft cluster for fault tolerance.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Browser                            │
│            (WebSocket on port 4000)                     │
└──────────────────────┬──────────────────────────────────┘
                       │
              ┌────────▼────────┐
              │     Gateway      │
              │   (Node.js)      │
              │  Port 4000 (WS)  │
              │  Port 4001 (RPC) │
              └────────┬────────┘
                       │
        ┌──────────────┼──────────────┐
        │              │              │
   ┌────▼────┐   ┌────▼────┐   ┌────▼────┐
   │Replica 1│   │Replica 2│   │Replica 3│
   │ (Raft)  │   │ (Raft)  │   │ (Raft)  │
   │ Port 3001│  │ Port 3002│  │ Port 3003│
   └─────────┘   └─────────┘   └─────────┘
```

### Components

| Component | Directory | Description |
|-----------|-----------|-------------|
| **Frontend** | `frontend/` | Single-page HTML/CSS/JS drawing board |
| **Gateway** | `gateway/` | Express + WebSocket server; routes strokes to Raft leader |
| **Replica Logic** | `replica-logic/` | Raft consensus implementation (election, replication, state) |

### How It Works

1. **Gateway** accepts WebSocket connections from browsers and tracks the current Raft leader
2. When a user draws, the stroke is sent to the **leader replica** via the gateway
3. The leader replicates the stroke to followers via Raft log replication
4. Once a majority acknowledges, the stroke is **committed** and broadcast to all connected clients
5. If the leader goes down, the remaining replicas hold an **election** (<1s) and a new leader takes over
6. Drawing is briefly paused during elections and resumes automatically

### Raft Internals

- **Election**: Randomized timeouts (500–800ms) prevent split votes
- **Heartbeat**: Leader sends AppendEntries every 150ms
- **Log Replication**: Strokes are entries in the Raft log; committed entries are applied to the canvas state
- **Persistence**: Each replica saves its state to a JSON file for crash recovery

## Prerequisites

- **Docker** (v20.10+) and **Docker Compose** (v2+, bundled with Docker Desktop)
- No Node.js installation needed — everything runs in containers

## Setup & Running

### Ubuntu (22.04+)

```bash
# 1. Install Docker
sudo apt update
sudo apt install -y ca-certificates curl gnupg lsb-release
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# 2. Add your user to the docker group (one-time only)
sudo usermod -aG docker $USER
newgrp docker

# 3. Start the project
cd Miniraft-main
docker compose up --build
```

### WSL (Windows Subsystem for Linux)

```bash
# Option A: Install Docker Desktop on Windows (recommended)
#   1. Download from https://www.docker.com/products/docker-desktop/
#   2. Enable WSL integration: Settings > Resources > WSL Integration > toggle your distro
#   3. Docker is available automatically in WSL — no extra install needed

# Option B: Install Docker inside WSL (Ubuntu distro)
sudo apt update
sudo apt install -y ca-certificates curl gnupg lsb-release
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Start the Docker daemon (WSL doesn't start it automatically)
sudo service docker start

# Add your user to the docker group (one-time only)
sudo usermod -aG docker $USER
newgrp docker

# Start the project
cd Miniraft-main
docker compose up --build
```

### macOS

```bash
# Install Docker Desktop from https://www.docker.com/products/docker-desktop/
# Then:
cd Miniraft-main
docker compose up --build
```

## Usage

Once running, open **http://localhost:4000** in your browser.

| Action | What happens |
|--------|-------------|
| Draw on canvas | Stroke is sent to the Raft leader, replicated, then committed |
| Leader fails | Automatic election — drawing pauses for <1s then resumes |
| Clear canvas | Clears local canvas (does not clear replicated state) |

The right sidebar shows live cluster state — node roles, term numbers, and commit indices. The event log tracks leader changes, stroke commits, and errors.

## Common Commands

```bash
# Start (foreground, logs visible)
docker compose up --build

# Start in background
docker compose up --build -d

# View logs
docker compose logs -f

# Stop
docker compose down

# Rebuild after code changes
docker compose up --build

# Quick start using the run script
./run.sh
```

## Ports

| Port | Service |
|------|---------|
| 4000 | Gateway (WebSocket + HTTP for browser) |
| 4001 | Gateway internal (replica communication) |
| 3001 | Replica 1 |
| 3002 | Replica 2 |
| 3003 | Replica 3 |

## Troubleshooting

### `permission denied while trying to connect to the Docker API`

Your user isn't in the docker group. Run:
```bash
sudo usermod -aG docker $USER
newgrp docker
```
Or log out and log back in. If using WSL without Docker Desktop, also make sure the daemon is running:
```bash
sudo service docker start
```

### `Cannot GET /` in the browser

The frontend volume mount isn't working. Make sure `docker-compose.yml` has the volume line under the gateway service:
```yaml
volumes:
  - ./frontend:/app/src/public:ro
```

### `version` attribute is obsolete warning in docker compose

This is a harmless warning. You can remove the `version: "3.9"` line from `docker-compose.yml` if it bothers you.

### WSL: Docker daemon not starting

If you installed Docker inside WSL (not Docker Desktop), the daemon doesn't auto-start. Run:
```bash
sudo service docker start
```
To make it start automatically, add to your `~/.bashrc`:
```bash
if ! service docker status > /dev/null 2>&1; then
  sudo service docker start > /dev/null 2>&1
fi
```

## Tech Stack

- **Frontend**: Vanilla HTML/CSS/JS, WebSocket API
- **Gateway**: Node.js, Express, `ws` library
- **Replica Logic**: Node.js, Express, custom Raft implementation
- **Containerization**: Docker, Docker Compose
