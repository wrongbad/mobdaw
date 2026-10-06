# mobdaw

A collaborative web DAW: invite-only, real-time editing of the same project. See `docs/spec.md`.

## Quick start
```
npm install
cp .env.example .env    # set ADMIN_EMAILS=you@x.com
npm run dev
```
Open http://localhost:5173 and log in as the admin email (dev mode). Create an invite, open it
in a private window, and log in as another email. Share a project and edit together.

The API and the `/collab` WebSocket share one port (8787); Vite proxies both in dev.

## Scripts
- `npm run dev` runs the server (watch mode) and the client dev server.
- `npm test` / `npm run typecheck`
- `npm run admin -- create-invite [--days N]`, `list-invites`, `add-user <email>`,
  `tree` (users, owned projects with members/roles, libraries, totals),
  `audit [--fix]` (reconcile storage with the DB: leaked objects, broken rows, unreferenced
  samples, `bytes_used` drift; exits non-zero on findings; `--fix` deletes leaked objects and
  recomputes `bytes_used`). Reads `.env`; operates on `DB_PATH` and the configured storage.

## Layout
`shared/` Yjs schema helpers + API types (consumed as TS source) · `server/` Hono API +
Hocuspocus + SQLite (`node:sqlite`) · `client/` Vite vanilla TS · `deploy/` Caddy, systemd, AWS notes.

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
- Samples are content-addressed by SHA-256 and belong to project libraries (`project_samples`);
  all sample endpoints are project-scoped (`/api/projects/:id/samples/...`). A sample whose last
  link goes away (project deleted) is tombstoned (`state='deleting'`), and a sweep (after the
  delete and every 15 min) removes the object, then the row, and refunds the uploader. Quota is
  charged once, to the first uploader, for the lifetime of the sample.
- A user with no access to an existing hash must really upload it before it is linked into their
  project (no `exists:true` oracle). The bytes go to a private per-user, per-project proof object
  (`proofs/<hash>/<hmac>`, hash-verified by the storage layer); `/complete` links only if that
  object exists, then deletes it. `samples/<hash>` is never accepted as proof. Abandoned local
  proofs are swept after 1 hour.
- Upgrading a pass-1 database: the migration converts `samples.complete` to `state` and links
  each project's library by scanning its stored doc for referenced hashes. Samples referenced by
  no doc stay unlinked (shown by `audit` as unreferenced).
