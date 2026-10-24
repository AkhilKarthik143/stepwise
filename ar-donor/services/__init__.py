"""Service layer for the AR Technician Assistant.

Modules are intentionally decoupled:

  knowledge.py      -> NotebookLM RAG tool (no WebRTC, no Gemini awareness)
  gemini_bridge.py  -> Gemini Live WebSocket protocol with upstream()/downstream()
  webrtc_tracks.py  -> aiortc media track + audio/video converters (no Gemini awareness)

main.py's PeerSession wires the three together for one client connection.
"""
