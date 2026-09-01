FROM oven/bun:1
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock* ./
RUN bun install --production --frozen-lockfile

COPY src ./src

RUN mkdir -p /data
VOLUME /data
EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
