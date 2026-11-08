# Debian-based Bun image on purpose: the build stage installs sharp, whose musl
# prebuilds on alpine are a common source of install failures.

# ---------- build the client bundle ----------
FROM oven/bun:1-slim AS build
WORKDIR /app
COPY package.json bun.lock .npmrc ./
RUN bun install --frozen-lockfile
COPY client ./client
COPY shared ./shared
COPY vite.config.ts tsconfig.json ./
RUN bun run build

# ---------- runtime ----------
FROM oven/bun:1-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package.json bun.lock .npmrc ./
RUN bun install --frozen-lockfile --production

COPY server ./server
COPY shared ./shared
COPY data/cards.manifest.json ./data/cards.manifest.json
COPY public/cards ./public/cards
COPY --from=build /app/dist ./dist

# Render supplies PORT; the server falls back to 3000 when run locally
EXPOSE 3000
CMD ["bun", "run", "server/index.ts"]
