# Agent ↔ dashboard protocol (v1)

One WebSocket per node, opened **by the agent** to `wss://<dashboard>/agent/ws`
with `Authorization: Bearer <nodeId>.<secret>`. Every frame is one JSON text
message with a `type` field. Timestamps are milliseconds since the Unix epoch.

The TypeScript side is `packages/protocol/src/index.ts` (zod) and the Rust side
is `agent/src/protocol.rs` (serde). Both test against the same samples in
`protocol/fixtures/*.json`, so a change to one side that the other cannot read
fails a test. Change the fixtures first.

Fields added after v0.1.0 get a default on the dashboard side, so a dashboard still
understands agents one version behind while it updates them; it never drops their
heartbeats over a field they do not know yet.

## Agent → dashboard

| type | when | fields |
|---|---|---|
| `hello` | first frame after every connect | `agentVersion`, `hostname`, `os`, `kernel`, `arch`, `cpus`, `activeJobs` (job ids still running), `sha256` (of the agent's own binary) |
| `heartbeat` | every 5 s | `ts`, `system` (`load1/5/15`, `memTotal`, `memAvailable`, `uptime`, `netRx`, `netTx`), `uvx` (path or null), `processedBytes` (monotonic counter since agent start), `lanes` (lane status list), `updatePending` (agent version installed and waiting for jobs to finish, or null) |
| `job_started` | a lane leased a model and knows its size | `lane`, `jobId`, `repo`, `revision`, `files`, `sizeBytes`, `startedAt` |
| `job_finished` | the job ended | `lane`, `jobId`, `result` (`listed` \| `already_listed` \| `refused` \| `error` \| `aborted`), `url?`, `infohash?`, `message?`, `finishedAt` |
| `log` | batched worker output | `lane`, `lines: [{ts, stream: out\|err\|agent, text}]` |
| `event` | something about the agent itself (started, lost the connection and for how long, update steps, a lane crashed, a lease wait, uv or key missing) | `ts`, `level` (`info` \| `warn` \| `error`), `text` |

Lane status: `name`, `state` (`stopped` \| `starting` \| `idle` \| `working` \|
`backoff` \| `draining` \| `error`), `pid`, `startedAt`, `restarts`, `lastExit`,
`message`, `job` (`jobId`, `repo`, `revision`, `files`, `sizeBytes`,
`doneBytes`, `startedAt`, `rateBps`) or null, `pfVersion` (the pirateface version
the worker was started with, or null).

While disconnected the agent keeps working and queues outgoing frames (job
events first; old log lines are dropped when the queue is full). It sends
`hello` and then the queue on reconnect. The dashboard marks jobs it thought
were running as `aborted` unless they are in `activeJobs`; a later
`job_finished` for the same id overwrites that.

## Dashboard → agent

| type | fields |
|---|---|
| `config` | `lanes: [{name, enabled, drain}]`, `maxSizeGiB` (0 = server cap), `idleSec`, `pirateKey` (string or null), `pirateVersion` (pin workers to `pirateface==<v>`, or null for `pirateface@latest`) |
| `command` | `id`, `action` (`restart` \| `restart_all`), `lane?`, `graceful` |
| `update` | `version`, `sha256`, `size`, `graceful`, then **one binary frame** with the agent for the node's CPU |

`config` is the desired state and is sent after every `hello` and on every
change. The agent stores it on disk and keeps running from it when the
dashboard is unreachable.

- A lane that is not in `lanes`, or has `enabled: false`, is stopped. With
  `drain: true` it finishes the current job first.
- When `maxSizeGiB`, `idleSec`, `pirateKey` or `pirateVersion` change, every lane
  restarts after its current job.
- `restart` with `graceful: false` kills the worker now (its lease lapses and the
  model goes back to the queue). With `graceful: true` it restarts after the
  current job. A restart also picks up a new `pirateface@latest`.

## Agent self-update

1. The dashboard sends `update` and the binary (on `hello` from an older agent when
   auto-update is on, or when you press **Update agent**).
2. The agent checks the size and SHA-256, writes it next to its own executable, runs
   `<new> version` and expects exactly `pf-fleet-agent <version>`, then renames it
   over its executable. Any failure leaves the old agent in place.
3. It stops starting new jobs. With `graceful: true` each lane finishes its current
   job first; with `false` the workers are stopped now.
4. With no worker left it `exec`s the new binary with the same arguments. The new
   agent reads `state.json`, starts the lanes and says `hello` with its version.

`SIGHUP` (what the install script sends to a running agent after replacing its
binary) takes the same path from step 3: finish jobs, then exec the binary on disk.

## Leases

Pirate Face holds a lease for 10 minutes after its last renewal and pf cannot release
or resume one. A lane whose worker died mid-job waits 10.5 minutes before starting
again; an unexpected `409 ... already hold lease` is rechecked every 60 s without
backoff. Leases still held at shutdown are written to `leases.json` and honoured by
the next agent process.
