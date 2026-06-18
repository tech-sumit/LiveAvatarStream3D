#!/usr/bin/env bash
# Build all GPU service images. Run from repo root context so the shared
# `services/gpu/common` package is in the Docker build context.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

REGISTRY="${REGISTRY:-localhost}"
TAG="${TAG:-dev}"

for svc in avatar-build image-gen voice avatar-video finishing realtime; do
  echo "==> build $svc"
  docker build -f "services/gpu/$svc/Dockerfile" -t "$REGISTRY/las-$svc:$TAG" .
done

echo "Done. Push with: for s in ...; do docker push $REGISTRY/las-\$s:$TAG; done"
