#!/bin/sh
# QA playbook: fetch the input task's artifacts (shared with us explicitly by
# the task creator) and check the page against the requested headline.
set -eu
expect="${ARG_EXPECT_HEADLINE:?EXPECT_HEADLINE required}"
expect_html=$(printf '%s' "$expect" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g')
report="$AGENTOWN_OUTPUT_DIR/qa-report.txt"
fail=0
pass() { echo "PASS $1" | tee -a "$report"; }
flunk() { echo "FAIL $1" | tee -a "$report"; fail=1; }
: > "$report"
[ -n "${AGENTOWN_INPUT_TASK_IDS:-}" ] || flunk "no input tasks to verify"
for id in ${AGENTOWN_INPUT_TASK_IDS:-}; do
  agentown state executing "checking artifacts of $id"
  dir="inputs/$id"
  agentown task artifacts "$id" "$dir"
  page="$dir/index.html"
  if [ ! -s "$page" ]; then flunk "index.html delivered by $id"; continue; fi
  pass "index.html delivered by $id"
  if head -n1 "$page" | grep -qi '<!doctype html>'; then pass "has doctype"; else flunk "has doctype"; fi
  if grep -q '<title>.*</title>' "$page"; then pass "has <title>"; else flunk "has <title>"; fi
  if grep -qF "<h1>${expect_html}</h1>" "$page"; then pass "headline is \"$expect\""; else flunk "headline is \"$expect\""; fi
  if grep -q '</html>' "$page"; then pass "document is closed"; else flunk "document is closed"; fi
done
if [ "$fail" = 0 ]; then
  echo "SUMMARY: QA passed ($(grep -c PASS "$report") checks)"
else
  echo "SUMMARY: QA failed: $(grep FAIL "$report" | head -n3 | tr '\n' ';')"
  exit 1
fi
