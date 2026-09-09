FROM node:20-bookworm-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

FROM node:20-bookworm-slim AS backend
WORKDIR /app/backend

# Build tooling for better-sqlite3 native module.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY backend/package.json ./
RUN npm install --omit=dev
COPY backend/ ./
COPY --from=frontend-build /app/frontend/dist /app/frontend/dist

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000

VOLUME ["/app/backend/data"]

CMD ["node", "src/server.js"]
