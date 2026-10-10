#!/bin/bash
#
# The relay, plus the loop that deletes the events of deleted accounts
# (purge-loop.sh). strfry takes over this process, so it still receives the
# container's stop signal, and the loop stops with the container.

/app/purge-loop.sh &
exec /app/strfry relay --config=/etc/strfry.conf
