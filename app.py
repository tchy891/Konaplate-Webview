#!/usr/bin/env python3
"""
KonaPlate WebView API Console
=============================
Desktop UI that replaces the Postman/cURL flow for the WebView APIs.

  Affiliate (Burger King / iKuka)  x  WebView version (V1 / V2)  x  Feature

Every connection value, header and request-body field comes from config.json,
so inputs can be changed later without touching this code.

Run:  python app.py
"""

import json
import os
import queue
import threading
import traceback
from datetime import datetime

import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from core.api_client import build_headers, parse_header_lines, send_request, to_curl
from core.config_store import ConfigStore, find_values
from core.randomizer import apply_random_fields

APP_TITLE = "KonaPlate WebView API Console"
# Malgun Gothic covers both Latin and Hangul, so Korean body values render correctly.
TEXT_FONT = ("Malgun Gothic", 10)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
HISTORY_DIR = os.path.join(BASE_DIR, "history")


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def labelled_entry(parent, text, variable, width=28, row=0, column=0, **kwargs):
    ttk.Label(parent, text=text).grid(row=row, column=column, sticky="w", padx=(0, 4), pady=2)
    entry = ttk.Entry(parent, textvariable=variable, width=width, **kwargs)
    entry.grid(row=row, column=column + 1, sticky="we", padx=(0, 12), pady=2)
    return entry


def scrolled_text(parent, height=10, readonly=False):
    frame = ttk.Frame(parent)
    text = tk.Text(frame, height=height, wrap="none", font=TEXT_FONT, undo=True)
    y_scroll = ttk.Scrollbar(frame, orient="vertical", command=text.yview)
    x_scroll = ttk.Scrollbar(frame, orient="horizontal", command=text.xview)
    text.configure(yscrollcommand=y_scroll.set, xscrollcommand=x_scroll.set)
    text.grid(row=0, column=0, sticky="nsew")
    y_scroll.grid(row=0, column=1, sticky="ns")
    x_scroll.grid(row=1, column=0, sticky="we")
    frame.rowconfigure(0, weight=1)
    frame.columnconfigure(0, weight=1)
    if readonly:
        text.configure(state="disabled")
    return frame, text


def set_text(widget, content):
    state = widget.cget("state")
    widget.configure(state="normal")
    widget.delete("1.0", "end")
    widget.insert("1.0", content)
    widget.configure(state=state)


# --------------------------------------------------------------------------- #
# one tab per feature
# --------------------------------------------------------------------------- #
class FeatureTab(ttk.Frame):
    def __init__(self, parent, app, feature_key):
        super().__init__(parent, padding=8)
        self.app = app
        self.store = app.store
        self.feature_key = feature_key
        self.feature = self.store.feature(feature_key)
        self.result_queue = queue.Queue()
        self.last_request = None

        self.method_var = tk.StringVar(value=self.feature.get("method", "POST"))
        self.path_var = tk.StringVar()
        self.randomize_var = tk.BooleanVar(value=True)
        self.history_var = tk.BooleanVar(value=True)
        self.status_var = tk.StringVar(value="Ready")

        self._build()
        self.reload_from_config()

    # ------------------------------------------------------------- build UI
    def _build(self):
        self.columnconfigure(0, weight=1)
        self.rowconfigure(2, weight=1)

        # --- endpoint row ------------------------------------------------- #
        endpoint = ttk.LabelFrame(self, text="Endpoint", padding=8)
        endpoint.grid(row=0, column=0, sticky="we")
        endpoint.columnconfigure(3, weight=1)

        ttk.Label(endpoint, text="Method").grid(row=0, column=0, sticky="w", padx=(0, 4))
        ttk.Combobox(
            endpoint, textvariable=self.method_var, width=8, state="readonly",
            values=["POST", "GET", "PUT", "PATCH", "DELETE"],
        ).grid(row=0, column=1, padx=(0, 12))
        ttk.Label(endpoint, text="Path").grid(row=0, column=2, sticky="w", padx=(0, 4))
        ttk.Entry(endpoint, textvariable=self.path_var).grid(row=0, column=3, sticky="we")

        self.url_label = ttk.Label(endpoint, text="", foreground="#555555")
        self.url_label.grid(row=1, column=0, columnspan=4, sticky="w", pady=(6, 0))
        self.path_var.trace_add("write", lambda *_: self.refresh_url_preview())

        # --- action row --------------------------------------------------- #
        actions = ttk.Frame(self)
        actions.grid(row=1, column=0, sticky="we", pady=(8, 6))

        self.send_button = ttk.Button(actions, text="  Send Request  ", command=self.send)
        self.send_button.pack(side="left")
        ttk.Button(actions, text="Randomize Now", command=self.randomize_body).pack(side="left", padx=4)
        ttk.Button(actions, text="Reset Body from config.json", command=self.reload_from_config).pack(side="left", padx=4)
        ttk.Button(actions, text="Format JSON", command=self.format_body).pack(side="left", padx=4)
        ttk.Button(actions, text="Copy as cURL", command=self.copy_curl).pack(side="left", padx=4)
        ttk.Button(actions, text="Save Body to config.json", command=self.save_body_to_config).pack(side="left", padx=4)

        ttk.Checkbutton(actions, text="Randomize before send", variable=self.randomize_var).pack(side="left", padx=(16, 4))
        ttk.Checkbutton(actions, text="Save history", variable=self.history_var).pack(side="left", padx=4)

        # --- request / response split ------------------------------------- #
        split = ttk.Panedwindow(self, orient="horizontal")
        split.grid(row=2, column=0, sticky="nsew")

        request_pane = ttk.Frame(split)
        request_pane.rowconfigure(1, weight=4)
        request_pane.rowconfigure(3, weight=1)
        request_pane.columnconfigure(0, weight=1)

        randomized = ", ".join(self.feature.get("randomize", [])) or "none"
        ttk.Label(
            request_pane,
            text="Request body (JSON)   -   randomized fields: {0}   -   {{{{placeholders}}}} are filled from Session".format(randomized),
        ).grid(row=0, column=0, sticky="w", pady=(0, 2))
        body_frame, self.body_text = scrolled_text(request_pane, height=20)
        body_frame.grid(row=1, column=0, sticky="nsew")

        ttk.Label(request_pane, text="Extra / override headers  (Key: value per line)").grid(
            row=2, column=0, sticky="w", pady=(8, 2)
        )
        header_frame, self.header_text = scrolled_text(request_pane, height=4)
        header_frame.grid(row=3, column=0, sticky="nsew")

        response_pane = ttk.Frame(split)
        response_pane.rowconfigure(1, weight=1)
        response_pane.rowconfigure(3, weight=3)
        response_pane.columnconfigure(0, weight=1)

        ttk.Label(response_pane, text="Sent headers").grid(row=0, column=0, sticky="w", pady=(0, 2))
        sent_frame, self.sent_text = scrolled_text(response_pane, height=7, readonly=True)
        sent_frame.grid(row=1, column=0, sticky="nsew")

        self.response_header_label = ttk.Label(response_pane, text="Response", font=("Segoe UI", 9, "bold"))
        self.response_header_label.grid(row=2, column=0, sticky="w", pady=(8, 2))
        response_frame, self.response_text = scrolled_text(response_pane, height=16, readonly=True)
        response_frame.grid(row=3, column=0, sticky="nsew")

        split.add(request_pane, weight=1)
        split.add(response_pane, weight=1)

        ttk.Label(self, textvariable=self.status_var, foreground="#1a5fb4").grid(
            row=3, column=0, sticky="w", pady=(6, 0)
        )

    # ------------------------------------------------------------- state
    def reload_from_config(self):
        """Pull path + body for the currently selected affiliate / webview version."""
        target, version = self.app.current_target()
        self.path_var.set(self.store.endpoint(target, version, self.feature_key))
        body = self.store.resolved_body(self.feature_key, target, version)
        set_text(self.body_text, json.dumps(body, ensure_ascii=False, indent=4))
        self.refresh_url_preview()
        if not self.path_var.get():
            self.status_var.set(
                "No endpoint configured for this feature yet - add the path in config.json "
                "(targets.{0}.versions.{1}.endpoints.{2})".format(target, version, self.feature_key)
            )
        else:
            self.status_var.set("Loaded defaults for {0} / {1}".format(self.store.target_label(target), version))

    def refresh_url_preview(self):
        self.url_label.configure(text="URL:  {0}".format(self.build_url()))

    def build_url(self):
        return self.app.base_url_var.get().rstrip("/") + self.path_var.get()

    def read_body(self):
        """Parse the editor contents as JSON, after substituting {{session}} placeholders."""
        raw = self.body_text.get("1.0", "end").strip()
        if not raw:
            return None
        raw = self.app.substitute_session(raw)
        try:
            return json.loads(raw)
        except ValueError as error:
            raise ValueError("Request body is not valid JSON:\n\n{0}".format(error))

    # ------------------------------------------------------------- actions
    def format_body(self):
        try:
            body = self.read_body()
        except ValueError as error:
            messagebox.showerror("Invalid JSON", str(error), parent=self)
            return
        set_text(self.body_text, json.dumps(body, ensure_ascii=False, indent=4))

    def randomize_body(self, silent=False):
        try:
            body = self.read_body()
        except ValueError as error:
            if not silent:
                messagebox.showerror("Invalid JSON", str(error), parent=self)
            return None
        if body is None:
            return None
        generated = apply_random_fields(body, self.feature.get("randomize", []), self.store.random_fields)
        set_text(self.body_text, json.dumps(body, ensure_ascii=False, indent=4))
        if generated and not silent:
            self.status_var.set("Randomized: " + ", ".join("{0}={1}".format(k, v) for k, v in generated.items()))
        return generated

    def save_body_to_config(self):
        try:
            body = self.read_body()
        except ValueError as error:
            messagebox.showerror("Invalid JSON", str(error), parent=self)
            return
        target, version = self.app.current_target()
        choice = messagebox.askyesnocancel(
            "Save request body",
            "Yes  = save as the override for {0} / {1} only\n"
            "No   = save as the shared default for every affiliate/version\n"
            "Cancel = do nothing".format(self.store.target_label(target), version),
            parent=self,
        )
        if choice is None:
            return
        if choice:
            self.store.save_override(self.feature_key, target, version, body)
            self.status_var.set("Saved as override for {0} / {1} in config.json".format(target, version))
        else:
            self.store.save_default_body(self.feature_key, body)
            self.status_var.set("Saved as the shared default body in config.json")

    def copy_curl(self):
        try:
            body = self.read_body()
        except ValueError as error:
            messagebox.showerror("Invalid JSON", str(error), parent=self)
            return
        headers = self.app.compose_headers(parse_header_lines(self.header_text.get("1.0", "end")))
        command = to_curl(self.build_url(), self.method_var.get(), headers, body)
        self.clipboard_clear()
        self.clipboard_append(command)
        self.status_var.set("cURL command copied to clipboard")

    # ------------------------------------------------------------- sending
    def send(self):
        if not self.path_var.get().strip():
            messagebox.showwarning("No endpoint", "Set the endpoint path first (or add it to config.json).", parent=self)
            return
        if self.randomize_var.get():
            self.randomize_body(silent=True)
        try:
            body = self.read_body()
        except ValueError as error:
            messagebox.showerror("Invalid JSON", str(error), parent=self)
            return

        headers = self.app.compose_headers(parse_header_lines(self.header_text.get("1.0", "end")))
        url = self.build_url()
        method = self.method_var.get()
        timeout = self.app.timeout_seconds()

        set_text(self.sent_text, "\n".join("{0}: {1}".format(k, v) for k, v in headers.items()))
        self.send_button.configure(state="disabled")
        self.status_var.set("Sending {0} {1} ...".format(method, url))
        self.last_request = {"url": url, "method": method, "headers": headers, "body": body}

        def worker():
            try:
                result = send_request(url, method, headers, body, timeout=timeout, use_proxy=self.app.use_proxy_var.get())
            except Exception:
                result = {"status": None, "reason": "ClientError", "text": traceback.format_exc(),
                          "responseHeaders": {}, "json": None, "elapsedMs": 0, "error": True}
            self.result_queue.put(result)

        threading.Thread(target=worker, daemon=True).start()
        self.after(100, self._poll_result)

    def _poll_result(self):
        try:
            result = self.result_queue.get_nowait()
        except queue.Empty:
            self.after(100, self._poll_result)
            return
        self.send_button.configure(state="normal")
        self._render_result(result)

    def _render_result(self, result):
        status = result.get("status")
        ok = isinstance(status, int) and 200 <= status < 300
        label = "Response   -   {0} {1}   -   {2} ms".format(
            status if status is not None else "NO RESPONSE", result.get("reason", ""), result.get("elapsedMs", 0)
        )
        self.response_header_label.configure(text=label, foreground="#2e7d32" if ok else "#c62828")

        payload = result.get("json")
        body_text = json.dumps(payload, ensure_ascii=False, indent=4) if payload is not None else result.get("text", "")
        headers_text = "\n".join("{0}: {1}".format(k, v) for k, v in result.get("responseHeaders", {}).items())
        set_text(self.response_text, "{0}\n{1}\n{2}".format(headers_text, "-" * 60, body_text) if headers_text else body_text)

        captured = {}
        if ok:
            body = self.last_request.get("body") or {}
            for name in self.feature.get("randomize", []) + ["ci", "loginId", "email", "mobileNumber"]:
                if isinstance(body.get(name), str):
                    captured[name] = body[name]
            if payload is not None:
                captured.update(find_values(payload, set(self.store.defaults.get("captureKeys", []))))
            self.app.update_session(captured)

        self.status_var.set(
            "{0} {1}  ({2} ms){3}".format(
                "SUCCESS" if ok else "FAILED", status, result.get("elapsedMs", 0),
                "  |  captured: " + ", ".join(captured) if captured else "",
            )
        )
        if self.history_var.get():
            self._write_history(result)

    def _write_history(self, result):
        try:
            os.makedirs(HISTORY_DIR, exist_ok=True)
            target, version = self.app.current_target()
            name = "{0}_{1}_{2}_{3}.json".format(
                datetime.now().strftime("%Y%m%d_%H%M%S"), self.feature_key, target, version
            )
            record = {
                "timestamp": datetime.now().isoformat(timespec="seconds"),
                "affiliate": self.store.target_label(target),
                "webViewVersion": version,
                "feature": self.feature_key,
                "request": self.last_request,
                "response": {
                    "status": result.get("status"),
                    "reason": result.get("reason"),
                    "headers": result.get("responseHeaders"),
                    "body": result.get("json") if result.get("json") is not None else result.get("text"),
                    "elapsedMs": result.get("elapsedMs"),
                },
            }
            with open(os.path.join(HISTORY_DIR, name), "w", encoding="utf-8") as handle:
                json.dump(record, handle, indent=2, ensure_ascii=False)
        except Exception as error:
            self.status_var.set("{0}  |  history not saved: {1}".format(self.status_var.get(), error))


# --------------------------------------------------------------------------- #
# main window
# --------------------------------------------------------------------------- #
class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title(APP_TITLE)
        self.geometry("1360x900")
        self.minsize(1100, 720)

        self.store = ConfigStore()
        self.session = {}

        self.affiliate_var = tk.StringVar()
        self.version_var = tk.StringVar()
        self.base_url_var = tk.StringVar()
        self.asp_id_var = tk.StringVar()
        self.access_key_var = tk.StringVar()
        self.time_zone_var = tk.StringVar(value=self.store.defaults.get("timeZone", "KST"))
        self.timeout_var = tk.StringVar(value=str(self.store.defaults.get("timeoutSeconds", 30)))
        self.use_proxy_var = tk.BooleanVar(value=False)

        try:
            ttk.Style(self).theme_use("vista")
        except tk.TclError:
            pass

        self._build()
        self._load_target_defaults()

    # ------------------------------------------------------------- build UI
    def _build(self):
        self.columnconfigure(0, weight=1)
        self.rowconfigure(1, weight=1)

        top = ttk.LabelFrame(self, text="Target  (affiliate x webview version)", padding=8)
        top.grid(row=0, column=0, sticky="we", padx=8, pady=(8, 4))
        for column in (1, 3, 5):
            top.columnconfigure(column, weight=1)

        labels = [self.store.target_label(key) for key in self.store.target_keys()]
        ttk.Label(top, text="Affiliate").grid(row=0, column=0, sticky="w", padx=(0, 4))
        affiliate_box = ttk.Combobox(top, textvariable=self.affiliate_var, values=labels, state="readonly", width=20)
        affiliate_box.grid(row=0, column=1, sticky="w", padx=(0, 16))
        self.affiliate_var.set(labels[0] if labels else "")
        affiliate_box.bind("<<ComboboxSelected>>", self._on_affiliate_change)

        ttk.Label(top, text="WebView version").grid(row=0, column=2, sticky="w", padx=(0, 4))
        self.version_box = ttk.Combobox(top, textvariable=self.version_var, state="readonly", width=10)
        self.version_box.grid(row=0, column=3, sticky="w", padx=(0, 16))
        self.version_box.bind("<<ComboboxSelected>>", lambda _event: self._load_target_defaults())

        ttk.Button(top, text="Reload config.json", command=self._reload_config).grid(row=0, column=4, sticky="e")
        ttk.Checkbutton(top, text="Use system proxy", variable=self.use_proxy_var).grid(row=0, column=5, sticky="e")

        grid = ttk.Frame(top)
        grid.grid(row=1, column=0, columnspan=6, sticky="we", pady=(8, 0))
        grid.columnconfigure(1, weight=3)
        grid.columnconfigure(3, weight=2)
        labelled_entry(grid, "Base URL", self.base_url_var, width=34, row=0, column=0)
        labelled_entry(grid, "X-KM-User-AspId", self.asp_id_var, width=24, row=0, column=2)
        labelled_entry(grid, "X-KM-Access-Key", self.access_key_var, width=46, row=1, column=0)
        labelled_entry(grid, "X-KM-Time-Zone", self.time_zone_var, width=10, row=1, column=2)
        labelled_entry(grid, "Timeout (s)", self.timeout_var, width=8, row=1, column=4)
        self.base_url_var.trace_add(
            "write", lambda *_: [tab.refresh_url_preview() for tab in getattr(self, "tabs", {}).values()]
        )

        self.notebook = ttk.Notebook(self)
        self.notebook.grid(row=1, column=0, sticky="nsew", padx=8, pady=4)

        self.tabs = {}
        for feature_key in self.store.feature_keys():
            tab = FeatureTab(self.notebook, self, feature_key)
            self.notebook.add(tab, text=self.store.feature(feature_key).get("label", feature_key))
            self.tabs[feature_key] = tab

        session_frame = ttk.LabelFrame(self, text="Session  (values captured from responses - reuse as {{placeholders}} in any body)", padding=6)
        session_frame.grid(row=2, column=0, sticky="we", padx=8, pady=(4, 8))
        session_frame.columnconfigure(0, weight=1)
        frame, self.session_text = scrolled_text(session_frame, height=5, readonly=True)
        frame.grid(row=0, column=0, sticky="nsew")
        buttons = ttk.Frame(session_frame)
        buttons.grid(row=0, column=1, sticky="ns", padx=(8, 0))
        ttk.Button(buttons, text="Copy", command=self._copy_session).pack(fill="x", pady=2)
        ttk.Button(buttons, text="Export", command=self._export_session).pack(fill="x", pady=2)
        ttk.Button(buttons, text="Clear", command=self._clear_session).pack(fill="x", pady=2)
        self._render_session()

    # ------------------------------------------------------------- target
    def current_target(self):
        target = self.store.label_to_target(self.affiliate_var.get())
        version = self.version_var.get() or self.store.version_keys(target)[0]
        return target, version

    def _on_affiliate_change(self, _event=None):
        target = self.store.label_to_target(self.affiliate_var.get())
        versions = self.store.version_keys(target)
        self.version_box.configure(values=versions)
        if self.version_var.get() not in versions:
            self.version_var.set(versions[0])
        self._load_target_defaults()

    def _load_target_defaults(self):
        target = self.store.label_to_target(self.affiliate_var.get())
        versions = self.store.version_keys(target)
        self.version_box.configure(values=versions)
        if self.version_var.get() not in versions:
            self.version_var.set(versions[0])
        connection = self.store.connection(target, self.version_var.get())
        self.base_url_var.set(connection.get("baseUrl", ""))
        self.asp_id_var.set(connection.get("aspId", ""))
        self.access_key_var.set(connection.get("accessKey", ""))
        for tab in getattr(self, "tabs", {}).values():
            tab.reload_from_config()
        self.title("{0}   -   {1} / {2}".format(APP_TITLE, self.store.target_label(target), self.version_var.get()))

    def _reload_config(self):
        try:
            self.store.load()
        except Exception as error:
            messagebox.showerror("config.json", "Could not read config.json:\n\n{0}".format(error), parent=self)
            return
        self._load_target_defaults()
        messagebox.showinfo("config.json", "Configuration reloaded.", parent=self)

    # ------------------------------------------------------------- requests
    def compose_headers(self, extra=None):
        return build_headers(
            self.asp_id_var.get().strip(),
            self.access_key_var.get().strip(),
            self.time_zone_var.get().strip() or "KST",
            self.store.defaults.get("contentType", "application/json"),
            extra,
        )

    def timeout_seconds(self):
        try:
            return max(1, int(float(self.timeout_var.get())))
        except (TypeError, ValueError):
            return 30

    # ------------------------------------------------------------- session
    def substitute_session(self, raw):
        for key, value in self.session.items():
            raw = raw.replace("{{%s}}" % key, str(value))
        return raw

    def update_session(self, values):
        self.session.update({k: v for k, v in (values or {}).items() if v not in (None, "")})
        self._render_session()

    def _render_session(self):
        if not self.session:
            set_text(self.session_text, "(empty - send a request and successful values land here)")
        else:
            set_text(self.session_text, json.dumps(self.session, ensure_ascii=False, indent=4))

    def _copy_session(self):
        self.clipboard_clear()
        self.clipboard_append(json.dumps(self.session, ensure_ascii=False, indent=4))

    def _export_session(self):
        path = filedialog.asksaveasfilename(
            parent=self, defaultextension=".json", filetypes=[("JSON", "*.json")],
            initialfile="session_{0}.json".format(datetime.now().strftime("%Y%m%d_%H%M%S")),
        )
        if not path:
            return
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(self.session, handle, indent=2, ensure_ascii=False)

    def _clear_session(self):
        self.session.clear()
        self._render_session()


if __name__ == "__main__":
    App().mainloop()
