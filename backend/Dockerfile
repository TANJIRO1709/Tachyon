# Tachyon serving layer (Node.js).
#
# The model weights (MiniLM for embeddings, DistilBERT for MODEL_BACKEND=hf)
# are downloaded from the public HuggingFace Hub at BUILD time and baked into
# the image, so the container starts and serves with no network access.
# Set --build-arg WITH_MODELS=false for a small image that runs with
# EMBEDDER=hash and the stub backend only.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM build AS models
ARG WITH_MODELS=true
# The embedder is always needed. The real inference model is only used with
# MODEL_BACKEND=hf, so a stub deployment skips its ~260 MB download.
ARG PREFETCH_HF_MODEL=false
ARG EMBEDDER_DTYPE=fp32
ENV TRANSFORMERS_CACHE=/app/models \
    PREFETCH_HF_MODEL=$PREFETCH_HF_MODEL \
    EMBEDDER_DTYPE=$EMBEDDER_DTYPE
RUN mkdir -p /app/models && if [ "$WITH_MODELS" = "true" ]; then node dist/src/prefetch.js; fi

FROM node:22-slim AS run
WORKDIR /app
ARG EMBEDDER_DTYPE=fp32
ENV NODE_ENV=production \
    TRANSFORMERS_CACHE=/app/models \
    HF_HUB_OFFLINE=1 \
    EMBEDDER=minilm \
    EMBEDDER_DTYPE=$EMBEDDER_DTYPE \
    MODEL_BACKEND=stub \
    HOST=0.0.0.0 \
    PORT=8000
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=models --chown=node:node /app/models ./models
USER node
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# One process on purpose: the batch queue and the cache must be shared by
# every request. Scale with replicas, not cluster workers.
CMD ["node", "dist/src/server.js"]
