#!/bin/sh
# Engineer playbook: build a static landing page from arguments.
set -eu
esc() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'; }
title=$(esc "${ARG_TITLE:-Agentown}")
headline=$(esc "${ARG_HEADLINE:-Hello from Agentown}")
body=$(esc "${ARG_BODY:-Built by an agent in its own runtime.}")
agentown state executing "writing index.html"
mkdir -p /workspace/site
cat > /workspace/site/index.html <<HTML
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.5}h1{font-size:2.2rem}</style>
</head>
<body>
<h1>${headline}</h1>
<p>${body}</p>
<footer><small>Built by agent ${AGENTOWN_AGENT_ID} for task ${AGENTOWN_TASK_ID}</small></footer>
</body>
</html>
HTML
cp /workspace/site/index.html "$AGENTOWN_OUTPUT_DIR/index.html"
size=$(wc -c < /workspace/site/index.html | tr -d ' ')
sum=$(sha256sum /workspace/site/index.html | cut -c1-12)
echo "SUMMARY: built index.html (${size} bytes, sha256 ${sum}…)"
