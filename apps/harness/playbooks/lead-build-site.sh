#!/bin/sh
# Leader playbook: hire (idempotently) an engineer and a QA under me, have the
# engineer build the page, then have QA verify the engineer's artifact.
set -eu
agentown state executing "hiring team"
eng=$(agentown spawn --template "${ARG_ENGINEER_TEMPLATE:-engineer-v1}" --name "${ARG_ENGINEER_NAME:-Eli}" --key site-engineer)
qa=$(agentown spawn --template qa-v1 --name "${ARG_QA_NAME:-Quinn}" --key site-qa)
echo "team: engineer=${eng} qa=${qa}"
build=$(agentown task create --to "$eng" --title "Build landing page" \
  --criteria "index.html with the given title and headline" \
  --playbook build-page --arg TITLE="${ARG_TITLE:-Agentown}" --arg HEADLINE="${ARG_HEADLINE:-Hello}" \
  --key "${AGENTOWN_TASK_ID}-build")
echo "build task: ${build}"
agentown task wait "$build" --timeout 900
qa_task=$(agentown task create --to "$qa" --title "Verify landing page" \
  --criteria "page exists and shows the requested headline" \
  --playbook qa-page --arg EXPECT_HEADLINE="${ARG_HEADLINE:-Hello}" --input "$build" \
  --key "${AGENTOWN_TASK_ID}-qa")
echo "qa task: ${qa_task}"
if agentown task wait "$qa_task" --timeout 900; then
  echo "SUMMARY: page built (${build}) and verified by QA (${qa_task})"
else
  echo "SUMMARY: QA did not pass (${qa_task})"
  exit 1
fi
