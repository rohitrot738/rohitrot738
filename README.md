# Suffer Sathi

A companion for train journeys: an Android app that follows your trip with the phone's GPS and writes down the time at every station on the way — where the train stopped, for how long, and which stations it passed without stopping.

The app works without internet: the station and route data ship inside the APK. Internet is only used to look for a new version.

## Install

The latest signed APK is always here:

**[Download the latest Suffer Sathi](https://github.com/rohitrot738/rohitrot738/releases/tag/suffer-sathi-updates)**

Install the file named in the release notes (`Suffer-Sathi-<version>.apk`). Once installed, the app tells you about new versions and downloads and installs them from inside the app; Android asks you to confirm each time.

## What it does

- **Journey log:** for every station, either a halt (arrival time, departure time, duration) or a pass (the time it went by). Halts are marked amber and passes green. Each entry also says how close the train came to the station's listed position.
- **How a station is found:** a station is watched from 1 km away, and how close the train came is measured in rings of 1 km, 750 m, 500 m, 250 m and 100 m. One passed within 250 m is certain and is written as soon as the train is 250 m past it. One that only reached a wider ring (its listed position is off) is written after the train has left the 1 km zone, unless another station in range at the same time was reached at a smaller ring. The train counts as stopping below 5 km/h, and a stop of 15 seconds or more is a halt; it moves off again at 2.7 km/h once it has stood still (below 2.7 km/h), or at 5 km/h if it only crawled.
- **Stops between stations:** when the train stands for 15 seconds or more away from any station, that is logged too, named by the nearest station.
- **Route:** a start station, an end station and up to three optional "via" stations. Stations can be found by name or code; renamed codes such as DDU and PRYJ work as well, and a typed code is shown with its station's name once the route is built. Changing the start station empties the via boxes. The route lists every station, halt and cabin of the line that the data knows, including the ones a fast train's link passes by.
- **Choose what is logged:** after a route is built, its stations are listed with a tick each. Untick the ones you do not want logged, and add any station the route missed. After "Save karein" the choice is kept even when the app is closed.
- **Next station:** from the route when you are on it (unticked stations are skipped), otherwise an estimate from the direction of travel.
- **Speed:** in a round dial, in km/h.
- **Clock:** date and time with seconds; one button turns it into a large full-screen clock that also shows the speed and hides the phone's status bar and buttons. The colour of the time can be picked from ten colours.
- **CSV:** the whole log can be exported as a CSV file.

## Logging with the screen off

While tracking, the app keeps every location fix on the native side as well. If Android pauses the app's screen while it is off or minimised, the missed fixes are read back when the screen returns and the log is filled in with the real times. That only works while Android keeps the app itself alive, so three phone settings are needed:

When a journey starts the app asks for the first two itself, and while tracking it shows a line saying which of the three is still missing.

1. Location permission: **Allow all the time**.
2. Battery: **Unrestricted** for Suffer Sathi.
3. Notifications: on. While tracking, the notification "Station pass aur halt record ho rahe hain" should stay visible.

## Good to know

- The route is the shortest path, not your train's actual route. If the train takes another line, add a via station; otherwise the app falls back to the estimate from the direction of travel.
- Station positions and names come from open data and can be out of date or slightly wrong in places, so the log can be wrong too.
- This is not an official railway app. It has no timetable, live train status or ticket information.

## What is in this repository

| Path | Contents |
| --- | --- |
| `safar/` | The app's screen (`index.html`), its tests (`test.cjs`) and the station and route data |
| `android/` | The Android shell (Capacitor) and the in-app update code |
| `irsd/osm/` | Scripts that build station and track data from OpenStreetMap |
| `loader_pipeline.py`, `indian_railways_complete.db` | The source data for the station catalog and the script that builds it |
| `scripts/build_www.sh` | Gathers the app's files for the APK |
| `scripts/android_e2e.mjs` | Runs the debug APK on an emulator and checks the app from inside its page |
| `.github/workflows/` | Workflows that build, test and release the APK |

## Build and test

```sh
node safar/test.cjs        # the app's tests
sh scripts/build_www.sh    # gather the web files into www/
npm ci && npx cap sync android
cd android && ./gradlew assembleDebug testDebugUnitTest
```

Every pull request also runs the debug APK on an Android emulator (`node scripts/android_e2e.mjs path/to/app-debug.apk`): it checks that the page reaches the native side of the app, that a journey keeps being recorded with the screen off, that the full-screen clock hides the phone's bars and fills the screen at any font-size setting, and that a route has its stations. Its screenshots are in the run's `app-test-screenshots` artifact.

The page is not built with Capacitor's script, so `Capacitor.registerPlugin` does not exist in it; native plugins are reached through `Capacitor.Plugins` (`nativePlugin()` in `safar/index.html`).

After every change on `main`, GitHub Actions builds a signed APK, installs it over the previous version on an emulator and launches it, and publishes it to the update release when that passes. Signing and updates are described in [`safar/README.md`](safar/README.md).

## Data credits

- Station catalog: derived from DataMeet (CC0).
- Track and many stations: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), ODbL 1.0.
