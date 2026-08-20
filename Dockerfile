# Single stage on purpose: the server runs TypeScript through tsx, so there is no
# compile artefact to copy between stages, and the image stays simple to reason
# about. The viewer is built at image build time and served by the same process.
FROM node:22-slim

WORKDIR /app

# Dependencies first, so a source change does not re-install them.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Definitions and match records live here. Mount a volume to keep them across
# rebuilds: they are the only state the project has.
ENV ANT_DATA_DIR=/data
ENV ANT_API_PORT=8787
VOLUME /data
EXPOSE 8787

CMD ["npx", "tsx", "server/index.ts"]
