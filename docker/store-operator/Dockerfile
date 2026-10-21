# syntax=docker/dockerfile:1
# The store operator (Task 30): the Node bundle, a pinned and checksum-verified Helm binary, and the
# store-instance chart with its dependencies, on distroless. Helm is a static Go binary, so it runs
# without a shell; it uses the pod's service account and keeps its cache in /tmp.

FROM node:24-alpine AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true TURBO_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@12.11.2 --activate
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --offline --frozen-lockfile
RUN pnpm --filter ./apps/store-operator build

FROM alpine:3.22 AS helm
ARG TARGETARCH=amd64
ARG HELM_VERSION=v4.3.1
# Published at https://get.helm.sh/helm-<version>-linux-<arch>.tar.gz.sha256sum
ARG HELM_SHA256_AMD64=0403a88ae20913d11b10a2467b50087721fea7581736da6b9d3992f5357fe54b
ARG HELM_SHA256_ARM64=8cf8f66ecbc252ac8f7f06cca68aba88508ddfde3a6a34feb1678ad1694b4f88
RUN set -eu; \
    case "$TARGETARCH" in amd64) sum="$HELM_SHA256_AMD64" ;; arm64) sum="$HELM_SHA256_ARM64" ;; *) exit 1 ;; esac; \
    wget -q -O /tmp/helm.tgz "https://get.helm.sh/helm-${HELM_VERSION}-linux-${TARGETARCH}.tar.gz"; \
    echo "$sum  /tmp/helm.tgz" | sha256sum -c -; \
    tar -xzf /tmp/helm.tgz -C /tmp; \
    install -m 0755 "/tmp/linux-${TARGETARCH}/helm" /usr/local/bin/helm
# The chart and the two sub-charts it reuses from the platform chart, packaged as its dependencies.
COPY charts/store-instance /charts/store-instance
COPY charts/ahjin/charts/store /charts/ahjin/charts/store
COPY charts/ahjin/charts/mcp-server /charts/ahjin/charts/mcp-server
RUN HELM_CACHE_HOME=/tmp/c HELM_CONFIG_HOME=/tmp/c HELM_DATA_HOME=/tmp/c \
    helm dependency build /charts/store-instance && helm lint /charts/store-instance

FROM gcr.io/distroless/nodejs24-debian13:nonroot
WORKDIR /app
COPY --from=build /repo/apps/store-operator/dist/ ./
COPY --from=helm /usr/local/bin/helm /usr/local/bin/helm
COPY --from=helm /charts/store-instance /app/charts/store-instance
ENV NODE_ENV=production NODE_OPTIONS=--enable-source-maps HELM_BIN=/usr/local/bin/helm
EXPOSE 8080
USER 65532:65532
CMD ["server.mjs"]
