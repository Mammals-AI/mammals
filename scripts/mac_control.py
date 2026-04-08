#!/usr/bin/env python3
"""
mac_control — CLI tool for controlling the Mac GUI.
Used by Mammals agents to handle popups, open apps, click buttons, etc.

Usage:
  mac_control screenshot [path]          # Take a screenshot (saves to /tmp/screen.png)
  mac_control click x,y                  # Left click at coordinates
  mac_control rclick x,y                 # Right click
  mac_control dclick x,y                 # Double click
  mac_control move x,y                   # Move mouse
  mac_control type "some text"           # Type text into focused app
  mac_control key escape                 # Press a key (esc, return, space, tab, etc.)
  mac_control shortcut cmd+s             # Press a keyboard shortcut
  mac_control open "App Name"            # Open an application
  mac_control dismiss                    # Dismiss frontmost alert/dialog
  mac_control frontmost                  # Print name of frontmost app
  mac_control script "AppleScript..."   # Run arbitrary AppleScript
  mac_control pos                        # Print current mouse position
"""

import sys
import os
import subprocess
import shlex
import time

CLICLICK = "/opt/homebrew/bin/cliclick"
SCREENCAPTURE = "/usr/sbin/screencapture"
OSASCRIPT = "/usr/bin/osascript"


def run(cmd, capture=True):
    result = subprocess.run(cmd, capture_output=capture, text=True)
    return result.stdout.strip(), result.stderr.strip(), result.returncode


def applescript(script):
    out, err, code = run([OSASCRIPT, "-e", script])
    if code != 0 and err:
        print(f"AppleScript error: {err}", file=sys.stderr)
    return out


def cmd_screenshot(args):
    path = args[0] if args else "/tmp/mac_screen.png"
    out, err, code = run([SCREENCAPTURE, "-x", path], capture=True)
    if code == 0:
        print(f"Screenshot saved to {path}")
    else:
        print(f"Error: {err}", file=sys.stderr)
        sys.exit(1)


def cmd_click(args):
    if not args:
        print("Usage: mac_control click x,y", file=sys.stderr)
        sys.exit(1)
    coords = args[0]
    run([CLICLICK, f"c:{coords}"], capture=False)


def cmd_rclick(args):
    if not args:
        print("Usage: mac_control rclick x,y", file=sys.stderr)
        sys.exit(1)
    coords = args[0]
    run([CLICLICK, f"rc:{coords}"], capture=False)


def cmd_dclick(args):
    if not args:
        print("Usage: mac_control dclick x,y", file=sys.stderr)
        sys.exit(1)
    coords = args[0]
    run([CLICLICK, f"dc:{coords}"], capture=False)


def cmd_move(args):
    if not args:
        print("Usage: mac_control move x,y", file=sys.stderr)
        sys.exit(1)
    coords = args[0]
    run([CLICLICK, f"m:{coords}"], capture=False)


def cmd_type(args):
    if not args:
        print("Usage: mac_control type \"text\"", file=sys.stderr)
        sys.exit(1)
    text = " ".join(args)
    run([CLICLICK, f"t:{text}"], capture=False)


KEY_MAP = {
    "esc": "esc", "escape": "esc",
    "return": "return", "enter": "return",
    "space": "space", "tab": "tab",
    "delete": "delete", "backspace": "delete",
    "up": "arrow-up", "down": "arrow-down",
    "left": "arrow-left", "right": "arrow-right",
    "home": "home", "end": "end",
    "pageup": "page-up", "pagedown": "page-down",
    "f1": "f1", "f2": "f2", "f3": "f3", "f4": "f4",
    "f5": "f5", "f6": "f6", "f7": "f7", "f8": "f8",
}

MODIFIER_MAP = {
    "cmd": "cmd", "command": "cmd",
    "ctrl": "ctrl", "control": "ctrl",
    "alt": "alt", "option": "alt",
    "shift": "shift",
}


def cmd_key(args):
    if not args:
        print("Usage: mac_control key <keyname>", file=sys.stderr)
        sys.exit(1)
    key = args[0].lower()
    mapped = KEY_MAP.get(key, key)
    run([CLICLICK, f"kp:{mapped}"], capture=False)


def cmd_shortcut(args):
    """Handle shortcuts like cmd+s, cmd+shift+t, etc."""
    if not args:
        print("Usage: mac_control shortcut cmd+s", file=sys.stderr)
        sys.exit(1)
    parts = args[0].lower().split("+")
    modifiers = []
    key = None
    for part in parts:
        if part in MODIFIER_MAP:
            modifiers.append(MODIFIER_MAP[part])
        else:
            key = KEY_MAP.get(part, part)

    if not key:
        print(f"No key found in shortcut: {args[0]}", file=sys.stderr)
        sys.exit(1)

    cmds = []
    if modifiers:
        cmds.append(f"kd:{','.join(modifiers)}")
    cmds.append(f"kp:{key}")
    if modifiers:
        cmds.append(f"ku:{','.join(modifiers)}")

    run([CLICLICK] + cmds, capture=False)


def cmd_open(args):
    if not args:
        print("Usage: mac_control open \"App Name\"", file=sys.stderr)
        sys.exit(1)
    app = " ".join(args)
    applescript(f'tell application "{app}" to activate')
    print(f"Opened {app}")


def cmd_dismiss(args):
    """Dismiss the frontmost alert/dialog by clicking OK or pressing Enter."""
    # Try AppleScript to click default button first
    result = applescript('''
        tell application "System Events"
            set frontApp to name of first application process whose frontmost is true
            tell process frontApp
                try
                    click button "OK" of window 1
                    return "dismissed via OK"
                end try
                try
                    click button "Continue" of window 1
                    return "dismissed via Continue"
                end try
                try
                    click button "Allow" of window 1
                    return "dismissed via Allow"
                end try
                try
                    click button "Close" of window 1
                    return "dismissed via Close"
                end try
            end tell
        end tell
    ''')
    if result:
        print(result)
    else:
        # Fall back to pressing Return
        run([CLICLICK, "kp:return"], capture=False)
        print("Dismissed via Return key")


def cmd_frontmost(args):
    result = applescript(
        'tell application "System Events" to get name of first application process whose frontmost is true'
    )
    print(result)


def cmd_script(args):
    if not args:
        print("Usage: mac_control script \"AppleScript...\"", file=sys.stderr)
        sys.exit(1)
    script = " ".join(args)
    result = applescript(script)
    if result:
        print(result)


def cmd_pos(args):
    out, _, _ = run([CLICLICK, "p:."])
    print(out)


COMMANDS = {
    "screenshot": cmd_screenshot,
    "click": cmd_click,
    "rclick": cmd_rclick,
    "dclick": cmd_dclick,
    "move": cmd_move,
    "type": cmd_type,
    "key": cmd_key,
    "shortcut": cmd_shortcut,
    "open": cmd_open,
    "dismiss": cmd_dismiss,
    "frontmost": cmd_frontmost,
    "script": cmd_script,
    "pos": cmd_pos,
}


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print(__doc__)
        sys.exit(0)

    command = sys.argv[1].lower()
    args = sys.argv[2:]

    if command not in COMMANDS:
        print(f"Unknown command: {command}", file=sys.stderr)
        print(f"Available: {', '.join(COMMANDS)}", file=sys.stderr)
        sys.exit(1)

    COMMANDS[command](args)
