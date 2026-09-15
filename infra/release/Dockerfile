FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c

ENV NEXT_TELEMETRY_DISABLED=1 TURBO_TELEMETRY_DISABLED=1
RUN npm install --global pnpm@10.34.9
WORKDIR /app
RUN chown node:node /app
USER node
COPY --chown=node:node . .
RUN --mount=type=cache,target=/home/node/.local/share/pnpm/store,uid=1000,gid=1000 \
    pnpm install --frozen-lockfile && pnpm audit --prod --audit-level high && pnpm build

CMD ["node", "scripts/release/runtime.mjs"]
