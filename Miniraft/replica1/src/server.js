/**
 * server.js — Replica HTTP server
 *
 * OWNERSHIP: Samyuktha (Consensus Lead) & Saanvi (Data Lead) — shared.
 *
 * Mounts all RPC endpoints from SYSTEM_CONTRACT §5 and internal endpoint §6.2.
 *
 * Endpoints
 * ─────────
 *   POST /request-vote          §5.1
 *   POST /append-entries        §5.2
 *   POST /heartbeat             §5.3
 *   POST /sync-log              §5.4
 *   POST /internal/stroke-forward  §6.2 — Gateway → Leader
 *   GET  /status                    observability / Gateway probe
 *   GET  /healthz                   Docker healthcheck
 */
'use strict';

const express     = require('express');
const state       = require('./state');
const election    = require('./election');
const replication = require('./replication');

function createServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // ── Request logger (skip /status & /healthz to reduce noise) ─────────────
  app.use((req, _res, next) => {
    if (req.path !== '/status' && req.path !== '/healthz') {
      console.log(`[${state.replicaId}] ← ${req.method} ${req.path}`);  
    }
    next();
  });

  // ── POST /request-vote §5.1 ────────────────────────────────────────────────
  app.post('/request-vote', (req, res) => {
    if (state.isPeerBlocked(req.body.candidateId)) {
      console.warn(`[${state.replicaId}] PARTITION rejects RequestVote from ${req.body.candidateId}`);
      return res.json({ term: state.currentTerm, voteGranted: false, partitioned: true });
    }
    const result = election.handleRequestVote(req.body);  
    res.json(result);
  });

  // ── POST /append-entries §5.2 ──────────────────────────────────────────────
  app.post('/append-entries', (req, res) => {
    const result = replication.handleAppendEntries(req.body, election.resetElectionTimer);
    if (!result.success && result.term > req.body.term) {
      // Stale term — inform caller with 400 per §10
      return res.status(400).json({
        error: 'STALE_TERM',
        currentTerm: state.currentTerm,
        message: `Request term ${req.body.term} is older than currentTerm ${state.currentTerm}.`,
      });
    }
    res.json(result);
  });

  // ── POST /heartbeat §5.3 ───────────────────────────────────────────────────
  app.post('/heartbeat', async (req, res) => {
    const { term, leaderId, commitIndex: leaderCommit } = req.body;

    if (state.isPeerBlocked(leaderId)) {
      console.warn(`[${state.replicaId}] PARTITION rejects heartbeat from ${leaderId}`);
      return res.json({ term: state.currentTerm, success: false, partitioned: true });
    }

    if (typeof term !== 'number') {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'heartbeat requires term.' });
    }

    if (term < state.currentTerm) {
      return res.json({ term: state.currentTerm, success: false });
    }

    if (term > state.currentTerm) {
      election.stepDown(term);
    } else if (state.role !== 'follower') {
      state.setRole('follower');
    }

    state.setLeaderId(leaderId);
    election.resetElectionTimer();

    if (typeof leaderCommit === 'number' && leaderCommit > state.commitIndex) {
      state.setCommitIndex(Math.min(leaderCommit, state.lastLogIndex()));
    }

    if (typeof leaderCommit === 'number' && leaderCommit > state.lastLogIndex()) {
      await replication.requestSyncLogFromLeader(leaderId, state.lastLogIndex() + 1);
    }

    res.json({ term: state.currentTerm, success: true });
  });

  // ── POST /sync-log §5.4 ────────────────────────────────────────────────────
  app.post('/sync-log', (req, res) => {
    const { term } = req.body;
    if (term < state.currentTerm) {
      return res.status(400).json({
        error: 'STALE_TERM',
        currentTerm: state.currentTerm,
        message: `Request term ${term} is older than currentTerm ${state.currentTerm}.`,
      });
    }
    election.resetElectionTimer();
    const result = replication.handleSyncLog(req.body);
    res.json(result);
  });

  // ── POST /internal/stroke-forward §6.2 ────────────────────────────────────
  // Gateway → Leader only. Variable name unified to `stroke` (not `strokeData`/`payload`).
  app.post('/internal/stroke-forward', async (req, res) => {
    if (state.role !== 'leader') {
      return res.status(403).json({
        error: 'NOT_LEADER',
        message: `Replica ${state.replicaId} is not the leader.`,
        leaderId: state.leaderId,
      });
    }

    const { stroke } = req.body;
    if (!stroke) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'Missing stroke field.' });
    }

    try {
      const result = await replication.receiveStroke(stroke);
      if (result) return res.json({ ok: true, logIndex: result.logIndex });
      return res.status(503).json({ error: 'REPLICATION_FAILED', message: 'Could not reach quorum.' });
    } catch (err) {
      if (err.code === 'NOT_LEADER') return res.status(403).json({ error: 'NOT_LEADER', message: err.message });
      console.error(`[${state.replicaId}] stroke-forward error:`, err.message);
      return res.status(500).json({ error: 'INTERNAL', message: err.message });
    }
  });

  // ── POST /internal/canvas-clear ────────────────────────────────────────────
  // Gateway → Leader. Replicates a "clear" command through Raft.
  app.post('/internal/canvas-clear', async (req, res) => {
    if (state.role !== 'leader') {
      return res.status(403).json({
        error: 'NOT_LEADER',
        message: `Replica ${state.replicaId} is not the leader.`,
        leaderId: state.leaderId,
      });
    }

    try {
      const result = await replication.receiveClear();
      if (result) return res.json({ ok: true, logIndex: result.logIndex });
      return res.status(503).json({ error: 'REPLICATION_FAILED', message: 'Could not reach quorum.' });
    } catch (err) {
      if (err.code === 'NOT_LEADER') return res.status(403).json({ error: 'NOT_LEADER', message: err.message });
      console.error(`[${state.replicaId}] canvas-clear error:`, err.message);
      return res.status(500).json({ error: 'INTERNAL', message: err.message });
    }
  });

  app.post('/internal/undo', async (req, res) => {
    if (state.role !== 'leader') {
      return res.status(403).json({
        error: 'NOT_LEADER',
        message: `Replica ${state.replicaId} is not the leader.`,
        leaderId: state.leaderId,
      });
    }

    try {
      const result = await replication.receiveUndo(req.body.clientId, req.body.vectorClock);
      if (result) return res.json({ ok: true, logIndex: result.logIndex });
      return res.status(503).json({ error: 'REPLICATION_FAILED', message: 'Could not reach quorum.' });
    } catch (err) {
      const status = err.code === 'NO_UNDO_TARGET' ? 409 : 500;
      return res.status(status).json({ error: err.code || 'INTERNAL', message: err.message });
    }
  });

  app.post('/internal/redo', async (req, res) => {
    if (state.role !== 'leader') {
      return res.status(403).json({
        error: 'NOT_LEADER',
        message: `Replica ${state.replicaId} is not the leader.`,
        leaderId: state.leaderId,
      });
    }

    try {
      const result = await replication.receiveRedo(req.body.clientId, req.body.vectorClock);
      if (result) return res.json({ ok: true, logIndex: result.logIndex });
      return res.status(503).json({ error: 'REPLICATION_FAILED', message: 'Could not reach quorum.' });
    } catch (err) {
      const status = err.code === 'NO_REDO_TARGET' ? 409 : 500;
      return res.status(status).json({ error: err.code || 'INTERNAL', message: err.message });
    }
  });

  app.post('/admin/partition', (req, res) => {
    const blockedPeers = Array.isArray(req.body.blockedPeers) ? req.body.blockedPeers : [];
    state.setPartitionedPeers(blockedPeers);
    res.json({ ok: true, replicaId: state.replicaId, partitionedPeers: [...state.partitionedPeers] });
  });

  app.post('/admin/heal', (_req, res) => {
    state.clearPartition();
    res.json({ ok: true, replicaId: state.replicaId, partitionedPeers: [] });
  });

  // ── GET /status ────────────────────────────────────────────────────────────
  app.get('/status', (_req, res) => res.json(state.snapshot()));

  // ── GET /healthz ───────────────────────────────────────────────────────────
  app.get('/healthz', (_req, res) => res.json({ ok: true, replicaId: state.replicaId }));

  return app;
}

module.exports = { createServer };
