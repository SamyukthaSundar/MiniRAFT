/**
 * index.js — Gateway entry point
 * OWNERSHIP: Sanika (Gateway Lead)
 */
'use strict';

const http       = require('http');
const express    = require('express');
const path       = require('path');
const { GATEWAY_PORT, INTERNAL_PORT } = require('./config');
const { createClientWsServer }        = require('./clientWsServer');
const { createInternalServer }        = require('./internalServer');
const leaderTracker = require('./leaderTracker');

// ── Public server (browser WebSocket + HTTP) ──────────────────────────────────
const publicApp = express();
publicApp.get('/healthz', (_req, res) => res.json({ ok: true, service: 'gateway-public' }));

// 1. Tell Express where the static assets live (matching the Docker volume)
const frontendPath = path.join(__dirname, 'public'); 
publicApp.use(express.static(frontendPath));

// 2. Catch-all route to serve the drawing board
publicApp.get('*', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'), (err) => {
    if (err) {
      console.error("[Gateway] UI ERROR:", err);
      res.status(500).send(`<h2>Container Error</h2><p>Failed to load index.html from ${frontendPath}.</p>`);
    }
  });
});

const publicHttpServer = http.createServer(publicApp);
createClientWsServer(publicHttpServer);
publicHttpServer.listen(GATEWAY_PORT, () => {
  console.log(`[Gateway] Public server listening on :${GATEWAY_PORT}`);
});

// ── Internal server (Replicas push state here) ──────────────────────────────
const internalApp = createInternalServer();

// Docker healthcheck needs this route on 4001
if (typeof internalApp.get === 'function') {
  internalApp.get('/healthz', (_req, res) => res.json({ ok: true, service: 'gateway-internal' }));
}

internalApp.listen(INTERNAL_PORT, () => {
  console.log(`[Gateway] Internal server listening on :${INTERNAL_PORT}`);
});