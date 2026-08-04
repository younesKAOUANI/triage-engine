# Deployment

Docker Compose on a shared host. Postgres and Redis run as containers alongside
the app. Deploys happen from GitHub Actions on every push to `main`.

Live at <https://triage-engine.youneskaouani.dev>.

**TLS is not in this repository.** The box also serves the portfolio and
Aliquot, and one edge Caddy terminates for every name on it. Host preparation,
DNS and the certificate story live in the [`deploy/edge`](https://github.com/younesKAOUANI/portfolio/tree/main/deploy/edge)
directory of the portfolio repository — read that first if you are building the
machine from nothing.

---

## Shape

```
                    ┌────────────────────────── the box ──────────────────────────┐
                    │                                                             │
  :443 ────────────►│  edge ──► app ──┬──► postgres   (network: data, no egress)  │
  (shared, all      │  caddy   edge   └──► redis      (network: data, no egress)  │
   three sites)     │          +data                                              │
  Mistral API ◄─────┼──────────┘ (app reaches out over `edge`)                    │
                    └─────────────────────────────────────────────────────────────┘
```

This stack publishes no ports at all. The app, Postgres and Redis are
unreachable from outside the host; the app is reached by the container alias
`triage-app` on the shared `edge` network. `data` is marked `internal`, so the
datastores have no route off the box; the app sits on both because it needs
inbound traffic from the edge and outbound access to the model API.

## First-time setup

**1. Host and DNS.** Both are the edge runbook's job. In short: prepare the box,
`docker network create edge`, and point an `A` record for
`triage-engine.youneskaouani.dev` at the server before the edge Caddy first
starts. It solves an ACME HTTP-01 challenge on port 80, so both 80 and 443 must
be open — and must stay open, or renewal starts failing about 60 days later
without any obvious symptom.

**2. Server prerequisites.** Docker Engine with the Compose plugin, and git.
Installed by the shared bootstrap script; listed here because this stack needs
them whether or not you used it.

**3. Clone and configure.**

```bash
sudo mkdir -p /srv/triage-engine && sudo chown "$USER" /srv/triage-engine
git clone https://github.com/younesKAOUANI/triage-engine.git /srv/triage-engine
cd /srv/triage-engine

cp .env.production.example .env
openssl rand -base64 32          # paste into POSTGRES_PASSWORD
${EDITOR:-nano} .env
```

`.env` is gitignored and untracked, so the deploy job's `git checkout` leaves it
alone. It is the only place secrets live on the box.

**4. First boot.**

```bash
docker network inspect edge          # must exist; see the edge runbook
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml logs -f app
curl https://triage-engine.youneskaouani.dev/ready
```

If that `curl` 502s, the edge is up and this stack is not on its network — which
is what happens when the stack was started before `docker network create edge`.
`docker network inspect edge` lists what is actually attached.

Migrations run on boot (`DB_RUN_MIGRATIONS_ON_BOOT=true`), which is safe with a
single app container. If you ever scale to more than one, turn it off and run
migrations as a separate step so instances don't race each other at startup.

**5. Backups.** Install as root, in `/etc/cron.d`, so the running user is
explicit rather than implied by whose crontab you happened to edit:

```bash
sudo tee /etc/cron.d/triage-backup >/dev/null <<'CRON'
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
17 3 * * * deploy cd /srv/triage-engine && ./deploy/backup.sh >> ./backups/backup.log 2>&1
CRON
sudo chmod 0644 /etc/cron.d/triage-backup
```

Two details that are easy to get wrong and fail silently:

- **It must run as the account that owns `/srv/triage-engine` and is in the
  `docker` group** — the same one CI deploys as. Run it as root instead and the
  dumps land root-owned in a tree the deploy job runs `git checkout -f` in.
- **The log goes inside `backups/`, not `/var/log`.** cron's shell opens the
  redirect *before* exec'ing the script, so an unprivileged user redirecting into
  a root-owned `/var/log` path fails with `EACCES` and the backup never runs at
  all. With no MTA on the box that failure goes nowhere. `backups/` is owned by
  the deploy user and is gitignored.

Verify it rather than trusting it — a backup job that dies on its own redirect
looks exactly like one that never fired:

```bash
sudo -u deploy bash -c 'cd /srv/triage-engine && ./deploy/backup.sh >> ./backups/backup.log 2>&1'
ls -lt /srv/triage-engine/backups | head
```

Redis is deliberately not backed up: it holds queue state, which the database and
the reconciliation sweep can reconstruct. Postgres is the only thing here whose
loss is unrecoverable.

## Continuous deployment

`.github/workflows/ci.yml` runs three jobs in sequence on push to `main`:

| Job | What it does | Gates |
| --- | --- | --- |
| `test` | typecheck, build, unit tests, integration tests against real Postgres + Redis | runs on PRs too |
| `publish` | builds the image and pushes `ghcr.io/youneskaouani/triage-engine:<sha>` and `:latest` | only after `test` passes, only on `main` |
| `deploy` | SSHes to the box, checks out the commit, pins `APP_IMAGE` to that exact sha, pulls and restarts | only after `publish` |

The deploy pins the image by commit sha rather than `:latest`, so the running
revision is unambiguous and rollback is a one-liner. It finishes by polling
`/ready` until it returns 200, and fails the run if it never does — a deploy that
starts a container but never serves traffic should not be reported as green.

### Repository secrets

Set these under Settings → Secrets and variables → Actions:

| Secret | Value |
| --- | --- |
| `DEPLOY_HOST` | server hostname or IP |
| `DEPLOY_USER` | SSH user (needs docker permissions) |
| `DEPLOY_SSH_KEY` | private key; put the matching public key in that user's `authorized_keys` |
| `DEPLOY_PATH` | `/srv/triage-engine` |
| `GHCR_TOKEN` | only while the GHCR package is private. Publish the package and you can delete both the secret and the login step. |

Generate a deploy-only key rather than reusing a personal one:

```bash
ssh-keygen -t ed25519 -f deploy_key -N "" -C "triage-engine-deploy"
ssh-copy-id -i deploy_key.pub user@host
# paste the contents of `deploy_key` into DEPLOY_SSH_KEY, then delete both files
```

The `deploy` job targets a GitHub Environment named `production`. Create it to
require manual approval before a deploy, or to scope these secrets so they are
unavailable to any other workflow.

## Operating it

```bash
cd /srv/triage-engine

docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f app
docker compose -f docker-compose.prod.yml restart app

curl https://triage-engine.youneskaouani.dev/ready
curl https://triage-engine.youneskaouani.dev/metrics
curl https://triage-engine.youneskaouani.dev/dlq
```

**Rolling back.** Every commit has an image, so roll back by pinning an older
sha and restarting:

```bash
sed -i 's|^APP_IMAGE=.*|APP_IMAGE=ghcr.io/youneskaouani/triage-engine:<older-sha>|' .env
docker compose -f docker-compose.prod.yml up -d app
```

This does not roll back migrations. The one in the repo is additive, but check
before rolling back across a schema change.

**Restoring a backup.**

Stop the app first: its open connections block the DROPs in a `--clean` dump.

```bash
docker compose -f docker-compose.prod.yml stop app

gunzip -c backups/triage-YYYYMMDDTHHMMSSZ.sql.gz \
  | docker compose -f docker-compose.prod.yml exec -T postgres \
      psql -v ON_ERROR_STOP=1 --single-transaction -U triage -d triage

docker compose -f docker-compose.prod.yml start app
```

`ON_ERROR_STOP=1` and `--single-transaction` are not optional. Without them psql
continues past errors and exits 0, so a restore that drops every table and then
fails to recreate them reports success — the failure only surfaces later, when
the data is already gone.

## What to watch

The engine is built so that giving up on work is always visible. These are the
signals worth alerting on, in rough order of how much they should worry you:

| Metric | Meaning |
| --- | --- |
| `events_failed_total{disposition="dead_letter_write_failed"}` | A job went terminal and its record could not be written. The only trace is a log line. This is the worst state the system can reach. |
| `outbox_messages_failed_total` | A notification exhausted its attempts and was abandoned. An at-least-once guarantee was knowingly given up. |
| `dlq_depth` | Jobs failing permanently and awaiting a decision. |
| `outbox_pending` rising steadily | The relay is not keeping up, or the downstream is down. |
| `circuit_breaker_state` = 1 | The model is unavailable; tickets are being classified by the fallback and queued for upgrade. Degraded, not broken. |
| `pipeline_queue_depth{state="waiting"}` growing | Ingestion is outpacing the worker. |

`/health` is liveness and deliberately checks nothing: a database blip must not
cause a restart loop. `/ready` checks Postgres and Redis, and is what Caddy and
the deploy verification gate on.

## Public exposure

`POST /events` is open, because the demo is not much use otherwise. Two things
keep that from being a liability:

- **Rate limiting** per client IP: 20 writes and 120 reads per minute by default.
  This depends on `TRUST_PROXY=true` and the edge Caddy setting
  `X-Forwarded-For`; without it every request looks like it came from Caddy and
  one caller would exhaust the bucket for everyone. It is safe in the other
  direction because Caddy writes that header from the real peer and *discards*
  whatever the caller sent, rather than appending to it — so an address cannot
  be forged. `TRUST_PROXY=true` on a container reachable without a proxy in
  front would be exactly the opposite. Health, readiness, metrics and the
  bundled sink are exempt
  — a throttled probe reads as an outage, and throttling the sink would throttle
  the engine's own deliveries.
- **Retention**: terminal rows older than `RETENTION_MAX_AGE_MS` (7 days) are
  pruned hourly. Only settled data is eligible. A ticket still `PENDING` or
  `DEGRADED`, or an outbox row still awaiting dispatch, is live work and is never
  deleted regardless of age.

`MISTRAL_API_KEY` can be left blank. The app boots and classifies everything with
the rule-based fallback rather than failing, which is a reasonable way to run a
public demo without paying per request.
