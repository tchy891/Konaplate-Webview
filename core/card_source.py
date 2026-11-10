"""Pull physical test-card data (card no / expiry / CVC / PAR) from the KONA PLATE QA portal.

Flow, as the portal's own SPA does it:
  1. POST /api/login                      {username, password}  -> X-KM-AUTH-TOKEN response header
  2. GET  /api/project                    ?userEmail=<lowercase>&pageNum=1&pageSize=N -> {"value": [...]}
  3. GET  /api/card-service/project/{id}                        -> [{cardServiceId, ...}]
  4. POST /api/test-data/card/list        {projectId, serviceList, page, size}
                                          -> {"cardInfo": [{cardNo, expiryDate, cvc, par,
                                                            status, serviceId}], "pageInfo": {...}}

serviceList must be a list of OBJECTS keyed "serviceId" - [{"serviceId": "000187000010000"}].
Sending plain strings (or objects keyed "cardServiceId") returns a bare 422 from the gateway with
no hint, which is what made this endpoint look broken.

A card consumed by Card Registration flips to status TERMINATED, so filtering on ACTIVE is what
keeps the API from answering 003_027 "User is already mapped to card error".

Required headers (discovered): X-KM-Accept-Language is mandatory - without it every call fails with
30_999_028 "Required Header is missing". X-KM-UserId is needed for anything user-scoped.
Note the project list filter is CASE SENSITIVE on the e-mail: "kona2@..." works, "Kona2@..." gives 0.
"""

import base64
import gzip
import json
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request

CARD_LIST_PATH = "/api/test-data/card/list"
CARD_LIST_METHOD = "POST"
CARD_LIST_PAGE_SIZE = 300


class PortalError(Exception):
    """Anything that stops us getting a card."""


class CardSource:
    def __init__(self, config):
        self.config = config or {}
        self.base = (self.config.get("baseUrl") or "").rstrip("/")
        self._token = None
        self._user_id = None
        self._expires_at = 0

    # ----------------------------------------------------------------- http
    def _context(self):
        if self.config.get("verifyTls"):
            return ssl.create_default_context()
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx

    def _headers(self, extra=None):
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            "Accept": "application/json, text/plain, */*",
            "Accept-Encoding": "gzip",
            "Origin": self.base,
            "X-KM-User-Agent": self.config.get("userAgentValue", "UP/0.0.1"),
            "X-KM-Accept-Language": self.config.get("language", "en"),
        }
        if self._token:
            headers["X-KM-AUTH-TOKEN"] = self._token
            headers["Cookie"] = "X-KM-AUTH-TOKEN=" + self._token
        if self._user_id:
            headers["X-KM-UserId"] = self._user_id
        headers.update(extra or {})
        return headers

    def _call(self, path, payload=None, method=None, extra_headers=None):
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(
            self.base + path, data=data, method=method or ("POST" if data is not None else "GET"))
        for key, value in self._headers(extra_headers).items():
            request.add_header(key, value)
        if data is not None:
            request.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(request, timeout=self.config.get("timeoutSeconds", 45),
                                        context=self._context()) as response:
                raw = response.read()
                if response.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                return response.status, dict(response.headers.items()), raw.decode("utf-8", "replace")
        except urllib.error.HTTPError as error:
            raw = error.read()
            try:
                raw = gzip.decompress(raw)
            except Exception:
                pass
            headers = dict(error.headers.items()) if error.headers else {}
            return error.code, headers, raw.decode("utf-8", "replace")
        except Exception as error:
            raise PortalError("{0} while calling {1}".format(type(error).__name__, path))

    @staticmethod
    def _json(body, where):
        try:
            return json.loads(body)
        except ValueError:
            raise PortalError("{0} did not return JSON: {1}".format(where, body[:200]))

    # ----------------------------------------------------------------- auth
    def login(self, force=False):
        if self._token and not force and time.time() < self._expires_at - 60:
            return
        email = self.config.get("email", "")
        status, headers, body = self._call(
            "/api/login", {"username": email, "password": self.config.get("password", "")})
        if status != 200:
            raise PortalError("portal login failed ({0}): {1}".format(status, body[:200]))
        token = headers.get("X-KM-AUTH-TOKEN") or headers.get("x-km-auth-token")
        if not token:
            raise PortalError("portal login returned no X-KM-AUTH-TOKEN header")
        self._token = token
        self._user_id = self._json(body, "login").get("userId")
        self._expires_at = self._token_expiry(token)

    @staticmethod
    def _token_expiry(token):
        try:
            claims = token.split(".")[1]
            claims += "=" * (-len(claims) % 4)
            return float(json.loads(base64.urlsafe_b64decode(claims)).get("exp", 0))
        except Exception:
            return time.time() + 600

    # ----------------------------------------------------------------- data
    def projects(self):
        """The account's projects. The e-mail filter is case sensitive - always lower-case it."""
        self.login()
        query = urllib.parse.urlencode({
            "userEmail": self.config.get("email", "").lower(), "pageNum": 1, "pageSize": 200})
        status, _, body = self._call("/api/project?" + query)
        if status != 200:
            raise PortalError("project list failed ({0}): {1}".format(status, body[:200]))
        data = self._json(body, "project list")
        return data.get("value") or []

    def project_id(self, name):
        wanted = (name or "").strip()
        for project in self.projects():
            if (project.get("name") or "").strip() == wanted:
                return project.get("projectId") or project.get("id")
        raise PortalError("project {0!r} not found for this portal account".format(wanted))

    def services(self, project_id):
        status, _, body = self._call("/api/card-service/project/{0}".format(project_id))
        if status != 200:
            raise PortalError("card services failed ({0}): {1}".format(status, body[:200]))
        data = self._json(body, "card services")
        if isinstance(data, dict):
            data = data.get("data") or []
        return sorted({item.get("cardServiceId") for item in data if item.get("cardServiceId")})

    def cards(self, project_id, services):
        # the portal sends [{"serviceId": "..."}] - plain strings are rejected with a bare 422
        payload = {"projectId": project_id,
                   "serviceList": [{"serviceId": str(s).strip()} for s in services],
                   "page": 0, "size": CARD_LIST_PAGE_SIZE}
        status, _, body = self._call(CARD_LIST_PATH, payload, CARD_LIST_METHOD)
        if status != 200:
            raise PortalError(
                "card list failed ({0}) for project {1}: {2}".format(status, project_id, body[:220]))
        data = self._json(body, "card list")
        for key in ("cardInfo", "value", "list", "content", "data"):
            found = data.get(key) if isinstance(data, dict) else None
            if isinstance(found, list):
                return found
            if isinstance(found, dict):
                for inner in ("cardInfo", "value", "list"):
                    if isinstance(found.get(inner), list):
                        return found[inner]
        return data if isinstance(data, list) else []

    # ----------------------------------------------------------------- pick
    def pick_card(self, project_name, exclude=(), prefer_service=None):
        """First ACTIVE card for the project that is not in `exclude`, mapped to body fields.

        `prefer_service` is the serviceId the card was applied for: a project can hold cards for
        several services, and the physical card should belong to the same one. If no ACTIVE card
        matches it we still return one, and say so in `source.serviceMatched`.
        """
        project_id = self.project_id(project_name)
        services = self.services(project_id)
        if not services:
            raise PortalError("project {0!r} exposes no card services".format(project_name))
        rows = self.cards(project_id, services)

        status_keys = ("status", "cardStatus", "cardStatusCode")
        wanted = (self.config.get("statusFilter") or "ACTIVE").upper()
        mapping = self.config.get("fieldMap") or {}
        exclude = {str(value) for value in exclude if value}
        number_key = mapping.get("physicalCardNo", "cardNo")

        active, skipped, by_status = [], 0, {}
        for row in rows:
            value = next((str(row.get(key)) for key in status_keys if row.get(key) is not None), "")
            by_status[value.upper()] = by_status.get(value.upper(), 0) + 1
            if value.upper() != wanted:
                continue
            if str(row.get(number_key, "") or "") in exclude:
                skipped += 1
                continue
            active.append(row)

        if not active:
            raise PortalError(
                "no unused {0} card in {1!r} - {2} cards: {3}{4}".format(
                    wanted, project_name, len(rows),
                    ", ".join("{0} {1}".format(count, name or "?") for name, count in sorted(by_status.items())),
                    " ({0} skipped as already used here)".format(skipped) if skipped else ""))

        matched = [row for row in active if str(row.get("serviceId", "")).strip() == str(prefer_service or "").strip()]
        card = (matched or active)[0]
        fields = {field: str(card.get(source, "") or "") for field, source in mapping.items()}
        return {
            "fields": fields,
            "card": card,
            "source": {
                "project": project_name, "projectId": project_id, "services": services,
                "totalCards": len(rows), "usableCards": len(active), "skippedUsed": skipped,
                "statusCounts": by_status, "serviceId": card.get("serviceId"),
                "preferredService": prefer_service,
                "serviceMatched": bool(matched) if prefer_service else None,
                "matchingCards": len(matched),
            },
        }
