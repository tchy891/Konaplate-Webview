"""Accounts and sessions for the console.

The password is never stored, only a PBKDF2-HMAC-SHA256 hash of it with a per-user random salt
and a high iteration count. Comparisons use compare_digest, so a wrong password takes the same
time to reject however wrong it is.

A session is a random token held server-side. The token is what the browser sends back on every
call; nothing about the user is encoded in it, so a token cannot be forged or read.

This gate exists to keep the console's data - access keys, project names, card numbers, the
record of every run - off the screen of anyone who has not signed in. The server enforces it on
every data endpoint; the login page only redirects, which is convenience, not the boundary.
"""

import hashlib
import json
import os
import re
import secrets
import threading
import time

USERS_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          "users.json")
ITERATIONS = 240000
SALT_BYTES = 16
SESSION_HOURS = 12
MIN_PASSWORD = 8
NAME_RE = re.compile(r"^[A-Za-z0-9._@-]{3,40}$")


class AuthError(Exception):
    """Anything that stops a sign-up or a sign-in, phrased for the person reading it."""


class Accounts:
    def __init__(self, path=USERS_PATH):
        self.path = path
        self._lock = threading.Lock()
        self._sessions = {}             # token -> {username, created, seen}
        self._users = self._load()

    # ------------------------------------------------------------- storage
    def _load(self):
        if not os.path.isfile(self.path):
            return {}
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
            return data.get("users", {}) if isinstance(data, dict) else {}
        except Exception:
            return {}

    def _save(self):
        payload = {
            "_README": ("Accounts for the console. Passwords are PBKDF2-HMAC-SHA256 hashes with "
                        "a per-user salt - the password itself is not here and cannot be read "
                        "back. This file is git-ignored; keep it that way."),
            "users": self._users,
        }
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
        os.replace(tmp, self.path)

    # ------------------------------------------------------------ hashing
    @staticmethod
    def _hash(password, salt):
        return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"),
                                   bytes.fromhex(salt), ITERATIONS).hex()

    # ------------------------------------------------------------ accounts
    def count(self):
        return len(self._users)

    def exists(self, username):
        return (username or "").strip().lower() in self._users

    def signup(self, username, password, display=""):
        name = (username or "").strip()
        if not NAME_RE.match(name):
            raise AuthError("A username is 3 to 40 characters: letters, digits, . _ - or @.")
        if len(password or "") < MIN_PASSWORD:
            raise AuthError("Use a password of at least {0} characters.".format(MIN_PASSWORD))
        key = name.lower()
        with self._lock:
            if key in self._users:
                raise AuthError("That username is taken.")
            salt = secrets.token_hex(SALT_BYTES)
            self._users[key] = {
                "username": name,
                "display": (display or name).strip()[:60],
                "salt": salt,
                "hash": self._hash(password, salt),
                "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "role": "owner" if not self._users else "member",
            }
            self._save()
            return self._public(key)

    def login(self, username, password):
        key = (username or "").strip().lower()
        user = self._users.get(key)
        # the same message either way, so this cannot be used to discover who has an account
        wrong = AuthError("That username and password do not match.")
        if not user:
            # still spend the time, so a missing user is not faster than a wrong password
            self._hash(password or "", secrets.token_hex(SALT_BYTES))
            raise wrong
        if not secrets.compare_digest(self._hash(password or "", user["salt"]), user["hash"]):
            raise wrong
        return self._public(key)

    def _public(self, key):
        user = self._users[key]
        return {"username": user["username"], "display": user.get("display") or user["username"],
                "role": user.get("role", "member")}

    # ------------------------------------------------------------ sessions
    def start_session(self, username):
        token = secrets.token_urlsafe(32)
        now = time.time()
        with self._lock:
            self._sessions[token] = {"username": username.lower(), "created": now, "seen": now}
        return token

    def session_user(self, token):
        """The account behind a token, or None. Expired tokens are dropped as they are seen."""
        if not token:
            return None
        with self._lock:
            session = self._sessions.get(token)
            if not session:
                return None
            if time.time() - session["created"] > SESSION_HOURS * 3600:
                self._sessions.pop(token, None)
                return None
            session["seen"] = time.time()
            key = session["username"]
        return self._public(key) if key in self._users else None

    def end_session(self, token):
        with self._lock:
            self._sessions.pop(token, None)
