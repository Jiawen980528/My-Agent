#!/usr/bin/env bash
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run with sudo'; exit 1; }
id myagent-deploy >/dev/null
command -v docker >/dev/null
command -v flock >/dev/null
command -v curl >/dev/null
docker inspect TickFlow_Stock_Panel >/dev/null
docker inspect myagent >/dev/null
install -d -m 755 /usr/local/sbin
cat > /usr/local/sbin/myagent-deploy <<'MYAGENT_DEPLOY_HELPER'
#!/usr/bin/env bash
# Install root-owned at /usr/local/sbin/myagent-deploy. Deployment access permits
# running repository code in the existing application container; trust main.
set -euo pipefail
umask 077
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

# Inspect the existing MyAgent deployment without printing credentials.
python3 - "$context" "$sha" <<'PLANPY'
import json, pathlib, secrets, subprocess, sys
root = pathlib.Path(sys.argv[1]); sha = sys.argv[2]
def inspect(name):
    return json.loads(subprocess.check_output(['docker', 'inspect', name], text=True))[0]
stock = inspect('TickFlow_Stock_Panel'); agent = inspect('myagent')
def env(container):
    return dict(item.split('=', 1) for item in container['Config']['Env'] if '=' in item)
aenv = env(agent); senv = env(stock)
if not aenv.get('ADMIN_TOKEN'):
    raise SystemExit('MyAgent administrator token is not configured')
labels = agent['Config']['Labels']
service = labels.get('com.docker.compose.service')
project = labels.get('com.docker.compose.project')
workdir = pathlib.Path(labels.get('com.docker.compose.project.working_dir', ''))
files = labels.get('com.docker.compose.project.config_files', '').split(',')
if not service or not project or not workdir.is_absolute() or not workdir.is_dir() or not all(pathlib.Path(f).is_absolute() and pathlib.Path(f).is_file() for f in files):
    raise SystemExit('Cannot safely identify the MyAgent Compose deployment')
data = next((m['Source'] for m in agent['Mounts'] if m['Destination'] == '/app/data'), '')
if not data or data == '/' or not pathlib.Path(data).is_dir():
    raise SystemExit('MyAgent persistent data mount missing')
requirements = subprocess.check_output(['docker', 'exec', 'myagent', 'cat', '/app/requirements.txt'])
def requirement_lines(value):
    return [line.split('#', 1)[0].strip() for line in value.decode().splitlines() if line.split('#', 1)[0].strip()]
if requirement_lines(requirements) != requirement_lines((root / 'myagent_requirements.txt').read_bytes()):
    raise SystemExit('MyAgent dependencies differ; prepare runtime upgrade separately')
legacy_code = """import json
from app.config import settings
from app import provider_store
items=[p.__dict__ for p in settings.providers().values() if p.api_key and p.name != 'shared']
for name, item in provider_store.read().get('custom_providers', {}).items():
    if isinstance(item, dict) and item.get('enabled', True) and item.get('api_key') and item.get('model'):
        items.append({**item, 'name': name})
print(json.dumps(items))
"""
legacy = subprocess.check_output(['docker', 'exec', 'myagent', 'python', '-c', legacy_code], text=True)
(root / 'legacy-ai.json').write_text(legacy)
plan = {'image': agent['Image'], 'project': project, 'service': service, 'workdir': str(workdir), 'files': files, 'data': data,
        'token': senv.get('TICKFLOW_BRIDGE_TOKEN') or aenv.get('TICKFLOW_BRIDGE_TOKEN') or secrets.token_urlsafe(40),
        'old_stock_token': senv.get('TICKFLOW_BRIDGE_TOKEN', ''),
        'agent_admin_token': aenv['ADMIN_TOKEN'],
        'old_stock_admin_token': senv.get('MYAGENT_ADMIN_TOKEN', ''),
        'old_stock_bridge_url': senv.get('MYAGENT_BRIDGE_URL', ''),
        'old_agent_env': {key: aenv.get(key, '') for key in ('SHARED_AI_ENABLED', 'TICKFLOW_BRIDGE_TOKEN', 'TICKFLOW_BRIDGE_URL')}}
(root / 'myagent-plan.json').write_text(json.dumps(plan))
print('MyAgent deployment and dependencies verified; credentials remain server-side')
PLANPY
plan_value() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$context/myagent-plan.json" "$1"; }
agent_old=$(plan_value image)
agent_project=$(plan_value project)
agent_service=$(plan_value service)
agent_workdir=$(plan_value workdir)
agent_data=$(plan_value data)
docker tag "$agent_old" "myagent-service-runtime:$sha"
cat > "$context/MyAgent.Dockerfile" <<'AGENTDOCKER'
ARG RUNTIME_IMAGE
FROM ${RUNTIME_IMAGE}
WORKDIR /app
RUN rm -rf /app/app
COPY myagent_app /app/app
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
AGENTDOCKER
docker build --network none -f "$context/MyAgent.Dockerfile" --build-arg "RUNTIME_IMAGE=myagent-service-runtime:$sha" -t "myagent-service-release:$sha" "$context"

cd /opt/tick-stock-panel
project=$(docker inspect TickFlow_Stock_Panel --format '{{ index .Config.Labels "com.docker.compose.project" }}')
[[ -n $project && $project != '<no value>' ]] || exit 1
codex_home=$(docker inspect TickFlow_Stock_Panel --format '{{range .Mounts}}{{if eq .Destination "/root/.codex"}}{{.Source}}{{end}}{{end}}')
[[ -d $codex_home ]] || { echo 'Codex mount missing; stop for review'; exit 1; }
export CODEX_HOME_HOST="$codex_home"
export COMPOSE_REMOVE_ORPHANS=false
old=$(docker inspect TickFlow_Stock_Panel --format '{{.Image}}')
backup_root=/opt/my-agent-backups
today=$(date +%Y%m%d)
backup="$backup_root/$(date +%Y%m%d-%H%M%S)-$sha"
install -d -m 700 "$backup_root" "$backup"
# 同一天复用已有数据备份；每次发布仍保存独立回滚配置。
data_backup=$(find "$backup_root" -mindepth 1 -maxdepth 1 -type d -name "$today-*" -print0 | sort -z | head -z -n 1 | xargs -0 -r -n1 printf '%s' || true)
docker tag "$old" "myagent-rollback:$sha"
cp -a .env tiers.yaml docker-compose*.yml "$backup/"

compose=(docker compose -p "$project" -f docker-compose.yml -f docker-compose.prod.yml)
python3 - "$context" "$backup" "$sha" <<'CONFIGPY'
import json, pathlib, sys
context, backup = map(pathlib.Path, sys.argv[1:3]); sha = sys.argv[3]
p = json.loads((context / 'myagent-plan.json').read_text())
old_stock = json.loads(__import__('subprocess').check_output(['docker', 'inspect', 'TickFlow_Stock_Panel'], text=True))[0]['Image']
configs = {
 'release.yml': {'services': {'app': {'image': 'myagent-release:' + sha, 'environment': {'TICKFLOW_BRIDGE_TOKEN': p['token'], 'MYAGENT_ADMIN_TOKEN': p['agent_admin_token'], 'MYAGENT_BRIDGE_URL': 'http://myagent:8000'}}}},
 'rollback.yml': {'services': {'app': {'image': old_stock, 'environment': {'TICKFLOW_BRIDGE_TOKEN': p['old_stock_token'], 'MYAGENT_ADMIN_TOKEN': p['old_stock_admin_token'], 'MYAGENT_BRIDGE_URL': p['old_stock_bridge_url']}}}},
 'myagent-release.yml': {'services': {p['service']: {'image': 'myagent-service-release:' + sha, 'environment': {'SHARED_AI_ENABLED': '1', 'TICKFLOW_BRIDGE_TOKEN': p['token'], 'TICKFLOW_BRIDGE_URL': 'http://tick-stock-panel:3018'}}}},
 'myagent-rollback.yml': {'services': {p['service']: {'image': p['image'], 'environment': p['old_agent_env']}}},
}
for name, config in configs.items():
    (backup / name).write_text(json.dumps(config))
for index, path in enumerate(p['files']):
    __import__('shutil').copy2(path, backup / ('myagent-original-' + str(index) + '.yml'))
if pathlib.Path(p['workdir'], '.env').is_file():
    __import__('shutil').copy2(pathlib.Path(p['workdir'], '.env'), backup / 'myagent-original.env')
CONFIGPY
agent_compose=(docker compose --project-directory "$agent_workdir" -p "$agent_project")
while IFS= read -r config; do agent_compose+=(-f "$config"); done < <(python3 -c 'import json,sys; print("\n".join(json.load(open(sys.argv[1]))["files"]))' "$context/myagent-plan.json")
"${agent_compose[@]}" -f "$backup/myagent-release.yml" config --quiet
"${compose[@]}" -f "$backup/release.yml" config --quiet
agent_needed=$(du -sk "$agent_data" | awk '{print $1}')
needed=$(du -sk /opt/tick-stock-panel-data | awk '{print $1}')
available=$(df -Pk /opt | awk 'END {print $4}')
(( available > needed + agent_needed + 1048576 )) || { echo 'Insufficient backup space'; exit 1; }

# Stop only the application for a consistent backup. Never remove orphan services.
docker stop TickFlow_Stock_Panel myagent
trap 'docker start TickFlow_Stock_Panel myagent >/dev/null || true' EXIT
if [[ -n "$data_backup" && -f "$data_backup/data.tar" && -f "$data_backup/myagent-data.tar" ]]; then
  ln -s "$data_backup/data.tar" "$backup/data.tar"
  ln -s "$data_backup/myagent-data.tar" "$backup/myagent-data.tar"
  echo "Reusing daily data backup: $data_backup"
else
  tar -C /opt -cf "$backup/data.tar" tick-stock-panel-data
  tar -C "$agent_data" -cf "$backup/myagent-data.tar" .
fi
trap - EXIT

rollback() {
  trap - ERR
  set +e
  "${compose[@]}" -f "$backup/rollback.yml" up -d --no-build --pull never --no-deps app
  "${agent_compose[@]}" -f "$backup/myagent-rollback.yml" up -d --no-build --pull never --no-deps "$agent_service"
  echo "Deployment failed. Previous image restarted; data backup: $backup/data.tar"
  echo 'Data has NOT been restored automatically; review migrations before restoring.'
  exit 1
}
trap rollback ERR
"${compose[@]}" -f "$backup/release.yml" up -d --no-build --pull never --no-deps app
"${agent_compose[@]}" -f "$backup/myagent-release.yml" up -d --no-build --pull never --no-deps "$agent_service"
ready=false
for attempt in $(seq 1 60); do
  if curl -fsS --max-time 5 http://127.0.0.1:8001/health >/dev/null && curl -fsS --max-time 5 http://127.0.0.1:8000/api/health >/dev/null; then
    ready=true; break
  fi
  sleep 3
done
[[ $ready == true ]]
# Import existing server-side provider keys into the shared store without logging them.
docker exec -i TickFlow_Stock_Panel /app/.venv/bin/python -c '
import hashlib,json,sys
from urllib.parse import urlsplit
from app.services import shared_ai
existing={p["id"] for p in shared_ai.profiles()}
count=0
for old in json.load(sys.stdin):
    url=(old.get("base_url") or "https://api.openai.com/v1").rstrip("/")
    if "/api/bridge/ai/" in url: continue
    item={"provider":"openai_compat","base_url":url,"model":old["model"],"api_key":old["api_key"],"protocol":"chat_completions"}
    item["id"]=hashlib.sha256("\n".join(item[k] for k in ("provider","base_url","model")).encode()).hexdigest()[:16]
    item["label"]=urlsplit(url).hostname or old["name"]
    if item["id"] not in existing:
        shared_ai.remember(item); count+=1
print("Existing AI profiles imported:",count)
' < "$context/legacy-ai.json"
docker exec myagent python -c '
from app.config import settings
from app.agent import get_client
assert "shared" in settings.providers(), "MyAgent is not using shared configuration"
client=get_client()
models=client.models.list()
assert any(item.id == "auto" for item in models.data), "Shared gateway model list missing"
print("MyAgent shared gateway authenticated; configured choices:",len(models.data)-1)
try:
    response=client.chat.completions.create(model="auto",messages=[{"role":"user","content":"请只回复 OK"}])
    assert response.choices and response.choices[0].message.content, "No text response"
    print("Shared AI text probe: OK")
except Exception as exc:
    print("Shared AI provider probe requires review:",type(exc).__name__)
'
cp "$backup/release.yml" docker-compose.github.yml
cp "$backup/myagent-release.yml" "$agent_workdir/docker-compose.shared-ai.yml"
chmod 600 docker-compose.github.yml "$agent_workdir/docker-compose.shared-ai.yml"
trap - ERR
# 只保留最近 5 个回滚目录，避免备份无限增长。
find "$backup_root" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | tail -n +6 | cut -d' ' -f2- | xargs -r rm -rf
echo "Deployed $sha; backup: $backup"
MYAGENT_DEPLOY_HELPER
chown root:root /usr/local/sbin/myagent-deploy
chmod 755 /usr/local/sbin/myagent-deploy
rule=$(mktemp)
trap 'rm -f "$rule"' EXIT
cat > /usr/local/sbin/myagent-static-deploy <<'STATIC_HELPER'
#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ $EUID == 0 && $# == 1 && $1 =~ ^[0-9a-f]{40}$ ]] || exit 2
sha=$1
release="/home/myagent-deploy/releases/$sha"
archive="$release/static.tar.gz"
checksum="$release/static.tar.gz.sha256"
[[ -f "$archive" && -f "$checksum" ]] || exit 1
read -r expected filename < "$checksum"
[[ $expected =~ ^[0-9a-f]{64}$ && $filename == static.tar.gz ]] || exit 1
[[ $(sha256sum "$archive" | awk '{print $1}') == "$expected" ]] || { echo 'Checksum mismatch'; exit 1; }
context=$(mktemp -d /opt/myagent-static-context.XXXXXX)
trap 'rm -rf "$context"' EXIT
tar -xzf "$archive" -C "$context"
[[ -f "$context/index.html" ]] || exit 1
docker inspect TickFlow_Stock_Panel >/dev/null
docker cp "$context/." TickFlow_Stock_Panel:/app/static/
docker cp "$context/index.html" TickFlow_Stock_Panel:/app/static/index.html
curl -fsS --max-time 10 http://127.0.0.1:8001/health >/dev/null
echo "Static frontend deployed $sha"
STATIC_HELPER
chown root:root /usr/local/sbin/myagent-static-deploy
chmod 755 /usr/local/sbin/myagent-static-deploy
printf '%s\n' 'myagent-deploy ALL=(root) NOPASSWD: /usr/local/sbin/myagent-deploy' > "$rule"
printf '%s\n' 'myagent-deploy ALL=(root) NOPASSWD: /usr/local/sbin/myagent-static-deploy' >> "$rule"
visudo -cf "$rule"
install -o root -g root -m 440 "$rule" /etc/sudoers.d/myagent-deploy
echo 'Setup complete. Add the following PUBLIC line as DEPLOY_KNOWN_HOSTS:'
printf '129.211.213.208 '
cat /etc/ssh/ssh_host_ed25519_key.pub
