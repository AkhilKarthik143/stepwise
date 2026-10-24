"""Azure Application Insights, on when APPLICATIONINSIGHTS_CONNECTION_STRING is set.

Requests (including /ws) are traced automatically, and every ``stepwise.*`` log line is exported.
BuildSight logs one line per turn on ``stepwise.metrics`` with ``kind`` and ``ms`` as custom
dimensions, so latency per stage, checks and mistakes can be charted in the portal:

    traces | where message == "turn" | summarize percentile(toint(customDimensions.ms), 50) by tostring(customDimensions.kind)
"""

from __future__ import annotations

import logging

logger = logging.getLogger("stepwise.telemetry")


def setup(connection_string: str) -> bool:
    if not connection_string:
        return False
    try:
        from azure.monitor.opentelemetry import configure_azure_monitor

        configure_azure_monitor(connection_string=connection_string, logger_name="stepwise")
    except Exception as exc:  # noqa: BLE001 — telemetry must never stop the app booting
        logger.warning("Application Insights not enabled: %r", exc)
        return False
    logging.getLogger("stepwise").setLevel(logging.INFO)
    logger.info("Application Insights enabled")
    return True
