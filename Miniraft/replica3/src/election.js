/**
 * election.js — RAFT Leader Election (§4.2 / §5.1 / §8)
 *
 * OWNERSHIP: Samyuktha (Consensus Lead) — merged into Saanvi's modular structure.
 *
 * Responsibilities:
 *  • Randomised election timer [500, 800) ms — redrawn fresh every reset (§7)
 *  • Follower → Candidate transition on timeout
 *  • Broadcast /request-vote to all peers; count votes
 *  • Majority (≥2) wins → becomeLeader()
 *  • Handle incoming /request-vote RPC (vote-once-per-term rule §5.1)
 *  • Step down on higher term anywhere (Safety Invariant §9.8)
 *
 * BUG FIX (from Samyuktha's original):
 *   votes.size was checked against hardcoded 2. Changed to use computed quorum
 *   so the code is correct for any cluster size (QUORUM = ⌊N/2⌋ + 1).
 */
'use strict';

const axios  = require('axios');
const state  = require('./state');

// ─── Timing constants (§7) ───────────────────────────────────────────────────
const ELECTION_TIMEOUT_MIN_MS = parseInt(process.env.ELECTION_TIMEOUT_MIN_MS) || 500;
const ELECTION_TIMEOUT_MAX_MS = parseInt(process.env.ELECTION_TIMEOUT_MAX_MS) || 800;
const RPC_TIMEOUT_MS          = parseInt(process.env.RPC_TIMEOUT_MS)          || 300;
const actualPeers             = state.peers.filter(url => !url.includes(state.replicaId));
const TOTAL_NODES             = 1 + actualPeers.length;
const QUORUM                  = Math.floor(TOTAL_NODES / 2) + 1;

// ─── Timer state ─────────────────────────────────────────────────────────────
let _electionTimer  = null;
let _heartbeatTimer = null;

// ─── Public API ──────────────────────────────────────────────────────────────

/** Start the election timer. Call once on replica boot. */
function start(onBecomeLeaderCallback) {
  _onBecomeLeader = onBecomeLeaderCallback || (() => {});
  resetElectionTimer();
}

/** Reset the election timer with a fresh random delay. Must be called on every
 *  valid heartbeat or AppendEntries receipt (§5.2 rule 2). */
function resetElectionTimer() {
  if (_electionTimer) clearTimeout(_electionTimer);
  if (state.role === 'leader') return; // Leaders never time out.

  // §7: draw fresh each reset to minimise split-vote collisions.
  const delay = ELECTION_TIMEOUT_MIN_MS
    + Math.floor(Math.random() * (ELECTION_TIMEOUT_MAX_MS - ELECTION_TIMEOUT_MIN_MS));

  _electionTimer = setTimeout(() => {
    console.log(`[${state.replicaId}] Election timeout fired (${delay}ms) — starting election`);
    _startElection();
  }, delay);
}

/** Stop the election timer (called when we become leader). */
function stopElectionTimer() {
  if (_electionTimer) { clearTimeout(_electionTimer); _electionTimer = null; }
}

/** Stop the heartbeat loop (called on step-down). */
function stopHeartbeatTimer() {
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
}

/**
 * Handle an incoming /request-vote RPC from a candidate.
 * Implements all vote-granting rules from §5.1.
 *
 * @param {object} body  { term, candidateId, lastLogIndex, lastLogTerm }
 * @returns {{ term, voteGranted }}
 */
function handleRequestVote({ term, candidateId, lastLogIndex, lastLogTerm }) {
  // Rule 1: stale term → deny
  if (term < state.currentTerm) {
    return { term: state.currentTerm, voteGranted: false };
  }

  // Rule 2: higher term → update, revert to follower, clear votedFor
  if (term > state.currentTerm) {
    state.setTerm(term);
    state.setVotedFor(null);
    state.setRole('follower');
    stopHeartbeatTimer();
    resetElectionTimer();
  }

  // Rule 3a: already voted for a different candidate this term
  if (state.votedFor !== null && state.votedFor !== candidateId) {
    return { term: state.currentTerm, voteGranted: false };
  }

  // Rule 3b: candidate log must be at least as up-to-date as ours
  // Compare lastLogTerm first; break ties with lastLogIndex (§5.1)
  const myLastTerm  = state.lastLogTerm();
  const myLastIndex = state.lastLogIndex();
  const upToDate =
    lastLogTerm > myLastTerm ||
    (lastLogTerm === myLastTerm && lastLogIndex >= myLastIndex);

  if (!upToDate) {
    return { term: state.currentTerm, voteGranted: false };
  }

  // Grant vote
  state.setVotedFor(candidateId);
  resetElectionTimer(); // valid leader contact — reset so we don't race
  console.log(`[${state.replicaId}] Vote granted → ${candidateId} (term ${term})`);
  return { term: state.currentTerm, voteGranted: true };
}

// ─── Private helpers ─────────────────────────────────────────────────────────

let _onBecomeLeader = () => {};

async function _startElection() {
  if (state.role === 'leader') return;

  // Transition to Candidate, increment term, self-vote (§8)
  state.setRole('candidate');
  state.setLeaderId(null);
  state.setTerm(state.currentTerm + 1);
  state.setVotedFor(state.replicaId);
  state.clearVotes();
  state.addVote(state.replicaId); // self-vote counts

  const electionTerm = state.currentTerm;
  console.log(`[${state.replicaId}] Election started: term=${electionTerm} quorum=${QUORUM}/${TOTAL_NODES}`);

  // Reset timer in case of split vote
  resetElectionTimer();

  const voteReq = {
    term:         electionTerm,
    candidateId:  state.replicaId,
    lastLogIndex: state.lastLogIndex(),
    lastLogTerm:  state.lastLogTerm(),
  };

  // Fan out to all peers — don't await all; count as they arrive
  const promises = actualPeers.map(peerUrl =>
    _requestVoteFrom(peerUrl, voteReq, electionTerm)
  );
  await Promise.allSettled(promises);

  if (state.role === 'candidate' && state.currentTerm === electionTerm) {
    console.log(`[${state.replicaId}] Election term ${electionTerm} ended without quorum`);
  }
}

async function _requestVoteFrom(peerUrl, voteReq, electionTerm) {
  if (state.isPeerBlocked(peerUrl)) {
    console.warn(`[${state.replicaId}] PARTITION blocks RequestVote to ${peerUrl}`);
    return;
  }

  try {
    const { data } = await axios.post(`${peerUrl}/request-vote`, voteReq, {
      timeout: RPC_TIMEOUT_MS,
    });

    // Stale response — we moved on
    if (state.role !== 'candidate' || state.currentTerm !== electionTerm) return;

    // Higher term seen → step down immediately (§9.8)
    if (data.term > state.currentTerm) {
      _stepDown(data.term);
      return;
    }

    if (data.voteGranted) {
      state.addVote(peerUrl);
      console.log(`[${state.replicaId}] Vote from ${peerUrl} — total: ${state.voteCount}/${QUORUM}`);

      // BUG FIX: compare against computed QUORUM, not hardcoded 2
      if (state.voteCount >= QUORUM && state.role === 'candidate') {
        _becomeLeader(electionTerm);
      }
    }
  } catch (err) {
    console.warn(`[${state.replicaId}] RequestVote failed to ${peerUrl}: ${err.message}`);
    // Peer unreachable — ignore, election timer handles it
  }
}

function _becomeLeader(term) {
  if (state.role !== 'candidate' || state.currentTerm !== term) return;

  state.setRole('leader');
  state.setLeaderId(state.replicaId);
  state.initLeaderState();
  stopElectionTimer();

  console.log(`[${state.replicaId}] LEADER elected: term=${term} quorum=${QUORUM}/${TOTAL_NODES}`);

  // Notify gateway (§6.2 leader:announce)
  _announceToGateway(term).catch(() => {});

  // Notify application layer so it can start the heartbeat loop
  _onBecomeLeader(term);
}

function _stepDown(higherTerm) {
  console.log(`[${state.replicaId}] Step down → term ${higherTerm}`);
  state.setTerm(higherTerm);
  state.setVotedFor(null);
  state.setRole('follower');
  state.setLeaderId(null);
  stopHeartbeatTimer();
  resetElectionTimer();
}

async function _announceToGateway(term) {
  if (!state.gatewayUrl) return;
  await axios.post(`${state.gatewayUrl}/internal/leader-announce`, {
    leaderId: state.replicaId,
    term,
  }, { timeout: RPC_TIMEOUT_MS });
}

module.exports = {
  start,
  resetElectionTimer,
  stopElectionTimer,
  stopHeartbeatTimer,
  handleRequestVote,
  // Exposed for replication.js to call on step-down
  stepDown: (higherTerm) => _stepDown(higherTerm),
};
