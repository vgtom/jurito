#!/usr/bin/env bash
# Local MinIO for development (S3-compatible storage).
# S3 API only on host port 9000 (console disabled — use minio/mc or mc against localhost:9000).
# Usage: ./setup-minio.sh
set -euo pipefail

NETWORK_NAME="${MINIO_NETWORK:-jurito-minio-net}"
CONTAINER_NAME="${MINIO_CONTAINER_NAME:-jurito-minio}"
MINIO_ROOT_USER="${MINIO_ROOT_USER:-minioadmin}"
MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-minioadmin}"
BUCKET="${MINIO_BUCKET:-documents}"
MINIO_IMAGE="${MINIO_IMAGE:-minio/minio:latest}"
MC_IMAGE="${MC_IMAGE:-minio/mc:latest}"

docker network create "$NETWORK_NAME" 2>/dev/null || true

if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  docker stop "$CONTAINER_NAME" >/dev/null
  docker rm "$CONTAINER_NAME" >/dev/null
fi

docker pull "$MINIO_IMAGE"

docker run -d \
  --name "$CONTAINER_NAME" \
  --network "$NETWORK_NAME" \
  -p 9000:9000 \
  -e "MINIO_ROOT_USER=${MINIO_ROOT_USER}" \
  -e "MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD}" \
  -e "MINIO_BROWSER=off" \
  -v jurito-minio-data:/data \
  "$MINIO_IMAGE" \
  server /data

echo "Waiting for MinIO to accept connections..."
configured=0
for _ in $(seq 1 40); do
  if docker run --rm --network "$NETWORK_NAME" --entrypoint /bin/sh "$MC_IMAGE" -c \
    "mc alias set local http://${CONTAINER_NAME}:9000 '${MINIO_ROOT_USER}' '${MINIO_ROOT_PASSWORD}' && mc ready local && mc mb --ignore-existing local/${BUCKET}" \
    2>/dev/null; then
    configured=1
    break
  fi
  sleep 1
done
if [ "$configured" -ne 1 ]; then
  echo "Timed out: could not reach MinIO or create bucket '${BUCKET}'." >&2
  echo "Check logs: docker logs ${CONTAINER_NAME}" >&2
  exit 1
fi

echo "MinIO is running."
echo "  S3 API:   http://localhost:9000   (set AWS_S3_ENDPOINT=http://127.0.0.1:9000)"
echo "  Bucket:   ${BUCKET}"
echo "  User:     ${MINIO_ROOT_USER}"
echo "  Console:  disabled (MINIO_BROWSER=off) — use mc CLI or your app."
