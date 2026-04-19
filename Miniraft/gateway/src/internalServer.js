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
const axios         = require('axios');
const leaderTracker = require('./leaderTracker');
const clientManager = require('./clientManager');
const { REPLICAS, TIMING } = require('./config');

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

  app.post('/internal/stroke-undone', (req, res) => {
    const { targetStrokeId, logIndex, vectorClock } = req.body;
    if (typeof targetStrokeId !== 'string' || typeof logIndex !== 'number') {
      return res.status(400).json({ error: 'targetStrokeId and logIndex are required.' });
    }

    const ok = clientManager.applyUndo(targetStrokeId, logIndex, vectorClock);
    clientManager.broadcast('stroke:undo', {
      targetStrokeId,
      logIndex,
      vectorClock,
      strokes: clientManager.visibleLog(),
    });
    console.log(`[Internal] stroke-undone: target=${targetStrokeId} logIndex=${logIndex} ok=${ok}`);
    res.json({ ok: true });
  });

  app.post('/internal/stroke-redone', (req, res) => {
    const { targetStrokeId, logIndex, vectorClock } = req.body;
    if (typeof targetStrokeId !== 'string' || typeof logIndex !== 'number') {
      return res.status(400).json({ error: 'targetStrokeId and logIndex are required.' });
    }

    const ok = clientManager.applyRedo(targetStrokeId, logIndex, vectorClock);
    clientManager.broadcast('stroke:redo', {
      targetStrokeId,
      logIndex,
      vectorClock,
      strokes: clientManager.visibleLog(),
    });
    console.log(`[Internal] stroke-redone: target=${targetStrokeId} logIndex=${logIndex} ok=${ok}`);
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

  app.get('/cluster/status', async (_req, res) => {
    const settled = await Promise.allSettled(REPLICAS.map(async replica => {
      const { data } = await axios.get(`${replica.url}/status`, { timeout: TIMING.RPC_TIMEOUT_MS });
      return { ...data, url: replica.url, reachable: true };
    }));

    const replicas = settled.map((result, idx) => {
      if (result.status === 'fulfilled') return result.value;
      return {
        replicaId: REPLICAS[idx].id,
        url: REPLICAS[idx].url,
        role: 'offline',
        reachable: false,
        term: 0,
        commitIndex: -1,
        lastApplied: -1,
        logLength: 0,
        partitionedPeers: [],
      };
    });

    res.json({
      ok: true,
      leader: leaderTracker.getLeader(),
      clients: clientManager.size(),
      committedVisible: clientManager.visibleLog().length,
      replicas,
    });
  });

  return app;
}

module.exports = { createInternalServer };
