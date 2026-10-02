#!/bin/sh
# Start the built app against a fresh, isolated local workerd state directory.
# The fake Storyteller path avoids Workers AI remote preview and model usage.
set -eu
cd "$(dirname "$0")/.."
review_tmp=$(mktemp -d "${TMPDIR:-/tmp}/mafia-review.XXXXXX")
review_port=${MAFIA_REVIEW_PORT:-5319}
cat > "$review_tmp/wrangler.jsonc" <<EOF
{
  "name": "mafia-review-local",
  "main": "$PWD/src/server/index.ts",
  "compatibility_date": "2025-05-01",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": { "bindings": [{ "name": "GAME_ROOMS", "class_name": "GameRoom" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["GameRoom"] }],
  "assets": {
    "directory": "$PWD/dist/client",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/room/*", "/api/*"]
  },
  "vars": { "STORYTELLER_FAKE": "1", "ALLOW_TEST_SEED": "1", "STORYTELLER_MODEL": "local-fake" }
}
EOF
echo "Local review state: $review_tmp/state"
WRANGLER_SEND_METRICS=false exec ./node_modules/.bin/wrangler dev --local --config "$review_tmp/wrangler.jsonc" --port "$review_port" --persist-to "$review_tmp/state"
