'use strict';

const axios = require('axios');
const state = require('./state');
const election = require('./election');

const RPC_TIMEOUT_MS = parseInt(process.env.RPC_TIMEOUT_MS, 10) || 300;
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS, 10) || 150;

const actualPeers = state.peers.filter(url => !url.includes(state.replicaId));
const TOTAL_NODES = 1 + actualPeers.length;
const QUORUM = Math.floor(TOTAL_NODES / 2) + 1;

let _heartbeatTimer = null;
const _heartbeatPeerInFlight = new Set();

function startHeartbeatLoop() {
  stopHeartbeatLoop();
  console.log(`[${state.replicaId}] Heartbeat loop started (${HEARTBEAT_INTERVAL_MS}ms)`);
  _sendHeartbeats();
  _heartbeatTimer = setInterval(_sendHeartbeats, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeatLoop() {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
    console.log(`[${state.replicaId}] Heartbeat loop stopped`);
  }
  _heartbeatPeerInFlight.clear();
}

async function receiveStroke(stroke) {
  return _appendAndCommit({
    type: 'stroke',
    stroke,
    clientId: stroke.clientId,
    vectorClock: stroke.vectorClock || null,
  });
}

async function receiveClear() {
  return _appendAndCommit({ type: 'clear' });
}

async function receiveUndo(clientId, vectorClock) {
  const view = _materializeCommittedView();
  const target = [...view.visible].reverse().find(item => item.stroke.clientId === clientId);
  if (!target) {
    const err = new Error('No committed stroke is available to undo for this client.');
    err.code = 'NO_UNDO_TARGET';
    throw err;
  }

  return _appendAndCommit({
    type: 'undo',
    clientId,
    targetStrokeId: target.stroke.strokeId,
    targetLogIndex: target.logIndex,
    vectorClock,
  });
}

async function receiveRedo(clientId, vectorClock) {
  const view = _materializeCommittedView();
  const target = [...view.undoStack].reverse().find(item => item.clientId === clientId);
  if (!target) {
    const err = new Error('No compensated stroke is available to redo for this client.');
    err.code = 'NO_REDO_TARGET';
    throw err;
  }

  return _appendAndCommit({
    type: 'redo',
    clientId,
    targetStrokeId: target.targetStrokeId,
    targetLogIndex: target.targetLogIndex,
    vectorClock,
  });
}

async function _appendAndCommit(command) {
  if (state.role !== 'leader') {
    const err = new Error(`Not the leader (role=${state.role})`);
    err.code = 'NOT_LEADER';
    throw err;
  }

  const entry = {
    index: state.log.length,
    term: state.currentTerm,
    ...command,
  };

  state.writeLogFrom(entry.index, [entry]);
  console.log(`[${state.replicaId}] LOG append index=${entry.index} term=${entry.term} type=${entry.type}${entry.stroke ? ` strokeId=${entry.stroke.strokeId}` : ''}`);

  let ackCount = 1;
  const peerAcksReached = await new Promise(resolve => {
    if (ackCount >= QUORUM) {
      resolve(true);
      return;
    }

    let settled = 0;
    let resolved = false;

    for (const peerUrl of actualPeers) {
      _replicateToPeer(peerUrl, entry)
        .then(success => {
          settled += 1;
          if (success) ackCount += 1;

          if (!resolved && ackCount >= QUORUM) {
            resolved = true;
            resolve(true);
            return;
          }

          if (!resolved && settled === actualPeers.length) {
            resolved = true;
            resolve(false);
          }
        })
        .catch(() => {
          settled += 1;
          if (!resolved && settled === actualPeers.length) {
            resolved = true;
            resolve(false);
          }
        });
    }
  });

  if (!peerAcksReached || ackCount < QUORUM) {
    console.warn(`[${state.replicaId}] LOG not committed index=${entry.index} type=${entry.type} ack=${ackCount}/${QUORUM}`);
    return null;
  }

  _advanceCommitIndex(entry.index);
  await _applyCommitted();
  console.log(`[${state.replicaId}] LOG committed index=${entry.index} type=${entry.type} ack=${ackCount}/${TOTAL_NODES}`);
  return { logIndex: entry.index };
}

function handleAppendEntries({ term, leaderId, prevLogIndex, prevLogTerm, entries, leaderCommit }, resetTimer) {
  if (state.isPeerBlocked(leaderId)) {
    console.warn(`[${state.replicaId}] PARTITION rejects AppendEntries from ${leaderId}`);
    return { term: state.currentTerm, success: false, matchIndex: state.lastLogIndex(), partitioned: true };
  }

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
      console.warn(`[${state.replicaId}] AppendEntries conflict prevLogIndex=${prevLogIndex} prevLogTerm=${prevLogTerm}`);
      return { term: state.currentTerm, success: false, matchIndex: state.lastLogIndex() };
    }
  }

  if (entries && entries.length > 0) {
    state.writeLogFrom(prevLogIndex + 1, entries);
    console.log(`[${state.replicaId}] AppendEntries accepted count=${entries.length} from=${leaderId} start=${prevLogIndex + 1}`);
  }

  if (leaderCommit > state.commitIndex) {
    state.setCommitIndex(Math.min(leaderCommit, state.lastLogIndex()));
    _advanceLastApplied();
  }

  return { term: state.currentTerm, success: true, matchIndex: state.lastLogIndex() };
}

function handleSyncLog({ term, leaderId, requesterId, fromIndex, entries, leaderCommit }) {
  const isPullRequest = entries === undefined;

  if (isPullRequest) {
    return _handleSyncLogPullRequest({ term, requesterId: requesterId || leaderId, fromIndex });
  }

  console.log(
    `[${state.replicaId}] SYNC-LOG receive leader=${leaderId} ` +
    `fromIndex=${fromIndex} entries=${(entries || []).length} leaderCommit=${leaderCommit}`
  );

  if (state.isPeerBlocked(leaderId)) {
    console.warn(`[${state.replicaId}] PARTITION rejects SyncLog from ${leaderId}`);
    return { term: state.currentTerm, success: false, matchIndex: state.lastLogIndex(), partitioned: true };
  }

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
  console.log(`[${state.replicaId}] SYNC-LOG applied from=${leaderId} fromIndex=${fromIndex} entries=${(entries || []).length} leaderCommit=${leaderCommit}`);

  return { term: state.currentTerm, success: true, matchIndex: state.lastLogIndex() };
}

async function requestSyncLogFromLeader(leaderId, fromIndex = state.lastLogIndex() + 1) {
  if (!leaderId || leaderId === state.replicaId) return false;
  if (state.isPeerBlocked(leaderId)) {
    console.warn(`[${state.replicaId}] PARTITION blocks SyncLog request to ${leaderId}`);
    return false;
  }

  const leaderUrl = _peerUrlForId(leaderId);
  if (!leaderUrl) {
    console.warn(`[${state.replicaId}] SYNC-LOG request skipped: no peer URL for leader=${leaderId}`);
    return false;
  }

  console.log(`[${state.replicaId}] SYNC-LOG request leader=${leaderId} fromIndex=${fromIndex}`);

  try {
    const { data } = await axios.post(`${leaderUrl}/sync-log`, {
      term: state.currentTerm,
      requesterId: state.replicaId,
      fromIndex,
    }, { timeout: RPC_TIMEOUT_MS });

    if (data.term > state.currentTerm) {
      election.stepDown(data.term);
      return false;
    }

    if (!data.success) {
      console.warn(`[${state.replicaId}] SYNC-LOG request rejected by ${leaderId}`);
      return false;
    }

    handleSyncLog({
      term: data.term,
      leaderId,
      fromIndex: data.fromIndex,
      entries: data.entries || [],
      leaderCommit: data.leaderCommit,
    });
    return true;
  } catch (err) {
    console.warn(`[${state.replicaId}] SYNC-LOG request failed leader=${leaderId}: ${err.message}`);
    return false;
  }
}

function _handleSyncLogPullRequest({ term, requesterId, fromIndex }) {
  if (state.isPeerBlocked(requesterId)) {
    console.warn(`[${state.replicaId}] PARTITION rejects SyncLog request from ${requesterId}`);
    return { term: state.currentTerm, success: false, matchIndex: state.lastLogIndex(), partitioned: true };
  }

  if (term < state.currentTerm) {
    return { term: state.currentTerm, success: false, matchIndex: state.lastLogIndex() };
  }

  if (term > state.currentTerm) {
    election.stepDown(term);
    return { term: state.currentTerm, success: false, leaderId: state.leaderId, matchIndex: state.lastLogIndex() };
  }

  if (state.role !== 'leader') {
    return {
      term: state.currentTerm,
      success: false,
      leaderId: state.leaderId,
      matchIndex: state.lastLogIndex(),
    };
  }

  const start = Number.isInteger(fromIndex) && fromIndex >= 0 ? fromIndex : 0;
  const entries = state.log.slice(start, state.commitIndex + 1);
  console.log(
    `[${state.replicaId}] SYNC-LOG serve requester=${requesterId} ` +
    `fromIndex=${start} entries=${entries.length} leaderCommit=${state.commitIndex}`
  );

  return {
    term: state.currentTerm,
    success: true,
    fromIndex: start,
    entries,
    leaderCommit: state.commitIndex,
    matchIndex: state.commitIndex,
  };
}

function _peerUrlForId(replicaId) {
  return actualPeers.find(url => {
    try { return new URL(url).hostname === replicaId; }
    catch { return url.includes(replicaId); }
  });
}

async function _replicateToPeer(peerUrl, targetEntry) {
  if (state.isPeerBlocked(peerUrl)) {
    console.warn(`[${state.replicaId}] PARTITION blocks AppendEntries to ${peerUrl}`);
    return false;
  }

  const MAX_ATTEMPTS = state.log.length + 2;
  for (let attempt = 0; attempt < MAX_ATTEMPTS && state.role === 'leader'; attempt++) {
    const nextIdx = state.nextIndex.get(peerUrl) ?? state.log.length;
    const prevLogIdx = nextIdx - 1;
    const prevLogTrm = prevLogIdx >= 0 ? (state.getEntry(prevLogIdx)?.term ?? 0) : 0;
    const entries = state.log.slice(nextIdx, targetEntry.index + 1);

    if (entries.length === 0) return false;

    try {
      const { data } = await axios.post(`${peerUrl}/append-entries`, {
        term: state.currentTerm,
        leaderId: state.replicaId,
        prevLogIndex: prevLogIdx,
        prevLogTerm: prevLogTrm,
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
        console.log(`[${state.replicaId}] AppendEntries ACK peer=${peerUrl} matchIndex=${data.matchIndex}`);
        return true;
      }

      const followerLen = (typeof data.matchIndex === 'number') ? data.matchIndex + 1 : nextIdx - 1;
      state.setNextIndex(peerUrl, Math.max(0, followerLen));
      console.warn(`[${state.replicaId}] AppendEntries NACK peer=${peerUrl} nextIndex=${state.nextIndex.get(peerUrl)}`);

      if ((state.nextIndex.get(peerUrl) ?? 0) < state.commitIndex - 3) {
        console.log(
          `[${state.replicaId}] SYNC-LOG trigger peer=${peerUrl} ` +
          `followerNextIndex=${state.nextIndex.get(peerUrl)} leaderCommit=${state.commitIndex}`
        );
        await _syncLogToPeer(peerUrl);
        return true;
      }
    } catch (err) {
      console.warn(`[${state.replicaId}] AppendEntries failed peer=${peerUrl}: ${err.message}`);
      return false;
    }
  }
  return false;
}

async function _syncLogToPeer(peerUrl) {
  if (state.isPeerBlocked(peerUrl)) {
    console.warn(`[${state.replicaId}] PARTITION blocks SyncLog to ${peerUrl}`);
    return;
  }

  const fromIndex = state.nextIndex.get(peerUrl) ?? 0;
  const entries = state.log.slice(fromIndex, state.commitIndex + 1);
  console.log(
    `[${state.replicaId}] SYNC-LOG send peer=${peerUrl} ` +
    `fromIndex=${fromIndex} entries=${entries.length} leaderCommit=${state.commitIndex}`
  );

  try {
    const { data } = await axios.post(`${peerUrl}/sync-log`, {
      term: state.currentTerm,
      leaderId: state.replicaId,
      fromIndex,
      entries,
      leaderCommit: state.commitIndex,
    }, { timeout: RPC_TIMEOUT_MS });

    if (data.success) {
      state.setMatchIndex(peerUrl, data.matchIndex);
      state.setNextIndex(peerUrl, data.matchIndex + 1);
      console.log(`[${state.replicaId}] SYNC-LOG ACK peer=${peerUrl} matchIndex=${data.matchIndex}`);
    } else if (data.term > state.currentTerm) {
      election.stepDown(data.term);
    } else {
      console.warn(`[${state.replicaId}] SYNC-LOG NACK peer=${peerUrl}`);
    }
  } catch (err) {
    console.warn(`[${state.replicaId}] SYNC-LOG failed peer=${peerUrl}: ${err.message}`);
  }
}

function _sendHeartbeats() {
  if (state.role !== 'leader') {
    stopHeartbeatLoop();
    return;
  }

  for (const peerUrl of actualPeers) {
    _sendHeartbeatToPeer(peerUrl);
  }
}

async function _sendHeartbeatToPeer(peerUrl) {
  if (_heartbeatPeerInFlight.has(peerUrl)) return;
  if (state.isPeerBlocked(peerUrl)) {
    console.warn(`[${state.replicaId}] PARTITION blocks heartbeat to ${peerUrl}`);
    return;
  }

  _heartbeatPeerInFlight.add(peerUrl);
  try {
    const { data } = await axios.post(`${peerUrl}/heartbeat`, {
      term: state.currentTerm,
      leaderId: state.replicaId,
      commitIndex: state.commitIndex,
    }, { timeout: RPC_TIMEOUT_MS });

    if (data.term > state.currentTerm) {
      election.stepDown(data.term);
    } else if (!data.success) {
      console.warn(`[${state.replicaId}] Heartbeat rejected by ${peerUrl}`);
    }
  } catch (err) {
    console.warn(`[${state.replicaId}] Heartbeat failed peer=${peerUrl}: ${err.message}`);
  } finally {
    _heartbeatPeerInFlight.delete(peerUrl);
  }
}

function _advanceCommitIndex(newIndex) {
  if (state.log[newIndex]?.term !== state.currentTerm) return;
  state.setCommitIndex(newIndex);
  console.log(`[${state.replicaId}] commitIndex -> ${newIndex}`);
}

async function _applyCommitted() {
  while (state.lastApplied < state.commitIndex) {
    const nextIdx = state.lastApplied + 1;
    const entry = state.log[nextIdx];
    if (!entry) break;
    state.setLastApplied(nextIdx);
    console.log(`[${state.replicaId}] APPLY index=${nextIdx} type=${entry.type || 'stroke'}`);
    await _notifyGatewayCommit(entry);
  }
}

function _advanceLastApplied() {
  while (state.lastApplied < state.commitIndex) {
    state.setLastApplied(state.lastApplied + 1);
  }
}

function _materializeCommittedView() {
  const visible = [];
  const visibleByStrokeId = new Map();
  const undoStack = [];

  for (const entry of state.log.slice(0, state.commitIndex + 1)) {
    if (!entry) continue;
    if (entry.type === 'clear') {
      visible.length = 0;
      visibleByStrokeId.clear();
      undoStack.length = 0;
      continue;
    }
    if (!entry.type || entry.type === 'stroke') {
      const item = { logIndex: entry.index, stroke: entry.stroke };
      visible.push(item);
      visibleByStrokeId.set(entry.stroke.strokeId, item);
      continue;
    }
    if (entry.type === 'undo') {
      const item = visibleByStrokeId.get(entry.targetStrokeId);
      if (item) {
        visible.splice(visible.indexOf(item), 1);
        visibleByStrokeId.delete(entry.targetStrokeId);
        undoStack.push(entry);
      }
      continue;
    }
    if (entry.type === 'redo') {
      const original = state.log[entry.targetLogIndex];
      if (original?.stroke && !visibleByStrokeId.has(entry.targetStrokeId)) {
        const item = { logIndex: entry.targetLogIndex, stroke: original.stroke };
        visible.push(item);
        visibleByStrokeId.set(entry.targetStrokeId, item);
        const idx = undoStack.findIndex(u => u.targetStrokeId === entry.targetStrokeId);
        if (idx >= 0) undoStack.splice(idx, 1);
      }
    }
  }

  return { visible, undoStack };
}

async function _notifyGatewayCommit(entry) {
  if (!state.gatewayUrl) return;

  try {
    if (entry.type === 'clear') {
      await axios.post(`${state.gatewayUrl}/internal/canvas-cleared`, {
        logIndex: entry.index,
        term: entry.term,
      }, { timeout: RPC_TIMEOUT_MS });
      return;
    }

    if (entry.type === 'undo') {
      await axios.post(`${state.gatewayUrl}/internal/stroke-undone`, {
        targetStrokeId: entry.targetStrokeId,
        targetLogIndex: entry.targetLogIndex,
        clientId: entry.clientId,
        vectorClock: entry.vectorClock,
        logIndex: entry.index,
        term: entry.term,
      }, { timeout: RPC_TIMEOUT_MS });
      return;
    }

    if (entry.type === 'redo') {
      const original = state.log[entry.targetLogIndex];
      await axios.post(`${state.gatewayUrl}/internal/stroke-redone`, {
        stroke: original?.stroke,
        targetStrokeId: entry.targetStrokeId,
        targetLogIndex: entry.targetLogIndex,
        clientId: entry.clientId,
        vectorClock: entry.vectorClock,
        logIndex: entry.index,
        term: entry.term,
      }, { timeout: RPC_TIMEOUT_MS });
      return;
    }

    await axios.post(`${state.gatewayUrl}/internal/stroke-committed`, {
      stroke: entry.stroke,
      logIndex: entry.index,
      term: entry.term,
    }, { timeout: RPC_TIMEOUT_MS });
  } catch (err) {
    console.warn(`[${state.replicaId}] Gateway commit notify failed: ${err.message}`);
  }
}

module.exports = {
  startHeartbeatLoop,
  stopHeartbeatLoop,
  receiveStroke,
  receiveClear,
  receiveUndo,
  receiveRedo,
  handleAppendEntries,
  handleSyncLog,
  requestSyncLogFromLeader,
};
