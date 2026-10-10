FROM dockurr/strfry:1.1.3@sha256:599ab3500dbfbe6cb78c668e1892cd9802c192d066df4660e8e3175034a8344d

# Install jq for the write policy script
RUN apk add --no-cache jq

# Copy config, write policy, and the loop that deletes deleted accounts' events
COPY strfry.conf /etc/strfry.conf
COPY write-policy.sh /app/write-policy.sh
COPY purge-loop.sh start.sh /app/
RUN chmod +x /app/write-policy.sh /app/purge-loop.sh /app/start.sh

# Create data directories and non-root user
RUN mkdir -p /app/strfry-db /app/data && \
    addgroup -g 1001 relay && adduser -u 1001 -G relay -s /bin/sh -D relay && \
    chown -R relay:relay /app/strfry-db /app/data /app/write-policy.sh

USER relay

EXPOSE 7777

CMD ["/app/start.sh"]
