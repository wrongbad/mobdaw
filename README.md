# mobdaw

A collaborative web DAW: invite-only, real-time editing of the same project. See `docs/spec.md`.

Free and open source under the [Apache License 2.0](LICENSE.md). See
[`docs/pro-tier.md`](docs/pro-tier.md) for free vs mobdaw Pro, and
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
Open http://localhost:5173 and log in. Create an invite on the invites page, open its link
(`#/register/<code>`) in a private window and register a second user. Share a project and edit together.

The API and the `/collab` WebSocket share one port (8787); Vite proxies both in dev.

## Scripts
- `npm run dev` runs the server (watch mode) and the client dev server.
- `npm test` (Rust `dsp` tests, then server tests) / `npm run typecheck`
- `npm run build:wasm` builds `engine/` to `client/src/audio/wasm/engine.wasm` (gitignored);
  `npm run test:dsp` runs the Rust tests alone. Dev playground: `#/engine-test` (not linked).
- `npm run admin -- create-invite [--days N]`, `list-invites`, `create-user <username> [--admin]`, `passwd <username>`, `make-admin <username>`,
  `set-plan <username> active|ended` (end or restore a subscription; see below), `purge-expired` (purge accounts past their
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
- Roles: owner, editor, viewer. Viewers can open, play and download but their WebSocket is
  read-only and they can't upload. Anyone can "save a copy" into a new project they own; only
  the owner renames, deletes, or manages members. Editors and viewers can leave.
- Access changes take effect immediately: removing, downgrading or a leave closes that user's
  open connections to the project (the client then re-checks access). Deleting a project closes
  everyone's. What a browser already downloaded stays; signed download URLs last 15 minutes.
- Uploads are content-addressed by SHA-256 and **owned per user** (`uploads`, one row per owner and hash;
  [`docs/data-policy.md`](docs/data-policy.md)). Projects link to the uploads they use (`project_samples`); all
  sample endpoints are project-scoped (`/api/projects/:id/samples/...`). The stored bytes are shared when two users
  upload the same file, but ownership, quota and deletion are per user: quota is charged to each owner for their own
  uploads. `GET /api/uploads` lists yours (with the projects using them), `DELETE /api/uploads/:hash` removes one from
  every project and tombstones it (`state='deleting'`); a sweep (right after, and every 15 min) deletes the bytes once
  no other owner needs them, then the row, and refunds the quota. Deleting a project only removes its links: uploads stay
  with their owners.
- A user with no access to an existing hash must really upload it before it gets their own upload (no `exists:true`
  oracle). The bytes go to a private per-user, per-project proof object (`proofs/<hash>/<hmac>`, hash-verified by the
  storage layer); `/complete` creates the upload only if that object exists, then deletes it. `samples/<hash>` is never
  accepted as proof (a `409 proof_required` tells the client to upload again if someone else's identical upload
  completed first). Someone who can already read the file through a project gets their own upload without re-uploading.
  Abandoned local proofs are swept after 1 hour.
- Subscriptions: `users.plan_status` is `active` or `read_only`. When a subscription ends the account becomes read-only
  for 30 days (`retention_ends_at`): sign in, play, download and delete still work; creating projects, uploading, copying,
  sharing and editing do not, and the projects it owns are frozen for their members. After 30 days the account is purged:
  its projects (for every member) and uploads are deleted. Resubscribing before then restores everything. There is no
  payment provider yet: `set-plan` (or `endSubscription`/`resumeSubscription` in `server/src/accounts.ts`) is the seam
  to call from a payment webhook. `POST /api/me/delete {password}` deletes an account immediately.
- Upgrading a pass-1 database: the migration converts `samples.complete` to `state` and links
  each project's library by scanning its stored doc for referenced hashes. Samples referenced by
  no doc stay unlinked (shown by `audit` as unreferenced).
