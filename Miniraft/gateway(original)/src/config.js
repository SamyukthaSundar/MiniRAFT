/**
 * config.js — Gateway configuration
 *
 * OWNERSHIP: Sanika (Gateway Lead)
 *
 * All replica URLs and timing constants read from environment variables so
 * docker-compose.yml is the single place to change topology.
 *
 * VARIABLE NAME FIX: standardised to REPLICA_URLS (comma-separated) instead of
 * the mix of REPLICA1_URL/REPLICA2_URL/REPLICA3_URL found in some earlier versions.
 * docker-compose.yml passes REPLICA_URLS; config.js splits them and assigns IDs.
 */
'use strict';

const REPLICA_URLS = (process.env.REPLICA_URLS || '')
  .split(',')
  .map(u => u.trim())
  .filter(Boolean);

// Derive IDs from URL hostnames (e.g. "http://replica1:3000" → "replica1")
const REPLICAS = REPLICA_URLS.map(url => ({
  id:  new URL(url).hostname,
  url,
}));

const TIMING = {
  LEADER_PROBE_INTERVAL_MS: parseInt(process.env.LEADER_PROBE_INTERVAL_MS) || 200,
  RPC_TIMEOUT_MS:           parseInt(process.env.RPC_TIMEOUT_MS)           || 300,
  STROKE_RETRY_DELAY_MS:    100,
  STROKE_MAX_RETRIES:       5,
};

const GATEWAY_PORT  = parseInt(process.env.GATEWAY_PORT)  || 4000;
const INTERNAL_PORT = parseInt(process.env.INTERNAL_PORT) || 4001;

module.exports = { REPLICAS, TIMING, GATEWAY_PORT, INTERNAL_PORT };
