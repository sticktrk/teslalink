# Continuous Tesla data receiver

This Docker stack runs on a Linux server with a public IP. The app can run on the same server with Cloudflare D1, or as a Cloudflare Worker. The deployed Nginx/port-9443 layout is described in [the server guide](../deploy/README.md); the examples below describe a standalone receiver.

```text
Tesla car -- vehicle mTLS --> Tesla Fleet Telemetry :443
                                    |
                                    v
                           private MQTT broker
                                    |
                                    v
                          Python + SQLite queue -- HTTPS --> Cloudflare /api/ingest

Cloudflare -- HTTPS + gateway secret --> bridge :8443
                                            |
                                            v
                                   private Tesla command proxy
                                            |
                                            v
                                      Tesla Fleet API
```

The public bridge accepts only `/configure`, authenticates a separate gateway secret, restricts VINs, and forwards only the Fleet Telemetry configuration endpoint. Other car commands are not exposed. The Tesla bearer token passes through this trusted receiver to Tesla’s official signing proxy; both TLS hops validate certificates. The MQTT broker and command proxy have no published host ports.

## 1. DNS and certificates

Use a hostname such as `telemetry.example.com` pointing directly to your server. If DNS is managed by Cloudflare, use **DNS only / grey cloud**, with no Cloudflare Tunnel or HTTP reverse proxy in front of port 443. Tesla requires its mutual-TLS session to terminate at the Fleet Telemetry process.

Allow inbound TCP **443** (vehicle telemetry), or your chosen receiver port. The configuration gateway defaults to loopback only; expose it through a TLS reverse proxy, or explicitly set `GATEWAY_BIND=0.0.0.0:8443` and allow inbound TCP **8443**. You will also need outbound HTTPS to Tesla and Cloudflare. Provide a trusted, publicly valid certificate for `telemetry.example.com`, such as one issued with ACME DNS validation. Cloudflare Origin CA certificates are not public Web PKI certificates and are not appropriate here.

Place the certificate files under `receiver/certs/`:

```text
certs/fullchain.pem   # Leaf server certificate followed by intermediates
certs/privkey.pem     # Corresponding TLS private key
certs/ca.pem          # CA certificate chain for Tesla vehicle configuration
```

`ca.pem` is public CA material, **not** a private key or the Tesla application public key. Follow Tesla’s certificate checker to choose and validate the appropriate complete CA chain for your certificate issuer. Run Tesla’s `tools/check_server_cert.sh` against a JSON file containing `hostname`, `port`, and `ca` before configuring the car. Instructions: [Tesla receiver setup](https://github.com/teslamotors/fleet-telemetry#install-steps).

The TLS key/certificate for the public receiver are separate from the Tesla application P-256 key used to sign configuration.

## 2. Prepare the stack

Run `npm run keys` in the parent app directory if you have not already generated the secrets. Copy this receiver directory to your server, including the ignored `secrets/private-key.pem` and `receiver/.env` through a secure channel. Never copy private keys into `public/` or a Git repository.

From the receiver directory:

```bash
cp config.example.json config.json
mkdir -p certs secrets
```

If you did not use `npm run keys`, copy `.env.example` to `.env`, supply strong matching secrets, and generate a P-256 Tesla application key pair following Tesla’s onboarding instructions.

Generate an internal TLS certificate for the private command proxy. The bridge explicitly trusts this certificate and checks the `command-proxy` hostname:

```bash
openssl req -x509 -newkey rsa:3072 -sha256 -nodes \
  -keyout secrets/proxy-key.pem -out secrets/proxy-cert.pem \
  -days 365 -subj '/CN=command-proxy' \
  -addext 'subjectAltName=DNS:command-proxy' \
  -addext 'basicConstraints=critical,CA:TRUE'
chmod 600 .env
# Official Tesla images run as non-root UID/GID 65532.
sudo chown root:65532 secrets certs secrets/*.pem certs/*.pem
sudo chmod 750 secrets certs
sudo chmod 640 secrets/*.pem certs/privkey.pem
sudo chmod 644 certs/fullchain.pem certs/ca.pem
```

Update `.env`:

- `APP_INGEST_URL=https://car.example.com/api/ingest`
- `INGEST_TOKEN`: exactly the Worker’s ingestion secret
- `TELEMETRY_PROXY_TOKEN`: exactly the Worker’s separate gateway secret
- `ALLOWED_VINS`: optional comma-separated VINs. Leave empty to refresh linked vehicle VINs from the authenticated app every minute.
- `TELEMETRY_BIND`: optional host/port, default `0.0.0.0:443`.
- `GATEWAY_BIND`: optional host/port, default `127.0.0.1:8443`.

## 3. Start

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

The stack uses named volumes for MQTT persistence and the bridge’s SQLite queue. Do not run `docker compose down -v` unless you mean to delete queued data. The broker is deliberately reachable only over an internal Docker network. Do not publish port 1883 or connect unrelated containers to that network.

The bridge needs to subscribe at least once before the vehicle starts streaming so its persistent MQTT session exists. Wait for `MQTT connected; durable upload queue ready` in `docker compose logs bridge` before enabling streaming. Tesla’s receiver may restart while MQTT starts; Docker’s restart policy handles this.

Verify that `https://telemetry.example.com:8443/configure` is reachable over valid HTTPS. A POST without the gateway secret must return `401`. Use Tesla’s certificate checker on port 443; a normal HTTPS probe is not a substitute for testing vehicle mutual TLS.

## 4. Configure the Worker

Set these environment values in Cloudflare (or use `wrangler secret put` from the parent app):

```text
INGEST_TOKEN=<same as receiver>
TELEMETRY_HOST=telemetry.example.com
TELEMETRY_PORT=443
TELEMETRY_CA=<contents of certs/ca.pem>
TELEMETRY_PROXY_URL=https://telemetry.example.com:8443
TELEMETRY_PROXY_TOKEN=<same as receiver>
```

Return to the app → Collection → Pair app key → Check diagnostics → Enable streaming. The receiver’s `secrets/private-key.pem` must correspond to the public key hosted by the app and paired with the vehicle. Tesla’s firmware, permissions, billing, and configuration limits still apply.

## Operation

- Renew the public TLS certificate before expiry, then restart `telemetry` and `bridge` so both load the new certificate. If its issuer/CA chain changes, update `TELEMETRY_CA` and reapply streaming in the app.
- Renew `proxy-cert.pem` before its one-year expiry, preserve the SAN, and restart `command-proxy` and `bridge` together. Keep the Tesla application key unchanged.
- Back up both Docker volumes and the app encryption/Tesla keys. Keep the server clock synchronized.
- Watch disk space. MQTT queues up to 100,000 messages / 256 MiB for the offline subscriber; the uploader spools up to 1,000,000 events. These are finite buffers, not an unlimited archive.
- The bridge acknowledges MQTT only after committing to SQLite. It retries Cloudflare failures with backoff and deletes queued data only after a complete acknowledgement. Repeated HTTP 401/403/409 usually means mismatched secrets, unlinked VINs, or a disconnected Tesla account; fix the configuration so the queue can drain.
- A revoked or deleted vehicle can leave its queued records blocking an upload batch. Review and export that queue on the receiver before intentionally removing those records. The app does not silently discard them on a permission error.
- Signal timestamps describe when this bridge received the MQTT record, because Tesla’s MQTT dispatcher omits the original per-signal timestamp. Buffered car data may therefore arrive with a later receiver time. Alerts, errors, and connectivity carry a vehicle time when the payload provides it.
- Future upstream fields, JSON strings, numbers, booleans, nested objects, and null readings are preserved. Unknown VINs and malformed or oversized records are rejected with a generic warning, without logging the private payload.

Tests: `python3 -m unittest -v test_bridge.py`. The Python tests require only the standard library. `paho-mqtt` is installed by the Docker image for runtime use.
