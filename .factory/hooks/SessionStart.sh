#!/bin/sh
# Sample SessionStart hook. Receives {event, payload} JSON on stdin and
# returns a JSON object on stdout. The optional `notice` field is surfaced
# to the user as an info message at session start.
#
# To customize: edit this file. To disable: delete it. To extend: add
# sibling files named after the other events — UserPromptSubmit.sh,
# PreToolUse.sh, PostToolUse.sh, PreCompact.sh, SessionEnd.sh.
read -r input
echo '{"notice": "hooks active"}'
