#!/bin/sh
# Appends a note to the persistent workspace and reports how many exist.
# Used to verify that the workspace survives runtime replacement.
set -eu
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) g${AGENTOWN_GENERATION} ${ARG_NOTE:-note}" >> /workspace/notes.txt
n=$(wc -l < /workspace/notes.txt | tr -d ' ')
cat /workspace/notes.txt
cp /workspace/notes.txt "$AGENTOWN_OUTPUT_DIR/notes.txt"
echo "SUMMARY: workspace has ${n} notes"
