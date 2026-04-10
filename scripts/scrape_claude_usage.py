#!/usr/bin/env python3
"""
Scrape Claude usage data from claude.ai/settings/usage via Chrome CDP.
Saves results to ~/claudeclaw/store/claude_usage.json.
Run via cron every 10 minutes.
"""

import asyncio
import json
import os
import time
import websockets
import urllib.request

CDP_PORT = 9222
USAGE_URL = "https://claude.ai/settings/usage"
OUTPUT_FILE = os.path.expanduser("~/claudeclaw/store/claude_usage.json")

JS_SCRAPE = """
(() => {
  const main = document.querySelector('main');
  if (!main) return JSON.stringify({error: 'no main element'});
  const text = main.innerText;

  // Current session
  const sessionMatch = text.match(/Current session[\\s\\S]*?Resets in ([^\\n]+)[\\s\\S]*?(\\d+)% used/);

  // Weekly all models
  const weeklyAllMatch = text.match(/All models[\\s\\S]*?Resets ([^\\n]+)[\\s\\S]*?(\\d+)% used/);

  // Weekly sonnet only
  const sonnetMatch = text.match(/Sonnet only[\\s\\S]*?Resets ([^\\n]+)[\\s\\S]*?(\\d+)% used/);

  // Extra usage
  const extraMatch = text.match(/\\$([\\.\\d]+) spent/);

  return JSON.stringify({
    session: {
      pct: sessionMatch ? parseInt(sessionMatch[2]) : null,
      resets_in: sessionMatch ? sessionMatch[1].trim() : null
    },
    weekly_all: {
      pct: weeklyAllMatch ? parseInt(weeklyAllMatch[2]) : null,
      resets: weeklyAllMatch ? weeklyAllMatch[1].trim() : null
    },
    weekly_sonnet: {
      pct: sonnetMatch ? parseInt(sonnetMatch[2]) : null,
      resets: sonnetMatch ? sonnetMatch[1].trim() : null
    },
    extra_usage: {
      spent: extraMatch ? extraMatch[1] : null
    },
    scraped_at: Date.now()
  });
})()
"""


async def scrape():
    # Get list of open tabs
    tabs_json = urllib.request.urlopen(f"http://localhost:{CDP_PORT}/json").read()
    tabs = json.loads(tabs_json)

    # Find existing usage tab or pick a suitable one
    usage_tab = None
    for tab in tabs:
        if "claude.ai/settings/usage" in tab.get("url", ""):
            usage_tab = tab
            break

    # If no existing usage tab, create one
    if not usage_tab:
        new_tab_json = urllib.request.urlopen(
            f"http://localhost:{CDP_PORT}/json/new?{USAGE_URL}"
        ).read()
        usage_tab = json.loads(new_tab_json)
        created_tab = True
    else:
        created_tab = False

    ws_url = usage_tab["webSocketDebuggerUrl"]
    msg_id = 1

    async with websockets.connect(ws_url, max_size=10_000_000) as ws:
        async def send_cmd(method, params=None):
            nonlocal msg_id
            cmd = {"id": msg_id, "method": method}
            if params:
                cmd["params"] = params
            await ws.send(json.dumps(cmd))
            while True:
                resp = json.loads(await ws.recv())
                if resp.get("id") == msg_id:
                    msg_id += 1
                    return resp
                # Skip events

        # Navigate to usage page (or reload if already there)
        await send_cmd("Page.navigate", {"url": USAGE_URL})
        # Wait for page load (usage page can be slow)
        await asyncio.sleep(6)

        # Execute scraping JS
        result = await send_cmd("Runtime.evaluate", {"expression": JS_SCRAPE})

        raw = result.get("result", {}).get("result", {}).get("value", "")
        if not raw:
            print(f"ERROR: No value returned. Full result: {json.dumps(result)}")
            return

        data = json.loads(raw)
        if "error" in data:
            print(f"ERROR: {data['error']}")
            return

        # Add server timestamp
        data["updated_at"] = int(time.time())

        # Save to file
        os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
        with open(OUTPUT_FILE, "w") as f:
            json.dump(data, f, indent=2)

        print(f"OK: session={data['session']['pct']}% weekly={data['weekly_all']['pct']}% sonnet={data['weekly_sonnet']['pct']}%")

        # Close the tab if we created it
        if created_tab:
            try:
                urllib.request.urlopen(
                    f"http://localhost:{CDP_PORT}/json/close/{usage_tab['id']}"
                )
            except Exception:
                pass


if __name__ == "__main__":
    asyncio.run(scrape())
