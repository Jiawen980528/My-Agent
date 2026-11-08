"""Local attachment storage for chat. Text is exposed to the model only on demand."""
import base64
import hashlib
import json
import re
import uuid
from pathlib import Path

from .config import settings

MAX_BYTES = 3 * 1024 * 1024
TEXT_EXTENSIONS = {".txt", ".md", ".csv", ".json", ".log"}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
IMAGE_MIME_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}

def _root() -> Path:
    root = Path(settings.uploads_path)
    root.mkdir(parents=True, exist_ok=True)
    return root

def save(filename: str, content_base64: str) -> dict:
    name = Path(filename).name.strip()
    suffix = Path(name).suffix.lower()
    if not name or suffix not in TEXT_EXTENSIONS | IMAGE_EXTENSIONS:
        raise ValueError("仅支持 txt、md、csv、json、log 和常见图片格式")
    try:
        raw = base64.b64decode(content_base64, validate=True)
    except Exception as exc:
        raise ValueError("附件编码无效") from exc
    if not raw or len(raw) > MAX_BYTES:
        raise ValueError("附件必须介于 1 字节和 3 MB 之间")
    attachment_id = uuid.uuid4().hex
    path = _root() / f"{attachment_id}{suffix}"
    path.write_bytes(raw)
    try: path.chmod(0o600)
    except OSError: pass
    meta = {"id": attachment_id, "name": name[:180], "suffix": suffix, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
    (path.with_suffix(path.suffix + ".json")).write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    return {**meta, "kind": "text" if suffix in TEXT_EXTENSIONS else "image"}

def context(ids: list[str]) -> tuple[str, list[dict]]:
    chunks, items = [], []
    for attachment_id in ids[:5]:
        if not re.fullmatch(r"[0-9a-f]{32}", attachment_id):
            raise ValueError("附件标识无效")
        matches = list(_root().glob(f"{attachment_id}.*"))
        source = next((p for p in matches if p.suffix != ".json"), None)
        if not source: raise ValueError("附件不存在或已清理")
        suffix = source.suffix.lower()
        if suffix in TEXT_EXTENSIONS:
            text = source.read_text(encoding="utf-8", errors="replace")[:30_000]
            chunks.append(f"\n--- 附件：{source.name} ---\n{text}\n--- 附件结束 ---")
            items.append({"id": attachment_id, "name": source.name, "kind": "text"})
        else:
            items.append({"id": attachment_id, "name": source.name, "kind": "image"})
    return "\n".join(chunks), items


def image_data_urls(ids: list[str]) -> list[str]:
    """Load requested image attachments for a single multimodal model call."""
    result: list[str] = []
    for attachment_id in ids[:5]:
        if not re.fullmatch(r"[0-9a-f]{32}", attachment_id):
            raise ValueError("附件标识无效")
        matches = list(_root().glob(f"{attachment_id}.*"))
        source = next((p for p in matches if p.suffix.lower() in IMAGE_EXTENSIONS), None)
        if source is None:
            continue
        mime_type = IMAGE_MIME_TYPES[source.suffix.lower()]
        encoded = base64.b64encode(source.read_bytes()).decode("ascii")
        result.append(f"data:{mime_type};base64,{encoded}")
    return result
