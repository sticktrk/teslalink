"""Tesla's official MQTT dispatcher -> durable local spool -> Cloudflare.

Vehicle signal timestamps are not included in Tesla's MQTT messages. Signal
timestamps therefore represent receipt by this bridge, explicitly labelled as
such. Alerts/errors/connectivity retain their vehicle timestamp when available.
"""
import hashlib
import hmac
import json
import logging
import os
import re
import sqlite3
import ssl
import threading
import time
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse, urljoin
from urllib.request import Request, urlopen, build_opener, HTTPSHandler, HTTPRedirectHandler

LOG = logging.getLogger("tesla-link")
VIN = re.compile(r"^[A-HJ-NPR-Z0-9]{17}$")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward secrets to a redirect destination.


def http_request(url, data, headers, context=None):
    opener = build_opener(NoRedirect(), HTTPSHandler(context=context or ssl.create_default_context()))
    return opener.open(Request(url, data=data, headers={"User-Agent": "TeslaLink/1.0", **headers}, method="POST"), timeout=25)


def decode_message(topic, payload, base, allowed, received_at=None):
    parts = topic.split("/")
    if len(parts) < 3 or parts[0] != base or not VIN.fullmatch(parts[1]) or parts[1] not in allowed:
        raise ValueError("unrecognized vehicle or topic")
    value = json.loads(payload)
    received_at = received_at or int(time.time() * 1000)
    kind = {"v": "signal", "connectivity": "connectivity", "alerts": "alert", "errors": "error"}.get(parts[2])
    if not kind or (kind != "connectivity" and len(parts) < 4):
        raise ValueError("unrecognized record type")
    field = "/".join(parts[3:]) if len(parts) > 3 else "connectivity"
    if not re.fullmatch(r"[a-zA-Z0-9_./:-]{1,128}", field):
        raise ValueError("invalid field")
    timestamp, source = received_at, "receiver"
    if kind != "signal" and isinstance(value, dict):
        candidate = value.get("CreatedAt") or value.get("StartedAt")
        if candidate:
            try:
                candidate_ms = int(datetime.fromisoformat(candidate.replace("Z", "+00:00")).timestamp() * 1000)
                if 1577836800000 <= candidate_ms <= received_at + 300000:
                    timestamp, source = candidate_ms, "vehicle"
            except (TypeError, ValueError, OverflowError):
                pass
    return {"id": str(uuid.uuid4()), "vin": parts[1], "kind": kind, "field": field, "value": value, "timestamp": timestamp, "timestampSource": source}


class Spool:
    def __init__(self, path):
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS pending(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS mqtt_ids(mid INTEGER PRIMARY KEY,digest TEXT NOT NULL,id TEXT NOT NULL);
        """)

    def add(self, event, mid, duplicate, digest):
        with self.lock, self.db:
            previous = self.db.execute("SELECT digest,id FROM mqtt_ids WHERE mid=?", (mid,)).fetchone()
            if duplicate and previous and previous[0] == digest:
                return  # Already durably queued (or uploaded) before the MQTT ACK was lost.
            if self.db.execute("SELECT COUNT(*) FROM pending").fetchone()[0] >= 1_000_000:
                raise RuntimeError("spool full")  # Do not ACK. Container restarts and retries.
            self.db.execute("INSERT INTO pending(id,body) VALUES(?,?)", (event["id"], json.dumps(event, separators=(",", ":"), allow_nan=False)))
            self.db.execute("INSERT INTO mqtt_ids VALUES(?,?,?) ON CONFLICT(mid) DO UPDATE SET digest=excluded.digest,id=excluded.id", (mid, digest, event["id"]))

    def batch(self, limit=100):
        with self.lock:
            rows = self.db.execute("SELECT id,body FROM pending ORDER BY seq LIMIT ?", (limit,)).fetchall()
        result, length = [], 0
        for row in rows:
            length += len(row[1].encode()) + 1
            if length > 220000 and result:
                break
            result.append((row[0], json.loads(row[1])))
        return result

    def reset_mqtt_ids(self):
        with self.lock, self.db:
            self.db.execute("DELETE FROM mqtt_ids")

    def remove(self, ids):
        with self.lock, self.db:
            self.db.executemany("DELETE FROM pending WHERE id=?", [(i,) for i in ids])


def upload_forever(spool, url, token):
    backoff = 2
    while True:
        batch = spool.batch()
        if not batch:
            time.sleep(2)
            continue
        try:
            data = json.dumps({"events": [event for _, event in batch]}, separators=(",", ":")).encode()
            with http_request(url, data, {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}) as response:
                result = json.load(response)
                if result.get("accepted", 0) + result.get("duplicates", 0) != len(batch):
                    raise ValueError("incomplete acknowledgement")
            spool.remove([key for key, _ in batch])
            backoff = 2
        except HTTPError as error:
            LOG.warning("Cloudflare upload returned HTTP %s; preserving queued events", error.code)
            # A configuration/permission error is never an instruction to discard data.
            retry = error.headers.get("Retry-After", "")
            wait = min(3600, max(backoff, int(retry))) if retry.isdigit() else backoff
            error.close()
            time.sleep(wait)
            backoff = min(300, backoff * 2)
        except (URLError, OSError, ValueError):
            LOG.warning("Cloudflare upload unavailable; preserving queued events")
            time.sleep(backoff)
            backoff = min(300, backoff * 2)


def gateway_handler(secret, allowed, proxy_url, context):
    class Gateway(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(30)

        def log_message(self, *_):
            pass  # No paths, credentials, bodies, or VINs in access logs.

        def reply(self, status, body, retry=None):
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            if retry:
                self.send_header("Retry-After", retry)
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            if self.path != "/configure":
                return self.reply(404, b'{"error":"not found"}')
            if not hmac.compare_digest(self.headers.get("X-Proxy-Token", ""), secret):
                return self.reply(401, b'{"error":"unauthorized"}')
            if not self.headers.get("Authorization", "").startswith("Bearer "):
                return self.reply(401, b'{"error":"missing Tesla token"}')
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 262144:
                    return self.reply(413, b'{"error":"invalid body size"}')
                data = self.rfile.read(length)
                body = json.loads(data)
                if not isinstance(body, dict) or not isinstance(body.get("vins"), list) or len(body["vins"]) != 1 or body["vins"][0] not in allowed or not isinstance(body.get("config"), dict):
                    return self.reply(400, b'{"error":"invalid configuration or VIN"}')
                with http_request(proxy_url + "/api/1/vehicles/fleet_telemetry_config", data, {"Authorization": self.headers["Authorization"], "Content-Type": "application/json"}, context) as response:
                    result = response.read(262145)
                    if len(result) > 262144:
                        raise ValueError("oversized proxy response")
                    self.reply(response.status, result)
            except HTTPError as error:
                # Return only a status, not an arbitrary diagnostic body containing secrets.
                self.reply(error.code, b'{"error":"Tesla rejected configuration"}', error.headers.get("Retry-After"))
                error.close()
            except (ValueError, TypeError, KeyError):
                self.reply(400, b'{"error":"invalid configuration"}')
            except (OSError, URLError):
                self.reply(502, b'{"error":"command proxy unavailable"}')
    return Gateway


def main():
    import paho.mqtt.client as mqtt
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    allowed = {vin.strip() for vin in os.environ.get("ALLOWED_VINS", "").split(",") if vin.strip()}
    if any(not VIN.fullmatch(v) for v in allowed):
        raise ValueError("Set ALLOWED_VINS to your vehicle VINs")
    token, secret = os.environ["INGEST_TOKEN"], os.environ["TELEMETRY_PROXY_TOKEN"]
    if min(len(token), len(secret)) < 32:
        raise ValueError("Receiver secrets must each contain at least 32 characters")
    url = os.environ["APP_INGEST_URL"]
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.path != "/api/ingest" or parsed.query or parsed.fragment:
        raise ValueError("APP_INGEST_URL must be the HTTPS ingestion endpoint")
    if not allowed:
        def refresh_vehicles():
            endpoint = urljoin(url, "/api/receiver/vehicles")
            while True:
                try:
                    opener = build_opener(NoRedirect(), HTTPSHandler(context=ssl.create_default_context()))
                    with opener.open(Request(endpoint, headers={"Authorization": f"Bearer {token}", "User-Agent": "TeslaLink/1.0"}), timeout=20) as response:
                        vins = json.load(response).get("vins", [])
                    if not isinstance(vins, list) or any(not isinstance(v, str) or not VIN.fullmatch(v) for v in vins):
                        raise ValueError("invalid vehicle list")
                    allowed.clear()
                    allowed.update(vins)
                except (ValueError, URLError, OSError):
                    LOG.warning("Vehicle allowlist unavailable; will retry")
                time.sleep(60)
        threading.Thread(target=refresh_vehicles, daemon=True).start()
    spool = Spool(os.environ.get("SPOOL_PATH", "/data/spool.sqlite"))
    threading.Thread(target=upload_forever, args=(spool, url, token), daemon=True).start()
    proxy_context = ssl.create_default_context(cafile=os.environ["PROXY_CA_FILE"])
    handler = gateway_handler(secret, allowed, os.environ.get("PROXY_URL", "https://command-proxy:4443"), proxy_context)
    server = ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("GATEWAY_PORT", "8443"))), handler)
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.minimum_version = ssl.TLSVersion.TLSv1_2
    tls.load_cert_chain(os.environ["TLS_CERT"], os.environ["TLS_KEY"])
    server.socket = tls.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=os.environ.get("MQTT_CLIENT_ID", "tesla-link-bridge"), clean_session=False, protocol=mqtt.MQTTv311, manual_ack=True)
    client.reconnect_delay_set(min_delay=1, max_delay=60)
    base = os.environ.get("MQTT_TOPIC_BASE", "tesla")

    def on_connect(client, _userdata, flags, reason, _properties):
        if reason.is_failure:
            LOG.warning("MQTT connection refused")
            return
        if not flags.session_present:
            spool.reset_mqtt_ids()
        client.subscribe(f"{base}/#", qos=1)
        LOG.info("MQTT connected; durable upload queue ready")

    def on_message(client, _userdata, message):
        try:
            if len(message.payload) > 32768:
                raise ValueError("oversized signal")
            event = decode_message(message.topic, message.payload, base, allowed)
        except (ValueError, TypeError, UnicodeError):
            LOG.warning("Rejected malformed or unapproved MQTT record")
            client.ack(message.mid, message.qos)
            return
        digest = hashlib.sha256(message.topic.encode() + b"\x00" + message.payload).hexdigest()
        spool.add(event, message.mid, message.dup, digest)
        client.ack(message.mid, message.qos)  # Commit to disk before acknowledging delivery.

    client.on_connect, client.on_message = on_connect, on_message
    client.connect_async(os.environ.get("MQTT_HOST", "mqtt"), int(os.environ.get("MQTT_PORT", "1883")), 60)
    client.loop_forever(retry_first_connection=True)


if __name__ == "__main__":
    main()
