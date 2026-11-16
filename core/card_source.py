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
import concurrent.futures
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

# An ASP id and a card service id are both 15 digits that open with the same 6-digit ASP code:
# ASP 000187000000000 (Burger King) owns 000187000010000, ASP 000163000000000 (iKuka) owns
# 000163000042000. That shared prefix is how a service, and a whole project, is tied to one
# affiliate - the project list the portal returns carries no aspId of its own.
ASP_CODE_LEN = 6
PROJECT_CACHE_SECONDS = 600


def asp_code(value):
    """The 6-digit affiliate code inside an ASP id or a service id; '' when it is not one."""
    text = str(value or "").strip()
    return text[:ASP_CODE_LEN] if len(text) >= ASP_CODE_LEN and text.isdigit() else ""


class PortalError(Exception):
    """Anything that stops us getting a card."""


class CardSource:
    def __init__(self, config):
        self.config = config or {}
        self.base = (self.config.get("baseUrl") or "").rstrip("/")
        self._token = None
        self._user_id = None
        self._expires_at = 0
        self._asp_by_project = {}        # projectId -> aspId, so we classify each project once
        self._project_cache = None       # (fetched_at, [rows]) for the affiliate project picker

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

    def project_asp(self, project_id):
        """The ASP (affiliate) a project belongs to. Only the details call carries it."""
        if project_id in self._asp_by_project:
            return self._asp_by_project[project_id]
        try:
            value = (self.project_summary(project_id) or {}).get("aspId") or ""
        except PortalError:
            value = ""
        self._asp_by_project[project_id] = value
        return value

    def projects_with_asp(self, refresh=False):
        """Every project on the account, each tagged with its ASP id.

        The project list endpoint does not return aspId, so each project needs its own details
        call. They run in a small thread pool and are cached, because this is what fills the
        affiliate's project picker on every target switch.
        """
        if not refresh and self._project_cache:
            fetched_at, rows = self._project_cache
            if time.time() - fetched_at < PROJECT_CACHE_SECONDS:
                return rows
        if refresh:
            self._asp_by_project = {}
        raw = self.projects()
        rows = [{"projectId": item.get("projectId") or item.get("id"),
                 "name": (item.get("name") or "").strip(),
                 "projectStatus": item.get("projectStatus"),
                 "aspId": ""} for item in raw]
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            for row, asp in zip(rows, pool.map(lambda r: self.project_asp(r["projectId"]), rows)):
                row["aspId"] = asp
        rows.sort(key=lambda row: row["name"].lower())
        self._project_cache = (time.time(), rows)
        return rows

    def projects_for_asp(self, asp_id, refresh=False):
        """(projects of that affiliate, whether filtering was possible).

        With no usable ASP id - an affiliate still set to CHANGE_ME in config.json - every
        project comes back rather than none, and the caller is told it is unfiltered.
        """
        rows = self.projects_with_asp(refresh=refresh)
        code = asp_code(asp_id)
        if not code:
            return rows, False
        return [row for row in rows if asp_code(row["aspId"]) == code], True

    def services(self, project_id):
        status, _, body = self._call("/api/card-service/project/{0}".format(project_id))
        if status != 200:
            raise PortalError("card services failed ({0}): {1}".format(status, body[:200]))
        data = self._json(body, "card services")
        if isinstance(data, dict):
            data = data.get("data") or []
        return sorted({item.get("cardServiceId") for item in data if item.get("cardServiceId")})

    def cards(self, project_id, services):
        return self.cards_page(project_id, services)[0]

    def cards_page(self, project_id, services):
        """(rows, pageInfo). pageInfo tells us whether one page held everything."""
        # the portal sends [{"serviceId": "..."}] - plain strings are rejected with a bare 422
        payload = {"projectId": project_id,
                   "serviceList": [{"serviceId": str(s).strip()} for s in services],
                   "page": 0, "size": CARD_LIST_PAGE_SIZE}
        status, _, body = self._call(CARD_LIST_PATH, payload, CARD_LIST_METHOD)
        if status != 200:
            raise PortalError(
                "card list failed ({0}) for project {1}: {2}".format(status, project_id, body[:220]))
        data = self._json(body, "card list")
        page = data.get("pageInfo") if isinstance(data, dict) else None
        for key in ("cardInfo", "value", "list", "content", "data"):
            found = data.get(key) if isinstance(data, dict) else None
            if isinstance(found, list):
                return found, page
            if isinstance(found, dict):
                for inner in ("cardInfo", "value", "list"):
                    if isinstance(found.get(inner), list):
                        return found[inner], page
        return (data if isinstance(data, list) else []), page

    # ------------------------------------------------------------- project
    def project_summary(self, project_id):
        """The project's Summary tab: name, status and the ASP ID the APIs are called with."""
        status, _, body = self._call("/api/project/{0}/details".format(project_id))
        if status != 200:
            raise PortalError("project details failed ({0}): {1}".format(status, body[:200]))
        return self._json(body, "project details")

    def project_keys(self, project_id):
        """The Credentials tab: [{keyType, accessKey, secretKey, keyStatus}].

        keyType OASL is the WebView/OpenAPI key - verified against both configured projects.
        OMCS is a different service and must not be used for these calls.
        """
        status, _, body = self._call("/api/project/keys/{0}".format(project_id))
        if status != 200:
            raise PortalError("project keys failed ({0}): {1}".format(status, body[:200]))
        data = self._json(body, "project keys")
        return data.get("accessKeyInfoRes") or []

    def card_services(self, project_id):
        """Card services with their names, for the Apply Card picker."""
        status, _, body = self._call("/api/card-service/project/{0}".format(project_id))
        if status != 200:
            raise PortalError("card services failed ({0}): {1}".format(status, body[:200]))
        data = self._json(body, "card services")
        if isinstance(data, dict):
            data = data.get("data") or []
        out, seen = [], set()
        for item in data:
            service_id = (item.get("cardServiceId") or "").strip()
            if not service_id or service_id in seen:
                continue
            seen.add(service_id)
            out.append({
                "serviceId": service_id,
                "name": item.get("name") or "",
                "status": item.get("status"),
                "productType": item.get("productType"),
            })
        return out

    def lookup_project(self, name, expected_asp=None):
        """Everything the UI needs for one project, in one portal round trip set.

        `expected_asp` is the ASP id of the affiliate selected in the UI. A project belongs to
        exactly one affiliate, so loading one from a different ASP would hand Burger King a set
        of iKuka service ids - that is refused outright rather than filtered quietly.
        """
        project_id = self.project_id(name)
        summary = self.project_summary(project_id)
        project_asp = summary.get("aspId") or ""
        wanted_code, found_code = asp_code(expected_asp), asp_code(project_asp)
        if wanted_code and found_code and wanted_code != found_code:
            raise PortalError(
                "{0!r} belongs to ASP {1}, but the selected affiliate is ASP {2}. Pick one of "
                "this affiliate's own projects, or switch the affiliate first.".format(
                    name, project_asp, expected_asp))
        keys = self.project_keys(project_id)
        services = self.card_services(project_id)

        wanted = (self.config.get("accessKeyType") or "OASL").upper()
        active = [k for k in keys if str(k.get("keyStatus", "")).upper() == "ACTIVE"]
        chosen = next((k for k in active if str(k.get("keyType", "")).upper() == wanted), None)

        warnings = []
        if chosen is None and active:
            chosen = active[0]
            warnings.append("No ACTIVE {0} key on this project - using the {1} key instead; check "
                            "it is the right one.".format(wanted, chosen.get("keyType")))
        if chosen is None:
            warnings.append("This project has no ACTIVE access key.")
        # a service id carries its owner's ASP code, so anything that is not this project's
        # affiliate is dropped before it can reach the serviceId picker
        foreign = [s for s in services if found_code and asp_code(s["serviceId"]) != found_code]
        if foreign:
            services = [s for s in services if s not in foreign]
            warnings.append("Hid {0} card service(s) that belong to another ASP: {1}.".format(
                len(foreign), ", ".join(s["serviceId"] for s in foreign)))
        if not services:
            warnings.append("This project exposes no card services.")

        return {
            "projectId": project_id,
            "projectName": summary.get("name") or name,
            "projectStatus": summary.get("projectStatus"),
            "aspId": project_asp,
            "accessKey": (chosen or {}).get("accessKey", ""),
            "keyType": (chosen or {}).get("keyType", ""),
            "availableKeys": [{"keyType": k.get("keyType"), "keyStatus": k.get("keyStatus")} for k in keys],
            "services": services,
            "warnings": warnings,
        }

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
        if prefer_service and not matched:
            # handing back a card from another service would register the wrong product,
            # so say what is actually available instead of quietly substituting
            per_service = {}
            for row in active:
                key = str(row.get("serviceId", "") or "?")
                per_service[key] = per_service.get(key, 0) + 1
            raise PortalError(
                "no unused {0} card for service {1} in {2!r}. Services with cards free right now: "
                "{3}".format(wanted, prefer_service, project_name,
                             ", ".join("{0} ({1})".format(k, v) for k, v in sorted(per_service.items()))
                             or "none"))
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
