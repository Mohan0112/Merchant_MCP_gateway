# syntax=docker/dockerfile:1
# Shared image recipe for every Node service in apps/ (build with --build-arg APP=<app folder>).
# Build stage: install from the lockfile and bundle the app into one file (tsup).
# Runtime stage: distroless Node 24, non-root, no shell or package manager, just the bundle.

FROM node:24-alpine AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true TURBO_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@12.11.2 --activate
WORKDIR /repo

# Download dependencies using only the lockfile, so this layer is cached until dependencies change.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch

COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --offline --frozen-lockfile

ARG APP
RUN test -n "$APP" && pnpm --filter "./apps/${APP}" build

FROM gcr.io/distroless/nodejs24-debian13:nonroot
ARG APP
WORKDIR /app
COPY --from=build /repo/apps/${APP}/dist/ ./
ENV NODE_ENV=production NODE_OPTIONS=--enable-source-maps
EXPOSE 8080
USER 65532:65532
CMD ["server.mjs"]
