# syntax=docker/dockerfile:1

FROM node:24-slim AS build
WORKDIR /app

COPY package.json ./

RUN npm i

COPY . .

RUN npm run ingest && npm run build

RUN npm prune --omit=dev \
    && rm -rf node_modules/onnxruntime-node/bin/napi-v6/darwin \
    node_modules/onnxruntime-node/bin/napi-v6/win32 \
    && find node_modules/onnxruntime-node -name 'libonnxruntime_providers_cuda.so' -delete \
    && find node_modules/onnxruntime-node -name 'libonnxruntime_providers_tensorrt.so' -delete

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/data ./data
COPY --from=build --chown=node:node /app/mcp-servers ./mcp-servers
COPY --from=build --chown=node:node /app/package.json /app/next.config.ts /app/README.md ./

USER node
EXPOSE 3000

# Bound to every interface so the port is reachable from outside the container.
CMD ["npx", "next", "start", "-H", "0.0.0.0", "-p", "3000"]
