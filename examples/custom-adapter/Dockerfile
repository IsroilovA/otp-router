FROM node:24-bookworm-slim AS build

WORKDIR /fixture
RUN corepack enable && corepack prepare pnpm@12.5.1 --activate
COPY package.json pnpm-lock.yaml* ./
COPY artifacts/otp-router-0.1.0.tgz /artifacts/otp-router-0.1.0.tgz
RUN pnpm install --no-frozen-lockfile --ignore-scripts
COPY tsconfig.fixture.json ./
COPY src ./src
RUN pnpm exec tsc -p tsconfig.fixture.json

CMD ["node", "dist/smoke.js"]
