FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1 AS app
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Dummy URL only so prisma.config.ts can load during generate
RUN DATABASE_URL="postgresql://x:x@localhost:5432/x" bunx --bun prisma generate
USER bun
EXPOSE 3000
CMD ["bun", "src/index.ts"]
