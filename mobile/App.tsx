import { CameraView, useCameraPermissions } from "expo-camera";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, type ScrollViewInstance, StatusBar as RNStatusBar, StyleSheet, Text, TextInput, View } from "react-native";
import { RepairCard } from "./src/RepairCard";
import { colors } from "./src/theme";
import { useStepwise } from "./src/useStepwise";
import { useVoice } from "./src/useVoice";

const DEFAULT_SERVER = process.env.EXPO_PUBLIC_STEPWISE_URL ?? "http://192.168.1.10:8000";
const FRAME_INTERVAL_MS = 4000;

export default function App() {
  const [server, setServer] = useState(DEFAULT_SERVER);
  const [serverDraft, setServerDraft] = useState(DEFAULT_SERVER);
  const [showServer, setShowServer] = useState(false);
  const [command, setCommand] = useState("");
  const [micError, setMicError] = useState<string | null>(null);
  const { state, sendText, sendFrame, sendPcm, clearError } = useStepwise(server);
  const [camPerm, requestCamPerm] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const scroll = useRef<ScrollViewInstance>(null);
  const capturing = useRef(false);

  const voiceIn = state.voice?.voice_in ?? state.config?.providers.voice_in ?? "browser";
  const voiceOut = state.voice?.voice_out ?? state.config?.providers.voice_out ?? "browser";
  const voice = useVoice({ serverUrl: server, voiceIn, voiceOut, sendPcm });

  // Keep a recent frame on the server so a spoken problem is identified against what the
  // phone sees right now.
  const captureFrame = useCallback(async () => {
    if (!camera.current || capturing.current || state.conn !== "connected") return;
    capturing.current = true;
    try {
      const pic = await camera.current.takePictureAsync({ quality: 0.3, base64: true, shutterSound: false });
      if (pic?.base64) sendFrame(pic.base64);
    } catch {
      /* camera busy or not ready */
    } finally {
      capturing.current = false;
    }
  }, [sendFrame, state.conn]);

  useEffect(() => {
    if (!camPerm?.granted || state.conn !== "connected") return;
    const id = setInterval(() => void captureFrame(), FRAME_INTERVAL_MS);
    return () => clearInterval(id);
  }, [camPerm?.granted, state.conn, captureFrame]);

  // Speak each new assistant reply once.
  const spoken = useRef(0);
  const lastAssistant = useMemo(() => [...state.lines].reverse().find((l) => l.role === "assistant"), [state.lines]);
  useEffect(() => {
    if (!lastAssistant || lastAssistant.id === spoken.current) return;
    spoken.current = lastAssistant.id;
    voice.speak(lastAssistant.text);
  }, [lastAssistant, voice.speak]);

  const say = useCallback(async (text: string) => {
    voice.stopSpeaking();
    if (state.guide.phase === "idle") await captureFrame();
    sendText(text);
  }, [voice.stopSpeaking, state.guide.phase, captureFrame, sendText]);

  async function toggleMic() {
    setMicError(null);
    if (voice.listening) return voice.stopListening();
    try {
      await voice.startListening();
    } catch (e) {
      setMicError((e as Error).message);
    }
  }

  const p = state.config?.providers;
  const pills: [string, string, boolean][] = [
    ["Brain", p?.agent === "claude" ? "Claude" : "mock", p?.agent === "claude"],
    ["Vision", p?.vision === "claude" ? "Claude" : "confirm by voice", p?.vision === "claude"],
    ["Voice", voiceOut === "cartesia" ? "Cartesia" : "on-device", voiceOut === "cartesia"],
    ["Search", p?.moss_configured ? "Moss" : "local", !!p?.moss_configured],
  ];
  const sourceLabel = state.sources[0]?.label ?? "STEPWISE catalog";

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Pressable onPress={() => setShowServer((v) => !v)} accessibilityRole="button" accessibilityLabel="Server settings">
          <Text style={styles.brand}>STEPWISE</Text>
          <Text style={styles.sub}>hands-free repair</Text>
        </Pressable>
        <View style={styles.headerRight}>
          <Text style={styles.asset}>{state.asset || "—"}</Text>
          <View style={[styles.dot, { backgroundColor: state.conn === "connected" ? colors.green : state.conn === "connecting" ? colors.amber : colors.red }]} />
        </View>
      </View>

      {showServer && (
        <View style={[styles.serverRow, { paddingHorizontal: 16, paddingBottom: 10 }]}>
          <TextInput style={styles.input} value={serverDraft} onChangeText={setServerDraft} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="https://your-server" placeholderTextColor={colors.muted} />
          <Pressable style={styles.sendBtn} onPress={() => { setServer(serverDraft); setShowServer(false); }}><Text style={styles.sendText}>Connect</Text></Pressable>
        </View>
      )}

      {/* The camera shrinks once a repair is underway so the action card stays in reach. */}
      <View style={[styles.cameraBox, { height: state.guide.phase === "idle" ? "34%" : "20%" }]}>
        {camPerm?.granted
          ? <CameraView ref={camera} style={StyleSheet.absoluteFill} facing="back" />
          : (
            <Pressable style={styles.camPrompt} onPress={() => void requestCamPerm()}>
              <Text style={styles.camPromptText}>Tap to turn on the camera so STEPWISE can see the machine</Text>
            </Pressable>
          )}
        <View style={styles.camBadge}><Text style={styles.camBadgeText}>{state.conv === "thinking" ? "THINKING" : voice.speaking ? "SPEAKING" : voice.listening ? "LISTENING" : "READY"}</Text></View>
      </View>

      <ScrollView ref={scroll} style={styles.body} contentContainerStyle={{ paddingBottom: 16 }} keyboardShouldPersistTaps="handled" onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}>
        <View style={styles.pills}>
          {pills.map(([k, v, live]) => (
            <View key={k} style={[styles.pill, live && styles.pillLive]}><Text style={[styles.pillText, live && { color: colors.green }]}><Text style={styles.pillKey}>{k} </Text>{v}</Text></View>
          ))}
        </View>

        {!!state.heard && <Text style={styles.heard}>“{state.heard}”</Text>}
        <Text style={styles.reply}>{lastAssistant?.text ?? "Point the camera at the machine and say what's wrong."}</Text>
        <Text style={styles.source}>grounded · {sourceLabel}</Text>

        <RepairCard guide={state.guide} procedure={state.procedure} report={state.report} onSay={(t) => void say(t)} />

        {state.guide.phase === "idle" && (
          <View style={styles.quick}>
            {[["The nozzle is clogged", "Clogged nozzle"], ["What am I looking at?", "Identify CNC"]].map(([text, label]) => (
              <Pressable key={text} style={styles.chip} onPress={() => void say(text)}><Text style={styles.chipText}>{label}</Text></Pressable>
            ))}
          </View>
        )}

        {(state.error || micError) && (
          <Pressable onPress={() => { clearError(); setMicError(null); }} style={styles.error}><Text style={styles.errorText}>{state.error || micError}  (tap to dismiss)</Text></Pressable>
        )}
      </ScrollView>

      <View style={styles.bottom}>
        <Pressable accessibilityRole="button" style={[styles.talk, voice.listening && styles.talkOn]} onPress={() => void toggleMic()}>
          <Text style={[styles.talkText, voice.listening && { color: colors.bg }]}>{voice.listening ? "Listening… tap to mute" : "Tap to talk"}</Text>
        </Pressable>
        <View style={styles.serverRow}>
          <TextInput style={styles.input} value={command} onChangeText={setCommand} placeholder="Or type what's wrong…" placeholderTextColor={colors.muted} returnKeyType="send"
            onSubmitEditing={() => { void say(command); setCommand(""); }} />
          <Pressable style={styles.sendBtn} onPress={() => { void say(command); setCommand(""); }}><Text style={styles.sendText}>Send</Text></Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, paddingTop: Platform.OS === "android" ? (RNStatusBar.currentHeight ?? 24) : 50 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 16, paddingBottom: 10 },
  brand: { color: colors.text, fontSize: 18, fontWeight: "800", letterSpacing: 3 },
  sub: { color: colors.muted, fontSize: 12 },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  asset: { color: colors.muted, fontSize: 12, fontFamily: "monospace" },
  dot: { width: 10, height: 10, borderRadius: 5 },
  cameraBox: { marginHorizontal: 16, borderRadius: 10, overflow: "hidden", backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  camPrompt: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  camPromptText: { color: colors.cyan, fontSize: 15, textAlign: "center" },
  camBadge: { position: "absolute", top: 8, left: 8, backgroundColor: "rgba(7,16,24,0.75)", borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  camBadgeText: { color: colors.cyan, fontSize: 11, fontWeight: "700", letterSpacing: 1 },
  body: { flex: 1, paddingHorizontal: 16 },
  pills: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 12 },
  pill: { borderWidth: 1, borderColor: colors.line, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3 },
  pillLive: { borderColor: "rgba(57,229,140,0.5)" },
  pillText: { color: colors.muted, fontSize: 11 },
  pillKey: { color: colors.text, fontWeight: "700" },
  heard: { color: colors.muted, fontStyle: "italic", marginTop: 12 },
  reply: { color: colors.text, fontSize: 19, lineHeight: 26, marginTop: 12 },
  source: { color: colors.muted, fontSize: 11, marginTop: 4 },
  quick: { flexDirection: "row", gap: 8, marginTop: 14 },
  chip: { borderWidth: 1, borderColor: colors.line, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 10 },
  chipText: { color: colors.cyan, fontSize: 14 },
  error: { marginTop: 12, padding: 10, borderRadius: 6, backgroundColor: "rgba(255,109,109,0.12)" },
  errorText: { color: colors.red, fontSize: 13 },
  bottom: { padding: 16, paddingBottom: Platform.OS === "ios" ? 30 : 16, gap: 10, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.surface },
  talk: { minHeight: 60, borderRadius: 10, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: colors.cyan },
  talkOn: { backgroundColor: colors.cyan },
  talkText: { color: colors.cyan, fontSize: 18, fontWeight: "800" },
  serverRow: { flexDirection: "row", gap: 8, paddingHorizontal: 0 },
  input: { flex: 1, minHeight: 46, borderRadius: 6, borderWidth: 1, borderColor: colors.line, color: colors.text, paddingHorizontal: 12, fontSize: 15 },
  sendBtn: { minHeight: 46, paddingHorizontal: 16, borderRadius: 6, backgroundColor: colors.cyan, alignItems: "center", justifyContent: "center" },
  sendText: { color: colors.bg, fontWeight: "800" },
});
