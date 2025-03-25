FROM node:current-alpine

RUN mkdir -p /app/files/certs /app/files/ca /app/files/traefik

WORKDIR /app

COPY . /app/

RUN corepack enable pnpm \
    && pnpm install --frozen-lockfile --no-optional

CMD ["pnpm", "start"]