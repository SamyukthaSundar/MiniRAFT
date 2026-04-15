/**
 * index.js — Replica entry point
 *
 * OWNERSHIP: Samyuktha (Consensus Lead)
 *
 * Boot sequence:
 *  1. Start Express HTTP server
 *  2. Start election timer (as follower)
 *  3. On winning election → start heartbeat loop + notify Gateway
 *  4. Push periodic status to Gateway for passive leader discovery
 *
 * Graceful shutdown: SIGTERM / SIGINT → drain in-flight, exit cleanly
 * (nodemon sends SIGTERM on hot-reload; Docker does too on container stop)
 */
'use strict';

const http        = require('http');
const state       = require('./state');
const election    = require('./election');
const replication = require('./replication');
const { createServer } = require('./server');
const axios       = require('axios');

const PORT                  = parseInt(process.env.PORT) || 3000;
const GATEWAY_URL           = process.env.GATEWAY_URL   || '';
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS) || 150;

// ── HTTP server ───────────────────────────────────────────────────────────────
const app        = createServer();
const httpServer = http.createServer(app);

httpServer.listen(PORT, () => {
  console.log(`[${state.replicaId}] 🚀 Replica listening on :${PORT}`);
  console.log(`[${state.replicaId}] Peers: ${state.peers.join(', ') || '(none)'}`);
  console.log(`[${state.replicaId}] Gateway: ${GATEWAY_URL || '(none)'}`);
});

// ── Election timer ────────────────────────────────────────────────────────────
election.start((term) => {
  // Called when this node wins an election
  replication.startHeartbeatLoop();
});

// ── Periodic status push to Gateway (§6.2 replica:status, passive discovery) ─
const _statusInterval = setInterval(async () => {
  if (!GATEWAY_URL) return;
  try {
    await axios.post(`${GATEWAY_URL}/internal/replica-status`, state.snapshot(), {
      timeout: 300,
    });
  } catch { /* swallow — gateway may not be up yet */ }
}, HEARTBEAT_INTERVAL_MS * 2);

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`[${state.replicaId}] ${signal} — shutting down…`);
  election.stopElectionTimer();
  replication.stopHeartbeatLoop();
  clearInterval(_statusInterval);

  const timer = setTimeout(() => process.exit(1), 3000);
  timer.unref();

  httpServer.close(() => {
    console.log(`[${state.replicaId}] Shutdown complete`);
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('unhandledRejection', (r) =>
  console.error(`[${state.replicaId}] Unhandled rejection:`, r));
