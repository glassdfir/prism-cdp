#!/usr/bin/env python3
"""Prism CDP: put Prism highlighting on every page you visit in Microsoft Edge or Google Chrome, over the Chrome
DevTools Protocol.

On macOS and Linux it launches the browser with its own profile and talks to it over a pipe (--remote-debugging-pipe),
so no debugging port is left listening for other programs. --port opens one on 127.0.0.1 when you want other tools in
too. On Windows, Python can't hand the browser a pipe, so it always uses a port: 61455 unless you pick another.
The engine is injected into an isolated world in every tab and frame: page scripts can't see it, and it changes
nothing in the page's DOM text (CSS Custom Highlight API).

  python3 prism_cdp.py                         # launch Edge (or Chrome if there's no Edge), rules from ./rules.csv
  python3 prism_cdp.py --chrome                # launch Chrome instead
  python3 prism_cdp.py --rules sigs.csv        # rules from a CSV (or .tsv, .prism.json, a Prism rule link);
                                               # reloaded whenever the file changes
  python3 prism_cdp.py --starter               # starter.csv, next to this script
  python3 prism_cdp.py --port                  # launch with a debugging port on 127.0.0.1:61455 instead of a pipe
  python3 prism_cdp.py --attach                # attach to a browser already debugging on 61455 (or --attach PORT)

Type `help` at the prompt for commands. Python 3.9+, standard library only. macOS, Windows and Linux. MIT (c) 2026 Jon Glass, https://jon.glass/
"""
import argparse
import asyncio
import base64
import csv
import json
import os
import shutil
import signal
import struct
import subprocess
import sys
import threading
import time
import urllib.request

IS_WIN = os.name == "nt"
if not IS_WIN:
    import fcntl  # pipe mode only
from collections import defaultdict
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
ENGINE = HERE / "engine.js"
STARTER = HERE / "starter.csv"
WORLD = "prism"
def browser_paths(kind):
    """Where Edge or Chrome usually lives on this OS: stable first, then the preview channels."""
    if IS_WIN:
        roots = [os.environ.get(k) for k in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA")]
        if kind == "edge":
            dirs, exe = [Path("Microsoft", "Edge" + ch) for ch in ("", " Beta", " Dev", " SxS")], "msedge.exe"
        else:
            dirs, exe = [Path("Google", "Chrome" + ch) for ch in ("", " Beta", " Dev", " SxS")], "chrome.exe"
        return [str(Path(r, d, "Application", exe)) for d in dirs for r in roots if r] + [exe[:-4]]
    if sys.platform == "darwin":
        if kind == "edge":
            return [f"/Applications/Microsoft Edge{ch}.app/Contents/MacOS/Microsoft Edge{ch}"
                    for ch in ("", " Beta", " Dev", " Canary")]
        return [f"/Applications/Google Chrome{ch}.app/Contents/MacOS/Google Chrome{ch}"
                for ch in ("", " Beta", " Dev", " Canary")]
    if kind == "edge":
        return ["microsoft-edge", "microsoft-edge-stable", "microsoft-edge-beta", "microsoft-edge-dev"]
    return ["google-chrome", "google-chrome-stable", "google-chrome-beta", "google-chrome-unstable",
            "chromium", "chromium-browser"]
DEFAULT_PORT = 61455  # used by a bare --port or --attach, and on Windows
PROFILES = Path.home() / ".prism-cdp"  # one profile folder per browser: edge-profile, chrome-profile
# Start the browser in its own process group, so Ctrl+C in this terminal reaches only the controller
# (which then shuts down cleanly) and a --keep-open browser survives it
DETACHED = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if IS_WIN else {"start_new_session": True}


# ---------------------------------------------------------------- rule files
# CSV header names (any case) -> Prism rule fields. Columns not listed here are shown on the hover card.
COLUMNS = {"name": "name", "title": "name", "rule": "name", "signature": "name",
           "pattern": "pattern", "regex": "pattern", "regexp": "pattern",
           "flags": "flags", "color": "color", "colour": "color", "style": "style",
           "desc": "desc", "description": "desc", "on": "on", "enabled": "on", "active": "on"}
OFF = {"0", "n", "no", "false", "off", "disabled"}


def csv_rules(path, warn=None):
    """Rules from a CSV (or .tsv) file: a header row with at least a pattern column, then one rule per row.
    Patterns are written exactly as in a regex tester: no JSON escaping, quote the cell if it contains a comma."""
    p = Path(path)
    with open(p, newline="", encoding="utf-8-sig") as f:  # -sig: Excel's byte-order mark
        reader = csv.reader(f, delimiter="\t" if p.suffix.lower() == ".tsv" else ",")
        header, rules = None, []
        for row in reader:
            if not any(c.strip() for c in row) or row[0].lstrip().startswith("#"):
                continue  # blank and # comment lines
            if header is None:
                header = [h.strip() for h in row]
                if "pattern" not in [COLUMNS.get(h.lower()) for h in header]:
                    raise ValueError(f"line {reader.line_num}: the first row must be a header with a pattern column "
                                     f"(name,pattern,flags,color,style,on,desc). Found: {', '.join(header)}")
                pi = [COLUMNS.get(h.lower()) for h in header].index("pattern")
                continue
            if len(row) > len(header):
                # Almost always an unquoted comma in the pattern, like {1,3}: put the pieces back together
                n = len(row) - len(header)
                row = row[:pi] + [",".join(row[pi:pi + n + 1])] + row[pi + n + 1:]
                if warn:
                    warn(f"{p.name} line {reader.line_num}: more cells than the header, so the extra commas were "
                         f"kept in the pattern. Put patterns with commas in double quotes to be sure.")
            r, extra = {}, []
            for h, v in zip(header, row):
                key = COLUMNS.get(h.lower())
                if key and key not in r:
                    r[key] = v if key == "pattern" else v.strip()
                elif v.strip() and h:
                    extra.append(f"{h}: {v.strip()}")
            if not r.get("pattern", "").strip():
                continue
            rule = {"name": r.get("name") or r["pattern"][:40], "pattern": r["pattern"], "flags": r.get("flags", ""),
                    "on": r.get("on", "").lower() not in OFF}
            for k in ("color", "style"):
                if r.get(k):
                    rule[k] = r[k]
            desc = "\n".join(x for x in [r.get("desc", "")] + extra if x)
            if desc:
                rule["desc"] = desc
            rules.append(rule)
    if not rules:
        raise ValueError("no rules found")
    return json.dumps({"name": p.stem, "rules": rules})


def read_rules(path, warn=None):
    """.prism.json text for a CSV/TSV file, a .prism.json export, or a file holding a Prism rule link."""
    p = Path(path)
    if p.suffix.lower() in (".csv", ".tsv"):
        return csv_rules(p, warn)
    text = p.read_text(encoding="utf-8-sig").strip()
    if "rules=" not in text:
        json.loads(text)  # fail early, with a line number, on a broken rules file
    return text


def log(*a):
    print("[prism]", *a, flush=True)


class CDPError(Exception):
    pass


# ---------------------------------------------------------------- transports
class PipeTransport:
    """CDP over --remote-debugging-pipe: the browser reads JSON on fd 3 and writes on fd 4, each message ending in NUL."""

    def __init__(self):
        self.proc = None
        self._w = None
        self.on_message = None
        self.on_close = None

    async def launch(self, cmd):
        loop = asyncio.get_running_loop()
        a, b = os.pipe()  # us -> browser
        c, d = os.pipe()  # browser -> us
        # Move the child's ends above 10 so the dup2 to 3 and 4 below can never clobber each other
        to_child = fcntl.fcntl(a, fcntl.F_DUPFD, 10)
        from_child = fcntl.fcntl(d, fcntl.F_DUPFD, 10)
        os.close(a)
        os.close(d)

        def child():
            os.dup2(to_child, 3)
            os.dup2(from_child, 4)

        # Every other fd Python opens is non-inheritable, so only 0-4 reach the browser
        self.proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL, preexec_fn=child, close_fds=False, **DETACHED)
        os.close(to_child)
        os.close(from_child)
        rd = os.fdopen(c, "rb", buffering=0)
        wr = os.fdopen(b, "wb", buffering=0)
        transport = self

        class Reader(asyncio.Protocol):
            buf = b""

            def data_received(self, data):
                self.buf += data
                *msgs, self.buf = self.buf.split(b"\0")
                for m in msgs:
                    transport.on_message(m)

            def connection_lost(self, exc):
                if transport.on_close:
                    transport.on_close()

        await loop.connect_read_pipe(Reader, rd)
        self._w, _ = await loop.connect_write_pipe(asyncio.Protocol, wr)

    def send(self, text):
        self._w.write(text.encode() + b"\0")

    async def close(self):
        if self.proc and self.proc.poll() is None:
            try:
                await asyncio.wait_for(asyncio.get_running_loop().run_in_executor(None, self.proc.wait), 5)
            except asyncio.TimeoutError:
                self.proc.terminate()


class WebSocketTransport:
    """Minimal RFC 6455 client, enough for CDP on a local --remote-debugging-port."""

    def __init__(self):
        self.on_message = None
        self.on_close = None
        self._r = self._w = None

    async def connect(self, ws_url):
        u = urlparse(ws_url)
        self._r, self._w = await asyncio.open_connection(u.hostname, u.port or 80)
        key = base64.b64encode(os.urandom(16)).decode()
        # No Origin header: Chromium only checks --remote-allow-origins when one is sent
        self._w.write((f"GET {u.path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\nUpgrade: websocket\r\n"
                       f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        head = await self._r.readuntil(b"\r\n\r\n")
        if b" 101 " not in head.split(b"\r\n", 1)[0]:
            raise CDPError("WebSocket handshake failed: " + head.split(b"\r\n", 1)[0].decode(errors="replace"))
        asyncio.ensure_future(self._read_loop())

    def _frame(self, opcode, payload):
        n = len(payload)
        hdr = bytes([0x80 | opcode])
        if n < 126:
            hdr += bytes([0x80 | n])
        elif n < 65536:
            hdr += bytes([0x80 | 126]) + struct.pack("!H", n)
        else:
            hdr += bytes([0x80 | 127]) + struct.pack("!Q", n)
        mask = os.urandom(4)
        body = bytes(x ^ mask[i % 4] for i, x in enumerate(payload)) if n < 4096 else _xor(payload, mask)
        self._w.write(hdr + mask + body)

    def send(self, text):
        self._frame(1, text.encode())

    async def _read_loop(self):
        parts = []
        try:
            while True:
                b0, b1 = await self._r.readexactly(2)
                op, n = b0 & 0x0F, b1 & 0x7F
                if n == 126:
                    n = struct.unpack("!H", await self._r.readexactly(2))[0]
                elif n == 127:
                    n = struct.unpack("!Q", await self._r.readexactly(8))[0]
                data = await self._r.readexactly(n)
                if op == 8:
                    break
                if op == 9:
                    self._frame(10, data)
                    continue
                if op in (0, 1, 2):
                    parts.append(data)
                    if b0 & 0x80:
                        self.on_message(b"".join(parts))
                        parts = []
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        if self.on_close:
            self.on_close()

    async def close(self):
        try:
            self._frame(8, b"")
            self._w.close()
        except Exception:
            pass


def _xor(payload, mask):
    m = int.from_bytes((mask * (len(payload) // 4 + 1))[:len(payload)], "big")
    return (int.from_bytes(payload, "big") ^ m).to_bytes(len(payload), "big")


# ---------------------------------------------------------------- CDP session multiplexer
class CDP:
    def __init__(self, transport):
        self.t = transport
        self.t.on_message = self._dispatch
        self._id = 0
        self._pending = {}
        self._handlers = defaultdict(list)
        self.closed = asyncio.get_event_loop().create_future()
        self.t.on_close = lambda: self.closed.done() or self.closed.set_result(True)

    def on(self, method, fn):
        self._handlers[method].append(fn)

    async def send(self, method, params=None, session=None, timeout=20):
        self._id += 1
        msg = {"id": self._id, "method": method, "params": params or {}}
        if session:
            msg["sessionId"] = session
        fut = asyncio.get_running_loop().create_future()
        self._pending[self._id] = fut
        self.t.send(json.dumps(msg))
        try:
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(msg["id"], None)

    def _dispatch(self, raw):
        msg = json.loads(raw)
        if "id" in msg:
            fut = self._pending.get(msg["id"])
            if fut and not fut.done():
                if "error" in msg:
                    fut.set_exception(CDPError(msg["error"].get("message", str(msg["error"]))))
                else:
                    fut.set_result(msg.get("result", {}))
            return
        for fn in self._handlers.get(msg.get("method"), ()):
            try:
                fn(msg.get("params", {}), msg.get("sessionId"))
            except Exception as e:  # a bad handler must not kill the reader
                log("handler error:", msg.get("method"), e)


# ---------------------------------------------------------------- the controller
class Prism:
    def __init__(self, cdp, args):
        self.cdp = cdp
        self.args = args
        self.engine = ENGINE.read_text()
        self.sessions = {}  # sessionId -> {"target": targetInfo, "script": identifier}
        self.targets = set()
        self.contexts = {}  # (sessionId, contextId) -> frameId
        self.enabled = not args.off
        self.rules = None
        self.rules_mtime = None
        self.verbose = args.verbose

    # rules ----------------------------------------------------------------
    def load_rules_file(self):
        p = self.args.rules
        if not p:
            return False
        self.rules_mtime = Path(p).stat().st_mtime  # set first, so a broken file isn't retried every second
        self.rules = read_rules(p, warn=log)
        return True

    def payload(self):
        starter = None
        try:
            starter = read_rules(STARTER) if STARTER.exists() else None
        except (ValueError, OSError):
            pass
        boot = {"rules": self.rules, "starter": starter, "enabled": self.enabled, "ui": not self.args.no_ui,
                "contextChars": self.args.context}
        return f"globalThis.__PRISM_BOOT__ = {json.dumps(boot)};\n{self.engine}"

    # targets --------------------------------------------------------------
    def on_attached(self, p, _parent):
        sid, ti, waiting = p["sessionId"], p["targetInfo"], p.get("waitingForDebugger")
        if ti["type"] not in ("page", "iframe") or ti["targetId"] in self.targets:
            # Not ours to highlight (workers etc.), or a second session for a target we already have
            asyncio.ensure_future(self._release(sid, waiting, detach=True))
            return
        self.targets.add(ti["targetId"])
        self.sessions[sid] = {"target": ti, "script": None, "since": time.time() * 1000}
        asyncio.ensure_future(self.setup(sid, ti, waiting))

    async def _release(self, sid, waiting, detach):
        try:
            if waiting:
                await self.cdp.send("Runtime.runIfWaitingForDebugger", session=sid)
            if detach:
                await self.cdp.send("Target.detachFromTarget", {"sessionId": sid})
        except CDPError:
            pass

    async def setup(self, sid, ti, waiting):
        try:
            await self.cdp.send("Runtime.enable", session=sid)
            await self.cdp.send("Page.enable", session=sid)
            # Cross-origin iframes run in their own process: attach to those too, as they appear. Workers are
            # attached only so they can be released at once (waitForDebuggerOnStart would otherwise hold them)
            await self.cdp.send("Target.setAutoAttach", {"autoAttach": True, "waitForDebuggerOnStart": True,
                                                         "flatten": True, "filter": [{"type": "iframe"}, {"type": "worker"}]}, sid)
            r = await self.cdp.send("Page.addScriptToEvaluateOnNewDocument",
                                    {"source": self.payload(), "worldName": WORLD, "runImmediately": True}, sid)
            self.sessions[sid]["script"] = r["identifier"]
            if self.verbose:
                log("attached", ti["type"], ti.get("url", "")[:90])
        except (CDPError, asyncio.TimeoutError) as e:
            if self.verbose:
                log("could not set up", ti.get("url", "")[:60], "-", e)
        finally:
            if waiting:
                try:
                    await self.cdp.send("Runtime.runIfWaitingForDebugger", session=sid)
                except CDPError:
                    pass

    def on_detached(self, p, _parent):
        s = self.sessions.pop(p["sessionId"], None)
        if s:
            self.targets.discard(s["target"]["targetId"])
        for k in [k for k in self.contexts if k[0] == p["sessionId"]]:
            del self.contexts[k]

    def on_ctx_created(self, p, sid):
        c = p["context"]
        if c.get("name") == WORLD:
            self.contexts[(sid, c["id"])] = c.get("auxData", {}).get("frameId")

    def on_ctx_destroyed(self, p, sid):
        self.contexts.pop((sid, p["executionContextId"]), None)

    def on_ctx_cleared(self, _p, sid):
        for k in [k for k in self.contexts if k[0] == sid]:
            del self.contexts[k]

    def on_console(self, p, sid):
        key = (sid, p.get("executionContextId"))
        s = self.sessions.get(sid)
        # Runtime.enable replays a page's earlier console messages: skip anything older than this session
        if key not in self.contexts or not s or p.get("timestamp", 1e18) < s["since"] - 50:
            return
        # Only top-level documents speak, unless --verbose: otherwise every ad iframe repeats itself
        is_top = s["target"]["type"] == "page" and self.contexts[key] == s["target"]["targetId"]
        if not (is_top or self.verbose):
            return
        text = " ".join(str(a.get("value", a.get("description", ""))) for a in p.get("args", []))
        host = urlparse(s["target"].get("url", "")).hostname or s["target"].get("url", "")
        print(f"  {host}: {text}", flush=True)

    def on_target_info(self, p, _parent):
        for s in self.sessions.values():
            if s["target"]["targetId"] == p["targetInfo"]["targetId"]:
                s["target"] = p["targetInfo"]

    async def start(self):
        c = self.cdp
        c.on("Target.attachedToTarget", self.on_attached)
        c.on("Target.detachedFromTarget", self.on_detached)
        c.on("Target.targetInfoChanged", self.on_target_info)
        c.on("Runtime.executionContextCreated", self.on_ctx_created)
        c.on("Runtime.executionContextDestroyed", self.on_ctx_destroyed)
        c.on("Runtime.executionContextsCleared", self.on_ctx_cleared)
        c.on("Runtime.consoleAPICalled", self.on_console)
        await c.send("Target.setDiscoverTargets", {"discover": True})
        await c.send("Target.setAutoAttach", {"autoAttach": True, "waitForDebuggerOnStart": True, "flatten": True,
                                              "filter": [{"type": "page"}]})
        # Tabs that were already open (when attaching): pick up any the auto-attach didn't
        await asyncio.sleep(0.3)
        for t in (await c.send("Target.getTargets"))["targetInfos"]:
            if t["type"] == "page" and t["targetId"] not in self.targets:
                try:
                    await c.send("Target.attachToTarget", {"targetId": t["targetId"], "flatten": True})
                except CDPError:
                    pass

    # live changes ---------------------------------------------------------
    async def each_context(self, expr):
        out = []
        for (sid, cid) in list(self.contexts):
            try:
                r = await self.cdp.send("Runtime.evaluate", {"expression": expr, "contextId": cid, "awaitPromise": True,
                                                             "returnByValue": True}, sid, timeout=10)
                out.append((sid, cid, r.get("result", {}).get("value")))
            except (CDPError, asyncio.TimeoutError):
                pass
        return out

    async def reregister(self):
        """New documents get the current rules and on/off state."""
        for sid, s in list(self.sessions.items()):
            try:
                if s["script"]:
                    await self.cdp.send("Page.removeScriptToEvaluateOnNewDocument", {"identifier": s["script"]}, sid)
                r = await self.cdp.send("Page.addScriptToEvaluateOnNewDocument",
                                        {"source": self.payload(), "worldName": WORLD}, sid)
                s["script"] = r["identifier"]
            except (CDPError, asyncio.TimeoutError):
                pass

    async def push_rules(self):
        await self.reregister()
        # Re-run the engine with the new rules wherever Prism is running (it replaces its previous run).
        # Frames where someone pressed ✕ stay clear until they reload.
        expr = f"(() => {{ if (!globalThis.prismHL) return false; {self.payload()}; return true; }})()"
        n = sum(1 for *_, v in await self.each_context(expr) if v)
        log(f"rules reloaded in {n} frame{'s' if n != 1 else ''}")

    async def set_enabled(self, on):
        self.enabled = on
        await self.reregister()
        n = sum(1 for *_, v in await self.each_context(
            f"globalThis.prismHL ? (prismHL.{'on' if on else 'off'}(), true) : false") if v)
        log(("on" if on else "off") + f" in {n} frame{'s' if n != 1 else ''}")

    async def status(self):
        rows = await self.each_context("globalThis.prismHL ? prismHL.status() : null")
        tops = [v for *_, v in rows if v and v.get("top")]
        frames = [v for *_, v in rows if v and not v.get("top")]
        log(f"{len(self.sessions)} targets, {len(tops)} tabs, {len(frames)} frames with Prism, rules: "
            f"{self.args.rules or 'none'}, {'on' if self.enabled else 'off'}")
        for v in tops:
            print(f"  {v['hits']:>6} hits  {v['rules']} rules  {'on ' if v['on'] else 'off'}  {v['url'][:100]}")
            for p in v.get("paused") or []:
                print(f"          not running: {p}")
        if frames:
            print(f"  {sum(f['hits'] for f in frames):>6} hits in {len(frames)} embedded frames")

    async def watch_rules(self):
        while True:
            await asyncio.sleep(1)
            p = self.args.rules
            if not p:
                continue
            try:
                m = Path(p).stat().st_mtime
            except OSError:
                continue
            if m != self.rules_mtime:
                try:
                    self.load_rules_file()
                    await self.push_rules()
                except (ValueError, OSError) as e:
                    log(f"{p}: not reloaded, {e}")

    async def detach(self):
        """Leave the browser as it was: remove Prism from every frame, stop injecting, let go of every target."""
        await self.each_context("globalThis.prismHL && prismHL.stop()")
        try:
            await self.cdp.send("Target.setAutoAttach", {"autoAttach": False, "waitForDebuggerOnStart": False})
        except CDPError:
            pass
        for sid, s in list(self.sessions.items()):
            try:
                if s["script"]:
                    await self.cdp.send("Page.removeScriptToEvaluateOnNewDocument", {"identifier": s["script"]}, sid)
                await self.cdp.send("Target.detachFromTarget", {"sessionId": sid})
            except (CDPError, asyncio.TimeoutError):
                pass


HELP = """commands:
  status         tabs, hit counts, rules that aren't running
  on | off       turn highlighting on or off everywhere
  reload         re-read the rules file now (it also reloads by itself when the file changes)
  rules <path>   switch to another rules file (CSV, TSV, .prism.json or a Prism rule link)
  starter        switch to starter.csv
  open <url>     open a new tab
  quit           remove Prism from every page and exit (closes the browser if Prism launched it)"""


async def ws_url(target, quiet=False):
    """Browser WebSocket URL for a port, an http://host:port, or a ws:// URL. None if nothing answers."""
    if target.startswith("ws"):
        return target
    base = target if "://" in target else f"http://127.0.0.1:{target}"

    def get():
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # CDP is local: never proxy it
            with opener.open(base.rstrip("/") + "/json/version", timeout=2) as r:
                return json.load(r)["webSocketDebuggerUrl"]
        except Exception:
            return None
    return await asyncio.get_running_loop().run_in_executor(None, get)


def find_browser(choice):
    """choice: "edge", "chrome", a path or command name, or None (Edge, then Chrome).
    Returns (executable, kind), kind being "edge" or "chrome" (it names the profile folder), or (None, kind)."""
    choice = choice or os.environ.get("PRISM_BROWSER") or ""
    key = choice.strip().lower()
    if key in ("edge", "msedge", "microsoft-edge"):
        order = ["edge"]
    elif key in ("chrome", "google-chrome", "chromium"):
        order = ["chrome"]
    elif key:
        exe = shutil.which(choice) or (choice if os.path.exists(choice) else None)
        return exe, "edge" if "edge" in key else "chrome"
    else:
        order = ["edge", "chrome"]
    for kind in order:
        for b in browser_paths(kind):
            if os.path.exists(b) or shutil.which(b):
                return shutil.which(b) or b, kind
    return None, order[0]


async def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")  # a cp1252 console or log file shouldn't crash on “ ” or ✕
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description="Prism highlighting on every page in Edge or Chrome, over CDP.")
    ap.add_argument("urls", nargs="*", help="pages to open at start")
    ap.add_argument("--rules", help="rules file: CSV/TSV, a .prism.json export, or a Prism rule link "
                                    "(default: ./rules.csv or ./rules.prism.json); reloaded when it changes")
    ap.add_argument("--starter", action="store_true", help="use starter.csv next to this script")
    ap.add_argument("--attach", metavar="PORT|URL", nargs="?", const=str(DEFAULT_PORT),
                    help=f"attach to a browser started with --remote-debugging-port (bare --attach: {DEFAULT_PORT})")
    ap.add_argument("--port", type=int, metavar="PORT", nargs="?", const=DEFAULT_PORT,
                    help=f"launch with a debugging port on 127.0.0.1 instead of a pipe, so other tools can attach too "
                         f"(bare --port: {DEFAULT_PORT}; 0: any free port). Always on in Windows, where pipes aren't available")
    ap.add_argument("--keep-open", action="store_true",
                    help="on quit, remove Prism but leave the launched browser running (useful with --port)")
    ap.add_argument("--browser", help="edge, chrome, or a path to any Chromium browser (default: Edge, or Chrome if "
                                      "Edge isn't installed; or set PRISM_BROWSER)")
    ap.add_argument("--chrome", dest="browser", action="store_const", const="chrome", help="same as --browser chrome")
    ap.add_argument("--profile", help=f"profile folder for the launched browser (default: {PROFILES}/edge-profile "
                                      f"or chrome-profile)")
    ap.add_argument("--browser-arg", action="append", default=[], metavar="ARG",
                    help="extra browser command-line switch, e.g. --browser-arg=--start-maximized (repeatable)")
    ap.add_argument("--headless", action="store_true", help="run the launched browser headless (testing)")
    ap.add_argument("--no-ui", action="store_true", help="no floating Prism control in pages")
    ap.add_argument("--off", action="store_true", help="start with highlighting off")
    ap.add_argument("--context", type=int, default=100, help="characters of context in the hover card (default 100)")
    ap.add_argument("--verbose", "-v", action="store_true")
    args = ap.parse_args()
    if args.starter:
        args.rules = str(STARTER)
    if not args.rules:
        args.rules = next((f for f in ("rules.csv", "rules.prism.json") if Path(f).exists()), None)

    proc = None  # a browser launched with --port
    if args.attach and args.port is not None:
        sys.exit("Use --attach or --port, not both.")
    if args.attach:
        ws = await ws_url(args.attach)
        if not ws:
            sys.exit(f"Nothing is serving CDP at {args.attach}. Start the browser with --remote-debugging-port, or use --port.")
        transport = WebSocketTransport()
        await transport.connect(ws)
        log("attached to", ws)
    else:
        exe, kind = find_browser(args.browser)
        if not exe:
            asked = args.browser or os.environ.get("PRISM_BROWSER")
            what = {"edge": "Microsoft Edge", "chrome": "Google Chrome"}.get((asked or "").lower(), asked) \
                if asked else "Neither Microsoft Edge nor Google Chrome"
            sys.exit(f"{what}: not found. Pass --browser with the path to the browser, or set PRISM_BROWSER.")
        args.profile = args.profile or str(PROFILES / f"{kind}-profile")
        Path(args.profile).mkdir(parents=True, exist_ok=True)
        cmd = [exe, f"--user-data-dir={args.profile}", "--no-first-run",
               "--no-default-browser-check"] + (["--headless=new"] if args.headless else []) + args.browser_arg
        if args.port is None and IS_WIN:
            args.port = DEFAULT_PORT  # Python can't hand the browser a pipe on Windows, so it always uses a port
        if args.port is not None:
            if args.port and await ws_url(str(args.port), quiet=True):
                sys.exit(f"Port {args.port} already has a browser debugging on it. Use --attach {args.port} instead"
                         f"{'' if args.port != DEFAULT_PORT else ' (or just --attach)'}, or --port 0 for any free port.")
            # Chromium binds the port to 127.0.0.1 only. With port 0 it picks a free port and writes it to
            # DevToolsActivePort in the profile folder (line 1: port, line 2: the browser's WebSocket path).
            # With a fixed port that file may never appear, so ask the port itself as well.
            active = Path(args.profile, "DevToolsActivePort")
            try:
                active.unlink()
            except OSError:
                pass
            proc = subprocess.Popen(cmd + [f"--remote-debugging-port={args.port}"], stdin=subprocess.DEVNULL,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **DETACHED)
            ws, port = None, args.port
            for _ in range(80):
                await asyncio.sleep(0.25)
                if proc.poll() is not None:
                    break
                try:
                    lines = active.read_text().split()
                    if len(lines) >= 2:
                        port, ws = int(lines[0]), f"ws://127.0.0.1:{lines[0]}{lines[1]}"
                        break
                except (OSError, ValueError):
                    pass
                if args.port:
                    ws = await ws_url(str(args.port), quiet=True)
                    if ws:
                        break
            if not ws:
                if proc.poll() is None:
                    proc.terminate()
                sys.exit(f"The browser didn't open a debugging port. Is another copy using the profile {args.profile}, "
                         f"or is port {args.port} taken by another program? (--port 0 picks any free port)")
            args.port = port
            transport = WebSocketTransport()
            await transport.connect(ws)
            log(f"launched {Path(exe).name} with debugging port 127.0.0.1:{port} (profile {args.profile})")
        else:
            transport = PipeTransport()
            await transport.launch(cmd + ["--remote-debugging-pipe"])
            log(f"launched {Path(exe).name} over a pipe, no port open (profile {args.profile})")

    cdp = CDP(transport)
    prism = Prism(cdp, args)
    try:
        if prism.load_rules_file():
            log("rules:", args.rules)
        else:
            log("no rules yet: use the Prism control in a page, `rules <path>`, or `starter`")
    except (ValueError, OSError) as e:
        sys.exit(f"{args.rules}: {e}")
    await prism.start()
    for u in args.urls:
        await cdp.send("Target.createTarget", {"url": u})
    log(f"ready. {len(prism.sessions)} tab(s). Type `help` for commands.")

    loop = asyncio.get_running_loop()
    lines = asyncio.Queue()

    def stdin_reader():
        for line in sys.stdin:
            loop.call_soon_threadsafe(lines.put_nowait, line)
        loop.call_soon_threadsafe(lines.put_nowait, None)

    if sys.stdin and not sys.stdin.closed:
        threading.Thread(target=stdin_reader, daemon=True).start()
    stop = loop.create_future()
    def on_signal(*_):
        loop.call_soon_threadsafe(lambda: stop.done() or stop.set_result(True))

    if IS_WIN:  # no add_signal_handler on Windows: a plain handler that wakes the loop (Ctrl+C, Ctrl+Break)
        signal.signal(signal.SIGINT, on_signal)
        signal.signal(signal.SIGBREAK, on_signal)
    else:
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, on_signal)
    watcher = asyncio.ensure_future(prism.watch_rules())

    async def repl():
        while True:
            line = await lines.get()
            if line is None:
                if sys.stdin.isatty():
                    break
                await asyncio.Event().wait()  # stdin closed (running in the background): keep going until a signal
            cmd, _, rest = line.strip().partition(" ")
            try:
                if cmd in ("quit", "exit", "q"):
                    break
                elif cmd == "help":
                    print(HELP)
                elif cmd == "status":
                    await prism.status()
                elif cmd in ("on", "off"):
                    await prism.set_enabled(cmd == "on")
                elif cmd == "reload":
                    prism.load_rules_file()
                    await prism.push_rules()
                elif cmd in ("rules", "starter") and (rest or cmd == "starter"):
                    args.rules = str(STARTER) if cmd == "starter" else os.path.expanduser(rest.strip())
                    prism.load_rules_file()
                    log("rules:", args.rules)
                    await prism.push_rules()
                elif cmd == "open" and rest:
                    await cdp.send("Target.createTarget", {"url": rest.strip()})
                elif cmd:
                    print("unknown command. Type `help`.")
            except (ValueError, OSError, CDPError) as e:
                log("error:", e)
        stop.done() or stop.set_result(True)

    r = asyncio.ensure_future(repl())
    await asyncio.wait([stop, cdp.closed], return_when=asyncio.FIRST_COMPLETED)
    watcher.cancel()
    r.cancel()
    if cdp.closed.done():
        log("browser closed.")
        return
    if args.attach or (args.keep_open and proc):
        await prism.detach()
        log("Prism removed from every page; browser left running" +
            (f" with port {args.port} open." if args.port else "."))
        await transport.close()
    elif proc:
        try:
            await cdp.send("Browser.close", timeout=5)
        except (CDPError, asyncio.TimeoutError):
            pass
        await transport.close()
        try:
            await asyncio.wait_for(loop.run_in_executor(None, proc.wait), 5)
        except asyncio.TimeoutError:
            proc.terminate()
        log("browser closed.")
    else:
        try:
            await cdp.send("Browser.close", timeout=5)
        except (CDPError, asyncio.TimeoutError):
            pass
        await transport.close()
        log("browser closed.")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
