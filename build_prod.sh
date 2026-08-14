#!/usr/bin/env bash
set -e

echo "======================================================="
echo " Building & Deploying P.A.C.K. Production Stack (v0.3 Alpha)"
echo "======================================================="

# Build Vite assets and run container deployment
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build

echo ""
echo "Successfully built and deployed production stack!"