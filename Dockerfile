FROM node:current-alpine

RUN mkdir -p /app/files/{certs,ca,traefik}/

WORKDIR /app

COPY . /app/

RUN corepack enable pnpm \
    && pnpm install --frozen-lockfile --no-optional

CMD ["pnpm", "start"]