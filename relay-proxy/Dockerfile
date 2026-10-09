FROM node:20-alpine

RUN addgroup -g 1001 -S appuser && adduser -u 1001 -S appuser -G appuser

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js ./

RUN chown -R appuser:appuser /app
USER appuser

EXPOSE 7778

CMD ["node", "index.js"]
