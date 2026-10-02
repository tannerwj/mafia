#!/bin/sh
# Run the complete test suite against an isolated local Wrangler config.
# The temporary config mirrors the app's DO, assets, and METRICS bindings but
# deliberately omits the production Workers AI binding, so tests never need a
# remote preview credential or a persistent Wrangler state directory.
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
test_tmp=$(mktemp -d "${TMPDIR:-/tmp}/mafia-test.XXXXXX")

cleanup() {
  rm -rf "$test_tmp"
}
trap cleanup EXIT HUP INT TERM

cat > "$test_tmp/wrangler.jsonc" <<EOF
{
  "name": "mafia-game-test-local",
  "main": "$repo_root/src/server/index.ts",
  "compatibility_date": "2025-05-01",
  "compatibility_flags": ["nodejs_compat"],
  "vars": {
    "ALLOW_TEST_SEED": "1",
    "STORYTELLER_FAKE": "1",
    "STORYTELLER_MODEL": "local-fake"
  },
  "durable_objects": {
    "bindings": [
      { "name": "GAME_ROOMS", "class_name": "GameRoom" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["GameRoom"] }
  ],
  "assets": {
    "directory": "$repo_root/dist/client",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/room/*", "/api/*"]
  },
  "analytics_engine_datasets": [
    { "binding": "METRICS", "dataset": "mafia_metrics" }
  ]
}
EOF

cd "$repo_root"
MAFIA_TEST_WRANGLER_CONFIG="$test_tmp/wrangler.jsonc" \
  WRANGLER_SEND_METRICS=false \
  npm test
