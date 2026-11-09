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
ANTHROPIC_API_KEY=
AI_MODEL=claude-opus-5-5
```

- `JWT_ACCESS_SECRET` and `FILE_URL_SECRET`: at least 32 characters each, and different from each other. Generate each with `openssl rand -base64 48`. Changing `JWT_ACCESS_SECRET` invalidates every access token at once (clients get new ones with their refresh cookie); changing `FILE_URL_SECRET` invalidates every file URL already handed out (clients fetch fresh ones).
- `STORAGE_DIR`: an absolute path on the persistent disk, writable by the service user.
- `ANTHROPIC_API_KEY`: optional. Left empty, AI grading answers `503 AI_UNAVAILABLE`.

The process checks every variable on start and exits with a message if one is missing or invalid.

## 3. Build and migrate

As the service user, in `/opt/edunify-backend`:

```sh
npm ci
npm run build
node --env-file=/etc/edunify/backend.env dist/db/migrate.js up
```

Run the migration step on **every** deploy, before starting the new version. It applies only migrations that haven't run yet.

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

## 8. Check by hand after the first deploy

These depend on a real browser or a real API key, so the automated tests can't cover them:

1. Open a lesson whose file is a PDF, in Chrome and in Firefox, and check that it shows in the page. The backend sends helmet's default security headers with files, and their effect on the browsers' built-in PDF viewers inside an `<iframe>` hasn't been checked.
2. Submit a drawing or photo homework with several large pages, to confirm the nginx limit above.
3. If `ANTHROPIC_API_KEY` is set, run AI grading on one submission and check that a suggestion appears for the teacher.
