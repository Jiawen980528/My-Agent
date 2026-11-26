from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes import router


def test_health_alias_is_available_for_mounted_quant_api() -> None:
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)

    canonical = client.get("/health")
    mounted_api = client.get("/api/health")

    assert canonical.status_code == 200
    assert mounted_api.status_code == 200
    canonical_body = canonical.json()
    mounted_body = mounted_api.json()
    assert mounted_body["status"] == canonical_body["status"] == "ok"
    assert mounted_body["version"] == canonical_body["version"]
    assert mounted_body["mode"] == canonical_body["mode"]
    assert set(mounted_body["memory"]) == set(canonical_body["memory"])
