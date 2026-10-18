# Deploying mobdaw on the shared EC2 box

mobdaw is served at `https://wrongbad.com/mobdaw/`. The box runs one Caddy for all sites (`../../proxy/Caddyfile`):
it serves `client/dist` and proxies `/mobdaw/api/*` and `/mobdaw/collab*` to `localhost:8787`, stripping
the `/mobdaw` prefix (so the server itself still routes `/api` and `/collab`). `PUBLIC_URL` carries the
prefix; the server derives cookie paths and local-storage URLs from it.

The box is set up from [wrongbad/kyle.fi](https://github.com/wrongbad/kyle.fi) (`sites.conf` + `Caddyfile` +
`install.sh`). It deploys this repo's `prod` branch on every push to it (ship with `git push origin main:prod`;
`main` is not deployed): a GitHub webhook makes it fetch the branch into
whichever of `/www/sites/mobdaw/a` and `b` is not live and run `deploy/build` there (wasm engine, client, and
the server bundle `server/dist/main.mjs`, so boot doesn't transpile with tsx). Only a successful build swaps
the `/www/sites/mobdaw/current` symlink to it; then `www@mobdaw` restarts and runs `deploy/start`. Caddy
serves `current/client/dist` directly. Deploy log: `journalctl -u www-deploy@mobdaw -f`; server log:
`journalctl -u www@mobdaw -f`; last built commit: `/www/sites/mobdaw/deployed`.
The server needs Node 24 (the box installs it). `/www/sites/mobdaw/data` exists only on the box, outside the checkout.

## Server env
Plain config is in the box repo, `env/mobdaw.env` (`PUBLIC_URL`, `DB_PATH`, S3 bucket and region); the box
sets `PORT` and `DATA_DIR`. mobdaw needs no secrets file: sessions are stored hashed in the SQLite DB, and the key that
signs local-storage URLs is generated into it on first boot. (A leftover `SESSION_SECRET` is ignored.)

First admin and invites, on the server:
```
cd /www/sites/mobdaw/current/server
sudo -u www-mobdaw /opt/node/bin/node --env-file=/www/box/env/mobdaw.env --disable-warning=ExperimentalWarning --import tsx scripts/admin.ts create-user you --admin   # prompts for a password
sudo -u www-mobdaw /opt/node/bin/node --env-file=/www/box/env/mobdaw.env --disable-warning=ExperimentalWarning --import tsx scripts/admin.ts create-invite --days 7   # prints a /#/register/<code> link
```
Admins can also make invites from the app (invites page). Friends register with username and
password (no email); `passwd <username>` resets a password. Logins are rate-limited per username.

## S3 bucket and instance role
Create a private bucket (block all public access) in the same region. Add a CORS rule so
browsers can PUT/GET directly:
```json
[{"AllowedOrigins":["https://wrongbad.com"],"AllowedMethods":["GET","PUT"],
  "AllowedHeaders":["*"],"ExposeHeaders":["ETag"],"MaxAgeSeconds":3000}]
```
Attach an IAM role to the instance with:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect":"Allow","Action":["s3:PutObject","s3:GetObject","s3:DeleteObject"],"Resource":["arn:aws:s3:::mobdaw-360949415650-us-east-1-an/samples/*"]},
    {"Effect":"Allow","Action":"s3:PutObject","Resource":"arn:aws:s3:::mobdaw-360949415650-us-east-1-an/backups/*"},
    {"Effect":"Allow","Action":"s3:ListBucket","Resource":"arn:aws:s3:::your-bucket"}
  ]
}
```
`s3:ListBucket` makes HeadObject return 404 (instead of 403) for missing keys, and is also
required by `npm run admin -- audit` (ListObjectsV2 on `samples/`). `s3:DeleteObject` is used by
the sample garbage collector. Copying an object (a user adding a file they can read through a shared project, and
the one-time startup move to per-owner keys) uses `s3:GetObject` + `s3:PutObject` within `samples/*`. The server
presigns uploads with a signed `Content-Length` and SHA-256 checksum, so S3 itself rejects
bodies that don't match.

## AWS Budget alert
Billing, Budgets, Create budget, "Cost budget", monthly, e.g. $10, with email alerts at 80% actual and 100% forecasted.

## Nightly SQLite backup
`deploy/backup` (`server/scripts/backup.ts` → `src/backup.ts`) snapshots the DB with `VACUUM INTO` and
uploads it to `s3://<S3_BUCKET>/backups/mobdaw-YYYY-MM-DD.db` (with `STORAGE_DRIVER=local` it keeps the
newest 7 in `backups/` next to the DB). The box runs it nightly as `www-backup@mobdaw`; run one now with
`sudo systemctl start www-backup@mobdaw`, log in `journalctl -u www-backup@mobdaw`.
The instance role needs `s3:PutObject` on `backups/*` (see the policy above), and an S3 lifecycle rule on
the `backups/` prefix should expire them after ~30 days. Restore: stop `www@mobdaw`, copy the file to
`DB_PATH` (owned by `www-mobdaw`), start it.

## Notes
- Removing a member (or deleting a project) closes their open WebSocket immediately. Signed
  download URLs last 15 minutes.
- Run `npm run admin -- audit` occasionally (it exits non-zero on drift or leaked objects).
- Back up the SQLite file only: sample bytes live in S3 (content-addressed, immutable).
