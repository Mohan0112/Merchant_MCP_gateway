# syntax=docker/dockerfile:1
# Dashboard image: Vite builds the React app; nginx (unprivileged, uid 101) serves the static files.
# The gateway is reached on the same host through the Ingress (/api, /mcp), so no API URL is baked in.

FROM node:24-alpine AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@12.11.2 --activate
WORKDIR /repo

# Dependencies from the lockfile only, cached until the lockfile changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch

COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --offline --frozen-lockfile
RUN pnpm --filter ./apps/dashboard build

FROM nginxinc/nginx-unprivileged:1.30.6-alpine
COPY docker/dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/dashboard/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /repo/apps/dashboard/dist/ /usr/share/nginx/html/
EXPOSE 8080
USER 101
