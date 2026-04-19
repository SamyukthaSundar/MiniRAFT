/**
 * leaderTracker.js — Gateway leader discovery
 *
 * OWNERSHIP: Sanika (Gateway Lead)
 *
 * Two discovery mechanisms:
 *  PASSIVE — replicas POST /internal/leader-announce immediately after winning.
 *  ACTIVE  — probe all replicas via GET /status every LEADER_PROBE_INTERVAL_MS.
 *
 * INTEGRATION FIX:
 *   Sanika's original polled GET /health (returns { ok, replicaId }).
 *   Samyuktha/Saanvi's server.js exposes GET /status (returns full state snapshot
 *   including `role` and `term`). Unified here to use /status, which is the
 *   endpoint defined in SYSTEM_CONTRACT §5 for Gateway probing.
 *
 * VARIABLE NAME FIX:
 *   Sanika's original used `currentLeaderUrl` in some places and `leader.url` in
 *   others. Now a single `_leader` object { id, url, term } is the source of truth.
 */
'use strict';

const EventEmitter = require('events');
const axios        = require('axios');
const { REPLICAS, TIMING } = require('./config');

class LeaderTracker extends EventEmitter {
  constructor() {
    super();
    /** @type {{ id: string, url: string, term: number } | null} */
    this._leader     = null;
    this._probing    = false;
    this._probeTimer = null;
  }

  /** Returns the current leader descriptor or null. */
  getLeader() {
    return this._leader ? { id: this._leader.id, url: this._leader.url, term: this._leader.term } : null;
  }

  /**
   * Called when a replica POSTs /internal/leader-announce.
   * @param {string} replicaId
   * @param {number} term
   */
  announceLeader(replicaId, term) {
    const replica = REPLICAS.find(r => r.id === replicaId);
    if (!replica) {
      console.warn(`[LeaderTracker] Unknown replicaId in announce: ${replicaId}`);
      return;
    }
    this._applyLeader(replica, term, 'announce');
  }

  /** Start background probe loop. */
  start() {
    this._probe(); // immediate probe on boot
    this._probeTimer = setInterval(() => this._probe(), TIMING.LEADER_PROBE_INTERVAL_MS);
  }

  stop() {
    if (this._probeTimer) { clearInterval(this._probeTimer); this._probeTimer = null; }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  async _probe() {
    if (this._probing) return;
    this._probing = true;
    try {
      const results = await Promise.allSettled(
        REPLICAS.map(r => this._fetchStatus(r))
      );

      let bestLeader = null;
      let bestTerm   = -1;

      for (const result of results) {
        if (result.status !== 'fulfilled' || !result.value) continue;
        const { status, replica } = result.value;
        // INTEGRATION FIX: use `status.role` and `status.term` from /status endpoint
        if (status.role === 'leader' && status.term > bestTerm) {
          bestTerm   = status.term;
          bestLeader = { replica, term: status.term };
        }
      }

      if (bestLeader) {
        this._applyLeader(bestLeader.replica, bestLeader.term, 'probe');
      } else if (this._leader) {
        console.warn(`[LeaderTracker] No leader found in probe — previous: ${this._leader.id}`);
      }
    } finally {
      this._probing = false;
    }
  }

  async _fetchStatus(replica) {
    try {
      // INTEGRATION FIX: probe /status (not /health) — /status returns role & term
      const { data } = await axios.get(`${replica.url}/status`, {
        timeout: TIMING.RPC_TIMEOUT_MS,
      });
      return { status: data, replica };
    } catch {
      return null;
    }
  }

  _applyLeader(replica, term, source) {
    const changed =
      !this._leader ||
      this._leader.id !== replica.id ||
      this._leader.term < term;

    if (!changed) return;

    const prev = this._leader?.id ?? null;
    this._leader = { id: replica.id, url: replica.url, term };
    console.log(`[LeaderTracker] Leader: ${prev} → ${replica.id} (term=${term}, via ${source})`);
    this.emit('change', this.getLeader());
  }
}

module.exports = new LeaderTracker();
