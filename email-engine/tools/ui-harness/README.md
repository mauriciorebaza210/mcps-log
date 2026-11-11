# Lifecycle page screenshot harness

Renders the real `lifecycle.css` + `js/features/lifecycle*.js` in a fake portal frame, with example data pushed through the real read model (`api/_lib/email-read.js`), so the page can be checked visually without logging in.

```bash
node email-engine/tools/ui-harness/fixture.mjs          # writes fixture.json + harness.html (gitignored)
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; P=$(mktemp -d)
"$CH" --headless=new --user-data-dir=$P --allow-file-access-from-files --hide-scrollbars --window-size=1440,1000 \
  --virtual-time-budget=7000 --screenshot=$PWD/shot.png "file://$PWD/email-engine/tools/ui-harness/harness.html?tab=contacts&batch=1"
```

URL params: `tab=emails|activity|contacts`, `drawer=step:<step_id>` or `drawer=contact:<id>`, `dtab=recipients|setup`, `confirm=1`, `batch=1|later`.
Gotchas: always use a fresh `--user-data-dir` (Chrome caches the CSS otherwise); headless windows can't be narrower than 500 px, so phone width is checked by framing `harness.html` in a 390 px iframe.
