# Image size ~ 400MB
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./

RUN apk add --no-cache --virtual .gyp \
        python3 \
        make \
        g++ \
    && apk add --no-cache git \
    && npm ci

COPY . .

RUN npm run build && apk del .gyp

FROM node:22-alpine AS deploy

WORKDIR /app

ARG PORT
ENV PORT=$PORT
EXPOSE $PORT

COPY package.json package-lock.json ./
COPY --from=builder /app/assets ./assets
COPY --from=builder /app/dist ./dist

RUN npm ci --omit=dev --ignore-scripts \
    && addgroup -g 1001 -S nodejs && adduser -S -u 1001 nodejs \
    && chown -R nodejs:nodejs /app

USER nodejs

CMD ["npm", "start"]
