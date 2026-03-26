FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server.js ./
COPY public ./public

# Writable uploads dir; OpenShift arbitrary UID uses group 0
RUN mkdir -p /app/uploads && chgrp -R 0 /app && chmod -R g=u /app

USER 1001
EXPOSE 3000
CMD ["node", "server.js"]
