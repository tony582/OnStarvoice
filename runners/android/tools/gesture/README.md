# Android 8.1 held swipe

`StarVoiceHeldSwipe.java` builds the small `held-swipe.dex` bundled with the runner. Android 8.1's shell swipe releases immediately after moving. Its drag-and-drop command holds at the starting point. [Android 8.1 input command](https://android.googlesource.com/platform/frameworks/base/+/android-8.1.0_r61/cmds/input/src/com/android/commands/input/Input.java)

The article reader uses the helper only while looking for the footer after the webpage body has been verified. It moves in one gesture, keeps contact at the destination and then releases. ADB runs the helper as the existing Android shell user and removes its temporary file at the end of the command.

Rebuild with JDK 17 and Android SDK D8 9.3.16. Run from this directory with both tools on PATH.

```sh
gesture_build=$(mktemp -d)
trap 'rm -r "$gesture_build"' EXIT
mkdir "$gesture_build/classes" "$gesture_build/dex"
javac --release 8 -g:none -d "$gesture_build/classes" StarVoiceHeldSwipe.java
d8 --release --min-api 27 --output "$gesture_build/dex" "$gesture_build/classes/"*.class
cp "$gesture_build/dex/classes.dex" held-swipe.dex
```
