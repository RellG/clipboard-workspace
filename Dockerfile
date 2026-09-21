# Multi-stage build
FROM node:18-alpine AS backend

WORKDIR /app
COPY package*.json ./
RUN npm install

COPY server.js ./
RUN mkdir -p uploads data

# Frontend stage
FROM nginx:alpine

RUN apk add --no-cache nodejs npm

COPY --from=backend /app /app
WORKDIR /app

COPY index.html /usr/share/nginx/html/
COPY nginx.conf /etc/nginx/nginx.conf

COPY start.sh /start.sh
RUN chmod +x /start.sh

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/api/health | grep -q '"status":"healthy"' || exit 1

CMD ["/start.sh"]
