"""Local-only email connection store. Secrets are never returned by API responses."""
import json
import os
from pathlib import Path
from .config import settings

def _path() -> Path:
    return Path(settings.email_config_path)

def read() -> dict:
    try:
        data = json.loads(_path().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError, TypeError):
        return {}

def save_qq(email: str, authorization_code: str) -> None:
    target = _path(); target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps({"qq_mail": {"email": email, "authorization_code": authorization_code}}, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, target)
    try: os.chmod(target, 0o600)
    except OSError: pass

def qq_credentials() -> tuple[str, str] | None:
    item = read().get("qq_mail", {})
    email, code = item.get("email"), item.get("authorization_code")
    return (email, code) if isinstance(email, str) and isinstance(code, str) and email and code else None

def qq_status() -> dict:
    credentials = qq_credentials()
    if not credentials: return {"connected": False}
    email = credentials[0]
    local, _, domain = email.partition("@")
    masked = (local[:2] + "***@" + domain) if local else "***"
    return {"connected": True, "email": masked}
