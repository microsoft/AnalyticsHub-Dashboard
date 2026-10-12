# syntax=docker/dockerfile:1

FROM node:25-alpine AS spa-build
WORKDIR /src/fabric-app
COPY ["app/package.json", "app/package-lock.json", "./"]
RUN npm ci
COPY ["app/", "./"]
RUN npm run build

FROM node:25-alpine AS web-deps
WORKDIR /app
COPY ["azure/web/package.json", "azure/web/package-lock.json", "./"]
RUN npm ci --omit=dev

FROM node:25-alpine AS final
ENV NODE_ENV=production \
    PORT=8080 \
    VALUELENS_PUBLIC_DIR=/app/public \
    VALUELENS_ASK_DIR=/app/ask
WORKDIR /app
RUN addgroup -S valuelens && adduser -S valuelens -G valuelens
COPY --from=web-deps /app/node_modules ./node_modules
COPY ["azure/web/package.json", "./package.json"]
COPY ["azure/web/src/", "./src/"]
COPY ["app/src/ask/catalogue.json", "./ask/catalogue.json"]
COPY ["app/src/queries/", "./ask/queries/"]
COPY --from=spa-build /src/fabric-app/dist ./public
USER valuelens
EXPOSE 8080
CMD ["node", "src/server.js"]
