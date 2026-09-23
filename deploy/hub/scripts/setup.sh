#!/usr/bin/env bash
# Fills missing .env keys once, then renders config and secrets into gitignored data/run for the containers.
set -euo pipefail
cd "$(dirname "$0")/.."
rand() { openssl rand -hex 32; }
ensure() { grep -q "^$1=" .env || echo "$1=$2" >> .env; }

(umask 077; touch .env)
ensure SERVER_NAME tp301.local
ensure HS_URL http://localhost:8008
ensure CORE_URL http://core:9009
ensure CORE_PORT 9009
for key in CORE_AS_TOKEN CORE_HS_TOKEN EDGE1_AS_TOKEN EDGE1_HS_TOKEN REG_SHARED_SECRET OWNER_PASSWORD; do
  ensure "$key" "$(rand)"
done
set -a; . ./.env; set +a

# The server name is baked into every id in data/db; refuse to render a different one over it.
mkdir -p data/run/appservices data/db data/core
if [ -n "$(ls -A data/db)" ] && [ -f data/server_name ] && [ "$(cat data/server_name)" != "$SERVER_NAME" ]; then
  echo "data/db was created for $(cat data/server_name), not $SERVER_NAME; wipe data/db or restore SERVER_NAME" >&2
  exit 1
fi
printf '%s' "$SERVER_NAME" > data/server_name

export SERVER_NAME_RE; SERVER_NAME_RE=$(printf '%s' "$SERVER_NAME" | sed 's/\./\\\\./g')
envsubst < config/tuwunel.toml.tmpl > data/run/tuwunel.toml
if [ -n "${PUBLIC_BASE_URL:-}" ]; then envsubst < config/tuwunel.remote.toml.tmpl >> data/run/tuwunel.toml; fi
for t in appservices/*.yaml.tmpl; do
  envsubst < "$t" > "data/run/appservices/$(basename "$t" .tmpl)"
done
printf '%s' "$REG_SHARED_SECRET" > data/run/reg_shared_secret
echo "rendered for $SERVER_NAME: tuwunel.toml $(ls data/run/appservices | tr '\n' ' ')"
