// Sends server traces, requests and console logs to Azure Application Insights when
// APPLICATIONINSIGHTS_CONNECTION_STRING is set (it is on the Azure deployment). Off otherwise.
// Telemetry must never take the app down: a bad connection string makes Next.js fail every
// request, so any error here is logged and skipped.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Pasted values sometimes keep their quotes or a trailing newline.
  const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING?.trim().replace(/^["']|["']$/g, "").trim();
  if (!connectionString) return;
  try {
    const { useAzureMonitor } = await import("@azure/monitor-opentelemetry");
    // Not a React hook, despite the name.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useAzureMonitor({ azureMonitorExporterOptions: { connectionString } });
    process.env.BUILDSIGHT_TELEMETRY = "on";
  } catch (e) {
    console.error("Application Insights is off:", e instanceof Error ? e.message : e);
  }
}
