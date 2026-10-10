#!/bin/bash
#
# Deletes the events of deleted BIES accounts from this relay.
#
# When a member deletes their account, the BIES server takes their pubkey off
# the whitelist and drops a file named after it in /app/data/purge/
# (server/src/services/relayWhitelist.service.ts). For each file, this loop
# deletes every event the pubkey published and the NIP-59 gift wraps
# addressed to it (what NIP-62 asks of a relay), then removes the file. A
# delete that fails leaves the file, so the next pass tries again.

QUEUE=/app/data/purge
STRFRY=(/app/strfry --config=/etc/strfry.conf)

while true; do
    for request in "$QUEUE"/*; do
        [ -f "$request" ] || continue
        pubkey=$(basename "$request")
        # Only a hex pubkey ever goes into a filter.
        if [[ ! "$pubkey" =~ ^[0-9a-f]{64}$ ]]; then
            rm -f -- "$request"
            continue
        fi
        if "${STRFRY[@]}" delete --filter "{\"authors\":[\"$pubkey\"]}" &&
           "${STRFRY[@]}" delete --filter "{\"kinds\":[1059],\"#p\":[\"$pubkey\"]}"; then
            rm -f -- "$request"
            echo "purge-loop: deleted the events of ${pubkey:0:8}..."
        else
            echo "purge-loop: deleting the events of ${pubkey:0:8}... failed; retrying next pass" >&2
        fi
    done
    sleep 10
done
