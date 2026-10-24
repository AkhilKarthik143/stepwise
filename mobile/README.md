# STEPWISE mobile

The React Native (Expo SDK 58) app. It talks to the same FastAPI backend as the web console over `/ws`, so the guide, the safety interlock and the report all run on the server.

## Run it on your phone

1. Start the backend on a machine your phone can reach (`stepwise/backend`, see the root CLAUDE.md).
2. Point the app at it:

   ```bash
   cd mobile
   npm install
   EXPO_PUBLIC_STEPWISE_URL=http://<your-laptop-ip>:8000 npx expo start
   ```

3. Scan the QR code with Expo Go (Android) or the Camera app (iOS).

You can also change the server inside the app: tap **STEPWISE** in the header.

## What uses what

| Piece | How |
|---|---|
| Camera | `expo-camera`. A frame goes to the server every 4 s and right before a typed problem, so Claude identifies what the phone sees. |
| Voice in | `expo-audio` `useAudioStream`: 16 kHz PCM16 over the socket to Cartesia Ink, which decides when you're done talking. Needs `CARTESIA_API_KEY` on the server. |
| Voice out | Cartesia Sonic WAV from `GET /api/tts`. Falls back to the phone's own speech (`expo-speech`). |
| Buttons | Each button sends the phrase you'd say ("next", "yes", "repeat", "it didn't work"), so taps and voice share one path. |

The mic is muted while STEPWISE talks so it doesn't hear itself.

## Build an installable app

```bash
npx eas-cli@latest build --platform android --profile preview   # APK you can sideload
```

Use an `https://` server URL for builds. Android blocks plain `http://` outside Expo Go.

## Checks

```bash
npx tsc --noEmit
npx expo export --platform android   # proves the JS bundle builds
```
