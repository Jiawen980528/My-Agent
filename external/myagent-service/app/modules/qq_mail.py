"""QQ Mail IMAP connector. Uses a QQ Mail authorization code, never the QQ password."""
import email as email_parser
import imaplib
import smtplib
from email.message import EmailMessage
from html import unescape
from html.parser import HTMLParser
import re
from email.header import decode_header

IMAP_HOST = "imap.qq.com"
IMAP_PORT = 993
SMTP_HOST = "smtp.qq.com"
SMTP_PORT = 465

def _decode(value: str | None) -> str:
    if not value: return ""
    pieces = []
    for part, encoding in decode_header(value):
        if isinstance(part, bytes):
            pieces.append(part.decode(encoding or "utf-8", errors="replace"))
        else: pieces.append(part)
    return "".join(pieces)

def _login(address: str, authorization_code: str):
    client = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT, timeout=20)
    client.login(address, authorization_code)
    return client

def _header_item(identifier: bytes, raw: tuple, seen: bool = False) -> dict:
    message = email_parser.message_from_bytes(raw[1])
    return {
        "id": identifier.decode("ascii"),
        "from": _decode(message.get("From")),
        "subject": _decode(message.get("Subject")) or "（无主题）",
        "date": _decode(message.get("Date")),
        "seen": seen,
    }

class _EmailHTMLText(HTMLParser):
    """Small safe HTML-to-text extractor for email previews; scripts never reach the UI."""
    _blocks={"p","div","br","li","tr","h1","h2","h3","h4","h5","h6","blockquote"}
    def __init__(self):
        super().__init__(); self.parts=[]; self.skip_depth=0
    def handle_starttag(self, tag, attrs):
        tag=tag.lower()
        if tag in {"script","style","head","noscript","svg"}: self.skip_depth+=1
        elif not self.skip_depth and tag in self._blocks: self.parts.append("\n")
    def handle_endtag(self, tag):
        tag=tag.lower()
        if tag in {"script","style","head","noscript","svg"} and self.skip_depth: self.skip_depth-=1
        elif not self.skip_depth and tag in self._blocks: self.parts.append("\n")
    def handle_data(self, data):
        if not self.skip_depth: self.parts.append(data)
    def text(self):
        text=unescape("".join(self.parts)).replace("\r", "")
        text=re.sub(r"[ \t]+", " ", text)
        text=re.sub(r"\n[ \t]*\n[ \t]*\n+", "\n\n", text)
        return text.strip()

def _looks_like_markup_or_script(text: str) -> bool:
    sample=text.lower()[:4000]
    signals=("function ", "var ", "document.", "window.", "javascript", "<script", "{\"", "</style")
    return sum(token in sample for token in signals) >= 2

def _body_text(message) -> str:
    parts = message.walk() if message.is_multipart() else [message]
    plain_parts=[]
    html_parts=[]
    for part in parts:
        if part.get_content_maintype() == "multipart" or part.get_filename():
            continue
        content_type = part.get_content_type()
        if content_type not in ("text/plain", "text/html"):
            continue
        payload = part.get_payload(decode=True)
        if payload is None:
            continue
        content = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
        if content_type == "text/plain": plain_parts.append(content.strip())
        else:
            parser=_EmailHTMLText(); parser.feed(content); parser.close()
            html_parts.append(parser.text())
    plain="\n\n".join(part for part in plain_parts if part).strip()
    html="\n\n".join(part for part in html_parts if part).strip()
    # Some commercial mailers put their JavaScript in text/plain while the real
    # message is in HTML. Prefer the clean version rather than exposing source code.
    chosen=html if html and (not plain or _looks_like_markup_or_script(plain)) else plain or html
    return chosen[:40_000]

def test_connection(address: str, authorization_code: str) -> dict:
    client = _login(address, authorization_code)
    try:
        status, info = client.select("INBOX", readonly=True)
        if status != "OK": raise RuntimeError("无法打开收件箱")
        return {"ok": True, "message_count": int(info[0] or b"0")}
    finally:
        try: client.logout()
        except Exception: pass

def unread_headers(address: str, authorization_code: str, limit: int = 20) -> list[dict]:
    client = _login(address, authorization_code)
    try:
        client.select("INBOX", readonly=True)
        status, data = client.search(None, "UNSEEN")
        if status != "OK": raise RuntimeError("无法查询未读邮件")
        ids = data[0].split()[-limit:][::-1]
        items = []
        for uid in ids:
            status, raw = client.fetch(uid, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")
            if status != "OK" or not raw or not raw[0]: continue
            items.append(_header_item(uid, raw[0], seen=False))
        return items
    finally:
        try: client.logout()
        except Exception: pass

def inbox_headers(address: str, authorization_code: str, limit: int = 50) -> list[dict]:
    client = _login(address, authorization_code)
    try:
        client.select("INBOX", readonly=True)
        status, data = client.search(None, "ALL")
        if status != "OK": raise RuntimeError("无法查询收件箱")
        ids = data[0].split()[-limit:][::-1]
        items = []
        for uid in ids:
            status, raw = client.fetch(uid, "(FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")
            if status != "OK" or not raw or not raw[0]: continue
            flags = raw[0][0] if isinstance(raw[0], tuple) else b""
            items.append(_header_item(uid, raw[0], seen=b"\\Seen" in flags))
        return items
    finally:
        try: client.logout()
        except Exception: pass

def message_detail(address: str, authorization_code: str, message_id: str) -> dict:
    if not message_id.isdigit():
        raise ValueError("邮件标识无效")
    client = _login(address, authorization_code)
    try:
        client.select("INBOX", readonly=True)
        status, raw = client.fetch(message_id, "(BODY.PEEK[])")
        if status != "OK" or not raw or not raw[0]: raise RuntimeError("无法读取邮件内容")
        message = email_parser.message_from_bytes(raw[0][1])
        return {
            "id": message_id,
            "from": _decode(message.get("From")),
            "to": _decode(message.get("To")),
            "subject": _decode(message.get("Subject")) or "（无主题）",
            "date": _decode(message.get("Date")),
            "body": _body_text(message) or "（此邮件没有可预览的纯文本内容）",
        }
    finally:
        try: client.logout()
        except Exception: pass

def mark_read(address: str, authorization_code: str, message_ids: list[str]) -> int:
    if not message_ids or len(message_ids) > 20 or any(not item.isdigit() for item in message_ids):
        raise ValueError("邮件标识无效")
    client = _login(address, authorization_code)
    try:
        client.select("INBOX", readonly=False)
        changed = 0
        for identifier in message_ids:
            status, _ = client.store(identifier, "+FLAGS", "\\Seen")
            if status == "OK": changed += 1
        return changed
    finally:
        try: client.logout()
        except Exception: pass

def send_message(address: str, authorization_code: str, recipient: str, subject: str, body: str) -> None:
    """Send one plain-text message through QQ Mail SMTP using its authorization code."""
    recipient = recipient.strip()
    if "@" not in recipient or len(recipient) > 254:
        raise ValueError("收件人地址无效")
    if not subject.strip() or len(subject) > 300:
        raise ValueError("邮件主题无效")
    if not body.strip() or len(body) > 12_000:
        raise ValueError("邮件正文无效")
    message = EmailMessage()
    message["From"] = address
    message["To"] = recipient
    message["Subject"] = subject.strip()
    message.set_content(body.strip())
    with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=20) as client:
        client.login(address, authorization_code)
        client.send_message(message)
