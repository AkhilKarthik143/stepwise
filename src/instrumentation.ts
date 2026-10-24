// Sends server traces, requests and console logs to Azure Application Insights when
// APPLICATIONINSIGHTS_CONNECTION_STRING is set (it is on the Azure deployment). Off otherwise.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || !process.env.APPLICATIONINSIGHTS_CONNECTION_STRING?.trim()) return;
  const { useAzureMonitor } = await import("@azure/monitor-opentelemetry");
  // Not a React hook, despite the name.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useAzureMonitor({ azureMonitorExporterOptions: { connectionString: process.env.APPLICATIONINSIGHTS_CONNECTION_STRING.trim() } });
}
