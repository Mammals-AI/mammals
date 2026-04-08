#!/bin/bash
# ensure-chrome.sh — Ensures Chrome is running with CDP + Claude extension.
#
# Uses a persistent profile at ~/.chrome-claude-profile (required by Chrome for CDP).
# On first run: opens Chrome Web Store to install Claude extension (one-time manual step).
# After that: fully automatic.
#
# Called by: proactive engine (chrome_cdp trigger), or before browser operations.
# Exit codes: 0 = CDP ready, 1 = failed, 2 = needs extension install (first run)

CDP_PORT=9222
CDP_URL="http://localhost:${CDP_PORT}/json/version"
PROFILE_DIR="$HOME/.chrome-claude-profile"
CLAUDE_EXT_ID="fcoeoabgfenejglbffodgkkbkcdhcgfn"
MAX_WAIT=20

check_cdp() {
  code=$(curl -s -o /dev/null -w "%{http_code}" "$CDP_URL" --connect-timeout 2 2>/dev/null)
  [ "$code" = "200" ]
}

check_extension_installed() {
  # Check if Claude extension exists in the persistent profile's Extensions dir
  [ -d "$PROFILE_DIR/Default/Extensions/$CLAUDE_EXT_ID" ]
}

is_our_profile() {
  pgrep -f "user-data-dir=$HOME/.chrome-claude-profile" >/dev/null 2>&1
}

# ─── CDP already working with our profile? ───
if check_cdp && is_our_profile; then
  echo "Chrome CDP ready"
  exit 0
fi

# ─── Kill Chrome if it's running (wrong profile or no CDP) ───
if pgrep -x "Google Chrome" >/dev/null 2>&1; then
  echo "Restarting Chrome with CDP profile..."
  osascript -e 'tell application "Google Chrome" to quit' 2>/dev/null
  sleep 3
  pgrep -x "Google Chrome" >/dev/null && killall "Google Chrome" 2>/dev/null && sleep 2
fi

# ─── Wait for Chrome to fully exit ───
for i in $(seq 1 5); do
  pgrep -x "Google Chrome" >/dev/null 2>&1 || break
  sleep 1
done

# ─── Create profile dir + symlink NativeMessagingHosts ───
mkdir -p "$PROFILE_DIR"
NMH_SRC="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
NMH_DST="$PROFILE_DIR/NativeMessagingHosts"
if [ -d "$NMH_SRC" ] && [ ! -L "$NMH_DST" ]; then
  ln -sf "$NMH_SRC" "$NMH_DST" 2>/dev/null
fi

# ─── Launch Chrome ───
echo "Launching Chrome with CDP on port ${CDP_PORT}..."
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=${CDP_PORT} \
  --remote-allow-origins=* \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  &>/tmp/chrome-launch.log 2>&1 &

# ─── Wait for CDP ───
echo -n "Waiting for CDP"
CDP_READY=false
for i in $(seq 1 $MAX_WAIT); do
  if check_cdp; then
    echo ""
    echo "CDP ready on port ${CDP_PORT}"
    CDP_READY=true
    break
  fi
  echo -n "."
  sleep 1
done

if [ "$CDP_READY" = false ]; then
  echo ""
  echo "ERROR: Chrome didn't start CDP after ${MAX_WAIT}s"
  exit 1
fi

# ─── Check if Claude extension is installed ───
sleep 2
if check_extension_installed; then
  echo "Claude extension present — ready to go"
  exit 0
else
  echo ""
  echo "══════════════════════════════════════════════════"
  echo "  FIRST-TIME SETUP: Install Claude extension"
  echo "══════════════════════════════════════════════════"
  echo ""
  echo "  Opening Chrome Web Store..."
  echo "  Click 'Add to Chrome' to install."
  echo "  Then log into claude.ai in Chrome."
  echo "  This only needs to happen once."
  echo ""

  # Open the extension page
  curl -s "http://localhost:${CDP_PORT}/json/new?https://chromewebstore.google.com/detail/claude/${CLAUDE_EXT_ID}" >/dev/null 2>&1

  exit 2
fi
