"""Verify deployment metadata and credential files before touching containers."""
import json
import os
import subprocess
from pathlib import Path

import pytest

HELPER = Path(__file__).resolve().parents[2] / 'ops/myagent-deploy'


def inline(name):
    return HELPER.read_text().split("<<'" + name + "'\n", 1)[1].split('\n' + name + '\n', 1)[0]


@pytest.fixture
def server(tmp_path, monkeypatch):
    context = tmp_path / 'context'
    context.mkdir()
    workdir = tmp_path / 'myagent'
    workdir.mkdir()
    data = workdir / 'data'
    data.mkdir()
    compose = workdir / 'compose.yml'
    compose.write_text('services: {}\n')
    (context / 'myagent_requirements.txt').write_text('fastapi>=0.115\n')
    agent = {'Image': 'old-agent', 'Config': {'Labels': {
        'com.docker.compose.service': 'myagent', 'com.docker.compose.project': 'existing-project',
        'com.docker.compose.project.working_dir': str(workdir), 'com.docker.compose.project.config_files': str(compose),
    }, 'Env': ['TICKFLOW_BRIDGE_TOKEN=agent-token', 'ADMIN_TOKEN=agent-admin-token']}, 'Mounts': [{'Source': str(data), 'Destination': '/app/data'}]}
    stock = {'Image': 'old-stock', 'Config': {'Env': ['TICKFLOW_BRIDGE_TOKEN=stock-token']}}
    (tmp_path / 'agent.json').write_text(json.dumps([agent]))
    (tmp_path / 'stock.json').write_text(json.dumps([stock]))
    binary = tmp_path / 'bin'
    binary.mkdir()
    docker = binary / 'docker'
    docker.write_text(f'''#!/bin/sh
if [ "$1" = inspect ]; then
  if [ "$2" = myagent ]; then cat '{tmp_path}/agent.json'; else cat '{tmp_path}/stock.json'; fi
elif [ "$3" = cat ]; then
  printf 'fastapi>=0.115\\n'
else
  printf '[]\\n'
fi
''')
    docker.chmod(0o755)
    monkeypatch.setenv('PATH', str(binary) + os.pathsep + os.environ['PATH'])
    return tmp_path, context, agent


def test_plan_preserves_deployment_and_keeps_tokens_out_of_logs(server):
    root, context, _ = server
    result = subprocess.run(['python', '-c', inline('PLANPY'), str(context), 'a' * 40], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert 'stock-token' not in result.stdout + result.stderr
    assert 'agent-admin-token' not in result.stdout + result.stderr
    plan = json.loads((context / 'myagent-plan.json').read_text())
    assert plan['token'] == 'stock-token'
    assert plan['project'] == 'existing-project'
    backup = root / 'backup'
    backup.mkdir()
    result = subprocess.run(['python', '-c', inline('CONFIGPY'), str(context), str(backup), 'a' * 40], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    release = json.loads((backup / 'myagent-release.yml').read_text())
    assert release['services']['myagent']['environment']['SHARED_AI_ENABLED'] == '1'
    assert release['services']['myagent']['environment']['TICKFLOW_BRIDGE_TOKEN'] == plan['token']
    assert json.loads((backup / 'rollback.yml').read_text())['services']['app']['image'] == 'old-stock'


@pytest.mark.parametrize('invalid', ['data', 'compose', 'dependencies'])
def test_plan_rejects_missing_mount_config_or_runtime_change(server, invalid):
    root, context, agent = server
    if invalid == 'data':
        agent['Mounts'] = []
    elif invalid == 'compose':
        agent['Config']['Labels']['com.docker.compose.project.config_files'] = 'relative.yml'
    else:
        (context / 'myagent_requirements.txt').write_text('new-dependency\n')
    (root / 'agent.json').write_text(json.dumps([agent]))
    result = subprocess.run(['python', '-c', inline('PLANPY'), str(context), 'a' * 40], capture_output=True, text=True)
    assert result.returncode != 0
    expected = {'data': 'persistent data mount missing', 'compose': 'Cannot safely identify', 'dependencies': 'dependencies differ'}[invalid]
    assert expected in result.stderr
    assert not (context / 'myagent-plan.json').exists()
