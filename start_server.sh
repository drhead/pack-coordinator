#!/usr/bin/env bash

# Clean up background backend process when script exits or is interrupted
trap 'kill $(jobs -p) 2>/dev/null' EXIT INT TERM

# Dev Backend FastAPI server on port 8501
uvicorn app.main:app --reload --port 8501 &

# Dev Frontend Vite server on port 8623
npm run dev