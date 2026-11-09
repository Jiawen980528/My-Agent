from __future__ import annotations

import asyncio

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import secrets_store
from app.api.shared_ai import router
from app.config import settings
from app.services import shared_ai


@pytest.fixture
def configured(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, 'data_dir', tmp_path)
    monkeypatch.setattr(settings, 'ai_api_key', '')
    monkeypatch.setattr(settings, 'ai_provider', 'openai_compat')
    monkeypatch.setattr(settings, 'ai_base_url', '')
    monkeypatch.setattr(settings, 'ai_model', '')
    secrets_store.save({'ai_provider': 'openai_compat', 'ai_base_url': 'https://first.example/v1', 'ai_model': 'first', 'ai_api_key': 'secret-first'})
    first = shared_ai.snapshot()
    shared_ai.remember(first)
    secrets_store.save({'ai_base_url': 'https://second.example/v1', 'ai_model': 'second', 'ai_api_key': 'secret-second'})
    shared_ai.remember(shared_ai.snapshot())
    return first


def test_profiles_preserve_keys_without_exposing_them(configured):
    assert len(shared_ai.public_profiles()['items']) == 2
    assert 'secret-' not in str(shared_ai.public_profiles())
    shared_ai.select(configured['id'], 'manual')
    assert secrets_store.get_ai_key() == 'secret-first'
    assert [p['model'] for p in shared_ai.candidates()] == ['first']
    shared_ai.select(configured['id'], 'auto')
    assert [p['model'] for p in shared_ai.candidates()] == ['first', 'second']


@pytest.mark.asyncio
async def test_request_overrides_are_isolated_and_reset(configured):
    async def read(profile):
        with shared_ai.using(profile):
            await asyncio.sleep(0)
            return secrets_store.get_ai_key(), secrets_store.get_ai_config('ai_model')
    values = await asyncio.gather(*(read(p) for p in shared_ai.profiles()))
    assert values == [('secret-second', 'second'), ('secret-first', 'first')]
    assert shared_ai.current_override() is None


@pytest.mark.asyncio
async def test_auto_falls_back_before_output_but_never_restarts_partial_answer(configured):
    calls = []
    @shared_ai.routed
    async def operation():
        model = secrets_store.get_ai_config('ai_model')
        calls.append(model)
        if model == 'second':
            raise httpx.ConnectError('not available')
        return 'answer'
    assert await operation() == 'answer'
    assert calls == ['second', 'first']
    @shared_ai.routed
    async def partial():
        yield 'partial answer'
        raise httpx.ReadError('connection lost')
    result = partial()
    assert await anext(result) == 'partial answer'
    with pytest.raises(httpx.ReadError):
        await anext(result)
    assert shared_ai.current_override() is None


def test_gateway_auth_and_model_list_never_expose_keys(configured, monkeypatch):
    monkeypatch.setenv('TICKFLOW_BRIDGE_TOKEN', 'bridge-secret')
    app = FastAPI()
    app.include_router(router, prefix='/api/bridge')
    client = TestClient(app)
    assert client.get('/api/bridge/ai/v1/models').status_code == 401
    response = client.get('/api/bridge/ai/v1/models', headers={'Authorization': 'Bearer bridge-secret'})
    assert response.status_code == 200
    assert response.json()['data'][0]['id'] == 'auto'
    assert 'secret-' not in response.text
    response = client.post('/api/bridge/ai/v1/chat/completions', headers={'Authorization': 'Bearer bridge-secret'}, json={'model': 'unknown', 'messages': []})
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_gateway_preserves_images_and_tools_and_uses_server_key(configured, monkeypatch):
    from app.api import shared_ai as gateway
    monkeypatch.setenv('TICKFLOW_BRIDGE_TOKEN', 'bridge-secret')
    real_client = httpx.AsyncClient
    requests = []
    def provider(request):
        import json
        requests.append((str(request.url), request.headers['Authorization'], json.loads(request.content)))
        return httpx.Response(200, json={'choices': [{'message': {'content': 'image understood'}}]})
    def make_client(**kwargs):
        return real_client(transport=httpx.MockTransport(provider), **kwargs)
    monkeypatch.setattr(gateway.httpx, 'AsyncClient', make_client)
    app = FastAPI()
    app.include_router(router, prefix='/api/bridge')
    messages = [{'role': 'user', 'content': [{'type': 'text', 'text': 'describe'}, {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,AA=='}}]}]
    tools = [{'type': 'function', 'function': {'name': 'read_market', 'parameters': {}}}]
    async with real_client(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        result = await client.post('/api/bridge/ai/v1/chat/completions', headers={'Authorization': 'Bearer bridge-secret'}, json={'model': 'auto', 'messages': messages, 'tools': tools})
    assert result.status_code == 200
    assert requests[0][0] == 'https://second.example/v1/chat/completions'
    assert requests[0][1] == 'Bearer secret-second'
    assert requests[0][2]['messages'] == messages
    assert requests[0][2]['tools'] == tools
    assert requests[0][2]['model'] == 'second'


def test_responses_image_conversion_preserves_actual_image():
    from app.services.ai_responses import chat_input
    result = chat_input([{'role': 'user', 'content': [
        {'type': 'text', 'text': 'describe'},
        {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,AA=='}},
    ]}])
    assert result[0]['content'] == [
        {'type': 'input_text', 'text': 'describe'},
        {'type': 'input_image', 'image_url': 'data:image/png;base64,AA=='},
    ]


@pytest.mark.asyncio
async def test_failed_tool_round_does_not_restart_completed_tools(configured, monkeypatch):
    from types import SimpleNamespace

    from app.services import ai_provider
    calls = []
    rounds = 0
    async def model(*args, **kwargs):
        nonlocal rounds
        rounds += 1
        if rounds == 1:
            return SimpleNamespace(content='', tool_calls=[SimpleNamespace(id='tool-1', function=SimpleNamespace(name='read_market', arguments='{}'))])
        raise httpx.ReadError('model failed after tool completion')
    async def tool(name, arguments):
        calls.append(name)
        return {'ok': True}
    monkeypatch.setattr(ai_provider, '_run_openai_message_once', model)
    with pytest.raises(httpx.ReadError):
        await ai_provider.generate_ai_text_with_tools([{'role': 'user', 'content': 'query'}], [{'type': 'function', 'function': {'name': 'read_market'}}], execute_tool=tool)
    assert calls == ['read_market']
    assert rounds == 2
