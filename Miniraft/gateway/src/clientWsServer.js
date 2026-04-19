/**
 * clientWsServer.js — Public WebSocket server for browser clients
 *
 * OWNERSHIP: Sanika (Gateway Lead)
 *
 * Handles §6.1 events:
 *   Client → Gateway:  stroke:new
 *   Gateway → Client:  stroke:commit, canvas:state, system:leader, system:error
 */
'use strict';

const WebSocket     = require('ws');
const { v4: uuid }  = require('uuid');
const clientManager = require('./clientManager');
const leaderTracker = require('./leaderTracker');
const { forwardStroke, forwardClear, forwardHistoryCommand } = require('./strokeForwarder');

function createClientWsServer(httpServer) {
  const wss = new WebSocket.Server({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const clientId = uuid();
    clientManager.add(clientId, ws);
    clientManager.sendInitialState(ws);

    // Inform new client about current leader (observability)
    const leader = leaderTracker.getLeader();
    if (leader) {
      _send(ws, {
        event:    'system:leader',
        leaderId: leader.id,
        term:     leaderTracker._leader?.term ?? 0,
      });
    }

    ws.on('message', raw => _handleMessage(ws, clientId, raw));
    ws.on('close',   ()  => clientManager.remove(clientId));
    ws.on('error',   ()  => clientManager.remove(clientId));
  });

  // Broadcast leader changes to all clients
  leaderTracker.on('change', leader => {
    if (!leader) {
      clientManager.broadcast('system:no-leader', {});
      return;
    }

    clientManager.broadcast('system:leader', {
      leaderId: leader.id,
      term:     leaderTracker._leader?.term ?? 0,
    });
  });

  return wss;
}

async function _handleMessage(ws, clientId, raw) {
  let msg;
  try { msg = JSON.parse(raw.toString()); }
  catch { _send(ws, { event: 'system:error', code: 'INVALID_JSON', message: 'Message must be valid JSON.' }); return; }

  if (msg.event === 'stroke:new') {
    const { stroke } = msg;
    if (!_validateStroke(stroke)) {
      _send(ws, { event: 'system:error', code: 'INVALID_STROKE', message: 'Stroke payload is malformed.', strokeId: stroke?.strokeId });
      return;
    }
    await forwardStroke(stroke, clientId);
    return;
  }

  if (msg.event === 'canvas:clear') {
    await forwardClear(clientId);
    return;
  }

  if (msg.event === 'history:undo') {
    await forwardHistoryCommand('undo', msg.clientId || clientId, clientId, msg.vectorClock);
    return;
  }

  if (msg.event === 'history:redo') {
    await forwardHistoryCommand('redo', msg.clientId || clientId, clientId, msg.vectorClock);
    return;
  }
}

function _validateStroke(s) {
  if (!s || typeof s !== 'object') return false;
  if (typeof s.strokeId !== 'string' || !s.strokeId) return false;
  if (typeof s.clientId !== 'string' || !s.clientId) return false;
  if (typeof s.color !== 'string' || !s.color.match(/^#[0-9A-Fa-f]{6}$/)) return false;
  if (typeof s.width !== 'number' || s.width <= 0) return false;
  if (!Array.isArray(s.points) || s.points.length < 2) return false;
  if (typeof s.timestamp !== 'number') return false;
  return true;
}

function _send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

module.exports = { createClientWsServer };
