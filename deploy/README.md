# Deploying mobdaw on EC2

The server runs from TypeScript sources via `tsx` (no compile step), behind Caddy which
serves `client/dist` and proxies `/api/*` and `/collab*` to `localhost:8787`.

## 1. EC2
1. Launch an Amazon Linux 2023 / Ubuntu instance (t4g.small is plenty). Security group: 80 and 443 open, SSH from your IP.
2. Point a DNS A record for your domain at the instance.
3. Install Node 24, Caddy and sqlite3. `sudo useradd -r -m mobdaw`.
4. Deploy the code:
   ```
   sudo git clone <repo> /opt/mobdaw && cd /opt/mobdaw
   sudo npm ci
   sudo npm run build          # builds client/dist
   sudo chown -R mobdaw /opt/mobdaw
   ```
5. Create `/etc/mobdaw.env` (mode 600), see below, then install `deploy/mobdaw.service`
   (`systemctl enable --now mobdaw`).
6. Caddy: copy `deploy/Caddyfile` to `/etc/caddy/Caddyfile`, set `DOMAIN=your.domain` in
   `/etc/caddy/caddy.env` (or the unit's environment), `systemctl reload caddy`. Certificates are automatic.

`/etc/mobdaw.env`:
```
PORT=8787
PUBLIC_URL=https://your.domain
AUTH_MODE=google
GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
SESSION_SECRET=<openssl rand -hex 32>
ADMIN_EMAILS=you@gmail.com
DB_PATH=/var/lib/mobdaw/mobdaw.db
STORAGE_DRIVER=s3
S3_BUCKET=your-bucket
S3_REGION=us-east-1
```
`sudo install -d -o mobdaw /var/lib/mobdaw`. Create invites with
`cd /opt/mobdaw && sudo -u mobdaw node --env-file=/etc/mobdaw.env --import tsx server/scripts/admin.ts create-invite --days 7`.

## 2. Google OAuth client
Google Cloud Console, APIs & Services, Credentials, Create OAuth client ID, type "Web application".
Add `https://your.domain` as an **Authorized JavaScript origin** (no redirect URI is needed for
Google Identity Services). Put the client id in `GOOGLE_CLIENT_ID`.

## 3. S3 bucket and instance role
Create a private bucket (block all public access) in the same region. Add a CORS rule so
browsers can PUT/GET directly:
```json
[{"AllowedOrigins":["https://your.domain"],"AllowedMethods":["GET","PUT"],
  "AllowedHeaders":["*"],"ExposeHeaders":["ETag"],"MaxAgeSeconds":3000}]
```
Attach an IAM role to the instance with:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect":"Allow","Action":["s3:PutObject","s3:GetObject","s3:DeleteObject"],"Resource":["arn:aws:s3:::your-bucket/samples/*","arn:aws:s3:::your-bucket/proofs/*"]},
    {"Effect":"Allow","Action":"s3:ListBucket","Resource":"arn:aws:s3:::your-bucket"}
  ]
}
```
`s3:ListBucket` makes HeadObject return 404 (instead of 403) for missing keys, and is also
required by `npm run admin -- audit` (ListObjectsV2 on `samples/`). `s3:DeleteObject` is used by
the sample garbage collector. The server
presigns uploads with a signed `Content-Length` and SHA-256 checksum, so S3 itself rejects
bodies that don't match.

Add a lifecycle rule that expires the `proofs/` prefix after 1 day: proof objects are temporary
uploads used to prove possession of an existing sample, and abandoned ones are not swept by the app
on S3.

## 4. AWS Budget alert
Billing, Budgets, Create budget, "Cost budget", monthly, e.g. $10, with email alerts at 80% actual and 100% forecasted.

## 5. Nightly SQLite backup
`/etc/cron.daily/mobdaw-backup` (executable):
```sh
#!/bin/sh
set -e
f=/tmp/mobdaw-$(date +%F).db
sqlite3 /var/lib/mobdaw/mobdaw.db ".backup '$f'"   # or: VACUUM INTO '$f'
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
