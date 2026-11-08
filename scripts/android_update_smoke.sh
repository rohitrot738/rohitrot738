#!/usr/bin/env bash
set -euo pipefail

package=com.railtrack.app
old_apk="$RUNNER_TEMP/previous-sathi.apk"
new_apk="$GITHUB_WORKSPACE/android/app/build/outputs/apk/release/app-release.apk"

notes="$(gh release view suffer-sathi-updates --json body --jq .body)"
previous="$(printf '%s\n' "$notes" | sed -n 's/^versionCode: \([0-9][0-9]*\)$/\1/p')"
if [[ ! "$previous" =~ ^[0-9]+$ ]]; then
  echo "Current release has no valid version code"
  exit 1
fi
gh release download suffer-sathi-updates --pattern "Suffer-Sathi-$previous.apk" --output "$old_apk"
adb wait-for-device
adb install "$old_apk"
if [[ "$previous" == 100037 ]]; then
  adb logcat -c
  adb shell am start -W -n "$package/.MainActivity" || true
  sleep 5
  adb logcat -d -s AndroidRuntime:E | grep -A 15 'FATAL EXCEPTION' || true
fi
adb install -r "$new_apk"
adb shell pm grant "$package" android.permission.POST_NOTIFICATIONS
adb logcat -c
adb shell am start -W -n "$package/.MainActivity"
sleep 15
if ! adb shell pidof "$package" >/dev/null; then
  echo "App exited after launch"
  adb logcat -d -s AndroidRuntime:E SathiUpdate:E
  exit 1
fi
if ! adb shell dumpsys activity activities | grep -E '(mResumedActivity|topResumedActivity).*com\.railtrack\.app/.MainActivity'; then
  echo "Main activity is not in the foreground"
  adb shell dumpsys activity activities | grep -i 'resumed' || true
  exit 1
fi
if adb logcat -d -s AndroidRuntime:E SathiUpdate:E | grep -E 'FATAL EXCEPTION|Could not schedule|schedule nahi ho saka'; then
  echo "App or update scheduler failed"
  exit 1
fi
if ! adb shell dumpsys jobscheduler "$package" | grep -q '73418'; then
  echo "Update check job was not scheduled"
  exit 1
fi
