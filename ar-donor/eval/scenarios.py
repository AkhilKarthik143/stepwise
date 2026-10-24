"""
Representative field-technician scenarios for the diagram-quality eval. Each is a
first-turn user request; `expect_tool` is the tool we'd expect the AI to reach for
(a soft signal — the LLM judge does the real appraisal), and `rationale` says what
"good" looks like so the judge can score against intent.
"""
SCENARIOS = [
    {
        "id": "pump_exploded",
        "prompt": "Show me how the impeller, shaft, and seal stack up inside the pump housing.",
        "expect_tool": "show_model",
        "rationale": "3D exploded assembly; every part labelled with a note; realistic layout.",
    },
    {
        "id": "scissors_cut",
        "prompt": "Show me how the cutting blades close on the wire when I squeeze the tool.",
        "expect_tool": "show_model",
        "rationale": "3D with a 'swing' animate about a pivot (the joint) to demonstrate the motion.",
    },
    {
        "id": "relay_wiring",
        "prompt": "Draw the wiring for the start relay circuit so I can trace it.",
        "expect_tool": "show_model",
        "rationale": "2D schematic, labelled lines/terminals; dashed for hidden runs if useful.",
    },
    {
        "id": "bolt_torque",
        "prompt": "Which way do I turn the M8 head bolt, and what torque should I use?",
        "expect_tool": "query_technical_manual",
        "rationale": "Torque is a hard spec — should look it up (not guess); may also show the turn direction.",
    },
    {
        "id": "rotor_clearance",
        "prompt": "What's the clearance between the rotor and the housing, and show me where to measure it?",
        "expect_tool": "show_model",
        "rationale": "2D 'dimension' call-out for the clearance; look up the spec value rather than invent it.",
    },
    {
        "id": "terminal_safety",
        "prompt": "Can I just work on the terminal block while the unit is still plugged in?",
        "expect_tool": "show_model",
        "rationale": "Must flag the hazard (isolate/lock-out first); a diagram should carry a 'warning'.",
    },
    {
        "id": "gearbox_seethrough",
        "prompt": "I can't see what's inside the gearbox housing — show me the gears in there.",
        "expect_tool": "show_model",
        "rationale": "3D with a see-through housing (glass material / low opacity) revealing the internals.",
    },
    {
        "id": "pump_head_steps",
        "prompt": "Walk me through removing the pump head, step by step.",
        "expect_tool": "show_model",
        "rationale": "A stepped diagram (parts carry a 'step') so it can be played step-by-step.",
    },
]
