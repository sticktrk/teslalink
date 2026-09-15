# Server deployment with Cloudflare D1

## Installed layout

- App: `https://tesla.dtconcepts.net`, Nginx → loopback `8788`, systemd `tesla-link`.
- Source: `/var/www/tesla`, GitHub `sticktrk/teslalink`.
- History: D1 `teslalink-production`, accessed through an authenticated storage Worker. `wrangler.storage.jsonc` contains the binding; `migrations/` contains the schema.
- Tesla receiver: `tesla-receiver.dtconcepts.net:9443`, DNS-only, with vehicle mutual TLS. Do not orange-cloud this hostname.
- Configure-only gateway: Nginx `/configure` → TLS loopback `8443`; separate secret plus Tesla bearer authentication required.
- Account state: `data/tesla.sqlite`, owned by the unprivileged `tesla` service user. Daily SQLite backups retain seven copies in `backups/`. These backups do not include D1, secrets, or the receiver queue.
- Receiver MQTT and retry queue: Docker named volumes. Do not use `docker compose down -v` unless intentionally deleting queued data.

Orange-cloud `tesla.dtconcepts.net` and use Cloudflare **Full (strict)** TLS. A hostname-specific Configuration Rule named `Tesla dashboard strict TLS` enforces Strict mode for this app without changing other domains. The existing server firewall permits web traffic only from Cloudflare. Exclude the Tesla public-key URL from additional authentication/challenges; permit OAuth callbacks and authenticated ingestion/configuration. The app disables caching of private responses.

## Finish Tesla setup

1. Edit `/var/www/tesla/.env` and fill `TESLA_CLIENT_ID` and `TESLA_CLIENT_SECRET`. Set `TESLA_REGION` appropriately (`na` or `eu`). Preserve all generated secrets and keys.
2. In Tesla's developer portal, set allowed origin `https://tesla.dtconcepts.net` and callback `https://tesla.dtconcepts.net/auth/callback`. Enable authorization-code and machine-to-machine grants, Vehicle Information and Vehicle Location permissions. Configure Tesla billing and its spending limit.
3. Run `systemctl restart tesla-link`.
4. Read the app password from `/var/www/tesla/deployment-access.txt`. Sign in, register the app, connect Tesla, and discover vehicles.
5. Pair the app key through the Tesla mobile app, run diagnostics, then enable your desired streaming preset. The receiver automatically refreshes its vehicle allowlist every minute.

History is retained indefinitely (`RETENTION_DAYS=0`), with no automatic deletion of telemetry or snapshots. Positive values of 1–365 enable optional expiry. D1 capacity is finite, so growing beyond its limits requires archival storage or database partitioning; indefinite retention does not mean unlimited storage. High-detail collection consumes more Tesla signals and D1 writes. The Trips tab reconstructs trips and displays route traces from stored location and driving signals. See the root README for inference rules and limits.

## Operations

```sh
cd /var/www/tesla
systemctl status tesla-link
journalctl -u tesla-link -n 50
docker compose -f receiver/compose.yaml --env-file receiver/.env ps
sudo sh deploy/update.sh
```

`update.sh` pulls main, installs locked dependencies, checks types/tests, builds the app, backs up local account state, and restarts app/receiver. Apply schema migrations before deploying code that needs them. Review Nginx/systemd changes separately before copying them into `/etc`.

The service uses `/opt/tesla-link/bin/node`, an executable outside root's private home, and Node's SQLite API (Node 24+ required). Update this runtime deliberately with a supported Node release. `npm` must also be available for source builds.

For D1 changes, use an authenticated Cloudflare workstation:

```sh
npx wrangler d1 migrations apply teslalink-production --remote --config wrangler.storage.jsonc
npx wrangler deploy --config wrangler.storage.jsonc
```

Tesla token exchanges use the same authenticated Cloudflare gateway at `/oauth/token`, configured through `TESLA_AUTH_RELAY_URL` and `TESLA_AUTH_RELAY_TOKEN`. This handles Tesla edge denials from the server network. Only the official Tesla token endpoint is reachable; grants, audience, scopes, and the callback URL are restricted. Credentials and tokens stay server-side and are not logged. Ordinary Fleet API calls and the vehicle receiver remain on the server.

The server `.env` uses `STORAGE_API_URL` and `STORAGE_API_TOKEN`. This token matches the storage Worker's `STORAGE_TOKEN` secret. It grants access to this database gateway; no Cloudflare account token is placed on the server. The OAuth relay token also matches this gateway secret; rotate all three together. Never expose the token to browser code.

TLS certificates renew through Certbot. The renewal pre/post hooks briefly permit HTTP validation through the existing firewall and then remove that temporary rule. The deploy hook copies renewed certificates to the receiver and reloads Nginx/restarts TLS services. Certificate/private-key group access is restricted to the official containers' UID/GID 65532; do not make private keys world-readable.

Back up `.env`, Tesla private keys, and receiver volumes securely in addition to database backups. Losing the token-encryption key requires reconnecting Tesla; losing the Tesla application key requires pairing a replacement key. Keep D1 exports separately for disaster recovery. Local backups on the same disk do not protect against server loss.

## Bootstrap reference

The `deploy/` templates target this hostname/layout. For a fresh server: create the `tesla` user and writable `data/` directory, install Node outside `/root`, install dependencies/build, generate keys with `npm run keys`, create the D1 database/migrations/storage Worker and shared secret, issue the web/receiver certificate, then run `configure-server.py`. That script preserves existing credentials but sets this deployment's hostnames. Install the service, backup timer, Nginx site, and certificate renewal hooks. Generate the command proxy's internal TLS certificate with SAN `command-proxy` before starting Compose. See `receiver/README.md` for receiver details.
