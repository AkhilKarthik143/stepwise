"""
Generate a tiny, valid binary glTF (.glb) sample model — a unit cube with
per-face normals and a double-sided PBR material — written to
web/public/sample-assets/box.glb.

This is a REAL, spec-valid asset operators can point MODEL_ASSETS_JSON at to test
their setup (and that we use to validate the GLTF render path end-to-end). It is
hand-built from stdlib + numpy (no glTF library needed) and is intentionally
trivial. Re-run with:  python scripts/make_sample_glb.py
"""
from __future__ import annotations

import json
import struct
from pathlib import Path

import numpy as np

# 6 faces x 4 corners of a unit cube centred at the origin (side = 1.0).
FACES = [
    # (normal, [4 corners CCW when viewed from outside])
    ((0, 0, 1), [(-0.5, -0.5, 0.5), (0.5, -0.5, 0.5), (0.5, 0.5, 0.5), (-0.5, 0.5, 0.5)]),
    ((0, 0, -1), [(0.5, -0.5, -0.5), (-0.5, -0.5, -0.5), (-0.5, 0.5, -0.5), (0.5, 0.5, -0.5)]),
    ((1, 0, 0), [(0.5, -0.5, 0.5), (0.5, -0.5, -0.5), (0.5, 0.5, -0.5), (0.5, 0.5, 0.5)]),
    ((-1, 0, 0), [(-0.5, -0.5, -0.5), (-0.5, -0.5, 0.5), (-0.5, 0.5, 0.5), (-0.5, 0.5, -0.5)]),
    ((0, 1, 0), [(-0.5, 0.5, 0.5), (0.5, 0.5, 0.5), (0.5, 0.5, -0.5), (-0.5, 0.5, -0.5)]),
    ((0, -1, 0), [(-0.5, -0.5, -0.5), (0.5, -0.5, -0.5), (0.5, -0.5, 0.5), (-0.5, -0.5, 0.5)]),
]

positions: list[tuple[float, float, float]] = []
normals: list[tuple[float, float, float]] = []
indices: list[int] = []
for normal, corners in FACES:
    base = len(positions)
    positions.extend(corners)
    normals.extend([normal] * 4)
    indices.extend([base, base + 1, base + 2, base, base + 2, base + 3])  # two triangles

pos = np.array(positions, dtype=np.float32)
nrm = np.array(normals, dtype=np.float32)
idx = np.array(indices, dtype=np.uint16)


def _pad(buf: bytes, align: int = 4, fill: bytes = b"\x00") -> bytes:
    rem = len(buf) % align
    return buf + (fill * (align - rem)) if rem else buf


pos_bytes = pos.tobytes()
nrm_bytes = nrm.tobytes()
idx_bytes = _pad(idx.tobytes())  # keep the next (none) view aligned; harmless if last
bin_blob = _pad(pos_bytes + nrm_bytes + idx_bytes)

gltf = {
    "asset": {"version": "2.0", "generator": "ar-technician make_sample_glb"},
    "scene": 0,
    "scenes": [{"nodes": [0]}],
    "nodes": [{"mesh": 0, "name": "SampleBox"}],
    "meshes": [{
        "name": "Box",
        "primitives": [{
            "attributes": {"POSITION": 0, "NORMAL": 1},
            "indices": 2,
            "material": 0,
        }],
    }],
    "materials": [{
        "name": "SteelBlue",
        "doubleSided": True,
        "pbrMetallicRoughness": {
            "baseColorFactor": [0.55, 0.65, 0.78, 1.0],
            "metallicFactor": 0.6,
            "roughnessFactor": 0.4,
        },
    }],
    "buffers": [{"byteLength": len(bin_blob)}],
    "bufferViews": [
        {"buffer": 0, "byteOffset": 0, "byteLength": len(pos_bytes), "target": 34962},
        {"buffer": 0, "byteOffset": len(pos_bytes), "byteLength": len(nrm_bytes), "target": 34962},
        {"buffer": 0, "byteOffset": len(pos_bytes) + len(nrm_bytes), "byteLength": idx.nbytes, "target": 34963},
    ],
    "accessors": [
        {"bufferView": 0, "componentType": 5126, "count": len(positions), "type": "VEC3",
         "min": pos.min(axis=0).tolist(), "max": pos.max(axis=0).tolist()},
        {"bufferView": 1, "componentType": 5126, "count": len(normals), "type": "VEC3"},
        {"bufferView": 2, "componentType": 5123, "count": len(indices), "type": "SCALAR"},
    ],
}

json_blob = _pad(json.dumps(gltf, separators=(",", ":")).encode("utf-8"), fill=b" ")

# .glb container: 12-byte header + JSON chunk + BIN chunk.
GLB_MAGIC, GLB_VERSION = 0x46546C67, 2
CHUNK_JSON, CHUNK_BIN = 0x4E4F534A, 0x004E4942
total = 12 + 8 + len(json_blob) + 8 + len(bin_blob)
out = bytearray()
out += struct.pack("<III", GLB_MAGIC, GLB_VERSION, total)
out += struct.pack("<II", len(json_blob), CHUNK_JSON) + json_blob
out += struct.pack("<II", len(bin_blob), CHUNK_BIN) + bin_blob

dest = Path(__file__).resolve().parent.parent / "web" / "public" / "sample-assets" / "box.glb"
dest.parent.mkdir(parents=True, exist_ok=True)
dest.write_bytes(out)
print(f"wrote {dest} ({len(out)} bytes): {len(positions)} verts, {len(indices)} indices")
