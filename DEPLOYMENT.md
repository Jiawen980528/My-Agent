# MyAgent / Tick Stock Panel deployment

This repository is prepared for Docker deployment. Runtime data and credentials stay outside Git.

## Runtime configuration

Copy `.env.example` to `.env` on the server and set values there. Never commit `.env`.

- `TICKFLOW_API_KEY`: paid TickFlow key for realtime/minute capabilities.
- `AUTH_PASSWORD`: initial web password; only applies before a password exists.
- `DATA_DIR`: persistent data directory, normally `/app/data` in Docker.
- `FUYAO_API_KEY`: optional Fuyao key for THS industry/concept catalogs and index data.
- `AI_API_KEY` and `AI_BASE_URL`: optional AI provider configuration.
- `MYAGENT_BRIDGE_URL` and `MYAGENT_ADMIN_TOKEN`: optional adjacent MyAgent service.

If `external/myagent-service` is deployed separately, configure its `.env` from
`external/myagent-service/.env.example`. It requires a long `ADMIN_TOKEN`; never
put that value in frontend code or logs.

## Docker deployment

On a Linux server with Docker Compose:

```bash
cp .env.example .env
# edit .env without committing it
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

The application listens on `PORT` (default `3018`). Mount the persistent host
data directory to `/app/data`; do not replace it during source upgrades. The
production compose file uses `/opt/tick-stock-panel-data`.

## GitHub Actions

`.github/workflows/docker.yml` builds multi-architecture images and pushes them to
GitHub Container Registry on pushes to `main` or version tags. It uses the
automatic `GITHUB_TOKEN`; no market/API key is required by the workflow.

For a private deployment, keep the runtime `.env` on the server. Do not add
provider keys as GitHub repository variables unless a workflow explicitly consumes
them securely.

## Data safety

The repository excludes `.env`, runtime databases, Parquet data, caches, build
outputs, archives, private keys, screenshots and local debug exports. These files
remain on the local machine but are not part of the GitHub commit.
