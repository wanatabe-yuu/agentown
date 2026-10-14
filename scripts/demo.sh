#!/usr/bin/env bash
# End-to-end demo against a running server with real agent runtimes:
#   owner goal -> CEO delegates -> leader hires engineer + QA -> engineer builds
#   the page -> QA verifies the engineer's artifact -> owner reviews.
# Nothing here is simulated: every step is a real agent process calling the API
# with its own token. Prints the task tree and the final artifact.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API="${AGENTOWN_API:-http://127.0.0.1:8080}"
TOKEN="${AGENTOWN_OWNER_TOKEN:-$(cat "$ROOT/.agentown/owner-token")}"
HEADLINE="${1:-Agents that ship}"
j() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
api() { curl -fsS -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' "$@"; }

task=$(api -X POST "$API/api/tasks" -d "$(python3 -c "import json,sys; print(json.dumps({
  'title': 'Launch the marketing landing page',
  'description': 'Owner goal: a landing page with our headline, verified by QA.',
  'acceptanceCriteria': 'index.html exists, shows the headline, QA passed',
  'assigneeAgentId': 'ceo',
  'projectId': 'website',
  'spec': {'kind': 'playbook', 'playbook': 'ceo-launch-site', 'args': {'TITLE': 'Agentown', 'HEADLINE': sys.argv[1], 'GOAL': 'Launch the landing page'}},
}))" "$HEADLINE")" | j "d['task']['id']")
echo "owner -> ceo: $task"

deadline=$((SECONDS + ${DEMO_TIMEOUT:-300}))
while :; do
  status=$(api "$API/api/tasks/$task" | j "d['status']")
  [ "$status" = review ] || [ "$status" = failed ] || [ "$status" = "done" ] && break
  [ $SECONDS -gt $deadline ] && { echo "timed out (status $status)"; exit 1; }
  sleep 3
done
echo "ceo task: $status"

echo
echo "task tree:"
api "$API/api/tasks" | python3 -c "
import json, sys
tasks = json.load(sys.stdin)['tasks']
by_parent = {}
for t in tasks: by_parent.setdefault(t['parentTaskId'], []).append(t)
def show(t, depth):
    print('  ' * depth + f\"- {t['title']} [{t['status']}] -> {t['assigneeAgentId']} (by {t['createdBy']}) :: {t['summary'] or ''}\")
    for c in sorted(by_parent.get(t['id'], []), key=lambda x: x['createdAt']): show(c, depth + 1)
root = next(t for t in tasks if t['id'] == '$task')
show(root, 1)
"

build=$(api "$API/api/tasks" | j "next(t['id'] for t in d['tasks'] if t['title']=='Build landing page' and t['status']=='done')")
art=$(api "$API/api/tasks/$build" | j "d['artifacts'][0]['id']")
echo
echo "artifact from $build:"
api "$API/api/artifacts/$art" | head -n 14
[ "$status" = review ] || exit 1
