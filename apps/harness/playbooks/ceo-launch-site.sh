#!/bin/sh
# CEO playbook: turn the owner's goal into work for a leader, then wait.
set -eu
leader="${ARG_LEADER:-lead-eng}"
echo "goal: ${ARG_GOAL:-launch the landing page}"
t=$(agentown task create --to "$leader" --title "Ship landing page: ${ARG_TITLE:-Agentown}" \
  --desc "${ARG_GOAL:-Launch the landing page}" --project website \
  --playbook lead-build-site --arg TITLE="${ARG_TITLE:-Agentown}" --arg HEADLINE="${ARG_HEADLINE:-Hello}" \
  --key "${AGENTOWN_TASK_ID}-lead")
echo "delegated to ${leader}: ${t}"
if agentown task wait "$t" --timeout 1800; then
  echo "SUMMARY: ${leader} delivered (${t}); ready for owner review"
else
  echo "SUMMARY: delegated work did not finish (${t})"
  exit 1
fi
