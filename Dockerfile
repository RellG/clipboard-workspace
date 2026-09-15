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

RUN echo '#!/bin/sh' > /start.sh &&     echo 'mkdir -p /app/uploads /app/data' >> /start.sh &&     echo 'cd /app && node server.js &' >> /start.sh &&     echo 'nginx -g "daemon off;"' >> /start.sh &&     chmod +x /start.sh

EXPOSE 80 3000

CMD ["/start.sh"]
