# MiniRaft Distributed Drawing Board

MiniRaft is a collaborative drawing board backed by a Raft-style replicated log. The browser sends drawing commands to the gateway, the gateway forwards them to the current leader, and the leader commits them only after a quorum of replicas acknowledges the log entry.

## Repository Layout

This repository now matches the expected source structure:

- `gateway/` - WebSocket and HTTP gateway
- `replica1/` - first Raft replica service
- `replica2/` - second Raft replica service
- `replica3/` - third Raft replica service
- `replica4/` - fourth Raft replica service
- `frontend/` - browser drawing board and dashboard
- `docker-compose.yml` - four replicas plus gateway
- `logs/` - sample failover, sync-log, partition, and hot-reload event logs

`replica-logic/` is kept as a reference copy of the shared replica implementation. Docker Compose uses the four concrete `replica1` to `replica4` folders so the submitted source tree visibly contains each replica.

## Implemented Requirements

- Four-replica Raft cluster with dynamic quorum calculation.
- Leader election, heartbeat, append entries, and `/sync-log` endpoint.
- Network partition simulation through per-replica admin endpoints.
- Vector-based undo/redo using compensation log entries.
- Dashboard showing leader, term, commit index, log size, and partition status for all replicas.
- Hot reload for any replica through bind mounts and nodemon.
- Logs with failover, sync-log, split-brain simulation, and hot-reload examples.

## Run

```bash
docker compose up --build
```

Open:

```text
http://localhost:4000
```

Ports:

| Service | Host port |
| --- | --- |
| Gateway UI and WebSocket | 4000 |
| Gateway internal API | 4001 |
| Replica 1 | 3001 |
| Replica 2 | 3002 |
| Replica 3 | 3003 |
| Replica 4 | 3004 |

## Useful Checks

View all logs:

```bash
docker compose logs -f
```

Check dashboard API:

```bash
curl http://localhost:4000/cluster/status
```

Check one replica:

```bash
curl http://localhost:3001/status
```

## Simulate Failover

Stop the current leader container. For example:

```bash
docker compose stop replica1
docker compose logs -f gateway replica2 replica3 replica4
```

The remaining three replicas can still reach quorum `3` in a four-node cluster only when all three are alive. A new leader will be elected and the gateway dashboard will update.

Bring the replica back:

```bash
docker compose start replica1
```

## Simulate Network Partitions

The partition simulation is application-level. A replica can be told to block selected peer IDs.

Example split into `{replica1, replica2}` and `{replica3, replica4}`:

```bash
curl -X POST http://localhost:3001/admin/partition -H "Content-Type: application/json" -d "{\"blockedPeers\":[\"replica3\",\"replica4\"]}"
curl -X POST http://localhost:3002/admin/partition -H "Content-Type: application/json" -d "{\"blockedPeers\":[\"replica3\",\"replica4\"]}"
curl -X POST http://localhost:3003/admin/partition -H "Content-Type: application/json" -d "{\"blockedPeers\":[\"replica1\",\"replica2\"]}"
curl -X POST http://localhost:3004/admin/partition -H "Content-Type: application/json" -d "{\"blockedPeers\":[\"replica1\",\"replica2\"]}"
```

With a four-node cluster the quorum is `3`, so neither two-node side can commit new drawing entries. The logs will show `PARTITION blocks ...` and `Could not reach quorum`.

Heal:

```bash
curl -X POST http://localhost:3001/admin/heal
curl -X POST http://localhost:3002/admin/heal
curl -X POST http://localhost:3003/admin/heal
curl -X POST http://localhost:3004/admin/heal
```

## Undo and Redo

The frontend has Undo and Redo buttons. Each request includes a vector clock entry for the browser client:

```json
{ "client-id": 7 }
```

Undo does not delete log history. The leader appends an `undo` compensation entry pointing at the original stroke log index and stroke ID. Redo appends a `redo` compensation entry that re-materializes the compensated stroke. This preserves an auditable replicated log.

## Hot Reload

Each replica folder is bind-mounted into its own container:

```yaml
volumes:
  - ./replica2:/app
  - /app/node_modules
```

To demonstrate hot reload, edit a file such as:

```text
replica2/src/server.js
```

Nodemon restarts only `replica2`. The other replicas and gateway remain live. The restarted replica loads its persisted state from `/tmp/.raft-replica2.json` and rejoins.

## Important Log Lines

Look for these in `docker compose logs -f`:

- `LEADER elected: term=...`
- `LOG append index=... type=stroke`
- `AppendEntries ACK peer=...`
- `LOG committed index=...`
- `SYNC-LOG send peer=...`
- `SYNC-LOG applied from=...`
- `PARTITION blocks ...`
- `UNDO compensation ...`
- `REDO compensation ...`
- `SIGTERM - shutting down`
- `Shutdown complete`
