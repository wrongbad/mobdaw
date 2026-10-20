# Agent API

Agents (Claude Code, scripts) take part in a cloud project the way a person does: they show up in presence, read and write chat,
read the project in an easy-to-parse form and edit it. Agents never speak Yjs: the server holds every live document and runs their
reads and writes through the `shared/src/schema.ts` mutators, so the API follows whatever schema is deployed.

Everything an API token does appears as **"`<username>` (api)"** (for user `k`: `k (api)`, mentioned as `@k(api)`). There is no
separate agent account: the token acts with its owner's membership and role. Owners and editors only (viewers do not take part
live); a read-only account or a frozen project can read but not write (`403 account_read_only` / `project_frozen`).

Code: `server/src/apiTokens.ts` (tokens), `agentHub.ts` (presence and the event feed), `agentOps.ts` (ops), `agentService.ts`
(the operations), `routes/agent.ts` (HTTP), `mcp.ts` (MCP), `shared/src/agentView.ts` (the state view).

## Tokens
Create one on the **account page** ("api tokens"): give it a name, copy it (shown once; the server keeps only its SHA-256), revoke it
there when done. Tokens look like `mdw_...`.

- `GET /api/me/api-tokens` -> `[{id, name, createdAt, lastUsedAt}]`; `POST /api/me/api-tokens {name?}` -> `{id, name, ..., token}` (201;
  at most 20 per user); `DELETE /api/me/api-tokens/:id`. These need a **session**: a token can't list, make or revoke tokens.
- Send it as `Authorization: Bearer mdw_...` to `/api/agent/*`, `/mcp` and the collab WebSocket (`token` of the Hocuspocus provider;
  the connection then has `via: 'api'` and the name "k (api)"). It is refused everywhere else (`/api/me`, projects, ...). The agent
  routes also take a session token as Bearer (never the cookie).
- **Revoking is immediate**: the next request is a 401, the agent's presence is removed, its open WebSocket connections are closed.
  Deleting the account and the admin `passwd` command revoke every token of the user (the CLI runs in another process: its effect on
  open connections and presence arrives within a minute).

## Routes (`/api/agent`, JSON)
Errors are `{error, message}` with 400 (`bad_request`, `bad_ops` with `op`: the failing op's index), 401, 403, 404.

| Route | |
|---|---|
| `GET /projects` | `[{id, name, role, canEdit}]`: where you are owner or editor. |
| `GET /projects/:id/state?format=json\|text` | The project (see "State"). `text` is `text/plain`. |
| `POST /projects/:id/ops {label?, ops}` | Validate, then apply all ops in one transaction -> `{ids: [...], seq}`. |
| `GET /projects/:id/chat?since=<ts>&limit=` | `{messages: [{id, username, text, ts, mentions?, mentionsMe}], ts}`; messages with `ts` after `since`. |
| `POST /projects/:id/chat {text}` | Post as "k (api)"; mentions are parsed against the members and who is present. Returns the message. |
| `GET /projects/:id/history?since=<seq>&limit=` | The change log (`{seq, ts, username, text, via, api}`), oldest first. |
| `POST /projects/:id/history/:seq/revert` and `/restore` | As the History panel does ("revert this", "restore to this version"), logged as "k (api)". `{applied, skipped, seq}`. |
| `GET /projects/:id/events?since=<cursor>&wait=<s>` | Long-poll, see "Events". |
| `GET /catalog` | The ops reference and the device types with their params, as text. |

## State
`GET .../state` is `agentView(doc)` plus `rev` (the latest history seq):

```json
{ "rev": 12, "meta": {"ppq": 960, "sampleRate": 48000, "key": "D minor"},
  "regions": [{"id": "default", "bar": 1, "kind": "metered", "bpm": 120, "meter": "4/4", "beatTicks": 960, "barTicks": 3840}],
  "markers": [{"id": "...", "bar": 9, "label": "Chorus"}],
  "tracks": [{"id": "...", "name": "Bass", "kind": "midi", "muted": false, "soloed": false,
    "devices": [{"id": "...", "type": "finnwave", "typeId": 2, "params": {"rolloff": 0.3, "...": 0}}, {"type": "mix", "params": {"volume": 1, "pan": 0}}],
    "clips": [{"id": "...", "kind": "midi", "start": "2.1.0", "startTick": 3840, "lengthTicks": 7680, "length": "2 bars",
               "end": "4.1.0", "loopTicks": 3840, "notes": [{"id": "...", "p": "C2", "pitch": 36, "t": 0, "d": 240, "v": 100}]}]}],
  "master": {"devices": []} }
```
Positions are `bar.beat.tick` (bar and beat from 1, tick within the beat; a beat is a `1/den` note, so an eighth in 7/8) next to ticks
from bar 1. Note `t` and `d` are ticks inside the clip. Velocity `v` is MIDI 1..127. Audio clips show `start` (the position),
`startSeconds`, `lengthSeconds` and the sample name; they can be moved and resized but not created yet. `format=text` is the same as a
compact outline (ids in brackets) for prompting.

## Ops
`POST .../ops {"label": "drum loop", "ops": [ {"op": "addTrack", ...}, ... ]}`. The batch is checked field by field (an unknown
field or a wrong type names the op), then run on a scratch copy of the live document; only if every op works is its change applied
to the live document, inside one transaction attributed to "k (api)". So a batch is **all or nothing and one history entry**, named
`label` (cut to 40 characters; without one the usual description is used). At most 500 ops and 5000 notes per batch.

Conventions: positions are `"5"`, `"5.3"`, `"9.3.240"` or a tick number. Lengths (clip length, loop, note `t`/`d`) are ticks or
unit text: `"4 bars"`, `"1 bar 2 beats"`, `"3 beats"`, `"240 ticks"`. Pitches `"C4"` (middle C = 60), `"F#3"`, `"Bb2"` or a number
0..127. `"$N"` in an id field is the id op N (0-based, earlier in the batch) returned; `addNotes` returns a list (`"$N.0"`).

| Op | Fields |
|---|---|
| `addTrack` | `name`, `kind?` (`midi` default, `audio`), `preset?` (an instrument name, e.g. `"finnwave"`, or `"none"`; midi tracks get `finnwave` by default) |
| `updateTrack` / `removeTrack` | `id`, `name?`, `muted?`, `soloed?`, `color?` / `id` |
| `addMidiClip` | `trackId`, `start`, `length`, `loop?` (pattern length), `view?` (`"drums"`) |
| `updateClip` / `removeClip` | `id`, `start?`, `length?`, `trackId?`, `loop?` (0 or null clears), `view?` / `id` |
| `addNotes` | `clipId`, `notes: [{p\|pitch, t, d, v?}]` |
| `updateNotes` / `removeNotes` | `notes: [{id, p?, t?, d?, v?}]` / `ids` |
| `addDevice` | `trackId` (or `"master"`), `type` (name, see `/catalog`), `name?`, `key?` (a one-key drum), `params?: {name: value}` |
| `removeDevice` / `setParam` | `id` / `deviceId`, `param` (name), `value` (number, or an option name; clamped to the range) |
| `addRegion` | `bar`, `bpm?`, `meter?` (`"7/8"`, `"7/8 2+2+3"`), `rampTo?`, `free?` (seconds: one unmetered bar); replaces the region starting at that bar; unset fields carry on from before |
| `setRegion` / `removeRegion` | `id` or `bar`, `bpm?`, `meter?`, `rampTo?` (null clears), `free?` / `id` or `bar` |
| `addMarker` / `updateMarker` / `removeMarker` | `bar`, `label`, `text?` / `id`, ... / `id` |
| `setKey` | `key` (display only; `""` clears) |

Not in v1: audio import, automation lanes, loopers, per-track presets (client-side content).

## Events
`GET .../events?since=<cursor>&wait=25` returns `{cursor, events, gap?}`. Without `since` it starts from now (`events` empty;
use the returned `cursor` next). With events after `since` it answers at once; otherwise after `wait` seconds (max 25; 0 = don't
wait) or when the first arrives. Pass the returned `cursor` as the next `since`. What you did yourself is left out.

- `{type: 'chat', message, mentionsMe}`: `mentionsMe` is true when the message mentions your handle (`@k(api)`).
- `{type: 'history', entry}`: someone else's change (`{seq, username, text, ts, api?}`).
- `{type: 'presence', joined}` / `{type: 'presence', left}`: a name arrived / left (once per name, not per tab).
- `gap: true`: events before your cursor were not kept (the buffer holds 500 events and exists only while an agent is active in the
  project): re-read state and chat.

## Presence
While an agent is **active** in a project (any request to it in the last 60 s, or an open `events` wait) the server publishes a
state into the document's awareness under its own client id, `{user: {username: "k (api)", color}, api: true}`, which Hocuspocus
broadcasts like a browser's. In the bar it is a dot with a dashed ring and `[k]` as the initial, titled "k (api) — via API". It
is removed 60 s after the last request (`AGENT_IDLE_MS`), when the token is revoked, or the server stops. Presence is per token
and project; the project's document is kept loaded for as long as an agent is present.

## MCP
`POST /mcp` is a stateless streamable-HTTP MCP server (JSON responses; GET and DELETE answer 405), authenticated with the same
Bearer token. Tools: `list_projects`, `get_state {projectId, format}`, `apply_ops {projectId, label?, ops}`, `send_chat`,
`get_chat`, `wait_for_events {projectId, since?, wait?}`, `get_history`, `revert {projectId, seq}`, `restore`. The `apply_ops`
description carries the ops reference. They are wrappers over the same functions as the routes.

```
claude mcp add --transport http mobdaw https://<host>/mcp --header "Authorization: Bearer mdw_..."
```
(In production under a path prefix: `https://wrongbad.com/mobdaw/mcp`. In dev: `http://localhost:5173/mcp`, proxied by Vite, or
`http://localhost:8787/mcp`.)

## A suggested agent loop
1. `list_projects`; pick the project. `wait_for_events` (no `since`) to get a cursor.
2. Loop: `wait_for_events {since, wait: 25}`. For a chat event with `mentionsMe`, read the request.
3. `get_state` (text for reading, json for exact values) and think in bars and beats.
4. `apply_ops` with a short `label` ("bassline v2"): one batch per idea, so a person can revert it from the History panel.
5. `send_chat` to answer (mention people with `@name`), then back to 2. If something went wrong, `revert` the entry (`seq` from
   the `apply_ops` result).

Try it with `curl`:
```
curl -H "Authorization: Bearer $T" $BASE/api/agent/projects
curl -H "Authorization: Bearer $T" "$BASE/api/agent/projects/$P/state?format=text"
curl -H "Authorization: Bearer $T" -H 'content-type: application/json' -d '{"label":"hello","ops":[{"op":"addTrack","name":"Pad"}]}' $BASE/api/agent/projects/$P/ops
```
