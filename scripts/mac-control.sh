#!/bin/bash
# mac-control.sh — Mac GUI automation tool for ClaudeClaw
# Usage: mac-control.sh <command> [args...]
#
# Commands:
#   screenshot [file]         — capture screen to file (default: /tmp/screen.png)
#   click <x> <y>             — click at coordinates
#   doubleclick <x> <y>       — double-click at coordinates
#   rightclick <x> <y>        — right-click at coordinates
#   type <text>               — type text into frontmost app
#   key <key>                 — press a key combo (e.g. cmd+w, escape, return, tab)
#   move <x> <y>              — move mouse to coordinates
#   mousepos                  — print current mouse position
#   open <app>                — open an application by name
#   quit <app>                — quit an application
#   frontmost                 — show frontmost app name
#   windows                   — list all visible windows
#   alert <message>           — show a system alert popup
#   dismiss                   — press Escape to dismiss frontmost dialog
#   click-button <text>       — click a button by its label in frontmost dialog
#   notify <title> <message>  — send a macOS notification
#   running                   — list running GUI apps

set -e

CMD="${1:-help}"
shift 2>/dev/null || true

case "$CMD" in

  screenshot)
    FILE="${1:-/tmp/screen.png}"
    /usr/sbin/screencapture -x "$FILE"
    echo "$FILE"
    ;;

  click)
    cliclick "c:${1},${2}"
    ;;

  doubleclick)
    cliclick "dc:${1},${2}"
    ;;

  rightclick)
    cliclick "rc:${1},${2}"
    ;;

  type)
    cliclick "t:${*}"
    ;;

  key)
    # Map common key names to cliclick key: codes
    KEY="$1"
    case "$KEY" in
      escape|esc)     cliclick "kp:esc" ;;
      return|enter)   cliclick "kp:return" ;;
      tab)            cliclick "kp:tab" ;;
      space)          cliclick "kp:space" ;;
      delete|backspace) cliclick "kp:delete" ;;
      fwd-delete)     cliclick "kp:fwd-delete" ;;
      up)             cliclick "kp:arrow-up" ;;
      down)           cliclick "kp:arrow-down" ;;
      left)           cliclick "kp:arrow-left" ;;
      right)          cliclick "kp:arrow-right" ;;
      cmd+*)
        COMBO="${KEY#cmd+}"
        osascript -e "tell application \"System Events\" to keystroke \"$COMBO\" using command down"
        ;;
      cmd+shift+*)
        COMBO="${KEY#cmd+shift+}"
        osascript -e "tell application \"System Events\" to keystroke \"$COMBO\" using {command down, shift down}"
        ;;
      ctrl+*)
        COMBO="${KEY#ctrl+}"
        osascript -e "tell application \"System Events\" to keystroke \"$COMBO\" using control down"
        ;;
      alt+*|opt+*)
        COMBO="${KEY#alt+}"; COMBO="${COMBO#opt+}"
        osascript -e "tell application \"System Events\" to keystroke \"$COMBO\" using option down"
        ;;
      *)              cliclick "kp:$KEY" ;;
    esac
    ;;

  move)
    cliclick "m:${1},${2}"
    ;;

  mousepos)
    cliclick "p:."
    ;;

  open)
    APP_NAME="$*"
    osascript -e "tell application \"$APP_NAME\" to activate"
    echo "Opened $APP_NAME"
    ;;

  quit)
    APP_NAME="$*"
    osascript -e "tell application \"$APP_NAME\" to quit"
    echo "Quit $APP_NAME"
    ;;

  frontmost)
    osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'
    ;;

  windows)
    osascript -e '
      tell application "System Events"
        set output to ""
        repeat with proc in (every application process whose visible is true)
          set appName to name of proc
          try
            repeat with w in (every window of proc)
              set winName to name of w
              set winPos to position of w
              set winSize to size of w
              set output to output & appName & " | " & winName & " | pos:" & (item 1 of winPos) & "," & (item 2 of winPos) & " | size:" & (item 1 of winSize) & "," & (item 2 of winSize) & "\n"
            end repeat
          end try
        end repeat
        return output
      end tell'
    ;;

  alert)
    MSG="$*"
    osascript -e "display dialog \"$MSG\" buttons {\"OK\"} default button \"OK\""
    ;;

  dismiss)
    cliclick "kp:escape"
    echo "Pressed Escape"
    ;;

  click-button)
    BUTTON_TEXT="$*"
    osascript -e "
      tell application \"System Events\"
        tell (first application process whose frontmost is true)
          try
            click button \"$BUTTON_TEXT\" of window 1
          on error
            try
              click button \"$BUTTON_TEXT\" of sheet 1 of window 1
            on error
              click button \"$BUTTON_TEXT\" of (first dialog)
            end try
          end try
        end tell
      end tell"
    echo "Clicked button: $BUTTON_TEXT"
    ;;

  notify)
    TITLE="$1"
    shift
    MSG="$*"
    osascript -e "display notification \"$MSG\" with title \"$TITLE\""
    ;;

  running)
    osascript -e '
      tell application "System Events"
        set appList to name of every application process whose background only is false
        set AppleScript'\''s text item delimiters to "\n"
        return appList as text
      end tell'
    ;;

  help|*)
    echo "mac-control.sh — Mac GUI automation"
    echo ""
    echo "Commands:"
    echo "  screenshot [file]        — capture screen"
    echo "  click <x> <y>            — click at coordinates"
    echo "  doubleclick <x> <y>      — double-click"
    echo "  rightclick <x> <y>       — right-click"
    echo "  type <text>              — type text"
    echo "  key <combo>              — press key (escape, return, cmd+w, etc.)"
    echo "  move <x> <y>             — move mouse"
    echo "  mousepos                 — print mouse position"
    echo "  open <app>               — open app"
    echo "  quit <app>               — quit app"
    echo "  frontmost                — show frontmost app"
    echo "  windows                  — list all windows with positions"
    echo "  dismiss                  — press Escape"
    echo "  click-button <text>      — click button by label"
    echo "  notify <title> <msg>     — send notification"
    echo "  running                  — list running GUI apps"
    ;;
esac
