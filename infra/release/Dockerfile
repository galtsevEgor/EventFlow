FROM node:24.22.1-bookworm@sha256:d862bb5d082c5ae0210ac07e8c0344cb8cf7bef6d78e9b8c50c179da923108ea

ENV NEXT_TELEMETRY_DISABLED=1 TURBO_TELEMETRY_DISABLED=1
RUN npm install --global pnpm@10.34.9
WORKDIR /app
RUN chown node:node /app
USER node
COPY --chown=node:node . .
RUN --mount=type=cache,target=/home/node/.local/share/pnpm/store,uid=1000,gid=1000 \
    pnpm install --frozen-lockfile && pnpm audit --prod --audit-level high && pnpm build

CMD ["node", "scripts/release/runtime.mjs"]
