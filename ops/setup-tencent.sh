#!/usr/bin/env bash
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run with sudo'; exit 1; }
id myagent-deploy >/dev/null
command -v docker >/dev/null
command -v flock >/dev/null
command -v curl >/dev/null
docker inspect TickFlow_Stock_Panel >/dev/null
install -d -m 755 /usr/local/sbin
cat > /usr/local/sbin/myagent-deploy <<'MYAGENT_DEPLOY_HELPER'
#!/usr/bin/env bash
# Install root-owned at /usr/local/sbin/myagent-deploy. Deployment access permits
# running repository code in the existing application container; trust main.
set -euo pipefail
[[ $EUID == 0 && $# == 1 && $1 =~ ^[0-9a-f]{40}$ ]] || exit 2
exec 9>/run/lock/myagent-deploy.lock
flock -n 9 || { echo 'Another deployment is running'; exit 1; }
sha=$1
release="/home/myagent-deploy/releases/$sha"
[[ -f "$release/code.tar.gz" && ! -L "$release/code.tar.gz" ]] || exit 1
read -r expected filename < "$release/code.tar.gz.sha256"
[[ $expected =~ ^[0-9a-f]{64}$ && $filename == code.tar.gz ]] || exit 1
context=$(mktemp -d /opt/myagent-release-context.XXXXXX)
chmod 700 "$context"
cp "$release/code.tar.gz" "$context/code.tar.gz"
actual=$(sha256sum "$context/code.tar.gz" | awk '{print $1}')
[[ $actual == "$expected" ]] || { echo 'Checksum mismatch'; exit 1; }
python3 - "$context" <<'PYTHON'
import pathlib, subprocess, sys, tarfile, tomllib
root = pathlib.Path(sys.argv[1])
with tarfile.open(root / 'code.tar.gz') as archive:
    for member in archive.getmembers():
        target = (root / member.name).resolve()
        if not target.is_relative_to(root) or not (member.isfile() or member.isdir()):
            raise SystemExit('Unsafe archive member')
    archive.extractall(root, filter='data')
old = tomllib.loads(subprocess.check_output(
    ['docker', 'exec', 'TickFlow_Stock_Panel', 'cat', '/app/pyproject.toml'], text=True))
new = tomllib.loads((root / 'pyproject.toml').read_text())
for key in ('requires-python', 'dependencies', 'optional-dependencies'):
    if old['project'].get(key) != new['project'].get(key):
        raise SystemExit('Dependencies changed; prepare a separate runtime upgrade first: ' + key)
print('Dependency declarations match; reusing the existing server environment')
PYTHON
old=$(docker inspect TickFlow_Stock_Panel --format '{{.Image}}')
docker tag "$old" "myagent-runtime:$sha"
cat > "$context/Dockerfile" <<'DOCKERFILE'
ARG RUNTIME_IMAGE
FROM ${RUNTIME_IMAGE}
WORKDIR /app
RUN rm -rf /app/app /app/static
COPY app /app/app
COPY static /app/static
COPY frontend/package.json /app/frontend/package.json
COPY pyproject.toml /app/pyproject.toml
COPY generate_manifest.py /tmp/generate_manifest.py
RUN APP_VER=$(/app/.venv/bin/python -c "import json; print(json.load(open('/app/frontend/package.json'))['version'])") && /app/.venv/bin/python /tmp/generate_manifest.py --root /app --output /app/app/upgrade_manifest.json --version "$APP_VER"
CMD ["/app/.venv/bin/python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "3018"]
DOCKERFILE
docker build --network none --build-arg "RUNTIME_IMAGE=myagent-runtime:$sha" -t "myagent-release:$sha" "$context"

cd /opt/tick-stock-panel
project=$(docker inspect TickFlow_Stock_Panel --format '{{ index .Config.Labels "com.docker.compose.project" }}')
[[ -n $project && $project != '<no value>' ]] || exit 1
codex_home=$(docker inspect TickFlow_Stock_Panel --format '{{range .Mounts}}{{if eq .Destination "/root/.codex"}}{{.Source}}{{end}}{{end}}')
[[ -d $codex_home ]] || { echo 'Codex mount missing; stop for review'; exit 1; }
export CODEX_HOME_HOST="$codex_home"
export COMPOSE_REMOVE_ORPHANS=false
old=$(docker inspect TickFlow_Stock_Panel --format '{{.Image}}')
backup="/opt/my-agent-backups/$(date +%Y%m%d-%H%M%S)-$sha"
install -d -m 700 "$backup"
docker tag "$old" "myagent-rollback:$sha"
cp -a .env tiers.yaml docker-compose*.yml "$backup/"

compose=(docker compose -p "$project" -f docker-compose.yml -f docker-compose.prod.yml)
printf 'services:\n  app:\n    image: myagent-release:%s\n' "$sha" > "$backup/release.yml"
printf 'services:\n  app:\n    image: myagent-rollback:%s\n' "$sha" > "$backup/rollback.yml"
"${compose[@]}" -f "$backup/release.yml" config --quiet
needed=$(du -sk /opt/tick-stock-panel-data | awk '{print $1}')
available=$(df -Pk /opt | awk 'END {print $4}')
(( available > needed + 1048576 )) || { echo 'Insufficient backup space'; exit 1; }

# Stop only the application for a consistent backup. Never remove orphan services.
docker stop TickFlow_Stock_Panel
trap 'docker start TickFlow_Stock_Panel >/dev/null || true' EXIT
tar -C /opt -cf "$backup/data.tar" tick-stock-panel-data
trap - EXIT

rollback() {
  trap - ERR
  set +e
  "${compose[@]}" -f "$backup/rollback.yml" up -d --no-build --pull never --no-deps app
  echo "Deployment failed. Previous image restarted; data backup: $backup/data.tar"
  echo 'Data has NOT been restored automatically; review migrations before restoring.'
  exit 1
}
trap rollback ERR
"${compose[@]}" -f "$backup/release.yml" up -d --no-build --pull never --no-deps app
ready=false
for attempt in $(seq 1 60); do
  if curl -fsS --max-time 5 http://127.0.0.1:8001/health >/dev/null; then
    ready=true; break
  fi
  sleep 3
done
[[ $ready == true ]]
cp "$backup/release.yml" docker-compose.github.yml
trap - ERR
echo "Deployed $sha; backup: $backup"
MYAGENT_DEPLOY_HELPER
chown root:root /usr/local/sbin/myagent-deploy
chmod 755 /usr/local/sbin/myagent-deploy
rule=$(mktemp)
trap 'rm -f "$rule"' EXIT
printf '%s\n' 'myagent-deploy ALL=(root) NOPASSWD: /usr/local/sbin/myagent-deploy' > "$rule"
visudo -cf "$rule"
install -o root -g root -m 440 "$rule" /etc/sudoers.d/myagent-deploy
echo 'Setup complete. Add the following PUBLIC line as DEPLOY_KNOWN_HOSTS:'
printf '129.211.213.208 '
cat /etc/ssh/ssh_host_ed25519_key.pub
