from __future__ import annotations

from pathlib import Path

from app.services import secure_research_import


def test_encrypted_workbook_is_imported_once_and_private_material_is_erased(
    tmp_path: Path, monkeypatch,
):
    data_dir = tmp_path / "data"
    payload_path = tmp_path / "payload.bin"
    imported: list[tuple[bytes, str]] = []

    def fake_import(_data_dir: Path, raw: bytes, filename: str) -> dict:
        imported.append((raw, filename))
        return {"count": 93, "imported": 93, "unresolved": 0, "sources": [filename]}

    monkeypatch.setattr(secure_research_import.research_pool, "import_workbook", fake_import)
    public = secure_research_import.public_key(data_dir, bits=1024)
    assert public["state"] == "ready"
    assert (data_dir / "user_data" / ".myagent_research_import_key.json").stat().st_mode & 0o777 == 0o600

    payload_path.write_bytes(secure_research_import.encrypt(b"private workbook", "产业链.xlsx", public))
    result = secure_research_import.consume(data_dir, payload_path)

    assert result == {"state": "done", "result": {"count": 93, "imported": 93, "unresolved": 0}}
    assert imported == [(b"private workbook", "产业链.xlsx")]
    assert not payload_path.exists()
    assert not (data_dir / "user_data" / ".myagent_research_import_key.json").exists()
    assert secure_research_import.consume(data_dir, payload_path) == result
    assert len(imported) == 1


def test_tampered_payload_is_rejected_without_losing_retry_material(tmp_path: Path):
    data_dir = tmp_path / "data"
    payload_path = tmp_path / "payload.bin"
    public = secure_research_import.public_key(data_dir, bits=1024)
    payload = bytearray(secure_research_import.encrypt(b"private workbook", "产业链.xlsx", public))
    payload[-33] ^= 1
    payload_path.write_bytes(payload)

    result = secure_research_import.consume(data_dir, payload_path)

    assert result["state"] == "error"
    assert "authentication failed" in result["error"]
    assert payload_path.exists()
    assert (data_dir / "user_data" / ".myagent_research_import_key.json").exists()
