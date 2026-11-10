"""Header building + plain-stdlib HTTP sending (no third-party packages needed)."""

import json
import random
import time
import urllib.error
import urllib.request
from datetime import datetime

_rng = random.SystemRandom()


def new_correlation_id(now=None):
    """Same shape as the sample header: yyMMddHHmmss-<7 digits>."""
    now = now or datetime.now()
    return "{0}-{1:07d}".format(now.strftime("%y%m%d%H%M%S"), _rng.randint(0, 9999999))


def new_tran_time(now=None):
    """yyyyMMddHHmmss - the sample cURL had an unevaluated JS snippet here."""
    return (now or datetime.now()).strftime("%Y%m%d%H%M%S")


def build_headers(asp_id, access_key, time_zone="KST", content_type="application/json", extra=None):
    now = datetime.now()
    headers = {
        "X-KM-User-AspId": asp_id,
        "X-KM-Correlation-Id": new_correlation_id(now),
        "X-KM-Access-Key": access_key,
        "X-KM-Tran-Time": new_tran_time(now),
        "X-KM-Time-Zone": time_zone,
        "Content-Type": content_type,
    }
    for key, value in (extra or {}).items():
        if key and value is not None:
            headers[key] = value
    return headers


def parse_header_lines(text):
    """Parse 'Key: value' lines (blank lines and #-comments ignored) into a dict."""
    headers = {}
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        key, value = line.split(":", 1)
        headers[key.strip()] = value.strip()
    return headers


def send_request(url, method, headers, body, timeout=30, use_proxy=False):
    """Fire the request and always return a result dict (never raises for HTTP errors)."""
    payload = None
    if body is not None:
        payload = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode("utf-8")

    request = urllib.request.Request(url, data=payload, method=method.upper())
    for key, value in headers.items():
        request.add_header(key, value)

    handlers = [] if use_proxy else [urllib.request.ProxyHandler({})]
    opener = urllib.request.build_opener(*handlers)

    started = time.time()
    result = {"url": url, "method": method.upper(), "requestHeaders": dict(headers)}
    try:
        with opener.open(request, timeout=timeout) as response:
            result.update(
                status=response.status,
                reason=response.reason,
                responseHeaders=dict(response.headers.items()),
                text=response.read().decode("utf-8", errors="replace"),
            )
    except urllib.error.HTTPError as error:
        result.update(
            status=error.code,
            reason=error.reason,
            responseHeaders=dict(error.headers.items()) if error.headers else {},
            text=(error.read() or b"").decode("utf-8", errors="replace"),
        )
    except Exception as error:  # connection refused, DNS, timeout, ...
        result.update(status=None, reason=type(error).__name__, responseHeaders={}, text=str(error), error=True)

    result["elapsedMs"] = int((time.time() - started) * 1000)
    try:
        result["json"] = json.loads(result["text"]) if result["text"] else None
    except ValueError:
        result["json"] = None
    return result


def to_curl(url, method, headers, body):
    """Render the exact call as a cURL command for sharing / pasting into a ticket."""
    parts = ["curl --location --request {0} '{1}'".format(method.upper(), url)]
    for key, value in headers.items():
        parts.append("  --header '{0}: {1}'".format(key, value))
    if body is not None:
        pretty = json.dumps(body, ensure_ascii=False, indent=4)
        parts.append("  --data-raw '{0}'".format(pretty))
    return " \\\n".join(parts)
