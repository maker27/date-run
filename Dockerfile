FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
ARG APP_REVISION
RUN printf '%s' "$APP_REVISION" | grep -Eq '^[0-9a-f]{40}$' \
    && [ "$APP_REVISION" != '0000000000000000000000000000000000000000' ] \
    || { echo 'APP_REVISION must be an explicit nonzero 40-character lowercase hexadecimal SHA' >&2; exit 1; }
LABEL org.opencontainers.image.revision=$APP_REVISION
ENV NODE_ENV=production BIND_HOST=0.0.0.0 PORT=3000 APP_REVISION=$APP_REVISION
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./package.json
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=4s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/date-run/health/ready',{headers:{'X-Real-IP':'127.0.0.1'},signal:AbortSignal.timeout(3000)}).then(response=>{if(!response.ok)process.exitCode=1}).catch(()=>{process.exitCode=1})"]
CMD ["node", "dist/server/index.js"]
