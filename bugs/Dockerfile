FROM node:24-alpine
WORKDIR /app
COPY server.js ./
RUN mkdir -p data && addgroup -g 1001 -S app && adduser -u 1001 -S app -G app && chown -R app:app /app
USER app
EXPOSE 4000
CMD ["node", "server.js"]
