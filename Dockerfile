# --- Stage 1: Build Vite / Tailwind Frontend ---
FROM node:20-alpine AS frontend-builder
WORKDIR /app

# Build arguments for frontend compile-time constants
ARG VITE_E621_APP_AUTHOR=anonymous
ARG VITE_APP_ENV=prod
ARG VITE_APP_VERSION="0.4 Alpha"
ARG VITE_DOMAIN=""

ENV VITE_E621_APP_AUTHOR=$VITE_E621_APP_AUTHOR
ENV VITE_APP_ENV=$VITE_APP_ENV
ENV VITE_APP_VERSION=$VITE_APP_VERSION
ENV VITE_DOMAIN=$VITE_DOMAIN

COPY package*.json ./
RUN npm ci

# Copy ONLY what Vite needs for building frontend assets
COPY vite.config.js index.html ./
COPY static/ ./static
COPY templates/ ./templates

RUN npm run build

# --- Stage 2: Production Python Server ---
FROM python:3.11-slim
WORKDIR /app

# Install lightweight Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy Python backend code, static data, & templates
COPY app/ ./app
COPY static/ ./static
COPY templates/ ./templates

# Copy compiled static bundle from Node stage
COPY --from=frontend-builder /app/dist ./dist

EXPOSE 8500
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8500"]
