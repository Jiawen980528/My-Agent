"""One-time encrypted delivery for a private research workbook.

The repository is public, so the workbook must never be committed as plaintext.
This module creates a server-only RSA key, accepts an encrypted static payload,
imports it into the private research pool, and destroys both key and payload.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import secrets
import threading
from pathlib import Path

from app.services import research_pool
from app.services.fs_utils import atomic_write_text

_MAGIC = b"MYAGENT_RESEARCH_IMPORT_V1\x00"
_KEY_NAME = ".myagent_research_import_key.json"
_STATUS_NAME = "myagent_research_import_status.json"
PAYLOAD_PATH = Path("/app/static/myagent-research-import-v1.bin")
_LOCK = threading.Lock()


def _user_dir(data_dir: Path) -> Path:
    return data_dir / "user_data"


def _key_path(data_dir: Path) -> Path:
    return _user_dir(data_dir) / _KEY_NAME


def _status_path(data_dir: Path) -> Path:
    return _user_dir(data_dir) / _STATUS_NAME


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _int_bytes(value: int, length: int | None = None) -> bytes:
    size = length or max(1, (value.bit_length() + 7) // 8)
    return value.to_bytes(size, "big")


def _probable_prime(value: int, rounds: int = 32) -> bool:
    small = (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47)
    if value in small:
        return True
    if value < 2 or any(value % prime == 0 for prime in small):
        return False
    odd = value - 1
    power = 0
    while odd % 2 == 0:
        power += 1
        odd //= 2
    for _ in range(rounds):
        base = secrets.randbelow(value - 3) + 2
        check = pow(base, odd, value)
        if check in (1, value - 1):
            continue
        for _ in range(power - 1):
            check = pow(check, 2, value)
            if check == value - 1:
                break
        else:
            return False
    return True


def _prime(bits: int) -> int:
    while True:
        value = secrets.randbits(bits) | (1 << (bits - 1)) | 1
        if _probable_prime(value):
            return value


def _generate_key(bits: int = 2048) -> dict[str, str | int]:
    exponent = 65537
    while True:
        left, right = _prime(bits // 2), _prime(bits // 2)
        if left == right:
            continue
        totient = (left - 1) * (right - 1)
        if math.gcd(exponent, totient) == 1:
            modulus = left * right
            private = pow(exponent, -1, totient)
            return {"n": str(modulus), "e": exponent, "d": str(private)}


def _load_key(data_dir: Path) -> dict[str, int] | None:
    try:
        value = json.loads(_key_path(data_dir).read_text(encoding="utf-8"))
        return {name: int(value[name]) for name in ("n", "e", "d")}
    except (OSError, ValueError, KeyError, TypeError):
        return None


def public_key(data_dir: Path, *, bits: int = 2048) -> dict:
    """Return a public one-time key while keeping its private exponent server-side."""
    with _LOCK:
        status = _read_status(data_dir)
        if status.get("state") == "done":
            return {"state": "done", "result": status.get("result")}
        key = _load_key(data_dir)
        if key is None:
            generated = _generate_key(bits)
            directory = _user_dir(data_dir)
            directory.mkdir(parents=True, exist_ok=True)
            atomic_write_text(_key_path(data_dir), json.dumps(generated), mode=0o600)
            key = {name: int(generated[name]) for name in ("n", "e", "d")}
        return {"state": "ready", "algorithm": "RSA-OAEP-SHA256/HMAC-SHA256-CTR",
                "n": _b64(_int_bytes(key["n"])), "e": key["e"]}


def _mgf1(seed: bytes, length: int) -> bytes:
    output = bytearray()
    for counter in range((length + 31) // 32):
        output.extend(hashlib.sha256(seed + counter.to_bytes(4, "big")).digest())
    return bytes(output[:length])


def _xor(left: bytes, right: bytes) -> bytes:
    return bytes(a ^ b for a, b in zip(left, right, strict=True))


def _oaep_encrypt(message: bytes, modulus: int, exponent: int) -> bytes:
    size = (modulus.bit_length() + 7) // 8
    digest = hashlib.sha256(b"").digest()
    if len(message) > size - 66:
        raise ValueError("RSA key is too small for the import key")
    data = digest + b"\x00" * (size - len(message) - 66) + b"\x01" + message
    seed = secrets.token_bytes(32)
    masked_data = _xor(data, _mgf1(seed, size - 33))
    masked_seed = _xor(seed, _mgf1(masked_data, 32))
    encoded = b"\x00" + masked_seed + masked_data
    return _int_bytes(pow(int.from_bytes(encoded, "big"), exponent, modulus), size)


def _oaep_decrypt(ciphertext: bytes, modulus: int, private: int) -> bytes:
    size = (modulus.bit_length() + 7) // 8
    if len(ciphertext) != size:
        raise ValueError("Invalid encrypted key length")
    encoded = _int_bytes(pow(int.from_bytes(ciphertext, "big"), private, modulus), size)
    if encoded[0] != 0:
        raise ValueError("Invalid encrypted key")
    masked_seed, masked_data = encoded[1:33], encoded[33:]
    seed = _xor(masked_seed, _mgf1(masked_data, 32))
    data = _xor(masked_data, _mgf1(seed, size - 33))
    digest = hashlib.sha256(b"").digest()
    if not hmac.compare_digest(data[:32], digest):
        raise ValueError("Invalid encrypted key")
    separator = data.find(b"\x01", 32)
    if separator < 0 or any(data[32:separator]):
        raise ValueError("Invalid encrypted key")
    return data[separator + 1:]


def _stream(key: bytes, nonce: bytes, length: int) -> bytes:
    output = bytearray()
    for counter in range((length + 31) // 32):
        output.extend(hmac.new(key, nonce + counter.to_bytes(8, "big"), hashlib.sha256).digest())
    return bytes(output[:length])


def encrypt(raw: bytes, filename: str, key: dict) -> bytes:
    """Encrypt a workbook for a key returned by :func:`public_key`."""
    modulus = int.from_bytes(_unb64(str(key["n"])), "big")
    exponent = int(key["e"])
    body = json.dumps({"filename": filename, "data": _b64(raw)}, ensure_ascii=False).encode()
    master, nonce = secrets.token_bytes(32), secrets.token_bytes(16)
    encrypted_key = _oaep_encrypt(master, modulus, exponent)
    enc_key = hmac.new(master, b"enc" + nonce, hashlib.sha256).digest()
    mac_key = hmac.new(master, b"mac" + nonce, hashlib.sha256).digest()
    header = _MAGIC + nonce + len(encrypted_key).to_bytes(2, "big") + encrypted_key
    ciphertext = _xor(body, _stream(enc_key, nonce, len(body)))
    return header + ciphertext + hmac.new(mac_key, header + ciphertext, hashlib.sha256).digest()


def _decrypt(payload: bytes, key: dict[str, int]) -> tuple[str, bytes]:
    if not payload.startswith(_MAGIC) or len(payload) < len(_MAGIC) + 16 + 2 + 32:
        raise ValueError("Invalid research import payload")
    offset = len(_MAGIC)
    nonce = payload[offset:offset + 16]
    offset += 16
    key_size = int.from_bytes(payload[offset:offset + 2], "big")
    offset += 2
    encrypted_key = payload[offset:offset + key_size]
    offset += key_size
    ciphertext, tag = payload[offset:-32], payload[-32:]
    master = _oaep_decrypt(encrypted_key, key["n"], key["d"])
    enc_key = hmac.new(master, b"enc" + nonce, hashlib.sha256).digest()
    mac_key = hmac.new(master, b"mac" + nonce, hashlib.sha256).digest()
    if not hmac.compare_digest(tag, hmac.new(mac_key, payload[:-32], hashlib.sha256).digest()):
        raise ValueError("Research import payload authentication failed")
    body = json.loads(_xor(ciphertext, _stream(enc_key, nonce, len(ciphertext))))
    filename = str(body.get("filename", ""))
    raw = _unb64(str(body.get("data", "")))
    if not filename.lower().endswith(".xlsx") or not raw:
        raise ValueError("Research import payload has no valid workbook")
    return filename, raw


def _read_status(data_dir: Path) -> dict:
    try:
        value = json.loads(_status_path(data_dir).read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def consume(data_dir: Path, payload_path: Path = PAYLOAD_PATH) -> dict:
    """Import the encrypted payload once and erase its private material."""
    with _LOCK:
        status = _read_status(data_dir)
        if status.get("state") == "done":
            return status
        if not payload_path.is_file():
            return {"state": "waiting" if _load_key(data_dir) else "needs_key"}
        key = _load_key(data_dir)
        if key is None:
            return {"state": "error", "error": "server import key is missing"}
        try:
            filename, raw = _decrypt(payload_path.read_bytes(), key)
            result = research_pool.import_workbook(data_dir, raw, filename)
            safe_result = {name: result[name] for name in ("count", "imported", "unresolved")}
            status = {"state": "done", "result": safe_result}
            directory = _user_dir(data_dir)
            directory.mkdir(parents=True, exist_ok=True)
            atomic_write_text(_status_path(data_dir), json.dumps(status), mode=0o600)
            _key_path(data_dir).unlink(missing_ok=True)
            payload_path.unlink(missing_ok=True)
            return status
        except (OSError, ValueError, KeyError, TypeError) as exc:
            return {"state": "error", "error": str(exc)}
