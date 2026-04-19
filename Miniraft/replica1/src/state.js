/**
 * state.js — Unified RAFT replica state (Saanvi × Samyuktha merge)
 *
 * Single source of truth for ALL state variables defined in SYSTEM_CONTRACT §4.
 *
 * Persistent (§4.1): currentTerm, votedFor, log[]  ← survive container restarts
 * Volatile   (§4.2): role, leaderId, commitIndex, lastApplied, electionTimer, votes
 * Leader-only(§4.3): nextIndex, matchIndex
 *
 * OWNERSHIP: Saanvi (Data Lead) owns this file.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Environment ──────────────────────────────────────────────────────────────
const REPLICA_ID   = process.env.REPLICA_ID;
const PERSIST_FILE = process.env.PERSIST_FILE
  || path.join('/tmp', `.raft-state-${REPLICA_ID}.json`);
const PEER_URLS    = (process.env.PEER_URLS || '')
  .split(',').map(u => u.trim()).filter(Boolean);
const GATEWAY_URL  = process.env.GATEWAY_URL || '';
const INITIAL_PARTITIONED_PEERS = (process.env.PARTITIONED_PEERS || '')
  .split(',').map(id => id.trim()).filter(Boolean);

if (!REPLICA_ID) throw new Error('REPLICA_ID env var is required');

// ─── Persistent state (§4.1) ─────────────────────────────────────────────────
let _currentTerm = 0;
let _votedFor    = null;   // replicaId | null
let _log         = [];     // LogEntry[]

function _loadPersistentState() {
  try {
    if (fs.existsSync(PERSIST_FILE)) {
      const data = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf8'));
      _currentTerm = data.currentTerm ?? 0;
      _votedFor    = data.votedFor    ?? null;
      _log         = data.log         ?? [];
      console.log(`[${REPLICA_ID}] Loaded state — term=${_currentTerm} logLen=${_log.length}`);
    }
  } catch (err) {
    console.warn(`[${REPLICA_ID}] Could not load persistent state, starting fresh:`, err.message);
  }
}

function _savePersistentState() {
  try {
    fs.writeFileSync(PERSIST_FILE, JSON.stringify({
      currentTerm: _currentTerm,
      votedFor:    _votedFor,
      log:         _log,
    }));
  } catch (err) {
    console.error(`[${REPLICA_ID}] Failed to persist state:`, err.message);
  }
}

// ─── Volatile state (§4.2) ───────────────────────────────────────────────────
let _role        = 'follower';  // 'follower' | 'candidate' | 'leader'
let _leaderId    = null;
let _commitIndex = -1;
let _lastApplied = -1;
let _votes       = new Set();

// ─── Leader-only volatile state (§4.3) ───────────────────────────────────────
let _nextIndex  = new Map();   // peerUrl → number
let _matchIndex = new Map();   // peerUrl → number
let _partitionedPeers = new Set(INITIAL_PARTITIONED_PEERS);

function _peerIdFromUrl(url) {
  try { return new URL(url).hostname; }
  catch { return String(url); }
}

// ─── Public state object ─────────────────────────────────────────────────────
const state = {
  // Identity
  get replicaId()  { return REPLICA_ID; },
  get peers()      { return PEER_URLS;  },
  get gatewayUrl() { return GATEWAY_URL; },

  // Persistent accessors
  get currentTerm() { return _currentTerm; },
  get votedFor()    { return _votedFor;    },
  get log()         { return _log;         },

  // Volatile accessors
  get role()        { return _role;        },
  get leaderId()    { return _leaderId;    },
  get commitIndex() { return _commitIndex; },
  get lastApplied() { return _lastApplied; },
  get votes()       { return _votes;       },

  // Leader-only accessors
  get nextIndex()   { return _nextIndex;   },
  get matchIndex()  { return _matchIndex;  },
  get partitionedPeers() { return new Set(_partitionedPeers); },

  // ── Persistent mutators ──────────────────────────────────────────────────
  /**
   * Update currentTerm. Monotonically increasing — will not decrement (§9.5).
   */
  setTerm(term) {
    if (term < _currentTerm) return; // Safety invariant §9.5
    _currentTerm = term;
    _savePersistentState();
  },

  setVotedFor(candidateId) {
    _votedFor = candidateId;
    _savePersistentState();
  },

  /**
   * Overwrite log from `fromIndex` onward (append or truncate + append).
   * Satisfies §5.2 rule 4 (overwrite conflicting suffix) and §5.4 rule 2.
   */
  writeLogFrom(fromIndex, entries) {
    _log.splice(fromIndex, _log.length - fromIndex, ...entries);
    _savePersistentState();
  },

  // ── Volatile mutators ────────────────────────────────────────────────────
  setRole(role) {
    console.log(`[${REPLICA_ID}] Role: ${_role} → ${role}`);
    _role = role;
  },

  setLeaderId(id)      { _leaderId    = id;  },
  setCommitIndex(idx)  { if (idx > _commitIndex) _commitIndex = idx; },
  setLastApplied(idx)  { if (idx > _lastApplied) _lastApplied = idx; },

  // Election vote tracking
  clearVotes()   { _votes.clear(); },
  addVote(id)    { _votes.add(id); },
  get voteCount(){ return _votes.size; },

  // Leader tracking maps
  setNextIndex(peerUrl, idx)  { _nextIndex.set(peerUrl, idx);  },
  setMatchIndex(peerUrl, idx) { _matchIndex.set(peerUrl, idx); },

  setPartitionedPeers(peerIds) {
    _partitionedPeers = new Set((peerIds || []).filter(Boolean));
    console.warn(`[${REPLICA_ID}] NETWORK PARTITION updated: blocked=${[..._partitionedPeers].join(',') || '(none)'}`);
  },

  clearPartition() {
    _partitionedPeers.clear();
    console.warn(`[${REPLICA_ID}] NETWORK PARTITION cleared`);
  },

  isPeerBlocked(peerIdOrUrl) {
    const value = String(peerIdOrUrl || '');
    const id = value.startsWith('http') ? _peerIdFromUrl(value) : value;
    return _partitionedPeers.has(id);
  },

  /**
   * Initialise leader tracking state when this node wins an election (§4.3).
   * nextIndex = leader.log.length (optimistic)
   * matchIndex = -1
   */
  initLeaderState() {
    _nextIndex.clear();
    _matchIndex.clear();
    for (const url of PEER_URLS) {
      _nextIndex.set(url, _log.length);
      _matchIndex.set(url, -1);
    }
  },

  // ── Log helpers ──────────────────────────────────────────────────────────
  lastLogIndex() { return _log.length - 1; },
  lastLogTerm()  { return _log.length > 0 ? _log[_log.length - 1].term : 0; },
  getEntry(idx)  { return (idx >= 0 && idx < _log.length) ? _log[idx] : undefined; },

  // ── Snapshot for /status endpoint ───────────────────────────────────────
  snapshot() {
    return {
      replicaId:   REPLICA_ID,
      role:        _role,
      term:        _currentTerm,
      votedFor:    _votedFor,
      leaderId:    _leaderId,
      commitIndex: _commitIndex,
      lastApplied: _lastApplied,
      logLength:   _log.length,
      partitionedPeers: [..._partitionedPeers],
    };
  },
};

// Bootstrap from disk on module load.
_loadPersistentState();

module.exports = state;
