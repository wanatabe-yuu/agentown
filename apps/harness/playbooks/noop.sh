#!/bin/sh
# Smallest possible playbook: proves claim -> run -> complete end to end.
set -eu
echo "noop: ${ARG_MESSAGE:-hello} (agent ${AGENTOWN_AGENT_ID}, task ${AGENTOWN_TASK_ID})"
echo "SUMMARY: noop done"
