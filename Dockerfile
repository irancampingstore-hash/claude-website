FROM node:22-slim AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production NODE_NO_WARNINGS=1 HUB_DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN useradd --system --uid 10001 hub && mkdir /data && chown hub /data
USER hub
VOLUME /data
EXPOSE 8787
CMD ["node", "dist/server.js"]
