#!/usr/bin/env python3
"""
KonaPlate WebView API Console - local web UI.

    python server.py            ->  http://127.0.0.1:8770
    python server.py --port 9000 --no-browser

Stdlib only: no pip installs. Binds to 127.0.0.1 only.
The browser never calls the WebView APIs directly - this server proxies every
call, so there is no CORS problem and the access key never leaves the machine.
"""

import argparse
import json
import mimetypes
import os
import re
import socket
import threading
import traceback
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, unquote

from core.api_client import build_headers, parse_header_lines, send_request, to_curl
from core.auth import Accounts, AuthError
from core.card_source import CardSource, PortalError, asp_code
from core.config_store import ConfigStore, deep_merge, find_values
from core.randomizer import apply_random_fields

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(BASE_DIR, "web")
HISTORY_DIR = os.path.join(BASE_DIR, "history")

store = ConfigStore()
store_lock = threading.Lock()


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def bootstrap_payload():
    targets = []
    for key in store.target_keys():
        targets.append({
            "key": key,
            "label": store.target_label(key),
            "versions": [
                {"key": version, **store.connection(key, version)}
                for version in store.version_keys(key)
            ],
        })
    features = []
    for key in store.feature_keys():
        feature = store.feature(key)
        features.append({
            "key": key,
            "label": feature.get("label", key),
            "method": feature.get("method", "POST"),
            "randomize": feature.get("randomize", []),
            # a module can say it is not part of the default Run All selection; anything that
            # does not say otherwise is ticked, so the six-step chain behaves as it always has
            "runAllDefault": feature.get("runAllDefault", True),
            # and it can say it belongs under another module, which is how the sidebar nests it
            "parent": feature.get("parent", ""),
            # free text shown on hover - e.g. the test bank account a variant expects
            "tooltip": feature.get("tooltip", ""),
            # what it counts AS: a variant behaves like the module it sits under
            "role": feature_role(key),
        })
    return {
        "targets": targets,
        "features": features,
        "defaults": store.defaults,
        "randomFields": store.random_fields,
    }


def resolve_body(feature_key, target, version):
    return store.resolved_body(feature_key, target, version)


PLACEHOLDER = re.compile(r"\{\{(\w+)\}\}")

# the card we sent is already mapped to a user -> take the next one and try again
CARD_IN_USE_CODES = {"003_027"}


def response_code(result):
    """The API's own response.code, e.g. 000_000 or 003_027."""
    payload = result.get("json")
    if isinstance(payload, dict) and isinstance(payload.get("response"), dict):
        return payload["response"].get("code")
    return None


def find_placeholders(value, found=None):
    """Collect every {{name}} still sitting in a request body."""
    found = set() if found is None else found
    if isinstance(value, str):
        found.update(PLACEHOLDER.findall(value))
    elif isinstance(value, list):
        for item in value:
            find_placeholders(item, found)
    elif isinstance(value, dict):
        for item in value.values():
            find_placeholders(item, found)
    return found


def tcp_check(base_url, timeout=2.5):
    parsed = urlparse(base_url if "://" in (base_url or "") else "http://" + (base_url or ""))
    host, port = parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80)
    if not host:
        return {"ok": False, "detail": "no host"}
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return {"ok": True, "detail": "{0}:{1} reachable".format(host, port)}
    except Exception as error:
        return {"ok": False, "detail": "{0}:{1} {2}".format(host, port, type(error).__name__)}


def write_history(feature, target, version, request, result, project_name=""):
    os.makedirs(HISTORY_DIR, exist_ok=True)
    name = "{0}_{1}_{2}_{3}.json".format(
        datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:19], feature, target, version
    )
    record = {
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "feature": feature,
        "target": target,
        "version": version,
        "affiliate": store.target_label(target) if target in store.target_keys() else target,
        "projectName": project_name or "",
        "request": request,
        "response": {
            "status": result.get("status"),
            "reason": result.get("reason"),
            "headers": result.get("responseHeaders"),
            "body": result.get("json") if result.get("json") is not None else result.get("text"),
            "elapsedMs": result.get("elapsedMs"),
        },
    }
    path = os.path.join(HISTORY_DIR, name)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(record, handle, indent=2, ensure_ascii=False)
    return name


def _as_dict(value):
    return value if isinstance(value, dict) else {}


def feature_role(key):
    """What a module counts AS, for Records and for the session seed.

    A variant is the same kind of request as the module it sits under, so Without CI counts as a
    User Registration. A module can also say so outright with "role" in config.json - which is
    what the Auto Recharge pair does, because the cURL they were built from registers a user.
    Without this, a user created by any of them would never reach the Records table.
    """
    try:
        feature = store.feature(key)
    except Exception:
        return key
    return feature.get("role") or feature.get("parent") or key


def build_records():
    """Ledger of registered users and their cards, rebuilt from the history folder.

    One row per card application (a user with none still gets a row), labelled:
      Physical / Plastic Card - the application was completed by Card Registration
      Mobile / Virtual Card   - Apply Card succeeded, no physical registration yet
      No card                 - user registered only
    """
    users = {}

    def user_slot(user_id, record):
        key = str(user_id)
        if key not in users:
            users[key] = {
                "userId": user_id, "affiliate": record.get("affiliate", ""),
                "target": record.get("target", ""), "version": record.get("version", ""),
                "registeredAt": "", "loginId": "", "email": "", "mobileNumber": "",
                "basicCardNo": "", "projectName": "", "cards": {},
            }
        return users[key]

    if not os.path.isdir(HISTORY_DIR):
        return []

    for name in sorted(os.listdir(HISTORY_DIR)):          # filenames start with a timestamp
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(HISTORY_DIR, name), "r", encoding="utf-8") as handle:
                record = json.load(handle)
        except Exception:
            continue

        status = _as_dict(record.get("response")).get("status")
        if not (isinstance(status, int) and 200 <= status < 300):
            continue
        feature = feature_role(record.get("feature", ""))
        request_body = _as_dict(_as_dict(record.get("request")).get("body"))
        response_body = _as_dict(_as_dict(record.get("response")).get("body"))

        if feature == "user_registration":
            user_id = response_body.get("userId")
            if user_id is None:
                continue
            slot = user_slot(user_id, record)
            slot.update(
                projectName=record.get("projectName", "") or slot["projectName"],
                registeredAt=record.get("timestamp", ""),
                affiliate=record.get("affiliate", slot["affiliate"]),
                target=record.get("target", slot["target"]),
                version=record.get("version", slot["version"]),
                loginId=request_body.get("loginId", ""),
                email=request_body.get("email", ""),
                mobileNumber=request_body.get("mobileNumber", ""),
                basicCardNo=_as_dict(response_body.get("basicCardInfo")).get("cardNo", ""),
            )

        elif feature == "apply_card":
            user_id = _as_dict(request_body.get("userInfo")).get("userId", request_body.get("userId"))
            apply_no = response_body.get("cardApplyNo")
            if user_id is None or not apply_no:
                continue
            slot = user_slot(user_id, record)
            if not slot["projectName"]:
                slot["projectName"] = record.get("projectName", "")
            slot["cards"][apply_no] = {
                "cardApplyNo": apply_no,
                "appliedAt": record.get("timestamp", ""),
                "serviceId": request_body.get("serviceId", ""),
                "isDeliveryRequired": request_body.get("isDeliveryRequired"),
                "mobileCardNo": response_body.get("mobileCardNo", ""),
                "mobileCardCVC": response_body.get("mobileCardCVC", ""),
                "mobileCardExpiry": response_body.get("mobileCardExpiryDate", ""),
                "physicalCardNo": "", "physicalCardExpDate": "", "physicalCardCVC": "",
                "registeredAt": "",
            }

        elif feature == "card_registration":
            user_id = request_body.get("userId")
            apply_no = request_body.get("cardApplyNo")
            if user_id is None or not apply_no:
                continue
            slot = user_slot(user_id, record)
            card = slot["cards"].setdefault(apply_no, {
                "cardApplyNo": apply_no, "appliedAt": "", "serviceId": "",
                "isDeliveryRequired": None, "mobileCardNo": "", "mobileCardCVC": "",
                "mobileCardExpiry": "",
            })
            card.update(
                physicalCardNo=request_body.get("physicalCardNo", ""),
                physicalCardExpDate=request_body.get("physicalCardExpDate", ""),
                physicalCardCVC=request_body.get("physicalCardCVC", ""),
                registeredAt=record.get("timestamp", ""),
            )

    rows = []
    for slot in users.values():
        base = {key: slot[key] for key in
                ("userId", "affiliate", "target", "version", "projectName", "registeredAt",
                 "loginId", "email", "mobileNumber", "basicCardNo")}
        if not slot["cards"]:
            rows.append(dict(base, cardType="No card", cardApplyNo="", appliedAt="",
                             mobileCardNo="", physicalCardNo="", serviceId="",
                             isDeliveryRequired=None, cardRegisteredAt=""))
            continue
        for card in slot["cards"].values():
            rows.append(dict(
                base,
                cardType="Physical / Plastic Card" if card.get("physicalCardNo") else "Mobile / Virtual Card",
                cardApplyNo=card.get("cardApplyNo", ""),
                appliedAt=card.get("appliedAt", ""),
                serviceId=card.get("serviceId", ""),
                isDeliveryRequired=card.get("isDeliveryRequired"),
                mobileCardNo=card.get("mobileCardNo", ""),
                physicalCardNo=card.get("physicalCardNo", ""),
                cardRegisteredAt=card.get("registeredAt", ""),
            ))

    rows.sort(key=lambda row: (row.get("registeredAt") or "", str(row.get("userId"))), reverse=True)
    return rows


USED_CARDS_FILE = os.path.join(BASE_DIR, "used_cards.json")


def load_used_cards():
    """Cards known to be spent or already mapped, learned across runs."""
    try:
        with open(USED_CARDS_FILE, "r", encoding="utf-8") as handle:
            return json.load(handle).get("cards", {})
    except Exception:
        return {}


def remember_used_card(number, code):
    """Record a card as unusable. Retries inside one send are not written to history, so without
    this the same already-mapped cards would be tried again on every later run."""
    if not number:
        return
    cards = load_used_cards()
    cards[str(number)] = {"code": code, "at": datetime.now().isoformat(timespec="seconds")}
    document = {
        "_README": "Physical cards this tool has sent to Card Registration and must never offer "
                   "again. The portal keeps listing a consumed card as ACTIVE for a while, and "
                   "cards mapped by other testing never show it at all, so this file is the "
                   "reliable record. 003_027 = already mapped to a user, 000_000 = registered by "
                   "us. Delete an entry only if you know the card is genuinely free.",
        "cards": cards,
    }
    try:
        with open(USED_CARDS_FILE, "w", encoding="utf-8") as handle:
            json.dump(document, handle, indent=2, ensure_ascii=False)
    except Exception:
        pass


def attempted_physical_cards():
    """Every physicalCardNo this tool has ever SENT, successful or not.

    The portal does not flip a consumed card to TERMINATED straight away - a card registered
    minutes ago still reads ACTIVE - and many cards are mapped by other testing and never show
    it at all. So portal status alone cannot tell us what is free: anything we have already sent
    is never offered again, whatever the portal says about it.
    """
    used = set(load_used_cards())
    if not os.path.isdir(HISTORY_DIR):
        return used
    for name in os.listdir(HISTORY_DIR):
        if not (name.endswith(".json") and "card_registration" in name):
            continue
        try:
            with open(os.path.join(HISTORY_DIR, name), "r", encoding="utf-8") as handle:
                record = json.load(handle)
            number = _as_dict(_as_dict(record.get("request")).get("body")).get("physicalCardNo")
            if number:
                used.add(str(number))
        except Exception:
            continue
    return used


def latest_session(target, version, scan=250):
    """The most recently created user on this affiliate + webview version, and its artefacts.

    Anchored on the newest successful User Registration for that exact target, then every later
    record belonging to that same userId. Switching version therefore loads that version's own
    user - a V2 userId can never surface while V1 is selected.
    """
    if not os.path.isdir(HISTORY_DIR):
        return {}
    names = sorted((n for n in os.listdir(HISTORY_DIR) if n.endswith(".json")), reverse=True)[:scan]

    records = []
    for name in names:
        try:
            with open(os.path.join(HISTORY_DIR, name), "r", encoding="utf-8") as handle:
                record = json.load(handle)
        except Exception:
            continue
        if record.get("target") != target or record.get("version") != version:
            continue
        status = _as_dict(record.get("response")).get("status")
        if isinstance(status, int) and 200 <= status < 300:
            records.append(record)

    anchor, seed = None, {}
    for record in records:                      # newest first
        if feature_role(record.get("feature")) == "user_registration":
            response_body = _as_dict(_as_dict(record.get("response")).get("body"))
            anchor = response_body.get("userId")
            request_body = _as_dict(_as_dict(record.get("request")).get("body"))
            for key in ("ci", "loginId", "email", "mobileNumber"):
                if isinstance(request_body.get(key), str):
                    seed[key] = request_body[key]
            seed.update(find_values(response_body, set(store.defaults.get("captureKeys", []))))
            seed["userId"] = anchor
            break
    if anchor is None:
        return {}

    keys = set(store.defaults.get("captureKeys", []))
    for record in records:                      # newest first, so the first value found wins
        if feature_role(record.get("feature")) == "user_registration":
            continue
        request_body = _as_dict(_as_dict(record.get("request")).get("body"))
        owner = request_body.get("userId") or _as_dict(request_body.get("userInfo")).get("userId")
        if owner is not None and owner != anchor:
            continue
        for key, value in find_values(_as_dict(_as_dict(record.get("response")).get("body")), keys).items():
            seed.setdefault(key, value)
    return seed


def api_session_seed(payload):
    seed = latest_session(payload.get("target", ""), payload.get("version", ""))
    return {"session": seed, "found": bool(seed)}


def history_list(limit=300):
    if not os.path.isdir(HISTORY_DIR):
        return []
    rows = []
    for name in sorted(os.listdir(HISTORY_DIR), reverse=True)[:limit]:
        if not name.endswith(".json"):
            continue
        row = {"file": name, "timestamp": "", "feature": "", "affiliate": "", "version": "",
               "projectName": "", "status": None, "elapsedMs": None}
        try:
            with open(os.path.join(HISTORY_DIR, name), "r", encoding="utf-8") as handle:
                record = json.load(handle)
            row.update(
                timestamp=record.get("timestamp", ""),
                feature=record.get("feature", ""),
                affiliate=record.get("affiliate", record.get("target", "")),
                version=record.get("version", ""),
                projectName=record.get("projectName", ""),
                status=record.get("response", {}).get("status"),
                elapsedMs=record.get("response", {}).get("elapsedMs"),
            )
        except Exception:
            pass
        rows.append(row)
    return rows


# --------------------------------------------------------------------------- #
# API handlers
# --------------------------------------------------------------------------- #
def api_bootstrap(_payload):
    return bootstrap_payload()


def api_body(payload):
    feature = payload["feature"]
    body = resolve_body(feature, payload["target"], payload["version"])
    return {
        "body": body,
        "path": store.endpoint(payload["target"], payload["version"], feature),
        "method": store.feature(feature).get("method", "POST"),
        "randomize": store.feature(feature).get("randomize", []),
        "options": store.feature(feature).get("options", {}),
        "cardSource": bool(store.feature(feature).get("cardSource")
                           and (store.data.get("cardSource") or {}).get("enabled")),
        "autoFetchCard": bool(store.feature(feature).get("cardSource")
                              and (store.data.get("cardSource") or {}).get("autoFetch")),
    }


def random_specs(feature_key):
    """The random rules for one feature: the global ones, with its own merged on top.

    A variant can need a different shape for the same field - the Without CI requests use
    dispostable.com addresses - without that leaking into every other module.
    """
    try:
        own = store.feature(feature_key).get("randomFields") or {}
    except Exception:
        own = {}
    return deep_merge(store.random_fields, own)


def api_randomize(payload):
    body = payload.get("body") or {}
    fields = payload.get("fields")
    if fields is None:
        fields = store.feature(payload["feature"]).get("randomize", [])
    generated = apply_random_fields(body, fields, random_specs(payload["feature"]))
    return {"body": body, "generated": generated}


def api_preview(payload):
    headers = build_headers(
        payload.get("aspId", ""), payload.get("accessKey", ""),
        payload.get("timeZone", "KST"), store.defaults.get("contentType", "application/json"),
        parse_header_lines(payload.get("extraHeaders", "")),
    )
    url = payload.get("baseUrl", "").rstrip("/") + payload.get("path", "")
    return {"headers": headers, "url": url,
            "curl": to_curl(url, payload.get("method", "POST"), headers, payload.get("body"))}


def api_send(payload):
    body = payload.get("body")
    feature = payload.get("feature", "")
    generated = {}
    if payload.get("randomizeBeforeSend") and feature:
        generated = apply_random_fields(body, store.feature(feature).get("randomize", []),
                                        random_specs(feature))

    # never ship a literal {{placeholder}} to the API - it produces a baffling validation error
    unresolved = find_placeholders(body)
    if unresolved:
        raise ValueError(
            "unresolved placeholder(s) {0} in the request body - run the earlier step that produces "
            "them for this affiliate + webview version first".format(
                ", ".join("{{%s}}" % name for name in sorted(unresolved)))
        )

    headers = build_headers(
        payload.get("aspId", ""), payload.get("accessKey", ""),
        payload.get("timeZone", "KST"), store.defaults.get("contentType", "application/json"),
        parse_header_lines(payload.get("extraHeaders", "")),
    )
    url = payload.get("baseUrl", "").rstrip("/") + payload.get("path", "")
    method = payload.get("method", "POST")
    timeout = int(payload.get("timeout") or store.defaults.get("timeoutSeconds", 30))

    result = send_request(url, method, headers, body, timeout=timeout, use_proxy=bool(payload.get("useProxy")))

    # "User is already mapped to card error": the portal still lists that card as ACTIVE because it
    # only flips to TERMINATED later, so we cannot tell up front. Take the next card and try again.
    card_attempts = []
    if (store.data.get("features", {}).get(feature) or {}).get("cardSource"):
        tried = [str((body or {}).get("physicalCardNo") or "")]
        limit = int((store.data.get("cardSource") or {}).get("maxCardAttempts", 6))
        while len(card_attempts) < limit - 1 and response_code(result) in CARD_IN_USE_CODES:
            card_attempts.append({"physicalCardNo": tried[-1], "code": response_code(result)})
            remember_used_card(tried[-1], response_code(result))
            try:
                nxt = pick_portal_card(payload.get("target", ""), payload.get("version", ""), tried)
            except (PortalError, ValueError) as error:
                card_attempts.append({"error": str(error)})
                break
            body.update(nxt["fields"])
            tried.append(str(nxt["fields"].get("physicalCardNo") or ""))
            headers["X-KM-Correlation-Id"] = build_headers("", "")["X-KM-Correlation-Id"]
            result = send_request(url, method, headers, body, timeout=timeout,
                                  use_proxy=bool(payload.get("useProxy")))

    status = result.get("status")
    ok = isinstance(status, int) and 200 <= status < 300
    if card_attempts and ok:
        remember_used_card((body or {}).get("physicalCardNo"), "000_000")
    captured = {}
    if ok:
        for name in list(generated) + ["ci", "loginId", "email", "mobileNumber"]:
            if isinstance((body or {}).get(name), str):
                captured[name] = body[name]
        if result.get("json") is not None:
            captured.update(find_values(result["json"], set(store.defaults.get("captureKeys", []))))

    request_record = {"url": url, "method": method, "headers": headers, "body": body}
    history_file = None
    if payload.get("saveHistory", True):
        try:
            history_file = write_history(feature, payload.get("target", ""), payload.get("version", ""),
                                         request_record, result, payload.get("projectName", ""))
        except Exception as error:
            history_file = "not saved: {0}".format(error)

    return {
        "ok": ok,
        "status": status,
        "reason": result.get("reason"),
        "elapsedMs": result.get("elapsedMs"),
        "responseHeaders": result.get("responseHeaders", {}),
        "responseBody": result.get("json") if result.get("json") is not None else result.get("text"),
        "isJson": result.get("json") is not None,
        "sentHeaders": headers,
        "sentBody": body,
        "generated": generated,
        "captured": captured,
        "curl": to_curl(url, method, headers, body),
        "historyFile": history_file,
        "cardAttempts": card_attempts,
        "url": url,
    }


def api_save_body(payload):
    with store_lock:
        if payload.get("scope") == "default":
            store.save_default_body(payload["feature"], payload["body"])
            where = "shared default body"
        else:
            store.save_override(payload["feature"], payload["target"], payload["version"], payload["body"])
            where = "override for {0} / {1}".format(payload["target"], payload["version"])
    return {"saved": where}


def api_save_connection(payload):
    with store_lock:
        connection = store.connection(payload["target"], payload["version"])
        for field in ("baseUrl", "aspId", "accessKey"):
            if field in payload:
                connection[field] = payload[field]
        if payload.get("path") is not None:
            connection.setdefault("endpoints", {})[payload["feature"]] = payload["path"]
        # remember the portal project for this target so it is not only in one browser
        name = (payload.get("projectName") or "").strip()
        if name:
            source = store.data.setdefault("cardSource", {})
            by_target = source.setdefault("projectsByTarget", {})
            by_target.setdefault(payload["target"], {})[payload["version"]] = {"name": name}
        store.save()
    return {"saved": "connection for {0} / {1}".format(payload["target"], payload["version"])}


def api_config_get(_payload):
    with open(store.path, "r", encoding="utf-8") as handle:
        return {"raw": handle.read()}


def api_config_save(payload):
    raw = payload.get("raw", "")
    parsed = json.loads(raw)  # ValueError bubbles up as a 400
    with store_lock:
        with open(store.path, "w", encoding="utf-8") as handle:
            handle.write(raw if raw.endswith("\n") else raw + "\n")
        store.data = parsed
    return {"saved": "config.json", "bootstrap": bootstrap_payload()}


def api_config_reload(_payload):
    with store_lock:
        store.load()
    return {"bootstrap": bootstrap_payload()}


def api_ping(payload):
    return tcp_check(payload.get("baseUrl", ""))


def api_history(_payload):
    return {"rows": history_list()}


_card_source = {"client": None, "config": None}


def card_source_client():
    config = store.data.get("cardSource") or {}
    if _card_source["config"] != config:
        _card_source["client"] = CardSource(config)
        _card_source["config"] = config
    return _card_source["client"], config


def last_applied_service(target, version):
    """serviceId of the most recent successful Apply Card for this target.

    The user can pick any service the project offers, so the physical card must follow what was
    actually applied for - not the default sitting in config.json.
    """
    if not os.path.isdir(HISTORY_DIR):
        return None
    for name in sorted(os.listdir(HISTORY_DIR), reverse=True):
        if not (name.endswith(".json") and "apply_card" in name):
            continue
        try:
            with open(os.path.join(HISTORY_DIR, name), "r", encoding="utf-8") as handle:
                record = json.load(handle)
        except Exception:
            continue
        if record.get("target") != target or record.get("version") != version:
            continue
        status = _as_dict(record.get("response")).get("status")
        if not (isinstance(status, int) and 200 <= status < 300):
            continue
        service = _as_dict(_as_dict(record.get("request")).get("body")).get("serviceId")
        if service:
            return str(service)
    return None


def pick_portal_card(target, version, extra_exclude=(), project_name=None, prefer=None):
    """One ACTIVE card for this target that we have not sent before. Raises PortalError/ValueError."""
    client, config = card_source_client()
    if not config.get("enabled"):
        raise ValueError("cardSource is disabled in config.json")

    # a project typed into the UI wins over the configured default for this target
    if project_name:
        chosen = {"name": project_name}
    else:
        chosen = (((config.get("projectsByTarget") or {}).get(target) or {}).get(version)
                  or (config.get("projects") or {}).get(version))
    if not chosen:
        raise ValueError("no portal project configured for {0} / {1} - type a Project Name "
                         "in the Target panel, or add one to config.json".format(target, version))

    used = attempted_physical_cards()
    used.update(str(value) for value in extra_exclude if value)

    # the physical card must belong to the service the card was actually applied for:
    # an explicit ask first, then the last real Apply Card, then the config default
    if not prefer:
        prefer = last_applied_service(target, version)
    if not prefer:
        try:
            prefer = resolve_body("apply_card", target, version).get("serviceId")
        except Exception:
            prefer = None

    result = client.pick_card(chosen.get("name"), exclude=used, prefer_service=prefer)
    result["project"] = chosen.get("name")
    return result


def selected_asp(payload):
    """The ASP id of the affiliate+version chosen in the UI.

    An explicit aspId in the payload wins (the header field can be edited by hand); otherwise it
    comes from config.json. A placeholder such as CHANGE_ME is not an ASP id and resolves to ''.
    """
    explicit = str(payload.get("aspId") or "").strip()
    if asp_code(explicit):
        return explicit
    try:
        value = (store.connection(payload.get("target", ""), payload.get("version", "")) or {}).get("aspId")
    except Exception:
        value = ""
    return str(value or "").strip()


def api_portal_projects(payload):
    """The portal projects that belong to the selected affiliate - nothing from another ASP.

    This is what the Project picker lists, so Burger King never offers an iKuka project and so
    the serviceIds that follow from that project can only be that affiliate's own.
    """
    client, config = card_source_client()
    if not config.get("enabled"):
        raise ValueError("cardSource is disabled in config.json")
    asp = selected_asp(payload)
    try:
        projects, filtered = client.projects_for_asp(asp, refresh=bool(payload.get("refresh")))
    except PortalError as error:
        return {"ok": False, "error": str(error), "projects": []}
    return {
        "ok": True,
        "aspId": asp,
        "filtered": filtered,
        "projects": projects,
        "note": "" if filtered else
                "This affiliate has no ASP ID in config.json yet, so every project on the portal "
                "account is listed. Set its aspId to narrow this down.",
    }


def api_project_lookup(payload):
    """Look a project up on the QA portal by the name the user picked.

    Reads the Summary tab for the ASP ID, the Credentials tab for the OASL access key, and the
    project's card services - so the UI can fill X-KM-User-AspId and X-KM-Access-Key and offer
    the right serviceIds on Apply Card. The lookup is refused when the project belongs to a
    different affiliate than the one selected.
    """
    client, config = card_source_client()
    if not config.get("enabled"):
        raise ValueError("cardSource is disabled in config.json")
    name = (payload.get("projectName") or "").strip()
    if not name:
        raise ValueError("no project name given")
    try:
        result = client.lookup_project(name, expected_asp=selected_asp(payload))
    except PortalError as error:
        return {"ok": False, "error": str(error), "projectName": name}
    result["ok"] = True
    return result


def api_card_stock(payload):
    """How many test cards a project holds, per service, and how many are actually usable.

    "Usable" is not the same as ACTIVE: the portal keeps showing a card as ACTIVE after it has
    been handed out, so a card this tool has already sent is counted as used however the portal
    reports it. That is the number that decides whether the next Card Registration can run.
    """
    client, config = card_source_client()
    if not config.get("enabled"):
        raise ValueError("cardSource is disabled in config.json")
    target, version = payload.get("target", ""), payload.get("version", "")
    name = (payload.get("projectName") or "").strip()
    if not name:
        chosen = (((config.get("projectsByTarget") or {}).get(target) or {}).get(version)
                  or (config.get("projects") or {}).get(version) or {})
        name = (chosen or {}).get("name", "")
    if not name:
        return {"ok": False, "error": "No project to look at - load one first."}

    try:
        project_id = client.project_id(name)
        services = client.card_services(project_id)
        rows, page_info = (client.cards_page(project_id, [s["serviceId"] for s in services])
                           if services else ([], None))
    except PortalError as error:
        return {"ok": False, "error": str(error), "projectName": name}

    mapping = (config.get("fieldMap") or {})
    number_key = mapping.get("physicalCardNo", "cardNo")
    wanted = (config.get("statusFilter") or "ACTIVE").upper()
    used = attempted_physical_cards()

    want_cards = bool(payload.get("detail"))
    limit = int(payload.get("limit") or 12)

    def slot(service_id, service_name):
        return {"serviceId": service_id, "name": service_name,
                "total": 0, "active": 0, "free": 0, "usedHere": 0, "statuses": {},
                "freeCards": [], "usedCards": [], "deadCards": []}

    by_service = {}
    for service in services:
        by_service[service["serviceId"]] = slot(service["serviceId"], service.get("name") or "")
    expiry_key = mapping.get("physicalCardExpDate", "expiryDate")
    for row in rows:
        key = str(row.get("serviceId", "") or "")
        entry = by_service.get(key)
        if entry is None:
            entry = by_service.setdefault(key, slot(key, "(not in this project)"))
        status = ""
        for candidate in ("status", "cardStatus", "cardStatusCode"):
            if row.get(candidate) is not None:
                status = str(row.get(candidate)).upper()
                break
        number = str(row.get(number_key, "") or "")
        card = {"cardNo": number, "expiry": str(row.get(expiry_key, "") or ""), "status": status}
        entry["total"] += 1
        entry["statuses"][status or "?"] = entry["statuses"].get(status or "?", 0) + 1
        if status != wanted:
            # not ACTIVE on the portal - terminated, suspended, whatever it says
            if want_cards and len(entry["deadCards"]) < limit:
                entry["deadCards"].append(card)
            continue
        entry["active"] += 1
        if number in used:
            entry["usedHere"] += 1
            if want_cards and len(entry["usedCards"]) < limit:
                entry["usedCards"].append(card)
        else:
            entry["free"] += 1
            if want_cards and len(entry["freeCards"]) < limit:
                entry["freeCards"].append(card)

    services_out = sorted(by_service.values(), key=lambda item: item["serviceId"])
    return {
        "ok": True,
        "projectName": name,
        "projectId": project_id,
        "statusFilter": wanted,
        "truncated": bool((page_info or {}).get("totalPage", 1) > 1),
        "services": services_out,
        "totals": {
            "services": len(services_out),
            "total": sum(s["total"] for s in services_out),
            "active": sum(s["active"] for s in services_out),
            "free": sum(s["free"] for s in services_out),
            "usedHere": sum(s["usedHere"] for s in services_out),
            "dead": sum(s["total"] - s["active"] for s in services_out),
        },
        "detail": want_cards,
        "limitPerService": limit,
    }


def api_card_source(payload):
    """Fetch one unused ACTIVE physical card for the selected target from the QA portal."""
    target, version = payload.get("target", ""), payload.get("version", "")
    try:
        result = pick_portal_card(target, version, payload.get("exclude") or [],
                                  project_name=payload.get("projectName"),
                                  prefer=payload.get("serviceId"))
    except PortalError as error:
        return {"ok": False, "error": str(error)}
    result["ok"] = True
    return result


def api_records(_payload):
    rows = build_records()
    users = {str(row["userId"]) for row in rows}
    return {
        "rows": rows,
        "summary": {
            "users": len(users),
            "applied": sum(1 for row in rows if row["cardApplyNo"]),
            "physical": sum(1 for row in rows if row["cardType"] == "Physical / Plastic Card"),
            "virtual": sum(1 for row in rows if row["cardType"] == "Mobile / Virtual Card"),
        },
    }


# --------------------------------------------------------------------------- #
# Accounts
# --------------------------------------------------------------------------- #
accounts = Accounts()

# everything else needs a session. These four are what you can reach without one, plus the
# static files - the pages themselves hold no data, every figure on them comes from an endpoint.
PUBLIC_ROUTES = {"/api/auth/signup", "/api/auth/login", "/api/auth/logout", "/api/auth/me"}


def api_auth_signup(payload):
    """Create an account. The first one made becomes the owner."""
    try:
        user = accounts.signup(payload.get("username", ""), payload.get("password", ""),
                               payload.get("display", ""))
    except AuthError as error:
        return {"ok": False, "error": str(error)}
    token = accounts.start_session(user["username"])
    return {"ok": True, "user": user, "token": token, "first": user["role"] == "owner"}


def api_auth_login(payload):
    try:
        user = accounts.login(payload.get("username", ""), payload.get("password", ""))
    except AuthError as error:
        return {"ok": False, "error": str(error)}
    return {"ok": True, "user": user, "token": accounts.start_session(user["username"])}


def api_auth_logout(payload):
    accounts.end_session(payload.get("token") or "")
    return {"ok": True}


def api_auth_me(payload):
    """Who the caller is, and whether anyone has signed up yet - that is all a stranger learns."""
    user = accounts.session_user(payload.get("token") or "")
    return {"ok": True, "user": user, "signedIn": bool(user), "hasAccounts": accounts.count() > 0}


ROUTES = {
    "/api/auth/signup": api_auth_signup,
    "/api/auth/login": api_auth_login,
    "/api/auth/logout": api_auth_logout,
    "/api/auth/me": api_auth_me,
    "/api/bootstrap": api_bootstrap,
    "/api/body": api_body,
    "/api/randomize": api_randomize,
    "/api/preview": api_preview,
    "/api/send": api_send,
    "/api/save-body": api_save_body,
    "/api/save-connection": api_save_connection,
    "/api/config": api_config_get,
    "/api/config/save": api_config_save,
    "/api/config/reload": api_config_reload,
    "/api/ping": api_ping,
    "/api/history": api_history,
    "/api/records": api_records,
    "/api/card-source": api_card_source,
    "/api/card-stock": api_card_stock,
    "/api/project-lookup": api_project_lookup,
    "/api/portal-projects": api_portal_projects,
    "/api/session-seed": api_session_seed,
}


# --------------------------------------------------------------------------- #
# HTTP plumbing
# --------------------------------------------------------------------------- #
class Handler(BaseHTTPRequestHandler):
    server_version = "KonaWebViewConsole/1.0"

    def log_message(self, fmt, *args):  # quieter console
        if "/api/send" in (args[0] if args else ""):
            print("[{0}] {1}".format(self.log_date_time_string(), fmt % args))

    # ----------------------------------------------------------- responses
    def _origin_allowed(self, origin):
        """Local pages always; anything else only if config.json lists it.

        The UI can be hosted (Vercel, an intranet box) while this server stays on the tester's
        machine - that is the only way to reach a private API host like 10.30.x.x. Any origin in
        the allowlist can drive this server while it runs, so keep the list short.
        """
        host = urlparse(origin).hostname
        if host in ("127.0.0.1", "localhost", "::1"):
            return True
        for allowed in (store.data.get("server") or {}).get("allowedOrigins") or []:
            allowed = str(allowed).strip().rstrip("/")
            if not allowed:
                continue
            # exact match only: a wildcard domain would let any site hosted there drive this server
            if allowed == origin:
                return True
        return False

    def _cors_headers(self):
        """CORS for a page served from somewhere other than this server."""
        origin = self.headers.get("Origin")
        if not origin or not self._origin_allowed(origin):
            return {}
        headers = {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Headers": "Content-Type, X-Kona-Session",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Max-Age": "600",
            "Vary": "Origin",
        }
        # Chrome/Edge Private Network Access: a public HTTPS page calling http://127.0.0.1 is
        # blocked unless the preflight is answered with this header.
        if self.headers.get("Access-Control-Request-Private-Network") == "true":
            headers["Access-Control-Allow-Private-Network"] = "true"
        return headers

    def _send(self, status, body, content_type="application/json; charset=utf-8", extra_headers=None):
        payload = body if isinstance(body, bytes) else str(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        for key, value in self._cors_headers().items():
            self.send_header(key, value)
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self):
        self.send_response(204)
        for key, value in self._cors_headers().items():
            self.send_header(key, value)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _json(self, status, obj):
        self._send(status, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    # ----------------------------------------------------------- routing
    def do_GET(self):
        path = unquote(urlparse(self.path).path)
        if path in ("/", "/index.html"):
            return self._static("index.html")
        if path.startswith("/api/history/"):
            if not self._allowed(path):
                return self._json(401, {"error": "Sign in to use this.", "signedOut": True})
            return self._history_file(path[len("/api/history/"):])
        if path in ROUTES:
            if not self._allowed(path):
                return self._json(401, {"error": "Sign in to use this.", "signedOut": True})
            return self._run(ROUTES[path], {})
        return self._static(path.lstrip("/"))

    def do_POST(self):
        path = unquote(urlparse(self.path).path)
        handler = ROUTES.get(path)
        if not handler:
            return self._json(404, {"error": "unknown endpoint {0}".format(path)})
        if not self._allowed(path):
            return self._json(401, {"error": "Sign in to use this.", "signedOut": True})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
        except ValueError as error:
            return self._json(400, {"error": "bad JSON in request: {0}".format(error)})
        return self._run(handler, payload)

    def _run(self, handler, payload):
        try:
            return self._json(200, handler(payload))
        except (KeyError, ValueError) as error:
            return self._json(400, {"error": "{0}: {1}".format(type(error).__name__, error)})
        except Exception:
            traceback.print_exc()
            return self._json(500, {"error": traceback.format_exc(limit=3)})

    def _token(self):
        """The session token: a header on same-origin and cross-origin calls alike."""
        header = self.headers.get("X-Kona-Session")
        if header:
            return header.strip()
        cookie = self.headers.get("Cookie") or ""
        for piece in cookie.split(";"):
            name, _, value = piece.strip().partition("=")
            if name == "konaSession":
                return value.strip()
        return ""

    def _allowed(self, path):
        """Every endpoint but the four auth ones needs a live session.

        The check is here rather than in each handler so a new endpoint is protected by default -
        forgetting to add a guard cannot quietly expose the next thing.
        """
        if path in PUBLIC_ROUTES:
            return True
        return bool(accounts.session_user(self._token()))

    def _history_file(self, name):
        safe = os.path.basename(name)
        path = os.path.join(HISTORY_DIR, safe)
        if not safe.endswith(".json") or not os.path.isfile(path):
            return self._json(404, {"error": "no such history record"})
        with open(path, "r", encoding="utf-8") as handle:
            return self._send(200, handle.read().encode("utf-8"))

    def _static(self, relative):
        target = os.path.normpath(os.path.join(WEB_DIR, relative))
        if not target.startswith(WEB_DIR) or not os.path.isfile(target):
            return self._json(404, {"error": "not found"})
        content_type = mimetypes.guess_type(target)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in ("application/javascript", "image/svg+xml"):
            content_type += "; charset=utf-8"
        with open(target, "rb") as handle:
            return self._send(200, handle.read(), content_type)


def main():
    parser = argparse.ArgumentParser(description="KonaPlate WebView API Console")
    parser.add_argument("--port", type=int, default=8770)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    url = "http://{0}:{1}".format(args.host, args.port)
    print("KONA WebView Helper  ->  {0}".format(url))
    print("config: {0}".format(store.path))
    print("VS Code Live Server: 'Go Live' serves web/ on :5500 and finds this API automatically.")
    print("Ctrl+C to stop.")
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
        httpd.server_close()


if __name__ == "__main__":
    main()
