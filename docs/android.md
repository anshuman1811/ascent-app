# Android app

Ascent can be installed on Android phones as an app. It's the same app you use in the browser,
packaged with [Capacitor](https://capacitorjs.com): the screens are built into the app, and your
data stays on the Ascent server running on your computer at home. The app just needs to know
that computer's address.

## What you need

- The Ascent server set up and running on a computer at home (see [Getting started](getting-started.md)).
- To build the app: [Node.js](https://nodejs.org) **22 or newer** (the Capacitor tools need it;
  the rest of Ascent also runs on Node 20), **JDK 21**, and the **Android SDK** with platform
  `android-36` and build-tools. Installing [Android Studio](https://developer.android.com/studio)
  gives you the SDK and a JDK.

## Build the APK

```bash
cd client
npm ci                       # first time only
export JAVA_HOME=/path/to/jdk-21          # Android Studio's: "/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME=~/Library/Android/sdk # where the Android SDK lives (Linux: ~/Android/Sdk)
npm run android:build
```

This builds the web app, copies it into the Android project (`client/android`) and produces a
debug APK at:

```
client/android/app/build/outputs/apk/debug/app-debug.apk
```

The first build downloads Gradle and its Android plugins (a few hundred MB) and takes a few
minutes; later builds take under a minute. Rebuild whenever you update Ascent.

Other scripts: `npm run android:sync` (build the web app and copy it into the Android project,
e.g. before opening `client/android` in Android Studio), `npm run android:icons` (regenerate
the launcher icons).

## Install it on a phone

**Over USB** — turn on *Developer options → USB debugging* on the phone, plug it in, then:

```bash
cd client
npm run android:install      # = adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

**Without a cable** — copy `app-debug.apk` to the phone (email, cloud drive, a USB stick, …),
open it there and allow installing from that source when Android asks. Android may warn that
the app is from an unknown developer; that's expected for an app you built yourself.

To update, install a newer APK the same way; your settings are kept.

## Connect it to your server

The first time you open the app it asks for your server's address. Use the **Network** address
the server prints when it starts, for example:

```
Network: http://192.168.1.20:3001  ← use this on iPad/phone
```

Type `192.168.1.20:3001` (or the full `http://…` address) and tap **Connect**. The app checks it
can reach Ascent there before saving it. If you leave out the port, `3001` is assumed.

- The phone must be on the **same Wi-Fi** as the computer running Ascent.
- If it can't connect: check the server is running, that you typed the right address, and that
  the computer's firewall allows incoming connections on port 3001. Opening the same address in
  the phone's browser is a quick test.
- If the computer's address changes (routers sometimes hand out new ones), update it in
  **Settings → Server address**. Giving the computer a fixed address in your router's settings
  avoids this.

The app talks to the server over plain `http://` on your home network, the same as the browser
does; it allows unencrypted connections for that reason.

## Using the app

Everything works as on the web. A few Android touches:

- The **back button** closes an open dialog or goes back a screen; on the first screen it sends
  the app to the background.
- The screen **stays on** during a live workout.
- Exercise demo images that come with Ascent are built into the app; your own photos are
  loaded from the server.

## When you're away from home or offline

The app keeps a copy of your data on the phone, so it works fully without reaching the server — log meals and workouts at the gym, check your progress on the train — and sends your changes to the server when you're back on the home network. A small cloud icon above the Feedback button shows whether you're online and how many changes are waiting. See [Offline use and sync](guide/09-offline-and-sync.md) for the details, including what happens when two phones change the same thing.

The two AI features (describing a meal in words, and Analyze my progress) need the server.
