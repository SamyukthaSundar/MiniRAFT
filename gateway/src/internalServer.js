/**
 * internalServer.js — Internal HTTP server for replica → Gateway pushes
 *
 * OWNERSHIP: Sanika (Gateway Lead)
 *
 * ENDPOINT NAME FIX:
 *   Replicas call POST /internal/leader-announce and POST /internal/stroke-committed
 *   (hyphens, not colons). Sanika's original used URL paths with colons
 *   (/internal/leader:announce) which requires express path escaping and breaks
 *   some HTTP clients. Unified to hyphenated paths matching SYSTEM_CONTRACT §6.2.
 *
 * WebSocket EVENT NAME FIX:
 *   clientManager.broadcast is called with 'stroke:commit' (§6.1),
 *   NOT 'stroke:committed'. 'stroke:committed' is the replica→gateway internal
 *   event name (§6.2); the client-facing broadcast is 'stroke:commit'.
 */
'use strict';

const express       = require('express');
const leaderTracker = require('./leaderTracker');
const clientManager = require('./clientManager');

function createInternalServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // ── POST /internal/leader-announce (§6.2) ─────────────────────────────────
  app.post('/internal/leader-announce', (req, res) => {
    const { leaderId, term } = req.body;
    if (typeof leaderId !== 'string' || typeof term !== 'number') {
      return res.status(400).json({ error: 'leaderId (string) and term (number) required.' });
    }
    console.log(`[Internal] leader-announce: leaderId=${leaderId} term=${term}`);
    leaderTracker.announceLeader(leaderId, term);
    res.json({ ok: true });
  });

  // ── POST /internal/stroke-committed (§6.2) ────────────────────────────────
  app.post('/internal/stroke-committed', (req, res) => {
    const { stroke, logIndex, term } = req.body;
    if (!stroke || typeof logIndex !== 'number') {
      return res.status(400).json({ error: 'stroke and logIndex are required.' });
    }

    // Record for new joiners
    clientManager.recordCommit(logIndex, stroke);

    // EVENT NAME FIX: broadcast 'stroke:commit' (§6.1) — not 'stroke:committed'
    clientManager.broadcast('stroke:commit', { stroke, logIndex });

    res.json({ ok: true });
  });

  // ── POST /internal/canvas-cleared ───────────────────────────────────────
  app.post('/internal/canvas-cleared', (req, res) => {
    const { logIndex, term } = req.body;
    if (typeof logIndex !== 'number') {
      return res.status(400).json({ error: 'logIndex is required.' });
    }

    // Clear the committed log so new joiners see empty canvas
    clientManager.clearLog(logIndex, term);

    // Broadcast clear to all connected clients
    clientManager.broadcast('canvas:clear', {});

    res.json({ ok: true });
  });

  // ── POST /internal/replica-status (§6.2, optional) ───────────────────────
  app.post('/internal/replica-status', (req, res) => {
    const { replicaId, role, term } = req.body;
    if (role === 'leader' && typeof term === 'number') {
      leaderTracker.announceLeader(replicaId, term);
    }
    res.json({ ok: true });
  });

  // ── GET /healthz ──────────────────────────────────────────────────────────
  app.get('/healthz', (_req, res) => {
    const leader = leaderTracker.getLeader();
    res.json({ ok: true, leader: leader?.id ?? null, clients: clientManager.size() });
  });

  return app;
}

module.exports = { createInternalServer };
