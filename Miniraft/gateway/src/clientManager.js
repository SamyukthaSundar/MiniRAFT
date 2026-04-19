/**
 * clientManager.js — Manages browser WebSocket connections
 *
 * OWNERSHIP: Sanika (Gateway Lead)
 *
 * WebSocket EVENT NAME FIX:
 *   Frontend index.html listens for:
 *     'stroke:commit'   (committed stroke broadcast)
 *     'canvas:state'    (initial hydration on connect)
 *     'system:leader'   (leader change notification)
 *     'system:error'    (error from gateway)
 *
 *   These match §6.1 exactly. Sanika's original had 'stroke:committed' in
 *   one place — unified to 'stroke:commit' throughout.
 */
'use strict';

const WebSocket = require('ws');

class ClientManager {
  constructor() {
    /** @type {Map<string, WebSocket>} */
    this._clients      = new Map();
    /** @type {Array<{ logIndex: number, stroke: object, hidden?: boolean }>} */
    this._committedLog = [];
  }

  add(clientId, ws) {
    this._clients.set(clientId, ws);
    console.log(`[ClientManager] + ${clientId} (total=${this._clients.size})`);
  }

  remove(clientId) {
    this._clients.delete(clientId);
    console.log(`[ClientManager] - ${clientId} (total=${this._clients.size})`);
  }

  size() { return this._clients.size; }

  /** Record a committed stroke so new joiners can hydrate. */
  recordCommit(logIndex, stroke) {
    if (this._committedLog.some(e => e.logIndex === logIndex)) return;
    this._committedLog.push({ logIndex, stroke, hidden: false });
    this._committedLog.sort((a, b) => a.logIndex - b.logIndex);
  }

  applyUndo(targetStrokeId, logIndex, vectorClock) {
    const entry = this._committedLog.find(e => e.stroke?.strokeId === targetStrokeId);
    if (!entry) return false;
    entry.hidden = true;
    console.log(`[ClientManager] UNDO compensation logIndex=${logIndex} targetStrokeId=${targetStrokeId} vector=${JSON.stringify(vectorClock || {})}`);
    return true;
  }

  applyRedo(targetStrokeId, logIndex, vectorClock) {
    const entry = this._committedLog.find(e => e.stroke?.strokeId === targetStrokeId);
    if (!entry) return false;
    entry.hidden = false;
    console.log(`[ClientManager] REDO compensation logIndex=${logIndex} targetStrokeId=${targetStrokeId} vector=${JSON.stringify(vectorClock || {})}`);
    return true;
  }

  visibleLog() {
    return this._committedLog.filter(e => !e.hidden);
  }

  /** Clear the committed log when canvas is cleared via Raft. */
  clearLog(logIndex, term) {
    console.log(`[ClientManager] Canvas cleared — log truncated at index ${logIndex} (term ${term})`);
    this._committedLog = []; // Empty the log so new clients see empty canvas
  }

  /** Send canvas:state to a freshly connected client (§6.1). */
  sendInitialState(ws) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      event:   'canvas:state',
      strokes: this.visibleLog(),
    }));
  }

  /**
   * Broadcast to all connected clients.
   * EVENT NAME FIX: caller passes the exact event name from §6.1.
   */
  broadcast(event, payload) {
    const msg = JSON.stringify({ event, ...payload });
    let sent = 0, dropped = 0;
    for (const [, ws] of this._clients) {
      if (ws.readyState === WebSocket.OPEN) { ws.send(msg); sent++; }
      else dropped++;
    }
    if (dropped > 0) console.warn(`[ClientManager] broadcast ${event}: sent=${sent} dropped=${dropped}`);
  }

  /** Send system:error to a specific client (§6.1). */
  sendError(clientId, code, message, strokeId) {
    const ws = this._clients.get(clientId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ event: 'system:error', code, message, strokeId }));
  }
}

module.exports = new ClientManager();
