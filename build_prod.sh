#!/usr/bin/env bash
set -e

APP_VERSION=$(grep '^APP_VERSION=' .env.prod 2>/dev/null | cut -d= -f2 | tr -d '"' || echo "0.4 Alpha")

echo "======================================================="
echo " Building & Deploying P.A.C.K. Production Stack (v${APP_VERSION})"
echo "======================================================="

# Build Vite assets and run container deployment
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build

echo ""
echo "Successfully built and deployed production stack!"