FROM node:24-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
# Next.js's own telemetry ping on startup, not anything floodgate calls.
# Its underlying HTTP client still calls the deprecated url.parse(), which
# otherwise prints a DEP0169 warning in every pod's logs a few seconds
# after boot.
ENV NEXT_TELEMETRY_DISABLED=1

# GitOps mode (WRITE_MODE=gitops) clones/commits/pushes to a git repo
# instead of writing to the K8s API, needing the real git binary (simple-git
# shells out to it) and an SSH client (deploy-key auth to the repo). ~3MB
# added; harmless when WRITE_MODE=direct, since git.ts is never invoked in
# that mode.
RUN apk add --no-cache git openssh-client

COPY --chown=node:node --from=builder /app/.next/standalone ./
COPY --chown=node:node --from=builder /app/.next/static ./.next/static

USER node

EXPOSE 3000
CMD ["node", "server.js"]
