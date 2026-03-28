#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
docker compose -f docker-compose.mailhog.yml up -d
echo "MailHog is up. Web UI: http://localhost:8025  SMTP: localhost:1025"
