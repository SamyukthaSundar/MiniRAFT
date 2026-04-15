/**
 * replication.js — RAFT Log Replication & Commit (§5.2 / §5.3 / §5.4)
 * OWNERSHIP: Saanvi (Data Lead).
 */
'use strict';

const axios   = require('axios');
const state   = require('./state');
const election = require('./election');

const RPC_TIMEOUT_MS  = parseInt(process.env.RPC_TIMEOUT_MS)  || 300;

// FIX 1: Filter out this node's own URL so we only count ACTUAL remote peers
const actualPeers     = state.peers.filter(url => !url.includes(state.replicaId));
const TOTAL_NODES     = 1 + actualPeers.length;          // Leader (1) + Followers (2) = 3
const QUORUM          = Math.floor(TOTAL_NODES / 2) + 1; // ⌊3/2⌋+1 → 2

const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS) || 150;

let _heartbeatTimer = null;

// ─── Public API ──────────────────────────────────────────────────────────────

function startHeartbeatLoop() {
  stopHeartbeatLoop();
  _heartbeatTimer = setInterval(_sendHeartbeats, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeatLoop() {
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
}

async function receiveStroke(stroke) {
  if (state.role !== 'leader') {
    const err = new Error(`Not the leader (role=${state.role})`);
    err.code = 'NOT_LEADER';
    throw err;
  }

  const entry = {
    index:  state.log.length,
    term:   state.currentTerm,
    stroke,
  };
  state.writeLogFrom(entry.index, [entry]);
  console.log(`[${state.replicaId}] Appended log[${entry.index}] strokeId=${stroke.strokeId}`);

  let ackCount  = 1; 
  let committed = false;

  // FIX 2: Only map over actual external peers
  const results = await Promise.allSettled(
    actualPeers.map(peerUrl => _replicateToPeer(peerUrl, entry))
  );

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value === true) {
      ackCount++;
    }
  }

  // FIX 3: Checks against the correct Quorum of 2
  if (ackCount >= QUORUM) {
    _advanceCommitIndex(entry.index);
    await _applyCommitted();
    committed = true;
  } else {
    console.warn(`[${state.replicaId}] Entry ${entry.index} not committed yet — only ${ackCount}/${QUORUM} ACKs`);
  }

  return committed ? { logIndex: entry.index } : null;
}

async function receiveClear() {
  if (state.role !== 'leader') {
    const err = new Error(`Not the leader (role=${state.role})`);
    err.code = 'NOT_LEADER';
    throw err;
  }

  const entry = {
    index: state.log.length,
    term:  state.currentTerm,
    type:  'clear',
  };
  state.writeLogFrom(entry.index, [entry]);
  console.log(`[${state.replicaId}] Appended log[${entry.index}] type=clear`);

  let ackCount  = 1;
  let committed = false;

  const results = await Promise.allSettled(
    actualPeers.map(peerUrl => _replicateToPeer(peerUrl, entry))
  );

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value === true) {
      ackCount++;
    }
  }

  if (ackCount >= QUORUM) {
    _advanceCommitIndex(entry.index);
    await _applyCommitted();
    committed = true;
  } else {
    console.warn(`[${state.replicaId}] Clear entry ${entry.index} not committed yet — only ${ackCount}/${QUORUM} ACKs`);
  }

  return committed ? { logIndex: entry.index } : null;
}

function handleAppendEntries({ term, leaderId, prevLogIndex, prevLogTerm, entries, leaderCommit }, resetTimer) {
  if (term < state.currentTerm) {
    return { term: state.currentTerm, success: false, matchIndex: state.lastLogIndex() };
  }

  resetTimer();

  if (term > state.currentTerm) {
    state.setTerm(term);
    state.setVotedFor(null);
  }
  if (state.role !== 'follower') state.setRole('follower');
  state.setLeaderId(leaderId);

  if (prevLogIndex >= 0) {
    const prev = state.getEntry(prevLogIndex);
    if (!prev || prev.term !== prevLogTerm) {
      return { term: state.currentTerm, success: false, matchIndex: state.lastLogIndex() };
    }
  }

  if (entries && entries.length > 0) {
    state.writeLogFrom(prevLogIndex + 1, entries);
  }

  if (leaderCommit > state.commitIndex) {
    state.setCommitIndex(Math.min(leaderCommit, state.lastLogIndex()));
    _advanceLastApplied();
  }

  return { term: state.currentTerm, success: true, matchIndex: state.lastLogIndex() };
}

function handleSyncLog({ term, leaderId, fromIndex, entries, leaderCommit }) {
  if (term < state.currentTerm) {
    return { term: state.currentTerm, success: false, matchIndex: state.lastLogIndex() };
  }

  if (term > state.currentTerm) {
    state.setTerm(term);
    state.setVotedFor(null);
  }
  state.setRole('follower');
  state.setLeaderId(leaderId);

  state.writeLogFrom(fromIndex, entries || []);
  state.setCommitIndex(leaderCommit);
  state.setLastApplied(leaderCommit);

  return { term: state.currentTerm, success: true, matchIndex: state.lastLogIndex() };
}

// ─── Private helpers ─────────────────────────────────────────────────────────

async function _replicateToPeer(peerUrl, targetEntry) {
  const MAX_ATTEMPTS = state.log.length + 2;
  for (let attempt = 0; attempt < MAX_ATTEMPTS && state.role === 'leader'; attempt++) {
    const nextIdx    = state.nextIndex.get(peerUrl) ?? state.log.length;
    const prevLogIdx = nextIdx - 1;
    const prevLogTrm = prevLogIdx >= 0 ? (state.getEntry(prevLogIdx)?.term ?? 0) : 0;
    const entries    = state.log.slice(nextIdx, targetEntry.index + 1);

    if (entries.length === 0) return false;

    try {
      const { data } = await axios.post(`${peerUrl}/append-entries`, {
        term:         state.currentTerm,
        leaderId:     state.replicaId,
        prevLogIndex: prevLogIdx,
        prevLogTerm:  prevLogTrm,
        entries,
        leaderCommit: state.commitIndex,
      }, { timeout: RPC_TIMEOUT_MS });

      if (data.term > state.currentTerm) {
        election.stepDown(data.term);
        return false;
      }

      if (data.success) {
        state.setMatchIndex(peerUrl, data.matchIndex);
        state.setNextIndex(peerUrl, data.matchIndex + 1);
        return true;
      }

      const followerLen = (typeof data.matchIndex === 'number') ? data.matchIndex + 1 : nextIdx - 1;
      state.setNextIndex(peerUrl, Math.max(0, followerLen));

      if ((state.nextIndex.get(peerUrl) ?? 0) < state.commitIndex - 3) {
        await _syncLogToPeer(peerUrl);
        return true;
      }

    } catch {
      return false;
    }
  }
  return false;
}

async function _syncLogToPeer(peerUrl) {
  const fromIndex = state.nextIndex.get(peerUrl) ?? 0;
  const entries   = state.log.slice(fromIndex, state.commitIndex + 1);
  try {
    const { data } = await axios.post(`${peerUrl}/sync-log`, {
      term:         state.currentTerm,
      leaderId:     state.replicaId,
      fromIndex,
      entries,
      leaderCommit: state.commitIndex,
    }, { timeout: RPC_TIMEOUT_MS });

    if (data.success) {
      state.setMatchIndex(peerUrl, data.matchIndex);
      state.setNextIndex(peerUrl, data.matchIndex + 1);
    } else if (data.term > state.currentTerm) {
      election.stepDown(data.term);
    }
  } catch {
    // peer unreachable
  }
}

async function _sendHeartbeats() {
  if (state.role !== 'leader') { stopHeartbeatLoop(); return; }

  // FIX 4: Only heartbeat actual external peers
  await Promise.allSettled(actualPeers.map(async peerUrl => {
    try {
      const { data } = await axios.post(`${peerUrl}/heartbeat`,{
        leaderId:    state.replicaId,
        commitIndex: state.commitIndex,
      }, { timeout: RPC_TIMEOUT_MS });

      if (data.term > state.currentTerm) {
        election.stepDown(data.term);
        return;
      }

      if (!data.success) {
        console.warn(`[${state.replicaId}] Heartbeat rejected by ${peerUrl}`);
      }
    } catch {
      // peer unreachable
    }
  }));
}

function _advanceCommitIndex(newIndex) {
  if (state.log[newIndex]?.term !== state.currentTerm) return;
  state.setCommitIndex(newIndex);
  console.log(`[${state.replicaId}] commitIndex → ${newIndex}`);
}

async function _applyCommitted() {
  while (state.lastApplied < state.commitIndex) {
    const nextIdx = state.lastApplied + 1;
    const entry   = state.log[nextIdx];
    if (!entry) break;
    state.setLastApplied(nextIdx);
    await _notifyGatewayCommit(entry);
  }
}

function _advanceLastApplied() {
  while (state.lastApplied < state.commitIndex) {
    state.setLastApplied(state.lastApplied + 1);
  }
}

async function _notifyGatewayCommit(entry) {
  if (!state.gatewayUrl) return;
  try {
    if (entry.type === 'clear') {
      await axios.post(`${state.gatewayUrl}/internal/canvas-cleared`, {
        logIndex: entry.index,
        term:     entry.term,
      }, { timeout: RPC_TIMEOUT_MS });
    } else {
      await axios.post(`${state.gatewayUrl}/internal/stroke-committed`, {
        stroke:   entry.stroke,
        logIndex: entry.index,
        term:     entry.term,
      }, { timeout: RPC_TIMEOUT_MS });
    }
  } catch (err) {
    console.warn(`[${state.replicaId}] Gateway commit notify failed:`, err.message);
  }
}

module.exports = {
  startHeartbeatLoop,
  stopHeartbeatLoop,
  receiveStroke,
  receiveClear,
  handleAppendEntries,
  handleSyncLog,
};