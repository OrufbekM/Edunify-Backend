# Deploying the Edunify backend

This guide sets the backend up on one Linux server, behind nginx with HTTPS, with systemd running the process. Paths such as `/opt/edunify-backend` are examples; change them to suit the server.

## What the server needs

- Node.js 24 LTS. The backend is built and tested on 24 (`.nvmrc`, `engines` in `package.json`).
- PostgreSQL 17.
- nginx, with a TLS certificate for the site's domain.
- A persistent disk for uploaded files (`STORAGE_DIR`).

Run **exactly one backend process**. Rate limits are counted in memory, so a second process would allow twice as many requests. The AI grading worker also runs inside the process, and on start it puts any job left `running` back in the queue, so a second process could take over a job the first is still working on.

## 1. Database

Create a role and a database it owns:

```sql
CREATE ROLE edunify LOGIN PASSWORD 'a-long-random-password';
CREATE DATABASE edunify OWNER edunify;
```

The first migration runs `CREATE EXTENSION IF NOT EXISTS citext`. `citext` is a trusted extension, so the database owner can create it without being a superuser.

## 2. Environment variables

Production has no `.env` file: the host provides the variables. With systemd, put them in a file that only root can read, for example `/etc/edunify/backend.env` with mode `600`:

```sh
NODE_ENV=production
PORT=3000
DATABASE_URL=postgres://edunify:a-long-random-password@localhost:5432/edunify
JWT_ACCESS_SECRET=...
FILE_URL_SECRET=...
STORAGE_DIR=/var/lib/edunify/storage
AI_GRADING_ENABLED=false
AI_PROVIDER_TEXT=anthropic
AI_PROVIDER_IMAGE=anthropic
AI_FALLBACK_PROVIDER=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_MODEL=claude-opus-5-5
GEMINI_MODEL=
OPENAI_MODEL=
```

- `JWT_ACCESS_SECRET` and `FILE_URL_SECRET`: at least 32 characters each, and different from each other. Generate each with `openssl rand -base64 48`. Changing `JWT_ACCESS_SECRET` invalidates every access token at once (clients get new ones with their refresh cookie); changing `FILE_URL_SECRET` invalidates every file URL already handed out (clients fetch fresh ones).
- `STORAGE_DIR`: an absolute path on the persistent disk, writable by the service user.
- `AI_GRADING_ENABLED`: AI grading is switched off for now (`false`, the default): it answers `503 AI_UNAVAILABLE`, no worker runs, and jobs left unfinished are closed as `failed` on start. Set `true` to turn it back on; the settings below still have to be valid either way.
- AI grading: `AI_PROVIDER_TEXT` grades typed answers and `AI_PROVIDER_IMAGE` grades pages, each `anthropic`, `gemini` or `openai`; `AI_FALLBACK_PROVIDER` is tried when the first one fails. A provider without its key is off; a homework type with no provider left answers `503 AI_UNAVAILABLE`. Every provider named needs its `*_MODEL`. Use paid API keys in production: free tiers allow few requests a day (Gemini's allowed 20 for one model in testing) and may use what is sent to improve the provider's models, which matters for pupils' work.

The process checks every variable on start and exits with a message if one is missing or invalid.

## 3. Build and migrate

As the service user, in `/opt/edunify-backend`:

```sh
npm ci
npm run build
node --env-file=/etc/edunify/backend.env dist/db/migrate.js up
```

Run the migration step on **every** deploy, before starting the new version. It applies only migrations that haven't run yet.

Once, after the first migration, create the admin account. The password is read from the environment only for this command; it is never stored in the variables file:

```sh
read -rs ADMIN_PASSWORD && export ADMIN_PASSWORD     # at least 12 characters
node --env-file=/etc/edunify/backend.env dist/db/seedAdmin.js
unset ADMIN_PASSWORD
```

The login is `edunify_admin`, or `ADMIN_LOGIN` if set. Running it again changes nothing; add `--reset-password` to replace a forgotten admin password (this also signs the admin out everywhere).

## 4. systemd

`/etc/systemd/system/edunify-backend.service`:

```ini
[Unit]
Description=Edunify backend
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=edunify
WorkingDirectory=/opt/edunify-backend
EnvironmentFile=/etc/edunify/backend.env
ExecStart=/usr/bin/node dist/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Use the path of Node 24 on this server in `ExecStart` (`which node`). Then:

```sh
systemctl daemon-reload
systemctl enable --now edunify-backend
journalctl -u edunify-backend -f
```

Logs are JSON lines, one per request plus start-up and AI worker messages. Access tokens, cookies, passwords and the signature in file URLs are redacted.

## 5. nginx

The frontend and the API share one origin, so cookies and file URLs work as the contract expects. nginx must be the only proxy in front of the backend: the backend trusts exactly one hop (`trust proxy 1`) when it reads the client's IP for rate limits. The backend listens on every interface, so keep port 3000 closed to the outside with the firewall; a client that reached it directly could set its own `X-Forwarded-For` and dodge the per-IP limits.

```nginx
server {
    listen 80;
    server_name edunify.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name edunify.example.com;

    ssl_certificate     /etc/letsencrypt/live/edunify.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/edunify.example.com/privkey.pem;

    # The largest upload outside submissions is a 20 MB lesson PDF. nginx's default is 1 MB.
    client_max_body_size 21m;

    # The built frontend.
    root /var/www/edunify-frontend;
    location / {
        try_files $uri /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # A submission carries up to 9 pages of 10 MB each (contract 2.7 and 7).
    location ~ ^/api/v1/homeworks/[^/]+/submissions$ {
        client_max_body_size 91m;
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

The backend still applies its own limits (1 MB of JSON, the per-file sizes), and holds page uploads in memory while it checks them, so a submission can use up to about 90 MB of RAM while it is being saved.

Check that `GET https://edunify.example.com/api/v1/health` answers `{"status":"ok"}`. It is rate-limited like every route (300 a minute per IP), which leaves room for any uptime monitor.

## 6. Files and backups

Uploaded files live in `STORAGE_DIR`; the database holds only their metadata. The two belong together:

- Back them up together, on the same schedule: dump the database first (`pg_dump -Fc edunify > edunify.dump`), then copy `STORAGE_DIR` straight after.
- Restore them together. A database without its files, or files from a different day, gives file links that answer `404`.

## 7. Deploying a new version

```sh
git pull
npm ci
npm run build
node --env-file=/etc/edunify/backend.env dist/db/migrate.js up
systemctl restart edunify-backend
```

A restart cuts off requests in flight, so restart at a quiet time. AI grading jobs that were running go back to the queue when the process starts again, and run from the beginning.

## 8. Upgrading a v1 server to v2

Version 2 follows the new contract (`docs/contract.md`): an admin who approves teachers, ordered categories and classes, units in every class, class groups with linked lessons, and lesson numbers. Migrations `018` to `023` rewrite existing tables, so this deploy is not like the others in section 7.

**1. Stop the backend.** The v1 code can't run against the v2 tables, and nothing should write while you back up.

```sh
systemctl stop edunify-backend
```

**2. Back up the database and the files** (section 6), and keep this copy until v2 has run for a while:

```sh
pg_dump -Fc edunify > edunify-before-v2.dump
cp -a /var/lib/edunify/storage /var/lib/edunify/storage-before-v2
```

The backup is the only way back. The `down` migrations restore the v1 tables, but not everything in them. For example, the class subject stays merged into the name, deleted teacher notifications don't come back, and group content is dropped.

**3. Update the variables file** (section 2):

- `AI_MODEL` is gone. Rename it to `ANTHROPIC_MODEL`. Without it the process exits on start, because Anthropic is the default provider for both homework types.
- Add `AI_GRADING_ENABLED=false`. That is also the default when the variable is missing, so AI grading stays off until you turn it on.
- Optional: `AI_PROVIDER_TEXT`, `AI_PROVIDER_IMAGE`, `AI_FALLBACK_PROVIDER`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `GEMINI_MODEL`, `OPENAI_MODEL`, as section 2 describes.
- Do not put `ADMIN_LOGIN` or `ADMIN_PASSWORD` in this file. They are read only by the seed command in step 5.

**4. Build and migrate**, as in section 3:

```sh
git pull
npm ci
npm run build
node --env-file=/etc/edunify/backend.env dist/db/migrate.js status   # 018 to 023 pending
node --env-file=/etc/edunify/backend.env dist/db/migrate.js up
```

Each migration runs in its own transaction, so one that fails changes nothing and the ones before it stay applied. Fix the cause and run `up` again.

What the migrations do to existing data:

- **Accounts.** Each name is split at its first space into first and last name; a one-word name gets an empty last name. Existing teachers stay `active` (they don't go back for approval), with an empty phone. Both can fill these in from their profile.
- **Classes.** The subject and name become one name (`subject name`, cut to 80 characters). Categories are ordered by name, and classes newest first within each category, which is the order teachers saw in v1.
- **Units and lessons.** A class without units gets `Unit 1`. Lessons that had no unit move to the start of the class's first unit. Every lesson stays visible.
- **Connections.** The `link_audit` table is renamed `connection_audit`, keeping its rows.
- **Notifications.** Teacher notifications are deleted, because teachers now see `newSubmissionCount` instead. Student notifications stay.

Submissions, grades and files are not changed.

**5. Create the admin account once**, as at the end of section 3 (`dist/db/seedAdmin.js`, with `ADMIN_PASSWORD` read from the prompt). Teachers who sign up from now on wait for this account's approval.

**6. Start it and check it:**

```sh
systemctl start edunify-backend
```

Then sign in as a teacher who existed before the upgrade. Check that their categories, classes, students, lessons, submissions and journal grades are all there, and that lesson numbers run 1, 2, 3 through each class. Then do the admin check in section 9, step 3.

To go back: stop the backend, check out the v1 commit and build it, restore the dump with `pg_restore --clean --if-exists -d edunify edunify-before-v2.dump`, put `storage-before-v2` back as `STORAGE_DIR`, restore the old variables file, and start it.

## 9. Check by hand after the first deploy

These depend on a real browser or a real API key, so the automated tests can't cover them:

1. Open a lesson whose file is a PDF, in Chrome and in Firefox, and check that it shows in the page. The backend sends helmet's default security headers with files, and their effect on the browsers' built-in PDF viewers inside an `<iframe>` hasn't been checked.
2. Submit a drawing or photo homework with several large pages, to confirm the nginx limit above.
3. Sign in as the admin at `POST /api/v1/auth/admin/login`. Check that a teacher who signs up gets `403 ACCOUNT_PENDING` on `GET /api/v1/categories`, shows up in `GET /api/v1/admin/users?status=pending`, and gets in once approved with `PATCH /api/v1/admin/users/:id/status`.
4. If AI grading is on: for each AI provider that has a key, run AI grading on one submission of a homework type it handles, and check that a suggestion appears for the teacher.
