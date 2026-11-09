"""Shared AI profiles. Secrets stay server-side; request overrides are task-local."""
from __future__ import annotations

import functools
import hashlib
import inspect
from contextlib import contextmanager
from contextvars import ContextVar
from urllib.parse import urlsplit

from app import secrets_store
from app.config import settings

_override: ContextVar[dict | None] = ContextVar('shared_ai_profile', default=None)
FIELDS = ('provider', 'base_url', 'model', 'api_key', 'protocol')


def current_override() -> dict | None:
    return _override.get()


def snapshot() -> dict:
    saved = secrets_store.load()
    result = {key: saved.get('ai_' + key) or getattr(settings, 'ai_' + key, '') for key in FIELDS}
    result['base_url'] = str(result['base_url']).rstrip('/')
    result['protocol'] = result['protocol'] or 'chat_completions'
    result['id'] = hashlib.sha256(('\n'.join(str(result[k]) for k in ('provider', 'base_url', 'model'))).encode()).hexdigest()[:16]
    result['label'] = urlsplit(result['base_url']).hostname or result['provider']
    return result


def remember(profile: dict) -> None:
    if not profile.get('api_key') or not profile.get('model') or profile.get('provider') == 'codex_cli':
        return
    saved = secrets_store.load().get('ai_profiles', {})
    if not isinstance(saved, dict):
        saved = {}
    saved[profile['id']] = profile
    secrets_store.save({'ai_profiles': saved})


def profiles() -> list[dict]:
    current = snapshot()
    raw = secrets_store.load().get('ai_profiles', {})
    result = [current] if current.get('api_key') and current.get('model') and current.get('provider') != 'codex_cli' else []
    if isinstance(raw, dict):
        result.extend(p for p in raw.values() if isinstance(p, dict) and p.get('api_key') and p.get('model') and p.get('id') != current['id'])
    return result


def public_profiles() -> dict:
    active = snapshot()['id']
    return {'mode': secrets_store.load().get('ai_selection_mode', 'auto'), 'active_id': active,
            'items': [{key: p.get(key) for key in ('id', 'label', 'provider', 'base_url', 'model')} for p in profiles()]}


def select(profile_id: str, mode: str) -> None:
    if mode not in {'auto', 'manual'}:
        raise ValueError('选择方式必须为 auto 或 manual')
    profile = next((p for p in profiles() if p['id'] == profile_id), None)
    if profile is None:
        raise ValueError('已保存的 AI 配置不存在')
    remember(snapshot())
    secrets_store.save({**{'ai_' + key: profile[key] for key in FIELDS}, 'ai_selection_mode': mode})


def candidates(requested: str = 'auto') -> list[dict]:
    if _override.get() is not None:
        return [_override.get()]
    items = profiles()
    if requested not in ('', 'auto'):
        items = [p for p in items if requested in (p['model'], 'profile:' + p['id'])]
        if not items:
            raise ValueError('请选择已保存并配置密钥的模型')
        return items[:1]
    if secrets_store.load().get('ai_selection_mode', 'auto') == 'manual':
        return items[:1]
    return items


@contextmanager
def using(profile: dict):
    token = _override.set(profile)
    try:
        yield
    finally:
        _override.reset(token)


def retryable(exc: Exception) -> bool:
    import httpx
    from openai import APIConnectionError, APIStatusError
    if isinstance(exc, (httpx.HTTPError, APIConnectionError, APIStatusError)):
        return True
    return exc.__cause__ is not None and exc.__cause__ is not exc and retryable(exc.__cause__)


def routed(function):
    """Fallback only before any output. A partial answer is never restarted."""
    if inspect.isasyncgenfunction(function):
        @functools.wraps(function)
        async def stream(*args, **kwargs):
            choices = candidates() if snapshot().get('provider') != 'codex_cli' else []
            if not choices:
                async for item in function(*args, **kwargs):
                    yield item
                return
            for index, profile in enumerate(choices):
                emitted = False
                try:
                    with using(profile):
                        async for item in function(*args, **kwargs):
                            emitted = True
                            yield item
                    return
                except Exception as exc:
                    if emitted or index == len(choices) - 1 or not retryable(exc):
                        raise
        return stream
    @functools.wraps(function)
    async def call(*args, **kwargs):
        choices = candidates() if snapshot().get('provider') != 'codex_cli' else []
        if not choices:
            return await function(*args, **kwargs)
        for index, profile in enumerate(choices):
            try:
                with using(profile):
                    return await function(*args, **kwargs)
            except Exception as exc:
                if index == len(choices) - 1 or not retryable(exc):
                    raise
    return call
