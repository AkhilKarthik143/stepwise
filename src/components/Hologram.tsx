"use client";

// Glowing blue "hologram" of the next part. LEGO bricks/plates/tiles are built to real
// proportions from their stud size; other shapes get a simple stand-in.
// Units: 1 = one stud pitch (8 mm). Brick 9.6 mm tall, plate 3.2 mm.

import { Canvas, useFrame } from "@react-three/fiber";
import { Edges, Float } from "@react-three/drei";
import { useMemo, useRef } from "react";
import * as THREE from "three";

export type HoloPart = {
  shape: "brick" | "plate" | "tile" | "slope" | "round" | "hardware" | "panel" | "other";
  studsX?: number;
  studsY?: number;
};

const HOLO = "#4fc3ff";
const BRICK_H = 1.2;
const PLATE_H = 0.4;
const STUD_R = 0.3;
const STUD_H = 0.2125;

function HoloMaterial({ opacity = 0.18 }: { opacity?: number }) {
  return <meshBasicMaterial color={HOLO} transparent opacity={opacity} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />;
}

function Shell({ children, edge = 15 }: { children: React.ReactNode; edge?: number }) {
  return (
    <mesh>
      {children}
      <HoloMaterial />
      <Edges color={HOLO} threshold={edge} />
    </mesh>
  );
}

function Studs({ x, y, top }: { x: number; y: number; top: number }) {
  const spots = useMemo(() => {
    const out: [number, number][] = [];
    for (let i = 0; i < x; i++) for (let j = 0; j < y; j++) out.push([i - (x - 1) / 2, j - (y - 1) / 2]);
    return out;
  }, [x, y]);
  return (
    <>
      {spots.map(([sx, sz]) => (
        <mesh key={`${sx}:${sz}`} position={[sx, top + STUD_H / 2, sz]}>
          <cylinderGeometry args={[STUD_R, STUD_R, STUD_H, 24]} />
          <HoloMaterial opacity={0.25} />
          <Edges color={HOLO} threshold={30} />
        </mesh>
      ))}
    </>
  );
}

// A side-on wedge: full height at the back, sloping to a short lip at the front.
function slopeGeometry(w: number, d: number, h: number) {
  const s = new THREE.Shape();
  s.moveTo(-d / 2, -h / 2);
  s.lineTo(d / 2, -h / 2);
  s.lineTo(d / 2, -h / 2 + h * 0.25);
  s.lineTo(-d / 2 + d * 0.3, h / 2);
  s.lineTo(-d / 2, h / 2);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: w, bevelEnabled: false });
  g.translate(0, 0, -w / 2);
  g.rotateY(Math.PI / 2);
  return g;
}

function PartModel({ part }: { part: HoloPart }) {
  const x = Math.min(8, Math.max(1, part.studsX ?? 2));
  const y = Math.min(8, Math.max(1, part.studsY ?? 2));
  const slope = useMemo(() => slopeGeometry(x, y, BRICK_H), [x, y]);

  switch (part.shape) {
    case "brick":
    case "plate":
    case "tile": {
      const h = part.shape === "brick" ? BRICK_H : PLATE_H;
      return (
        <group>
          <Shell><boxGeometry args={[x, h, y]} /></Shell>
          {part.shape !== "tile" && <Studs x={x} y={y} top={h / 2} />}
        </group>
      );
    }
    case "slope":
      return <Shell><primitive object={slope} attach="geometry" /></Shell>;
    case "round":
      return (
        <group>
          <Shell edge={40}><cylinderGeometry args={[x / 2, x / 2, PLATE_H * 2, 32]} /></Shell>
          <Studs x={1} y={1} top={PLATE_H} />
        </group>
      );
    case "hardware": // screw / bolt / dowel
      return (
        <group rotation={[0, 0, Math.PI / 2]}>
          <Shell edge={40}><cylinderGeometry args={[0.25, 0.25, 3, 16]} /></Shell>
          <mesh position={[0, 1.6, 0]}>
            <cylinderGeometry args={[0.55, 0.55, 0.25, 6]} />
            <HoloMaterial opacity={0.3} />
            <Edges color={HOLO} threshold={20} />
          </mesh>
        </group>
      );
    case "panel":
      return <Shell><boxGeometry args={[4, 0.25, 2.5]} /></Shell>;
    default:
      return <Shell><boxGeometry args={[1.6, 1.2, 1.6]} /></Shell>;
  }
}

function Turntable({ part }: { part: HoloPart }) {
  const spin = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (spin.current) spin.current.rotation.y += dt * 0.6;
  });
  const size = Math.max(part.studsX ?? 2, part.studsY ?? 2, 2);
  return (
    <>
      <Float speed={2} rotationIntensity={0.15} floatIntensity={0.6}>
        <group ref={spin} rotation={[0.35, 0, 0]}>
          <PartModel part={part} />
        </group>
      </Float>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.6, 0]}>
        <ringGeometry args={[size * 0.45, size * 0.6, 48]} />
        <HoloMaterial opacity={0.35} />
      </mesh>
    </>
  );
}

export default function Hologram({ part }: { part: HoloPart }) {
  const size = Math.max(part.studsX ?? 2, part.studsY ?? 2, 2);
  return (
    <Canvas camera={{ position: [0, 2.6, size + 5], fov: 40 }} gl={{ alpha: true, antialias: true }} style={{ background: "transparent" }}>
      <Turntable key={`${part.shape}-${part.studsX}x${part.studsY}`} part={part} />
    </Canvas>
  );
}
