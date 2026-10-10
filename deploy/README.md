# Deploying mobdaw on the shared EC2 box

mobdaw is served at `https://wrongbad.com/mobdaw/`. The box runs one Caddy for all sites (`../../proxy/Caddyfile`):
it serves `client/dist` and proxies `/mobdaw/api/*` and `/mobdaw/collab*` to `localhost:8787`, stripping
the `/mobdaw` prefix (so the server itself still routes `/api` and `/collab`). `PUBLIC_URL` carries the
prefix; the server derives cookie paths and local-storage URLs from it.

Deploy from the parent folder with `./upload.sh mobdaw` (builds the wasm engine, client and server bundle
(`server/dist/main.mjs`, so boot doesn't transpile with tsx) locally, rsyncs, runs `npm ci --omit=dev` on the server, then restarts the `www-mobdaw` unit). First time, or after
changing `systemd/` or `setup.sh`, run `./upload.sh install` (it also runs `setup.sh` on the server). Every site is a systemd unit (`../../systemd/`, installed by `setup.sh`) that starts on boot and
restarts on failure. Logs are in the persistent journal: `journalctl -u www-mobdaw -f`, or all sites with
`journalctl -u 'www-*'`. Status: `systemctl status 'www-*'`.
The server needs Node 24, and Caddy at `/www/proxy/caddy`. `/www/mobdaw/.env` and `/www/mobdaw/data`
exist only on the server (excluded from rsync).

## Server env
`/www/mobdaw/.env`:
```
PORT=8787
PUBLIC_URL=https://wrongbad.com/mobdaw
SESSION_SECRET=<openssl rand -hex 32>
DB_PATH=./data/mobdaw.db
STORAGE_DRIVER=s3
S3_BUCKET=your-bucket
S3_REGION=us-east-1
```
First admin and invites, on the server:
```
cd /www/mobdaw/server
node --env-file=/www/mobdaw/.env --disable-warning=ExperimentalWarning --import tsx scripts/admin.ts create-user you --admin   # prompts for a password
node --env-file=/www/mobdaw/.env --disable-warning=ExperimentalWarning --import tsx scripts/admin.ts create-invite --days 7   # prints a /#/register/<code> link
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
`/etc/cron.daily/mobdaw-backup` (executable):
```sh
#!/bin/sh
set -e
f=/tmp/mobdaw-$(date +%F).db
sqlite3 /www/mobdaw/data/mobdaw.db ".backup '$f'"   # or: VACUUM INTO '$f'
aws s3 cp "$f" s3://your-bucket/backups/$(basename "$f")
rm -f "$f"
```
Backups go under `backups/`, outside the `samples/*` prefix. Add an S3 lifecycle rule to expire them
after ~30 days. The instance role needs `s3:PutObject` on `backups/*` too.

## Notes
- Removing a member (or deleting a project) closes their open WebSocket immediately. Signed
  download URLs last 15 minutes.
- Run `npm run admin -- audit` occasionally (it exits non-zero on drift or leaked objects).
- Back up the SQLite file only: sample bytes live in S3 (content-addressed, immutable).
