"""Internal OpenAI-compatible gateway; provider keys never leave this service."""
from __future__ import annotations

import hmac
import os
import time
import uuid

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response, StreamingResponse

from app.services import shared_ai

router = APIRouter(prefix='/ai/v1', tags=['shared-ai'])


def authorize(request: Request) -> None:
    expected = os.getenv('TICKFLOW_BRIDGE_TOKEN', '').strip()
    supplied = request.headers.get('authorization', '').removeprefix('Bearer ').strip()
    if not expected or not supplied or not hmac.compare_digest(expected, supplied):
        raise HTTPException(status_code=401, detail='shared AI unauthorized')


@router.get('/models')
def models(request: Request):
    authorize(request)
    return {'object': 'list', 'configured': bool(shared_ai.profiles()), 'data': [
        {'id': 'auto', 'object': 'model', 'owned_by': 'shared-ai'},
        *({'id': 'profile:' + p['id'], 'object': 'model', 'owned_by': p['label'], 'name': p['model']} for p in shared_ai.profiles()),
    ]}


@router.post('/chat/completions')
async def chat(request: Request):
    authorize(request)
    body = await request.json()
    if not isinstance(body, dict) or not isinstance(body.get('messages'), list):
        raise HTTPException(status_code=422, detail='messages 必须为数组')
    try:
        choices = shared_ai.candidates(str(body.get('model') or 'auto'))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not choices:
        raise HTTPException(status_code=503, detail='请先在统一 AI 设置中配置并测试 API')
    last_status = 502
    for profile in choices:
        if profile.get("protocol") == "responses":
            if body.get("stream"):
                raise HTTPException(status_code=400, detail="此共享接口的 Responses 模型请使用非流式调用")
            from app.services import ai_responses
            try:
                with shared_ai.using(profile):
                    message = await ai_responses.run_message_once(body["messages"], tools=body.get("tools"), temperature=body.get("temperature"), max_tokens=body.get("max_tokens"), timeout=180)
            except Exception as exc:
                if not shared_ai.retryable(exc):
                    raise
                last_status = getattr(exc, "status_code", 502)
                continue
            calls = []
            for call in message.tool_calls or []:
                calls.append({"id": call.id, "type": "function", "function": {"name": call.function.name, "arguments": call.function.arguments}})
            return {"id": "chatcmpl-shared-" + uuid.uuid4().hex, "created": int(time.time()), "object": "chat.completion", "model": profile["model"], "choices": [{"index": 0, "finish_reason": "tool_calls" if calls else "stop", "message": {"role": "assistant", "content": message.content, "tool_calls": calls}}]}
        from app.services.ai_provider import (
            _openai_retry_kwargs,
            normalize_openai_base_url,
            prepare_tool_messages,
        )
        base = normalize_openai_base_url(profile['base_url']).rstrip('/')
        client = httpx.AsyncClient(timeout=180)
        with shared_ai.using(profile):
            payload = {**body, 'model': profile['model'], 'messages': prepare_tool_messages(body['messages'], model=profile['model'], base_url=profile['base_url'])}
        try:
            for _attempt in range(3):
                upstream = await client.send(client.build_request(
                    'POST', base + '/chat/completions', json=payload,
                    headers={'Authorization': 'Bearer ' + profile['api_key']},
                ), stream=True)
                if upstream.status_code != 400:
                    break
                await upstream.aread()
                from openai import BadRequestError
                try:
                    detail = upstream.json()
                except ValueError:
                    detail = {}
                retry = _openai_retry_kwargs(BadRequestError('Provider rejected optional argument', response=upstream, body=detail), payload)
                if retry is None:
                    break
                payload = retry
                await upstream.aclose()
        except httpx.HTTPError:
            await client.aclose()
            continue
        if upstream.status_code >= 400:
            last_status = upstream.status_code
            await upstream.aclose()
            await client.aclose()
            continue
        if body.get('stream'):
            async def chunks(response=upstream, connection=client):
                try:
                    async for chunk in response.aiter_bytes():
                        yield chunk
                finally:
                    await response.aclose()
                    await connection.aclose()
            return StreamingResponse(chunks(), media_type='text/event-stream', headers={'Cache-Control': 'no-cache'})
        try:
            content = await upstream.aread()
        finally:
            await upstream.aclose()
            await client.aclose()
        return Response(content, media_type='application/json')
    raise HTTPException(status_code=502, detail=f'已配置模型均调用失败，最后状态 HTTP {last_status}；请在统一 AI 设置中测试接口')
