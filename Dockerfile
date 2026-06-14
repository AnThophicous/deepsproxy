FROM node:20-bookworm-slim AS deps

WORKDIR /app
ENV DEEPSPROXY_SKIP_BROWSER_INSTALL=1

COPY package*.json ./
RUN npm ci

FROM deps AS builder

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV PLAYWRIGHT_HEADLESS=true
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV DEEPSPROXY_SKIP_BROWSER_INSTALL=1

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

RUN npx playwright install --with-deps chromium \
  && mkdir -p /app/deepseek_profile \
  && rm -rf /var/lib/apt/lists/*

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const h = process.env.API_KEY ? { Authorization: 'Bearer ' + process.env.API_KEY } : {}; fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health', { headers: h }).then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]
