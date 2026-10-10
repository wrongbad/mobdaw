# mobdaw — Implementation Spec (pass 1)

mobdaw is a web DAW (digital audio workstation) where several people edit the same project
at once, in real time. It is invite-only: the owner and their friends. The owner pays for
storage.

**Guiding principle: least code to maintain.** Prefer well-known libraries to custom
infrastructure. Write no clever abstractions beyond what this spec asks for.

## Scope of this pass
1. Backend:
   - Hocuspocus sync server
   - auth (username + password, invite-only registration)
   - invites
   - project access control
   - sample storage (local and S3 drivers)
   - SQLite persistence
2. A bare-bones web client:
   - login and registration (with an invite code)
   - project list and sharing
   - an admin invites page
   - a **minimal, low-clutter timeline**

Not in scope:
- MIDI
- effects
- real-time jamming
- mixing UI beyond per-track gain and mute

The owner has strong minimalist opinions about the eventual DAW UI and will redesign it.
Keep the timeline small, plain and isolated.

## Stack
- **Language:** TypeScript everywhere. ESM. Node 24 (the machine has v24.3.0). npm workspaces.
- **Server packages:**
  - `@hocuspocus/server` (latest major) and `yjs`
  - `node:sqlite` (built into Node; no native deps)
  - `hono` with `@hono/node-server` for HTTP, or plain `node:http` if simpler
  - password hashing with Node's built-in scrypt (no extra dependency)
  - `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` for the S3 driver
  - `tsx` for dev and running
  - `vitest` for tests
- **Client packages:**
  - Vite with **vanilla TypeScript** (no UI framework)
  - `yjs`, `@hocuspocus/provider`
  - Plain CSS
- One Node process serves both the HTTP API and the WebSocket. The WebSocket upgrade happens
  on path `/collab`. Check the installed Hocuspocus version's API in `node_modules` rather
  than relying on memory.

## Repo layout
```
package.json            # workspaces: shared, server, client; scripts: dev, build, test, typecheck
shared/src/schema.ts    # Yjs doc schema helpers + awareness types (used by client; server may import)
shared/src/api.ts       # API request/response types
server/src/...          # config.ts, db.ts, auth.ts, storage/{index,local,s3}.ts, routes/*.ts, collab.ts, main.ts
server/scripts/admin.ts # CLI: create-invite, list-invites, create-user, passwd, make-admin
server/test/...
client/index.html, client/src/...   # see Client section
deploy/Caddyfile, deploy/mobdaw.service, deploy/README.md
.env.example, .gitignore (node_modules, data/, dist/, .env)
```

## Config (env vars; load `.env` at the repo root with `node --env-file-if-exists`)
| var | default | notes |
|---|---|---|
| PORT | 8787 | |
| PUBLIC_URL | http://localhost:5173 | Used to build invite links; its path (e.g. `/mobdaw`) is the base path the app is served under. |
| SESSION_SECRET | random per boot in dev, required in prod | HMAC key for session tokens and signed storage URLs. |
| DB_PATH | ./data/mobdaw.db | |
| STORAGE_DRIVER | local | `local` or `s3`. |
| STORAGE_DIR | ./data/samples | Used by the local driver. |
| S3_BUCKET, S3_REGION | — | Used by the s3 driver. Credentials come from the standard AWS chain (EC2 instance role). |
| MAX_UPLOAD_BYTES | 4294967296 | 4 GiB, enough for an hour at 96k/24-bit stereo. S3 single PUT max is 5 GB. |
| USER_QUOTA_BYTES | 42949672960 | 40 GiB. |

## Auth model
- **Accounts:**
  - Usernames are lowercased, 3-32 chars of `a-z 0-9 _ . -`. No email is collected.
  - Passwords are 8-200 characters, hashed with scrypt (N=2^16, r=8, p=1, 16-byte random salt),
    stored as `scrypt$N$r$p$salt$hash` in `users.password_hash`.
  - `POST /api/auth/register {username, password, invite}` creates the account (consuming the
    invite) and signs in. `POST /api/auth/login {username, password}` signs in. Unknown users
    and wrong passwords both return 401 `invalid_credentials` (an unknown user still costs one
    hash). 8 failures per username in 15 minutes return 429 `too_many_attempts` (in memory).
  - There is no self-serve password change; an admin runs `npm run admin -- passwd <username>`.
- **Session:**
  - The server mints its own token: `base64url(JSON{username,exp}) + "." + HMAC-SHA256`.
    It lasts 30 days. It is only honored while the user still exists.
  - The token is set as an httpOnly cookie `mobdaw_session` (SameSite=Lax; Secure when
    PUBLIC_URL is https; Path = PUBLIC_URL's path). It is also returned in the JSON body so the
    WS provider can pass it as `token`.
- **Everyone with an account is a full user.** There is no signed-in-but-not-admitted state.
  Signed-out requests get 401 `not_signed_in`. Admins (`users.is_admin`) are created with
  `npm run admin -- create-user <username> --admin` (or `make-admin`); there is no config list.
- **Invites:**
  - Only admins can create them, via the API, the invites page, or `npm run admin -- create-invite`.
  - The token is 32 random bytes in base64url. Invites are single-use. Expiry is optional.
  - The invite link is `${PUBLIC_URL}/#/register/<token>`, which prefills the register form.
  - Registering with a bad code returns 400 `invite_invalid`; a used one 410 `invite_used`; an
    expired one 410 `invite_expired`. A taken username returns 409 `username_taken`
    (400 `bad_username` / `bad_password` for invalid input; the invite is only consumed on success).

## SQLite schema
```sql
users(username TEXT PRIMARY KEY, password_hash TEXT, is_admin INTEGER NOT NULL DEFAULT 0, bytes_used INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)
invites(token TEXT PRIMARY KEY, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER, redeemed_by TEXT, redeemed_at INTEGER)
projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_username TEXT NOT NULL, created_at INTEGER NOT NULL)
project_members(project_id TEXT NOT NULL, username TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','editor')), PRIMARY KEY(project_id,username))
documents(name TEXT PRIMARY KEY, data BLOB NOT NULL, updated_at INTEGER NOT NULL)   -- Yjs state (Y.encodeStateAsUpdate)
samples(hash TEXT PRIMARY KEY, size INTEGER NOT NULL, mime TEXT NOT NULL, uploaded_by TEXT NOT NULL, created_at INTEGER NOT NULL, complete INTEGER NOT NULL DEFAULT 0)
```
Timestamps are ms epoch. Project ids are random url-safe strings of about 12 characters.

## HTTP API (JSON; all under `/api`)
- `POST /auth/login` returns `{token, me}`. `POST /auth/logout` clears the cookie.
- `GET /me` returns `{username,isAdmin,bytesUsed,quotaBytes}`, or 401 when not
  signed in.
- Admin only:
  - `POST /invites` with `{expiresInDays?}` returns `{token,url}`, where
    url = `${PUBLIC_URL}/#/register/${token}`.
  - `GET /invites` returns a list.
- `GET /users` returns `[{username}]`: all users, for the share picker.
- Projects:
  - `GET /projects` lists the projects the user belongs to.
  - `POST /projects` with `{name}` creates a project with the caller as owner.
  - `GET /projects/:id` returns the project plus its members. Members only; otherwise 404.
  - `POST /projects/:id/members` with `{username}` is owner only. The target must exist;
    otherwise 400 `{error:"not_admitted"}`.
  - `DELETE /projects/:id/members/:username` is owner only. The owner cannot be removed.
- Samples. The hash is the lowercase hex SHA-256 of the file bytes. Any admitted user may
  use these endpoints.
  - `POST /samples/upload-url` with `{hash,size,mime}`:
    - Returns `{exists:true}` if the sample is already complete.
    - Returns 413 if size > MAX_UPLOAD_BYTES.
    - Returns 403 `{error:"quota_exceeded"}` if bytes_used + size > quota.
    - Otherwise returns `{exists:false, url, method:"PUT", headers}`.
    - **local driver:** url = `/api/storage/:hash?exp=..&sig=..` (HMAC). The PUT handler
      checks the signature and expiry, enforces the size limit while streaming, verifies
      that the body's SHA-256 equals the hash, and writes `STORAGE_DIR/<hash>` atomically
      (temp file, then rename).
    - **s3 driver:** presigned PutObject for key `samples/<hash>`, with ContentLength,
      ContentType and ChecksumSHA256 (base64 of the hash bytes) signed, so S3 itself
      rejects mismatched content. `headers` lists the headers the client must send.
  - `POST /samples/:hash/complete`:
    - The server confirms the object exists with the expected size (local: stat; s3:
      HeadObject).
    - It marks the sample complete and adds the size to the uploader's `bytes_used`, once
      only.
    - It returns `{ok:true}`.
  - `GET /samples/:hash/url` returns `{url}`, a signed GET valid for 1 hour.
    - local: `/api/storage/:hash?exp&sig`, served with `Cache-Control: private,
      max-age=31536000, immutable` and the stored mime type.
    - s3: presigned GetObject.
- `GET /storage/:hash` and `PUT /storage/:hash` exist for the local driver only, and are
  authorized by signature alone (no cookie needed).

## WebSocket (Hocuspocus)
- Document name: `project:<projectId>`.
- `onAuthenticate` verifies the session token, the admitted status and membership. If any
  check fails, it throws, and the connection is rejected. It sets
  `context = {username, role}`.
- Persistence uses `@hocuspocus/extension-database` with fetch/store against the
  `documents` table. Use a debounce of about 2 seconds, which is the default behavior.
- If a member is removed while connected, accept that they stay connected until reconnect.
  Note this in the README.

## Yjs document schema (`shared/src/schema.ts`)
Times are in **seconds** for this pass. Beat-based timing comes later.
```ts
doc.getMap('meta')    // { bpm: number (default 120) }
doc.getMap('tracks')  // trackId -> Y.Map { id, name, order: number (fractional; insert between = average), gain: number 0..1, muted: boolean }
doc.getMap('clips')   // clipId -> Y.Map { id, trackId, sampleHash, start: number, offset: number, duration: number, gain: number }
doc.getMap('samples') // hash -> plain object { hash, name, duration, size, mime }
```
- Clips are not stored inside tracks. They are a flat keyed map with `trackId`, so moving a
  clip between tracks is a single field change and concurrent edits merge cleanly.
- Export typed helpers:
  - `getTracks(doc)`, `getClips(doc)`
  - `addTrack(doc, name)`, `addClip(doc, {...})`, `moveClip`, `trimClip`
  - `deleteClip`, `deleteTrack` (also deletes the track's clips)
  - `newId()`
  - Use `doc.transact` for anything with multiple steps.
- Awareness state type:
  `{ user: {username, color}, playhead?: number | null, selection?: string[] }`.

## Client
- Hash routes:
  - `#/login` has a username and password form, with a link to register.
  - `#/register/:code?` has invite code, username, password and confirm fields; the code is
    prefilled from the link and the page says registration is invite-only.
  - The home page (no hash) lists projects, has a create form, and lets the owner share each project
    (pick from `/users`).
  - `#/project/:id` is the timeline.
  - `#/admin` (admins only) creates an invite, shows a copyable link, and lists invites.
- Dev server: Vite proxies `/api` and `/collab` (ws: true) to `localhost:8787`.
- **Sample pipeline** (`client/src/samples.ts`):
  1. On file drop: read the ArrayBuffer and compute SHA-256 with `crypto.subtle`.
  2. POST `upload-url`; if needed, PUT the file with the returned headers, then POST
     `complete`.
  3. Decode the audio to get its duration. Write metadata to `doc.samples` and create a clip.
- Loading samples: `getSampleBuffer(hash)` checks an in-memory map, then the Cache API
  (`caches.open('mobdaw-samples')`, keyed by `/sample/<hash>`), then fetches a signed URL.
  It decodes, memoizes and dedupes in-flight requests.
- **Audio engine** (`client/src/audio/engine.ts`, kept isolated; it will be redesigned later):
  - One AudioContext and a master gain. Each track gets a GainNode for gain and mute.
  - `play(fromSec)` schedules an AudioBufferSourceNode for every clip that overlaps the
    window, using `start(when, offset, duration)` and handling clips already in progress.
    `stop()`.
  - Expose `currentTime()` for the playhead.
  - If the doc changes during playback, simply restart scheduling from the current position.
- **Timeline UI** (`client/src/ui/timeline.ts`), absolutely positioned DOM. Keep it low
  clutter:
  - Thin top bar: project name, a play/stop button (Space toggles), and a time readout.
    Presence dots appear on the right, one per connected user in their color, with initials.
  - Lanes are full width. Each has a slim left header with the track name (double-click to
    rename), a mute toggle and a gain slider. Put a subtle "+ track" link below the last lane.
  - A ruler with second ticks. Clicking the ruler seeks.
  - Clips are rounded blocks showing the sample name. A waveform is optional; skip it if it
    adds bulk.
    - Drag a clip to move it in time and across lanes.
    - Drag its right edge to trim the duration. Clamp the duration to the sample length
      minus the offset.
    - Click to select. Delete/Backspace removes the selection.
  - Dropping audio files on a lane uploads them and places clips at the drop position.
  - Zoom: Ctrl/Cmd plus the wheel changes pixels per second. Plain wheel scrolls.
  - Remote presence: other users' selections get an outline in their color, and their
    playheads are drawn as thin lines in their color while they play.
  - Undo and redo use `Y.UndoManager` over tracks, clips and meta, tracking only local
    origins. Bind Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z.
  - Dragging updates the Yjs doc on pointermove, with a light rAF throttle, so others see
    the clip move live. Group each drag into one undo step (`captureTimeout`, or
    `stopCapturing()` on pointerup).
- **Styling:** dark neutral background and a single accent color. System font. No icon
  libraries. Little chrome, generous spacing.

## Deploy artifacts (written, not executed)
- `deploy/Caddyfile`: `{$DOMAIN}` serving `client/dist` as static files and reverse-proxying
  `/api/*` and `/collab*` to `localhost:8787`.
- `deploy/mobdaw.service`: a systemd unit running `node --env-file=/etc/mobdaw.env` on the
  server entry point via tsx, or on a compiled build. Pick one and document it.
- `deploy/README.md` covers:
  - EC2 setup steps
  - creating the first admin with `create-user --admin`
  - S3 bucket plus an IAM instance-role policy (s3:PutObject/GetObject on
    `samples/*`, s3:ListBucket for HeadObject 404s)
  - an AWS Budget alert
  - a nightly SQLite backup (`sqlite3 .backup` or `VACUUM INTO`, then `aws s3 cp`)

## Root README.md
Quick start:
```
npm install
cp .env.example .env
npm run admin -- create-user you --admin
npm run dev
```
Then open http://localhost:5173 and log in. Create an invite, open its link in a private window,
and register a second user. Share a project and edit together.

---

# Pass 2: Ownership & access policy

This section **supersedes** earlier sections wherever they conflict. Decided with the owner
on 2026-10-06.

> Upload ownership, deletion and retention are defined by [`data-policy.md`](data-policy.md),
> which supersedes this section where they conflict.

## Principles
- **Audio is immutable and append-only per project.**
  - Once a sample is added to a project, it is in that project's *library* for as long as
    the project exists.
  - Deleting a clip removes a placement on the timeline, never audio. Undo always works.
  - Audio bytes are deleted only when no project references them any more.
- **The arrangement is shared.** Every editor can edit or delete any track or clip. Undo
  only covers a user's own edits. There is no version history in this pass (deferred).
- **The database is the authority on ownership and access.** The Yjs doc is only the
  editing surface. A hash referenced in a doc but not linked in the DB is not readable.
- **Access is revocable; content is not retroactively unshared.** A removed member keeps
  whatever their browser already downloaded, and any signed URL they hold until it
  expires. Download URLs last **15 minutes**; the client caches bytes forever anyway.

## Ownership tree
```
users ──owns──> projects ──members──> project_members(role: owner | editor | viewer)
                   │
                   └──library──> project_samples(project_id, hash, added_by, added_at)
                                        │
users <──charged── samples(hash, size, mime, uploaded_by, state) ──> storage object samples/<hash>
```
- A project has exactly one owner, its creator. Ownership transfer is deferred.
- Samples are shared across libraries by reference. A sample whose last `project_samples`
  link is removed gets garbage-collected, both its row and its object. The uploader's
  `bytes_used` is refunded when the sample is purged.
- **Quota:** the uploader is charged for their lifetime, once per sample. Bytes stay charged
  even if the sample is used in other people's projects, and even if the uploader leaves
  those projects.

## Roles
| action | owner | editor | viewer |
|---|---|---|---|
| open project, play, download samples | ✓ | ✓ | ✓ |
| edit arrangement (Yjs writes) | ✓ | ✓ | ✗ (read-only WS connection) |
| add samples to the library (upload/attach) | ✓ | ✓ | ✗ |
| save a copy (new project owned by the caller) | ✓ | ✓ | ✓ |
| leave project | ✗ | ✓ | ✓ |
| rename, add/remove members, change roles | ✓ | ✗ | ✗ |
| delete project | ✓ | ✗ | ✗ |

## Deletion
**Project delete is immediate.** `DELETE /projects/:id` is owner only. In one transaction it:
- deletes the members, the project row and the Yjs `documents` row
- deletes the `project_samples` links
- marks every sample left with zero links as `state='deleting'`

After that:
- The GC sweep deletes the objects for `deleting` samples, then removes their rows and
  refunds the uploaders.
- The delete endpoint also kicks off a sweep in the background, so storage is freed promptly.
- Any open WebSocket connections to the project are closed. Use Hocuspocus's
  close-connections API for the document; check the v4 API.

## Sample states and GC
`samples.state` is one of `pending`, `complete` or `deleting`. It replaces the `complete`
column; write a migration that converts existing rows.
- **pending:** upload requested and not yet completed. It reserves quota. The existing
  rules still hold: 15-min upload URL, 30-min complete window, 60-min sweep.
- **complete:** readable through any linked project.
- **deleting:** a tombstone.
  - `upload-url` for a hash in this state returns 409 `{error:"sample_deleting"}`. The
    client retries after a short delay. This stops a re-upload from racing the object delete.
  - The sweep deletes the object first. Only after that succeeds does it delete the row
    and refund. If the object delete fails, the row stays and the next sweep retries.
- **One sweep function** (`sweepSamples`) handles both stale pending rows and deleting rows.
  It runs every 15 min and is triggered after a project delete.

## Sample API (replaces the earlier sample endpoints)
All sample routes are scoped to a project, and the caller must be a member.
- `POST /projects/:id/samples/upload-url` with `{hash,size,mime}`. Editors and owners only.
  - If the sample is **complete** and the caller can already read it through *any*
    project where they are a member:
    - link it to this project, without an upload
    - return `{exists:true}`
  - If the sample is complete but the caller has no existing access, it is a
    proof-of-possession case.
    - Return a normal upload URL and require a real upload. S3 verifies the checksum, so
      overwriting with identical bytes is harmless.
    - On `complete`, link the sample. Do **not** charge quota again, since the sample is
      already complete and charged.
  - If the sample is pending or absent, the earlier pending/quota rules apply.
  - If the sample is deleting, return 409.
- `POST /projects/:id/samples/:hash/complete`. Editors and owners only.
  - Checks storage as before.
  - Marks the sample complete, charging quota exactly once, if it wasn't already.
  - Inserts the `project_samples` link. That makes it idempotent and makes
    proof-of-possession re-uploads work.
- `GET /projects/:id/samples/:hash/url` is open to any member. It returns 404 unless
  `(project, hash)` is linked and the sample is complete. The URL is valid for 15 minutes.
- `GET /projects/:id/samples` returns the library: `[{hash,size,mime,addedBy,addedAt}]`.

## Project API additions and changes
- `ProjectSummary.role` and `Member.role` now include `'viewer'`.
- `POST /projects/:id/members` accepts `{username, role?: 'editor'|'viewer'}`, default
  `editor`. Called again for an existing member, it updates their role. Owner only, and
  the owner's own role can't be changed.
- `POST /projects/:id/leave`: editors and viewers only. The owner gets 400
  `{error:"owner_cannot_leave"}`.
- `PATCH /projects/:id` with `{name}`: owner only.
- `DELETE /projects/:id`: owner only, as described under Deletion.
- `POST /projects/:id/copy` with `{name?}`: any member. It creates a new project owned by
  the caller that:
  - copies the Yjs state from the stored doc in `documents`; if the doc is live in
    Hocuspocus, flush it first or read the live doc (check the API)
  - copies all `project_samples` links
  - adds no members other than the caller
- **WebSocket:** `onAuthenticate` makes the connection read-only for viewers (Hocuspocus
  `connectionConfig.readOnly = true` or the v4 equivalent; verify in node_modules).
- **Access changes take effect immediately.** When a member is removed or downgraded, or
  leaves, close their open connections to that project. This supersedes the earlier "stays
  connected until reconnect" note.

## Admin CLI additions
- `npm run admin -- tree` prints an indented view of users, then the projects they own
  (with members and roles), then each project's library (hash prefix, size, uploader),
  then totals.
- `npm run admin -- audit` reconciles storage with the DB.
  - It lists every object (local: the files in STORAGE_DIR; s3: ListObjectsV2 on
    `samples/`). Add a `list()` method to the Storage interface for this.
  - It reports:
    - objects with no `samples` row (leaked bytes)
    - complete rows with no object (broken)
    - complete samples with zero links (unreferenced; should not happen)
    - users whose `bytes_used` doesn't match the sum of their completed uploads
  - It exits non-zero on any finding. `--fix` deletes leaked objects and recomputes
    `bytes_used`. It never deletes rows that have links.

## Client changes
- Use the project-scoped sample endpoints. On 409 `sample_deleting`, retry after about 2s,
  up to 3 times.
- **Viewer mode:** no drag, trim, delete, file drop or "+ track"; mute and gain are
  disabled; play/stop still works. Show a subtle "view only" label in the top bar.
- **Projects page:**
  - The owner can rename, delete (with a confirm that names the project and says "deletes
    for all members"), share with a role picker, and change or remove members.
  - Non-owners get "Leave".
  - Everyone gets "Save a copy".
- If the WS connection is closed for lost access, or the project is deleted, show a short
  message and go back to the home page.

## Tests required
- Read leak:
  - A member of project A can't get a URL for a hash that is only linked in project B.
  - A removed member gets 404 or 403 and their WS is closed.
  - A viewer can download but can't upload, and their WS edits are not applied or persisted.
- Dedupe leak: a user with no access to a hash gets an upload URL (not `exists:true`).
  After a real upload and complete, they are linked, and quota is not charged twice.
- Within-access dedupe: the same user adding a sample they already have to a second
  project gets `exists:true`, and the link is created.
- Delete and refcount:
  - Delete project A, where sample X is shared with B and sample Y only with A. X survives,
    Y's object and row are removed, and Y's uploader is refunded.
  - `upload-url` for Y while it is deleting returns 409.
  - A sweep failure keeps the row, and the next sweep retries.
- Copy: the copy has the same doc content and library, and its owner is the caller.
- Audit: detects a planted leaked object and a planted `bytes_used` drift; `--fix` repairs
  both.
