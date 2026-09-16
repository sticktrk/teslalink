# Tesla Link

A small, private Tesla data app with OAuth, encrypted token storage, vehicle discovery, a dashboard, manual snapshots, continuous telemetry ingestion, signal search, battery charts, and NDJSON history export.

The deployed setup runs the app and Tesla receiver on the server, with **Cloudflare D1 for signals, location history, and snapshots**. Nginx serves the web app through Cloudflare orange cloud. The receiver uses direct mutual TLS on a DNS-only hostname. Encrypted OAuth state and login sessions remain in local SQLite; the receiver keeps a durable upload queue. See [the deployment guide](deploy/README.md).

An alternative Cloudflare Worker deployment is also supported below, with account state and history stored in a SQLite Durable Object by default. Continuous streaming always needs the included receiver.

This is a single-owner app: anyone with its app password can see the linked vehicles and their location history. The **Trips** tab automatically groups driving readings into trips, with date navigation, distance/duration/battery summaries, interactive route traces, CSV summaries, and GPX route exports.

## What it collects

| Mode | Coverage | Behavior |
| --- | --- | --- |
| Essentials streaming | 25 core fields | Battery, charging, location, temperature, tires, and vehicle state |
| Complete streaming (default) | 228 documented passenger-vehicle fields | Key driving fields every 10 seconds; most other fields every 60–300 seconds, only when changed |
| High detail streaming | The same broad field coverage | Key driving fields up to once per second; most charging/powertrain fields every 10 seconds |
| Manual snapshot | Every field returned in charge, climate, closures, drive, location, GUI settings, vehicle configuration, and vehicle state | Checks that the car is already online; defaults to one snapshot per 15 minutes and 24 per day, per vehicle |
| Receiver events | Alerts, errors, and connectivity | Stored alongside signal and snapshot history |

The field editor supports custom intervals from 1–3,600 seconds and `minimum_delta`. Null/invalid values and original typed values are preserved. Unknown incoming signal names are accepted and stored, even before the bundled catalog is updated. The catalog selects fields present in both Tesla’s documented data table and its protobuf `Field` enum, excluding deprecated and Semi-only fields from presets. Reviewed September 12, 2026.

Availability depends on your car, hardware, firmware, permissions, and Tesla’s API. Some older Model S/X vehicles do not support telemetry. This app cannot retrieve historical trips from before collection started, camera video, or data Tesla does not expose. Battery charts use five-minute averages; raw event history is retained separately.

## Alternative: deploy the app as a Cloudflare Worker

Prerequisites: Node.js 22.12+ (or a newer supported release), a Cloudflare account, a public HTTPS app domain, and an approved Tesla Fleet API application. Use a custom domain you control for Tesla registration and key pairing.

```bash
cd tesla-link
npm ci
npm run keys
```

`npm run keys` writes these files without printing secrets or overwriting existing keys:

- `.dev.vars`: a random app password, AES encryption key, ingestion/proxy secrets, your public Tesla key, and blank Tesla credentials/hostnames.
- `receiver/.env`: matching receiver secrets.
- `receiver/secrets/private-key.pem`: the private Tesla application key, used only by the command proxy.
- `receiver/secrets/public-key.pem`: the public application key.

Keep the generated private files safe. They are ignored by Git. **Do not change `TOKEN_ENCRYPTION_KEY` after connecting Tesla unless you intend to reconnect:** existing tokens are encrypted with that exact key. Do not replace the Tesla key pair without re-pairing the car.

1. In `wrangler.jsonc`, change `vars.APP_URL` to your final HTTPS origin, for example `https://car.example.com` (no path). Set `TESLA_REGION` to `na` (North America / Asia-Pacific) or `eu` (Europe / Middle East / Africa). China is not implemented.
2. In the Tesla developer portal, configure the matching allowed origin and callback URL: `https://car.example.com/auth/callback`. Enable authorization-code and machine-to-machine access. Select **Vehicle Information** and **Vehicle Location** permissions. The app requests `openid offline_access vehicle_device_data vehicle_location`; it does not request vehicle-control scopes.
3. Add `TESLA_CLIENT_ID` and `TESLA_CLIENT_SECRET` to `.dev.vars`. Other streaming values can remain blank until you install the receiver.
4. Authenticate and deploy:

```bash
npx wrangler login
npm run deploy
```

5. Add the custom domain to this Worker in Cloudflare → Workers & Pages → Tesla Link → Settings → Domains & Routes, or add a custom-domain route to Wrangler. `APP_URL` must match the URL you use. The app fails closed for API requests on a different origin.
6. Add secrets through the Cloudflare dashboard or CLI. For example:

```bash
npx wrangler secret put APP_PASSWORD
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler secret put TESLA_CLIENT_ID
npx wrangler secret put TESLA_CLIENT_SECRET
npx wrangler secret put TESLA_PUBLIC_KEY
```

Paste the generated app password and encryption key from `.dev.vars`; for `TESLA_PUBLIC_KEY`, paste the contents of `receiver/secrets/public-key.pem`. Multiline PEM values and literal `\n` escapes are both supported. Never upload the private key as a public asset or put it in Wrangler's `vars`.

7. Verify `https://car.example.com/.well-known/appspecific/com.tesla.3p.public-key.pem` returns the public key. This route intentionally stays public and supports Tesla’s byte-range check. If you add Cloudflare Access or WAF rules, exclude the public-key route; also allow OAuth callbacks and authenticated receiver ingestion through any additional perimeter rules.
8. Open the app, enter your **app password**, click **Register app**, then **Connect Tesla**. Tesla performs the actual Tesla-account sign-in. Click **Find my vehicles**. You can now take a snapshot while your car is awake.

Cloudflare provisions the SQLite Durable Object automatically on deployment; there is no database ID to create or paste. The project does not deploy itself or touch your existing Cloudflare resources during local verification.

### Environment reference

| Name | Location | Required for |
| --- | --- | --- |
| `APP_URL` | Wrangler `vars` | Exact public app origin; `http://localhost:8787` for local work |
| `APP_PASSWORD` | Secret | App login; at least 24 random characters |
| `TOKEN_ENCRYPTION_KEY` | Secret | 32 random bytes encoded as base64; generated by the script |
| `TESLA_CLIENT_ID`, `TESLA_CLIENT_SECRET` | Secrets | Tesla developer app |
| `TESLA_AUTH_RELAY_URL`, `TESLA_AUTH_RELAY_TOKEN` | Server secrets, optional | Authenticated Cloudflare token exchange for servers blocked by Tesla’s edge; installed in this server deployment |
| `TESLA_PUBLIC_KEY` | Secret or environment value | Public PEM from the generated application key pair |
| `TESLA_REGION` | Wrangler `vars` | `na` or `eu`; register separately if you change region, then reconnect |
| `INGEST_TOKEN` | Secret | At least 32 random characters; same as receiver |
| `TELEMETRY_HOST` | Secret or environment value | DNS-only receiver hostname, e.g. `telemetry.example.com` |
| `TELEMETRY_PORT` | Secret or environment value | Receiver TLS port, normally `443` |
| `TELEMETRY_CA` | Secret | Public CA certificate chain used for the receiver’s TLS certificate; see receiver guide |
| `TELEMETRY_PROXY_URL` | Secret or environment value | Receiver gateway origin, e.g. `https://telemetry.example.com:8443` |
| `TELEMETRY_PROXY_TOKEN` | Secret | Separate 32+ character secret shared with the receiver gateway |
| `RETENTION_DAYS` | Wrangler `vars` | Raw-history retention: `0` = indefinite (default), or 1–365 days |
| `SNAPSHOT_COOLDOWN_SECONDS` | Wrangler `vars` | Minimum snapshot spacing, 60–86,400; default 900 |
| `SNAPSHOT_DAILY_LIMIT` | Wrangler `vars` | Per-vehicle snapshot attempts per UTC day, 1–100; default 24 |

For local development, keep `APP_URL=http://localhost:8787` and run `npm run dev`. Never commit `.dev.vars`. Use the HTTPS deployed origin for the real Tesla onboarding flow; Tesla must be able to fetch your public key.

## Enable streaming

Follow [receiver/README.md](receiver/README.md) to run Tesla’s official receiver plus the included uploader and signing gateway. Then:

1. Set the receiver environment variables listed above in Cloudflare.
2. In the app’s **Collection** tab, open **Pair app key** on your phone with the Tesla app installed. Be near the car and complete Tesla’s key-pairing flow.
3. Click **Check diagnostics**. Verify `key_paired_vins` includes your VIN. Supported older Intel Model S/X vehicles instead use **Allow Third-Party App Data Streaming** in the car’s Safety settings; the app accepts that reported capability without requiring a virtual key.
4. Choose **Complete** for broad coverage, or another preset. Review the fields and click **Enable streaming**.
5. Check diagnostics for `synced: true`. Signals arrive when the car is awake and connected. Unsupported hardware, firmware, keys, or configuration limits are surfaced as failed setup, never as successful collection.

Tesla configurations expire after 30 days in this app. An hourly maintenance alarm checks for renewal during the final seven days, no more than once per vehicle per day. It renews only if a configuration still exists at Tesla and points to this receiver. It never recreates a removed configuration automatically. **Stop streaming** removes the Tesla configuration while preserving already collected data.

## Trip logging

Trips are reconstructed from retained `Gear`, `VehicleSpeed`, `Location`, `Odometer`, `Soc`, and `BatteryLevel` readings when you view a date. No additional Tesla calls or database writes are needed to view trips. Late and out-of-order uploads are included on the next refresh; original records remain unchanged. All built-in presets include these signals (location must stay enabled).

Drive/reverse or observed movement starts a trip. Park ends it. A 15-minute gap in driving evidence marks an incomplete trip instead of inventing a parking time. Stationary parked GPS drift is ignored, impossible jumps are rejected, and route gaps longer than two minutes are drawn as separate segments. Missing gear can be inferred from movement and is labeled. Vehicle speed and odometer use Tesla's miles/mph units; GPS distance is a fallback estimate and excludes missing segments.

The date picker uses your browser's local timezone. Queries include six hours of context on either side to join overnight trips; longer drives at the edge may be partial. Each request examines up to 100,000 relevant readings; an explicit warning appears if that bound is reached. All raw history remains exportable. This first version derives trips from source data rather than storing editable trip records, addresses, or business/personal classifications.

The route view is a private geographic trace with zoom and a time slider, not a street basemap. GPX exports include the retained route points and preserve gaps; the route filter removes tiny GPS movements. CSV exports provide per-trip summaries. Both can contain sensitive driving/location history. The receiver currently timestamps individual signals on receipt, so queued vehicle data may distort inferred trip times after an outage. Real-car validation remains necessary after Tesla onboarding.

## Tesla limits, storage, and costs

Tesla recommends Fleet Telemetry for ongoing collection and says not to poll `vehicle_data` regularly. The dashboard reads its own database; there is no scheduled vehicle-data polling and no wake-up endpoint in this app. Snapshots are manual and limited. All Tesla API work is serialized, refresh-token rotation is serialized, and `429` / temporary server failures pause subsequent requests using `Retry-After` or Tesla reset headers. Timeouts do not trigger an automatic snapshot retry.

**Set a billing limit and payment method in the Tesla developer dashboard before collecting.** Rate limits are not a budget. Complete and High detail can produce many paid signals. The app does not promise a dollar cap or calculate a bill from observed events; Tesla’s portal is authoritative. Exceeding Tesla’s billing limit can remove streaming configuration; after resolving billing, re-enable it manually.

Raw events and snapshots are retained indefinitely by default (`RETENTION_DAYS=0`); automatic history deletion is disabled. An optional positive `RETENTION_DAYS` enables expiry with deletion in bounded batches. Latest signal values and vehicle metadata remain available after history expires. NDJSON exports contain every retained event through the start of the export, streamed in bounded pages. Keep your own exports for a permanent archive. Exported files include VINs and location history.

In the server deployment, history lives in D1 and account state in local SQLite. In the alternative Worker deployment, both live in a Durable Object unless a D1 binding is configured. Check Cloudflare storage/request allowances; high-frequency collection or long retention may require a paid plan. The app identifies its history backend; the displayed local account storage size does not include D1. Storage exhaustion is not a retention policy: monitor usage and add archival storage or migrate history before reaching your plan’s storage limit. Do not change the object name `owner` or remove the migration casually, because doing so can disconnect the app from its existing database.

The receiver uses a persistent MQTT session, disk-backed MQTT data, a local SQLite upload queue, and idempotent event IDs. This tolerates ordinary network outages, but is not an exactly-once guarantee across every hardware failure. MQTT persistence, disk capacity, broker queue limits, and Tesla’s own buffer are finite. Tesla’s MQTT dispatcher omits the original timestamp on individual vehicle signals, so those timestamps are explicitly marked `receiver`; event types that carry Tesla timestamps preserve them as `vehicle`. The raw MQTT values are preserved, not the original protobuf packets.

## Validate

```bash
npm run check
npm test
npm run build
npm run build:server
python3 -m unittest discover -s receiver -p 'test_*.py' -v
```

Tests exercise the real Cloudflare `workerd` runtime with mocked outbound Tesla responses: access protection, OAuth state and token rotation, rate-limit backoff, no-wake behavior, snapshot limits, telemetry idempotency and ordering, exports, and rejected streaming configurations. Python tests cover receiver parsing and persistent queuing. `npm run build` is a Wrangler **dry run**, not a deployment.

Deployment checks cover native server login/status, D1 authenticated write/read/delete, receiver TLS with client-certificate enforcement, and the Docker stack. Live Tesla OAuth, pairing, and actual car streaming still require your Tesla application credentials and account authorization.

## Sources and maintenance

- [Tesla onboarding](https://developer.tesla.com/docs/fleet-api/getting-started/what-is-fleet-api)
- [Tesla OAuth and rotating refresh tokens](https://developer.tesla.com/docs/fleet-api/authentication/third-party-tokens)
- [Tesla API best practices](https://developer.tesla.com/docs/fleet-api/getting-started/best-practices)
- [Tesla billing and rate limits](https://developer.tesla.com/docs/fleet-api/billing-and-limits)
- [Tesla available telemetry data](https://developer.tesla.com/docs/fleet-api/fleet-telemetry/available-data)
- [Tesla Fleet Telemetry reference server](https://github.com/teslamotors/fleet-telemetry)
- [Tesla vehicle-command proxy](https://github.com/teslamotors/vehicle-command)
- [Cloudflare D1](https://developers.cloudflare.com/d1/)
- [Cloudflare SQLite Durable Objects](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Cloudflare Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/)

The receiver pins Tesla Fleet Telemetry `v0.9.4`, vehicle-command `0.4.1`, and paho-mqtt `2.1.0`. Review Tesla’s field catalog, firmware notes, image releases, and API changes before upgrading. The Wrangler/Miniflare versions are pinned in the lockfile so local tests match the deployment tooling.

### Trip street maps

Trips use locally hosted Leaflet 1.9.4 (BSD-2-Clause; license in `public/vendor/leaflet/LICENSE`) and OpenStreetMap standard tiles. No map API key is required. Only visible map tiles are requested, with browser caching, OSM attribution and an origin-only cross-site referrer. The tile service sees the viewer's IP and requested map area; vehicle credentials, VINs and route records are never sent to it. Routes remain usable if tiles fail. No offline tile download or prefetch is implemented. See https://operations.osmfoundation.org/policies/tiles/.
