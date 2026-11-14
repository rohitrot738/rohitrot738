# Suffer Sathi

A companion for train journeys: an Android app that follows your trip with the phone's GPS and writes down the time at every station on the way — where the train stopped, for how long, and which stations it passed without stopping.

The app works without internet: the station and route data ship inside the APK. Internet is only used to look for a new version.

## Install

The latest signed APK is always here:

**[Download the latest Suffer Sathi](https://github.com/rohitrot738/rohitrot738/releases/tag/suffer-sathi-updates)**

Install the file named in the release notes (`Suffer-Sathi-<version>.apk`). Once installed, the app tells you about new versions and downloads and installs them from inside the app; Android asks you to confirm each time.

## What it does

Everything the app shows is in English: the page, its messages, and Android's dialogs and notifications from the app.

- **Journey log:** for every station, either a halt (arrival time, departure time, duration) or a pass (the time it went by). Halts are marked amber and passes green. Each entry also says how close the train came to the station's listed position.
- **How a station is found:** a station is watched from 1 km away, and how close the train came is measured in rings of 1 km, 750 m, 500 m, 250 m and 100 m. One passed within 250 m is certain and is written as soon as the train is 250 m past it. One that only reached a wider ring (its listed position is off) is written after the train has left the 1 km zone, unless another station in range at the same time was reached at a smaller ring. The train counts as stopping below 5 km/h, and a stop of 15 seconds or more is a halt; it moves off again at 2.7 km/h once it has stood still (below 2.7 km/h), or at 5 km/h if it only crawled.
- **Stops between stations:** when the train stands for 15 seconds or more away from any station, that is logged too, named by the nearest station.
- **Route first:** the app opens on its own route screen. The clock, tracking and the log (the main screen) open once a route is found; there the route shows only as its list of stations. A saved route, or a journey that was going on, opens the main screen straight away. "Remove route" goes back to the route screen and keeps the log; "Clear log" (after Stop) deletes the log and the route and starts again from an empty route screen.
- **Route:** a start station, an end station and up to three optional "via" stations. Stations can be found by name or code; renamed codes such as DDU and PRYJ work as well, and a typed code is shown with its station's name once the route is built. Changing the start station empties the via boxes. The route lists every station, halt and cabin of the line that the data knows, including the ones a fast train's link passes by.
- **Choose what is logged:** after a route is built, its stations are listed with a tick each. Untick the ones you do not want logged, and add any station the route missed. After "Save" the choice is kept even when the app is closed.
- **Next station:** from the route when you are on it (unticked stations are skipped), otherwise an estimate from the direction of travel.
- **Speed:** in a round dial, in km/h.
- **Clock:** date and time with seconds; one button turns it into a large full-screen clock that also shows the speed and hides the phone's status bar and buttons. The colour of the time can be picked from ten colours.
- **Next station and journey log in the full-screen clock:** under the date, one line shows the next station and how far it is (as on the main screen, in short), and one line shows the journey log's latest entry: the stop in progress with how long the train has stood, or else the last station logged with the time it was passed (or from when to when the train stood there), marked amber for a halt and green for a station passed. A long name is cut short with "…" while the distance or time stays whole. A tap on the log line opens it over the clock to the stop in progress and the last five entries, as the main screen's log has them; another tap closes it. By themselves the two lines take the room beside the speed dial, so the time keeps its size.
- **Clock sizes:** in the full-screen clock, a small gear next to EXIT opens a bar for sizes (nothing changes until it is pressed). Pick the time (hours, minutes and seconds change together), the speed dial, the date, the next station or the journey log, with its button or by tapping it, and resize it like a picture: it sits in a dashed box with a handle at each corner, so drawing a corner out makes it larger and drawing it in makes it smaller, and spreading or pinching two fingers does the same. The slider and − and + are there for small steps. There are two ways, each with sizes of its own: **Auto** keeps everything apart, so a larger dial takes room from the time and the date (a very large dial has the time beside it) and a smaller one gives the time room back, and larger lines for the next station and the log make the time smaller rather than cover it; **Custom** gives each part its own size whatever the others do, so parts may overlap. "Reset" brings back the clock's own layout, and the sizes are kept.
- **CSV:** "CSV download" saves the whole log as `train-log-<date>-<time>.csv` in the phone's Download folder (on Android 9 and older the share menu opens instead, to send the file on or keep it).

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

Every pull request also runs the debug APK on an Android emulator (`node scripts/android_e2e.mjs path/to/app-debug.apk`): it checks that the page reaches the native side of the app, that a journey keeps being recorded with the screen off, that the full-screen clock hides the phone's bars and fills the screen at any font-size setting, that its sizes can be changed by touch from the gear (slider, corner handles, two fingers; Auto and Custom), that it shows the next station and the journey log clear of everything else and the log opens and closes with a tap, that the app opens on the route screen, that a found route opens the main screen with its stations, that "Clear log" goes back to the route screen, and that "CSV download" saves the log in the phone's Download folder. Its screenshots are in the run's `app-test-screenshots` artifact.

The page is not built with Capacitor's script, so `Capacitor.registerPlugin` does not exist in it; native plugins are reached through `Capacitor.Plugins` (`nativePlugin()` in `safar/index.html`).

After every change on `main`, GitHub Actions builds a signed APK, installs it over the previous version on an emulator and launches it, and publishes it to the update release when that passes. Signing and updates are described in [`safar/README.md`](safar/README.md).

## Data credits

- Station catalog: derived from DataMeet (CC0). Every station was checked against OpenStreetMap's track network and the order the timetables give its line. 201 stations stand where OpenStreetMap (ODbL) has them under the same code and name: ones DataMeet had placed on top of a neighbouring, differently named station (Muthani on Bhabua Road, for one), off the railway, or out of their line's order, where OpenStreetMap's spot is on the track and in order; and 97 where the two disagreed by more than a kilometre and Wikidata (CC0), as a third source, has the station where OpenStreetMap does. Most of Wikidata's station positions are copies of DataMeet's (7,781 identical), so only its own, different positions were counted. Their links are measured again from there. Where DataMeet and OpenStreetMap still disagree by more than a kilometre and nothing can tell which is right, the app keeps both places.
- Track and many stations: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), ODbL 1.0.
