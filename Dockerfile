# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: Build the React frontend
# ─────────────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS client-build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.js version.json ./
COPY public/ public/
COPY src/ src/

# In production, API calls go through nginx at the same origin
ENV VITE_API_URL=/api
RUN npm run build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: Build the Express server
# ─────────────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS server-build

RUN apk add --no-cache openssl

WORKDIR /app/server

COPY server/package.json server/package-lock.json ./
RUN npm ci

COPY server/tsconfig.json ./
COPY server/src/ src/
COPY server/prisma/ prisma/

RUN npx prisma generate
RUN npm run build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 3: Production server runtime (non-root)
# ─────────────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS server

RUN apk add --no-cache tini openssl sqlite python3 py3-pip \
    && pip3 install --no-cache-dir --break-system-packages gallery-dl

WORKDIR /app

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

COPY --from=server-build /app/server/dist/ dist/
COPY --from=server-build /app/server/prisma/ prisma/
COPY --from=server-build /app/server/node_modules/.prisma/ node_modules/.prisma/
COPY server/docker-entrypoint.sh docker-entrypoint.sh
COPY version.json /app/version.json

# The compiled server resolves __dirname relative to dist/src/,
# so symlink uploads where the code expects to find them
RUN mkdir -p uploads data dist/uploads \
    && rm -rf dist/uploads \
    && ln -s /app/uploads dist/uploads \
    && chmod +x /app/docker-entrypoint.sh \
    && addgroup -g 1001 -S bies \
    && adduser -u 1001 -S bies -G bies \
    && chown -R bies:bies /app

USER bies

ARG GIT_COMMIT=unknown
ARG GIT_COMMIT_SHORT=unknown
ARG GIT_BRANCH=unknown
ARG GIT_COMMITTED_AT=unknown
ENV NODE_ENV=production
ENV PORT=3001
ENV GIT_COMMIT=$GIT_COMMIT \
    GIT_COMMIT_SHORT=$GIT_COMMIT_SHORT \
    GIT_BRANCH=$GIT_BRANCH \
    GIT_COMMITTED_AT=$GIT_COMMITTED_AT

EXPOSE 3001

# Baselines pre-migration-tracking databases once, then runs
# `prisma migrate deploy` and starts the server (docs/deployment.md)
ENTRYPOINT ["tini", "--"]
CMD ["/app/docker-entrypoint.sh"]

# ─────────────────────────────────────────────────────────────────────────────
# Stage 4: Nginx for static frontend + reverse proxy (non-root)
# ─────────────────────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS nginx

RUN rm /etc/nginx/conf.d/default.conf

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=client-build /app/dist /usr/share/nginx/html
COPY bugs/index.html /usr/share/nginx/html/bugs/index.html

# Run nginx as non-root
RUN chown -R nginx:nginx /usr/share/nginx/html \
    && chown -R nginx:nginx /var/cache/nginx \
    && chown -R nginx:nginx /var/log/nginx \
    && touch /var/run/nginx.pid \
    && chown nginx:nginx /var/run/nginx.pid

USER nginx

EXPOSE 8080
