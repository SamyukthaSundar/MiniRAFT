/**
 * index.js — Gateway entry point
 * OWNERSHIP: Sanika (Gateway Lead)
 */
'use strict';

const http       = require('http');
const express    = require('express');
const path       = require('path');
const axios      = require('axios');
const { GATEWAY_PORT, INTERNAL_PORT, REPLICAS, TIMING } = require('./config');
const { createClientWsServer }        = require('./clientWsServer');
const { createInternalServer }        = require('./internalServer');
const leaderTracker = require('./leaderTracker');

// ── Public server (browser WebSocket + HTTP) ──────────────────────────────────
const publicApp = express();
publicApp.use(express.json({ limit: '1mb' }));
publicApp.get('/healthz', (_req, res) => res.json({ ok: true, service: 'gateway-public' }));
publicApp.get('/cluster/status', async (_req, res) => {
  const settled = await Promise.allSettled(REPLICAS.map(async replica => {
    const { data } = await axios.get(`${replica.url}/status`, { timeout: TIMING.RPC_TIMEOUT_MS });
    return { ...data, url: replica.url, reachable: true };
  }));

  res.json({
    ok: true,
    leader: leaderTracker.getLeader(),
    replicas: settled.map((result, idx) => result.status === 'fulfilled'
      ? result.value
      : {
          replicaId: REPLICAS[idx].id,
          url: REPLICAS[idx].url,
          role: 'offline',
          reachable: false,
          term: 0,
          commitIndex: -1,
          lastApplied: -1,
          logLength: 0,
          partitionedPeers: [],
        }),
  });
});

publicApp.post('/cluster/partition/split', async (req, res) => {
  const groups = req.body?.groups || [
    ['replica1', 'replica2'],
    ['replica3', 'replica4'],
  ];

  const validationError = _validatePartitionGroups(groups);
  if (validationError) {
    return res.status(400).json({ ok: false, error: 'BAD_PARTITION', message: validationError });
  }

  const groupByReplica = new Map();
  for (const group of groups) {
    for (const replicaId of group) groupByReplica.set(replicaId, new Set(group));
  }

  const results = await Promise.allSettled(REPLICAS.map(replica => {
    const visibleGroup = groupByReplica.get(replica.id) || new Set([replica.id]);
    const blockedPeers = REPLICAS
      .map(peer => peer.id)
      .filter(peerId => peerId !== replica.id && !visibleGroup.has(peerId));

    return axios.post(`${replica.url}/admin/partition`, { blockedPeers }, {
      timeout: TIMING.RPC_TIMEOUT_MS,
    }).then(({ data }) => ({ replicaId: replica.id, ok: true, ...data }));
  }));

  res.json({
    ok: results.every(result => result.status === 'fulfilled'),
    groups,
    replicas: _settledReplicaResults(results),
  });
});

publicApp.post('/cluster/partition/heal', async (_req, res) => {
  const results = await Promise.allSettled(REPLICAS.map(replica =>
    axios.post(`${replica.url}/admin/heal`, {}, {
      timeout: TIMING.RPC_TIMEOUT_MS,
    }).then(({ data }) => ({ replicaId: replica.id, ok: true, ...data }))
  ));

  res.json({
    ok: results.every(result => result.status === 'fulfilled'),
    replicas: _settledReplicaResults(results),
  });
});

function _validatePartitionGroups(groups) {
  if (!Array.isArray(groups) || groups.length < 2) return 'groups must contain at least two arrays.';

  const knownIds = new Set(REPLICAS.map(replica => replica.id));
  const seen = new Set();

  for (const group of groups) {
    if (!Array.isArray(group) || group.length === 0) return 'each group must be a non-empty array.';
    for (const replicaId of group) {
      if (!knownIds.has(replicaId)) return `unknown replica: ${replicaId}`;
      if (seen.has(replicaId)) return `replica appears in more than one group: ${replicaId}`;
      seen.add(replicaId);
    }
  }

  return null;
}

function _settledReplicaResults(results) {
  return results.map((result, idx) => {
    if (result.status === 'fulfilled') return result.value;
    return {
      replicaId: REPLICAS[idx].id,
      ok: false,
      error: result.reason?.message || 'request failed',
    };
  });
}

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
leaderTracker.start();
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
