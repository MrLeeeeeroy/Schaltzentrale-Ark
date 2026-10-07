#!/usr/bin/env python3
# Pi-hole-Status für die Schaltzentrale – läuft auf dem Raspberry Pi.
# Liest den Pi-hole (v6) lokal aus und gibt nur vier Zahlen als JSON aus.
import json, ssl, threading, time, urllib.request, urllib.error
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

CONF = json.loads(Path(__file__).with_name("config.json").read_text(encoding="utf-8"))
URL = CONF.get("piholeUrl", "http://127.0.0.1").rstrip("/")
PASSWORT = CONF.get("piholePasswort", "")
PORT = int(CONF.get("port", 8788))
TAKT = int(CONF.get("abfrageAlleSekunden", 120))

KEIN_ZERTIFIKAT = ssl._create_unverified_context()  # nur für lokales https
sid = None
stand = {"stand": None, "pihole": {"online": False}}


def anfrage(methode, pfad, koerper=None):
    kopf = {"Accept": "application/json"}
    if sid:
        kopf["X-FTL-SID"] = sid
    daten = None
    if koerper is not None:
        daten = json.dumps(koerper).encode()
        kopf["Content-Type"] = "application/json"
    req = urllib.request.Request(URL + pfad, data=daten, headers=kopf, method=methode)
    try:
        with urllib.request.urlopen(req, timeout=5, context=KEIN_ZERTIFIKAT) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception:
        return 0, None


def anmelden():
    global sid
    sid = None
    if not PASSWORT:
        return False
    status, d = anfrage("POST", "/api/auth", {"password": PASSWORT})
    if status == 200 and d and d.get("session", {}).get("sid"):
        sid = d["session"]["sid"]
        return True
    print("Pi-hole: Anmeldung fehlgeschlagen – Passwort in config.json prüfen", flush=True)
    return False


def abfragen():
    status, d = anfrage("GET", "/api/stats/summary")
    if status in (401, 403) and anmelden():
        status, d = anfrage("GET", "/api/stats/summary")
    if status != 200 or not d or "queries" not in d:
        return {"online": False}
    q, g = d["queries"], d.get("gravity") or {}
    p = q.get("percent_blocked")
    return {
        "online": True,
        "anfragen": q.get("total"),
        "blockiert": q.get("blocked"),
        "prozent": round(p, 1) if isinstance(p, (int, float)) else None,
        "domains": g.get("domains_being_blocked"),
    }


def schleife():
    global stand
    while True:
        ph = abfragen()
        stand = {"stand": datetime.now(timezone.utc).isoformat(timespec="seconds"), "pihole": ph}
        print("Pi-hole", f"{ph['prozent']} % blockiert" if ph["online"] else "nicht erreichbar", flush=True)
        time.sleep(TAKT)


class Antwort(BaseHTTPRequestHandler):
    def do_GET(self):
        text = json.dumps(stand).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(text)))
        self.end_headers()
        self.wfile.write(text)

    def log_message(self, *a):
        pass


threading.Thread(target=schleife, daemon=True).start()
print(f"Pi-hole-Status läuft auf 127.0.0.1:{PORT}", flush=True)
ThreadingHTTPServer(("127.0.0.1", PORT), Antwort).serve_forever()
