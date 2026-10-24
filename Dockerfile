# syntax=docker/dockerfile:1.7

# Override to pin a digest or use a mirror:  --build-arg NODE_IMAGE=node:22-bookworm-slim@sha256:...
ARG NODE_IMAGE=node:22-bookworm-slim

# --- frontend build -------------------------------------------------------
# The built files are plain JavaScript/CSS, identical on every CPU: build them once on the
# machine doing the build instead of slowly under emulation for each target (amd64, arm64).
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY frontend/ ./
RUN npm run build

# --- backend dependencies (compiler toolchain stays out of the final image)
FROM ${NODE_IMAGE} AS backend-deps
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
# better-sqlite3 ships prebuilt binaries for amd64 and arm64, so normally no compiler is needed.
# Only when none matches (an unusual platform) the toolchain is installed and it is built.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev \
    || ( apt-get update \
         && apt-get install -y --no-install-recommends python3 make g++ \
         && rm -rf /var/lib/apt/lists/* \
         && npm ci --omit=dev )

# --- runtime --------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="HomeVault" \
      org.opencontainers.image.description="Self-hosted home documents, equipment and maintenance manager" \
      org.opencontainers.image.source="https://github.com/Installation-04/HomeVault" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

WORKDIR /app/backend
ENV NODE_ENV=production \
    PORT=4000 \
    HOMEVAULT_VERSION=${VERSION}

COPY --from=backend-deps /app/backend/node_modules ./node_modules
COPY backend/ ./
COPY --from=frontend-build /app/frontend/dist /app/frontend/dist
COPY docker/entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# The code stays root-owned and (with `read_only: true` in compose) immutable at runtime.
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
  && mkdir -p /app/backend/data \
  && chown node:node /app/backend/data

EXPOSE 4000
VOLUME ["/app/backend/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Runs as root just long enough to fix volume ownership, then drops to "node".
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
