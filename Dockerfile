FROM oven/bun:1.3.11-alpine

WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

EXPOSE 8080
ENTRYPOINT ["/app/docker-entrypoint.sh"]
