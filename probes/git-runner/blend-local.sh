#!/usr/bin/env bash
# Usage: blend-local.sh '<job json without remotes>'  — mimics the Worker: mints tokens, calls the runner.
set -euo pipefail
B=https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/artifacts/namespaces/mycelium-dev
H=https://$CLOUDFLARE_ACCOUNT_ID.artifacts.cloudflare.net/git/mycelium-dev
JOB="$1"; TARGET=$(jq -r .target <<<"$JOB")
REPOS=$(jq -r '[.target] + [.ops[] | (.from // .onto)] | unique | .[]' <<<"$JOB")
REMOTES="[]"
for r in $REPOS; do
  scope=read; [ "$r" = "$TARGET" ] && scope=write
  tok=$(curl -sS -X POST $B/tokens -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" -d "{\"repo\":\"$r\",\"scope\":\"$scope\",\"ttl\":600}" | jq -r .result.plaintext)
  REMOTES=$(jq --arg n "$r" --arg u "$H/$r.git" --arg t "$tok" '. + [{name:$n,url:$u,token:$t}]' <<<"$REMOTES")
done
jq --argjson rem "$REMOTES" '. + {remotes: $rem}' <<<"$JOB" | curl -sS -X POST localhost:8080/run -H "Content-Type: application/json" -d @-
