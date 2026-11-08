"""Small, atomically-written local store for model-provider settings."""
import json
import os
from pathlib import Path
from tempfile import NamedTemporaryFile

from .config import settings

ALLOWED_PROVIDERS = {"openai", "deepseek", "dashscope", "siliconflow", "openrouter", "moonshot"}


def _path() -> Path:
    return Path(settings.provider_config_path)


def read() -> dict:
    try:
        with _path().open("r", encoding="utf-8") as handle:
            value = json.load(handle)
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError, TypeError):
        return {}


def _write(value: dict) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))
        handle.flush()
        os.fsync(handle.fileno())
        temporary = handle.name
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def update_provider(name: str, api_key: str | None, model: str | None, clear_key: bool = False) -> None:
    if name not in ALLOWED_PROVIDERS:
        raise ValueError("不支持的模型平台")
    data = read()
    providers = data.setdefault("providers", {})
    item = providers.setdefault(name, {})
    if clear_key:
        item.pop("api_key", None)
    elif api_key is not None:
        item["api_key"] = api_key.strip()
    if model is not None:
        item["model"] = model.strip()
    _write(data)


def update_order(order: list[str]) -> None:
    if not order or any(name not in ALLOWED_PROVIDERS for name in order) or len(order) != len(set(order)):
        raise ValueError("模型主备顺序无效")
    data = read()
    data["order"] = order
    _write(data)


def list_custom_providers() -> list[dict]:
    data = read()
    raw = data.get("custom_providers", {})
    if not isinstance(raw, dict):
        return []
    result = []
    for name, item in raw.items():
        if not isinstance(item, dict):
            continue
        result.append({
            "name": name,
            "label": str(item.get("label") or name),
            "base_url": str(item.get("base_url") or ""),
            "model": str(item.get("model") or ""),
            "usage_url": str(item.get("usage_url") or ""),
            "quota_url": str(item.get("quota_url") or ""),
            "enabled": bool(item.get("enabled", True)),
            "configured": bool(item.get("api_key")),
        })
    return result


def update_custom_provider(item: dict) -> None:
    data = read()
    providers = data.setdefault("custom_providers", {})
    name = item["name"]
    current = providers.setdefault(name, {})
    for key in ("label", "base_url", "model", "usage_url", "quota_url", "enabled"):
        current[key] = item.get(key, current.get(key, ""))
    if item.get("api_key") is not None:
        current["api_key"] = str(item["api_key"]).strip()
    _write(data)


def delete_custom_provider(name: str) -> bool:
    data = read()
    providers = data.get("custom_providers", {})
    if not isinstance(providers, dict) or name not in providers:
        return False
    providers.pop(name, None)
    _write(data)
    return True


def custom_provider_secret(name: str) -> dict:
    data = read()
    item = data.get("custom_providers", {}).get(name, {})
    return item if isinstance(item, dict) else {}
