# mobdaw

A collaborative web DAW: invite-only, real-time editing of the same project. See `docs/spec.md`.

Free and open source under the [Apache License 2.0](LICENSE.md). See
[`docs/pro-tier.md`](docs/pro-tier.md) for free vs mobdaw pro, and
[`docs/data-policy.md`](docs/data-policy.md) for how cloud data is handled.

## Quick start
Prerequisites: Node 24, and Rust via [rustup](https://rustup.rs) with the wasm target
(`rustup target add wasm32-unknown-unknown`). The audio engine (`engine/`, see `docs/engine.md`)
is compiled to wasm by `npm run build:wasm`, which `npm run dev` and the client build run first.
```
npm install
cp .env.example .env
npm run admin -- create-user you --admin    # prompts for a password
npm run dev
```
Open http://localhost:5173. Without an account you land on **projects on this device** (no server involved). To use
the cloud, log in at `#/login`, create an invite on the invites page, open its link (`#/register/<code>`) in a
private window and register a second user. Share a cloud project and edit together.

The API and the `/collab` WebSocket share one port (8787); Vite proxies both in dev.

## Scripts
- `npm run dev` runs the server (watch mode) and the client dev server.
- `npm test` (Rust `dsp` tests, then server tests) / `npm run typecheck`
- `npm run build:wasm` builds `engine/` to `client/src/audio/wasm/engine.wasm` (gitignored);
  `npm run test:dsp` runs the Rust tests alone. Dev playground: `#/engine-test` (not linked).
- `npm run admin -- create-invite [--days N] [--months N]`, `list-invites`, `create-user <username> [--admin] [--months N]`, `gift <username> <months>`,
  `passwd <username>`, `make-admin <username>`,
  `set-plan <username> active|ended` (end or restore a subscription; see below), `purge-expired` (delete the cloud data of accounts past their
  retention window; a running server does this itself every 15 min),
  `tree` (users, owned projects with members/roles, libraries, totals),
  `audit [--fix]` (reconcile storage with the DB: leaked objects, broken uploads, orphan library links,
  `bytes_used` drift; exits non-zero on findings; `--fix` deletes leaked objects and
  recomputes `bytes_used`). Reads `.env`; operates on `DB_PATH` and the configured storage.

## Layout
`shared/` Yjs schema helpers + API types (consumed as TS source) · `server/` Hono API +
Hocuspocus + SQLite (`node:sqlite`) · `client/` Vite vanilla TS · `engine/` Rust workspace (`dsp` lib, `engine` wasm) · `deploy/` Caddy, systemd, AWS notes.

## Notes
- `node:sqlite` is built into Node 24; it may print an ExperimentalWarning.
- Without `SESSION_SECRET` in dev, a random secret is used per boot, so a server restart logs
  everyone out. Set one in `.env`.
- **free / pro** ([`docs/pro-tier.md`](docs/pro-tier.md)): with no account the editor runs entirely in the browser. A local
  project's document is saved with `y-indexeddb` and its audio as blobs in IndexedDB (per project, keyed by SHA-256); the
  list of projects is in `localStorage`. A `.mobdaw` file (`client/src/projectFile.ts`) holds a project with its audio and is
  how projects are exported, imported and moved between "on this device" and the cloud (`client/src/transfer.ts`). Local
  project ids start with `local-`; `samples.ts` reads and writes audio on the device for those and in the cloud otherwise.
- Roles: owner, editor, viewer. Viewers can open, play and download but their WebSocket is
  read-only and they can't upload. Anyone can "save a copy" into a new project they own; only
  the owner renames, deletes, or manages members. Editors and viewers can leave.
- Access changes take effect immediately: removing, downgrading or a leave closes that user's
  open connections to the project (the client then re-checks access). Deleting a project closes
  everyone's. What a browser already downloaded stays; signed download URLs last 15 minutes.
- Uploads are content-addressed by SHA-256 and **owned per user** (`uploads`, one row per owner and hash;
  [`docs/data-policy.md`](docs/data-policy.md)). Projects link to the uploads they use (`project_samples`); all
  sample endpoints are project-scoped (`/api/projects/:id/samples/...`). Every upload is its own stored object
  (`samples/u<owner id>/<hash>`; no dedup across users), so ownership, quota and deletion are simply per user.
  `GET /api/uploads` lists yours (with the projects using them), `DELETE /api/uploads/:hash` removes one from every
  project and tombstones it (`state='deleting'`); a sweep (right after, and every 15 min) deletes the object, then the
  row, and refunds the quota. Deleting a project only removes its links: uploads stay with their owners.
- `upload-url` answers `exists:true` only for your own uploads, or for a file you can already read through a project
  (the server copies that owner's object to yours, no re-upload). Otherwise you upload the bytes, even if someone else
  has the same file. Objects stored under an older layout (`samples/<hash>`, `samples/<hex(username)>/<hash>`) are moved to per-owner keys at startup.
- Users have a numeric `id` (counting from 1, never reused). Every reference to a user (project ownership and membership,
  uploads, library links, the session token, storage keys) is by id; `username` is only the login name and display name,
  so it can change without touching anything else. The HTTP API still speaks usernames (adding members, `owner`).
- Subscriptions: `users.plan_status` is `active` or `read_only`. When a subscription ends the account becomes read-only
  for 30 days (`retention_ends_at`): sign in, play, download and delete still work; creating projects, uploading, copying,
  sharing and editing do not, and the projects it owns are frozen for their members. After 30 days the account's cloud data
  (its projects, for every member, and its uploads) is deleted and `data_purged_at` is set (`Me.planStatus` is then `lapsed`).
  **The account itself is never deleted automatically**: adding time (`giftMonths`) makes it `active` again, with an empty
  cloud (or exactly as it was, within the 30 days). Only `POST /api/me/delete {password}` deletes an account. There is no
  payment provider yet: `set-plan` (or `endSubscription`/`resumeSubscription` in `server/src/accounts.ts`) is the seam
  to call from a payment webhook.
- Pre-paid time: `users.paid_through` (ms) is how long an account is paid for. Invites carry `gift_months` (default 1, set with
  `create-invite --months N` or the invites page) that the new account starts with; `gift <username> <months>` adds more
  (months stack, and a lapsed account still in its retention window is restored). The sweep ends the subscription of any
  active account past `paid_through`. The migration gave every pre-existing account, and every still-open invite, 999 months. `POST /api/me/delete {password}` deletes an account immediately.
- Upgrading a pass-1 database: the migration converts `samples.complete` to `state` and links
  each project's library by scanning its stored doc for referenced hashes. Samples referenced by
  no doc stay unlinked (shown by `audit` as unreferenced).
