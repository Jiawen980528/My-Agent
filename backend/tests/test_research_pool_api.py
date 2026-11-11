import io
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, Request, UploadFile

from app.api import myagent_bridge
from app.services import research_pool


def _request_from(ip: str) -> Request:
    return Request({"type": "http", "method": "GET", "path": "/", "headers": [],
                    "client": (ip, 12345), "server": ("test", 80), "scheme": "http",
                    "query_string": b""})


def test_encrypted_import_control_is_server_local_only():
    myagent_bridge._require_local_research_import(_request_from("127.0.0.1"))
    with pytest.raises(HTTPException) as denied:
        myagent_bridge._require_local_research_import(_request_from("203.0.113.10"))
    assert denied.value.status_code == 404


def test_research_pool_api_empty_import_and_invalid_file(tmp_path: Path, monkeypatch):
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(repo=SimpleNamespace(store=SimpleNamespace(data_dir=tmp_path)))))

    assert myagent_bridge.get_research_pool(request) == {"items": [], "sources": []}
    with pytest.raises(HTTPException) as bad:
        myagent_bridge.import_research_pool(request, UploadFile(file=io.BytesIO(b"invalid"), filename="bad.xlsx"))
    assert bad.value.status_code == 422

    monkeypatch.setattr(research_pool, '_workbook_rows', lambda _raw, _filename, _data_dir: [
        {"symbol": "000739.SZ", "name": "普洛药业", "theme": "创新药", "segment": "原料药", "role": "产业链",
         "rationale": "测试", "source": "测试", "source_date": "2026-11-02", "source_file": "pool.xlsx"},
    ])
    saved = myagent_bridge.import_research_pool(request, UploadFile(file=io.BytesIO(b"file"), filename="pool.xlsx"))
    assert saved['count'] == 1
    assert myagent_bridge.get_research_pool(request)['items'][0]['symbol'] == '000739.SZ'
