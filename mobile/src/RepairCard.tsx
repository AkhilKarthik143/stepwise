import { Image, Linking, Pressable, Share, StyleSheet, Text, View } from "react-native";
import type { GuideStatus, ProcedureView } from "./protocol";
import { colors } from "./theme";

interface Props {
  guide: GuideStatus;
  procedure: ProcedureView | null;
  report: string | null;
  onSay: (text: string) => void;
}

function SayButton({ label, onPress, kind = "plain" }: { label: string; onPress: () => void; kind?: "plain" | "primary" | "safety" }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.btn, kind === "primary" && styles.primaryBtn, kind === "safety" && styles.safetyBtn, pressed && styles.pressed]}>
      <Text style={[styles.btnText, kind !== "plain" && styles.btnTextDark]}>{label}</Text>
    </Pressable>
  );
}

// Every button sends the phrase the technician would say, so taps and voice share one
// server path and one safety interlock.
export function RepairCard({ guide, procedure, report, onSay }: Props) {
  if (guide.phase === "awaiting_machine") {
    const ident = guide.identification;
    const how = !ident || ident.provider === "local"
      ? "Camera identification is off, so confirm the machine yourself."
      : `Claude vision guess · ${Math.round(ident.confidence * 100)}% confident`;
    return (
      <View style={[styles.card, { borderLeftColor: colors.cyan }]}>
        <Text style={[styles.kicker, { color: colors.cyan }]}>CONFIRM MACHINE</Text>
        <Text style={styles.title}>Is this the {guide.pending_machine}?</Text>
        <Text style={styles.note}>{how}</Text>
        <View style={styles.row}>
          <SayButton label="Yes" kind="primary" onPress={() => onSay("yes")} />
          <SayButton label="No" onPress={() => onSay("no")} />
        </View>
      </View>
    );
  }

  if (procedure?.mode === "procedure" && !procedure.complete) {
    const steps = procedure.steps || [];
    const idx = procedure.current ?? procedure.index ?? 0;
    const step = steps[idx];
    const locked = !!procedure.awaiting_confirmation;
    const source = procedure.source;
    return (
      <View style={[styles.card, locked && styles.locked]}>
        <Text style={styles.kicker}>STEP {Math.min(idx + 1, steps.length)} / {steps.length} · {procedure.title}</Text>
        <Text style={styles.title}>{step?.text}</Text>
        {step?.confirm && (
          <Text style={styles.safety}>{locked ? `SAFETY LOCK · ${step.confirm_prompt || "Confirm this step to continue."}` : "Safety step confirmed."}</Text>
        )}
        {idx === 0 && !!procedure.tools?.length && <Text style={styles.note}>Tools: {procedure.tools.join(", ")}</Text>}
        {/* Never a generated diagram: the manual's figure when it exists, else the source. */}
        {step?.figure_url
          ? <Image source={{ uri: step.figure_url }} style={styles.figure} resizeMode="contain" accessibilityLabel={`Manual figure for step ${step.n}`} />
          : (
            <Text style={styles.note}>
              No manual figure on file.{" "}
              {source?.url
                ? <Text style={styles.link} onPress={() => void Linking.openURL(source.url)}>Source: {source.title}</Text>
                : "Source: STEPWISE catalog"}
            </Text>
          )}
        <View style={styles.row}>
          <SayButton label="Repeat" onPress={() => onSay("repeat")} />
          {locked ? <SayButton label="Yes, confirmed" kind="safety" onPress={() => onSay("yes")} /> : <SayButton label="Next" kind="primary" onPress={() => onSay("next")} />}
        </View>
        <SayButton label="It didn't work" onPress={() => onSay("it didn't work")} />
      </View>
    );
  }

  if (procedure?.mode === "safety" && !procedure.complete) {
    const items = procedure.items || [];
    const idx = procedure.index ?? 0;
    return (
      <View style={[styles.card, styles.locked]}>
        <Text style={styles.kicker}>{procedure.title} · ITEM {idx + 1} / {items.length}</Text>
        <Text style={styles.title}>{items[idx]?.text}</Text>
        <Text style={styles.note}>{items[idx]?.prompt || "Say confirmed to advance this safety item."}</Text>
        <SayButton label="Confirmed" kind="safety" onPress={() => onSay("confirmed")} />
      </View>
    );
  }

  if (report && guide.phase === "report") {
    return (
      <View style={[styles.card, { borderLeftColor: colors.green }]}>
        <Text style={[styles.kicker, { color: colors.green }]}>SERVICE REPORT</Text>
        <Text style={styles.report}>{report}</Text>
        <View style={styles.row}>
          <SayButton label="Share report" kind="primary" onPress={() => void Share.share({ message: report, title: "STEPWISE service report" })} />
          <SayButton label="It didn't work" onPress={() => onSay("it didn't work")} />
        </View>
      </View>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  card: { gap: 8, marginTop: 12, padding: 14, borderLeftWidth: 3, borderLeftColor: colors.amber, backgroundColor: "rgba(246,191,85,0.08)", borderRadius: 6 },
  locked: { borderLeftWidth: 6, backgroundColor: "rgba(246,191,85,0.16)" },
  kicker: { color: colors.amber, fontSize: 11, letterSpacing: 1, fontWeight: "600" },
  title: { color: colors.text, fontSize: 20, fontWeight: "700", lineHeight: 26 },
  note: { color: colors.muted, fontSize: 13 },
  safety: { color: colors.amber, fontSize: 15, fontWeight: "700" },
  link: { color: colors.cyan, textDecorationLine: "underline" },
  figure: { width: "100%", height: 180, borderRadius: 4 },
  report: { color: colors.text, fontSize: 12, fontFamily: "monospace", lineHeight: 17 },
  row: { flexDirection: "row", gap: 8 },
  btn: { flex: 1, minHeight: 56, alignItems: "center", justifyContent: "center", borderRadius: 6, borderWidth: 1, borderColor: "rgba(232,241,245,0.2)", backgroundColor: "rgba(232,241,245,0.05)", paddingHorizontal: 8 },
  primaryBtn: { backgroundColor: colors.cyan, borderColor: colors.cyan },
  safetyBtn: { backgroundColor: colors.amber, borderColor: colors.amber },
  pressed: { opacity: 0.7 },
  btnText: { color: colors.text, fontSize: 16, fontWeight: "700" },
  btnTextDark: { color: colors.bg },
});
