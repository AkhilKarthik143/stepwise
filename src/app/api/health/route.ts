// Health check for Azure, and which providers are live (shown in the app). Never returns keys.

import { connection } from "next/server";
import { claudeConfigured } from "@/lib/claude";
import { cartesiaConfigured } from "@/lib/cartesia";

export async function GET() {
  await connection(); // read env vars per request, not at build time
  return Response.json(
    {
      status: "ok",
      claude: claudeConfigured() ? (process.env.ANTHROPIC_API_KEY?.trim() ? "anthropic" : "openrouter") : "missing",
      voice: cartesiaConfigured() ? "cartesia" : "browser",
      // "invalid" = the connection string is set but Application Insights rejected it (see instrumentation.ts)
      telemetry: process.env.BUILDSIGHT_TELEMETRY === "on" ? "application-insights" : process.env.APPLICATIONINSIGHTS_CONNECTION_STRING?.trim() ? "invalid" : "off",
      locked: Boolean(process.env.APP_PASSCODE?.trim()),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
