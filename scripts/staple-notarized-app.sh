#!/usr/bin/env bash
set -euo pipefail

# Apple's ticket service intermittently drops connections with stapler exit 68.
# Keep all signing/notarization checks and fail closed after bounded retries.
for attempt in 1 2 3; do
  if xcrun stapler staple "$1" && xcrun stapler validate "$1"; then
    exit 0
  else
    status=$?
  fi
  if [[ "$status" -ne 68 || "$attempt" -eq 3 ]]; then
    exit "$status"
  fi
  sleep 10
done
