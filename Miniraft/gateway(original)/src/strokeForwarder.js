/**
 * strokeForwarder.js — Forward strokes from clients to the RAFT leader
 *
 * OWNERSHIP: Sanika (Gateway Lead)
 *
 * VARIABLE NAME FIX:
 *   Body field is `stroke` everywhere (not `strokeData` or `payload`),
 *   matching §6.2 stroke:forward contract and replica's server.js handler.
 *
 * Retry strategy (TIMING.STROKE_MAX_RETRIES = 5):
 *   1. Get current leader URL
 *   2. POST /internal/stroke-forward with { stroke }
 *   3. On failure, wait STROKE_RETRY_DELAY_MS, clear leader cache, retry
 *   4. If all retries exhausted → send system:error to originating client
 */
'use strict';

const axios         = require('axios');
const leaderTracker = require('./leaderTracker');
const clientManager = require('./clientManager');
const { TIMING }    = require('./config');

/**
 * Forward a stroke to the current leader replica.
 * @param {object} stroke    Full Stroke object (§2)
 * @param {string} clientId  Originating client (for error routing)
 */
async function forwardStroke(stroke, clientId) {
  for (let attempt = 1; attempt <= TIMING.STROKE_MAX_RETRIES; attempt++) {
    const leader = leaderTracker.getLeader();

    if (!leader) {
      console.warn(`[Forwarder] No leader (attempt ${attempt}) — waiting…`);
      await _sleep(TIMING.STROKE_RETRY_DELAY_MS * attempt);
      continue;
    }

    try {
      // VARIABLE NAME FIX: body field is `stroke` (not `strokeData` or `payload`)
      const res = await axios.post(`${leader.url}/internal/stroke-forward`, {
        stroke,
      }, { timeout: TIMING.RPC_TIMEOUT_MS });

      if (res.status === 200 && res.data.ok) {
        console.log(`[Forwarder] stroke=${stroke.strokeId} forwarded → ${leader.id} logIndex=${res.data.logIndex}`);
        return;
      }

      // Non-2xx or not ok — treat as soft failure
      console.warn(`[Forwarder] Leader rejected (attempt ${attempt}):`, res.data?.error);

    } catch (err) {
      console.warn(`[Forwarder] Network error to ${leader.id} (attempt ${attempt}):`, err.message);
    }

    await _sleep(TIMING.STROKE_RETRY_DELAY_MS);
  }

  // All retries exhausted
  console.error(`[Forwarder] stroke=${stroke.strokeId} failed after ${TIMING.STROKE_MAX_RETRIES} attempts`);
  clientManager.sendError(
    clientId,
    'NO_LEADER',
    'No leader is currently elected. Please retry.',
    stroke.strokeId,
  );
}

const _sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Forward a canvas:clear command to the current leader replica.
 * @param {string} clientId  Originating client (for error routing)
 */
async function forwardClear(clientId) {
  for (let attempt = 1; attempt <= TIMING.STROKE_MAX_RETRIES; attempt++) {
    const leader = leaderTracker.getLeader();

    if (!leader) {
      console.warn(`[Forwarder] No leader for clear (attempt ${attempt}) — waiting…`);
      await _sleep(TIMING.STROKE_RETRY_DELAY_MS * attempt);
      continue;
    }

    try {
      const res = await axios.post(`${leader.url}/internal/canvas-clear`, {}, {
        timeout: TIMING.RPC_TIMEOUT_MS,
      });

      if (res.status === 200 && res.data.ok) {
        console.log(`[Forwarder] canvas:clear forwarded → ${leader.id}`);
        return;
      }

      console.warn(`[Forwarder] Leader rejected clear (attempt ${attempt}):`, res.data?.error);

    } catch (err) {
      console.warn(`[Forwarder] Clear network error to ${leader.id} (attempt ${attempt}):`, err.message);
    }

    await _sleep(TIMING.STROKE_RETRY_DELAY_MS);
  }

  console.error(`[Forwarder] canvas:clear failed after ${TIMING.STROKE_MAX_RETRIES} attempts`);
  clientManager.sendError(
    clientId,
    'NO_LEADER',
    'No leader is currently elected. Please retry.',
    null,
  );
}

async function forwardHistoryCommand(command, clientId, vectorClock) {
  const endpoint = command === 'undo' ? '/internal/undo' : '/internal/redo';

  for (let attempt = 1; attempt <= TIMING.STROKE_MAX_RETRIES; attempt++) {
    const leader = leaderTracker.getLeader();

    if (!leader) {
      console.warn(`[Forwarder] No leader for ${command} (attempt ${attempt})`);
      await _sleep(TIMING.STROKE_RETRY_DELAY_MS * attempt);
      continue;
    }

    try {
      const res = await axios.post(`${leader.url}${endpoint}`, {
        clientId,
        vectorClock,
      }, { timeout: TIMING.RPC_TIMEOUT_MS });

      if (res.status === 200 && res.data.ok) {
        console.log(`[Forwarder] ${command} forwarded -> ${leader.id} logIndex=${res.data.logIndex}`);
        return;
      }
      console.warn(`[Forwarder] Leader rejected ${command} (attempt ${attempt}):`, res.data?.error);
    } catch (err) {
      const code = err.response?.data?.error;
      if (code === 'NO_UNDO_TARGET' || code === 'NO_REDO_TARGET') {
        clientManager.sendError(clientId, code, err.response.data.message, null);
        return;
      }
      console.warn(`[Forwarder] ${command} network error to ${leader.id} (attempt ${attempt}):`, err.message);
    }

    await _sleep(TIMING.STROKE_RETRY_DELAY_MS);
  }

  clientManager.sendError(
    clientId,
    'NO_LEADER',
    `No leader is currently elected. Could not ${command}.`,
    null,
  );
}

module.exports = { forwardStroke, forwardClear, forwardHistoryCommand };
