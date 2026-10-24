import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { HoloPart } from "../lib/partShape";

// The part to grab, as a slowly turning 3D shape in its color with glowing edges.
// LEGO bricks, plates and tiles use real proportions: 1 unit = one stud pitch (8 mm), brick 9.6 mm
// tall, plate and tile 3.2 mm. Other parts are stand-ins from their shape family (see partShape.ts).
// Loaded lazily so three.js stays out of the first page load.

const BRICK_H = 1.2;
const PLATE_H = 0.4;
const STUD_R = 0.3;
const STUD_H = 0.2125;

// Side-on wedge: full height at the back, sloping down to a short lip at the front.
function wedge(w: number, d: number, h: number): THREE.BufferGeometry {
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

function buildPart(part: HoloPart): THREE.Group {
  const group = new THREE.Group();
  const color = new THREE.Color(part.color);
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.05, emissive: color, emissiveIntensity: 0.15 });
  const edge = new THREE.LineBasicMaterial({ color: new THREE.Color("#7fe3ff"), transparent: true, opacity: 0.85 });

  const add = (geometry: THREE.BufferGeometry, pos: [number, number, number] = [0, 0, 0], rot: [number, number, number] = [0, 0, 0]) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...pos);
    mesh.rotation.set(...rot);
    const lines = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 30), edge);
    lines.position.copy(mesh.position);
    lines.rotation.copy(mesh.rotation);
    group.add(mesh, lines);
  };
  const studs = (x: number, y: number, top: number) => {
    const stud = new THREE.CylinderGeometry(STUD_R, STUD_R, STUD_H, 24);
    for (let i = 0; i < x; i++) for (let j = 0; j < y; j++) add(stud, [i - (x - 1) / 2, top + STUD_H / 2, j - (y - 1) / 2]);
  };
  const { x, y } = part;

  switch (part.shape) {
    case "brick":
    case "plate":
    case "tile": {
      const h = part.shape === "brick" ? BRICK_H : PLATE_H;
      add(new THREE.BoxGeometry(x * 0.98, h, y * 0.98));
      if (part.shape !== "tile") studs(x, y, h / 2);
      break;
    }
    case "slope":
      add(wedge(x, y, BRICK_H));
      break;
    case "round":
      add(new THREE.CylinderGeometry(x / 2, x / 2, BRICK_H, 32));
      break;
    case "bolt": // shaft lying on its side, hex head on the left
      add(new THREE.CylinderGeometry(0.22, 0.22, 3, 16), [0.2, 0, 0], [0, 0, Math.PI / 2]);
      add(new THREE.CylinderGeometry(0.5, 0.5, 0.3, 6), [-1.45, 0, 0], [0, 0, Math.PI / 2]);
      break;
    case "dowel":
      add(new THREE.CylinderGeometry(0.3, 0.3, 2.6, 20), [0, 0, 0], [0, 0, Math.PI / 2]);
      break;
    case "ring":
      add(new THREE.TorusGeometry(0.7, 0.22, 12, 6), [0, 0, 0], [Math.PI / 2, 0, 0]);
      break;
    case "cam":
      add(new THREE.CylinderGeometry(0.8, 0.8, 0.5, 32));
      add(new THREE.BoxGeometry(0.9, 0.1, 0.18), [0, 0.3, 0]);
      break;
    case "key": // L-shaped Allen key
      add(new THREE.BoxGeometry(2.4, 0.22, 0.22), [0.3, 0, 0]);
      add(new THREE.BoxGeometry(0.22, 0.9, 0.22), [-0.8, 0.34, 0]);
      break;
    case "leg":
      add(new THREE.BoxGeometry(0.6, 3, 0.6));
      break;
    case "panel":
      add(new THREE.BoxGeometry(3.2, 0.2, 2));
      break;
    default:
      add(new THREE.BoxGeometry(1.6, 1.2, 1.6));
  }
  return group;
}

export default function PartHologram({ part }: { part: HoloPart }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const size = el.clientWidth || 120;
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(size, size);
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 2);
    sun.position.set(3, 6, 4);
    scene.add(sun);

    const piece = buildPart(part);
    piece.rotation.x = 0.45;
    scene.add(piece);

    const span = part.shape === "brick" || part.shape === "plate" || part.shape === "tile" ? Math.max(part.x, part.y, 2) : 2.4;
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    camera.position.set(0, span * 0.9, span * 2.1);
    camera.lookAt(0, 0, 0);

    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      piece.rotation.y += ((now - last) / 1000) * 0.6;
      piece.position.y = Math.sin(now / 700) * 0.08;
      last = now;
      renderer.render(scene, camera);
      frame = requestAnimationFrame(tick);
    };
    if (still) {
      piece.rotation.y = 0.6;
      renderer.render(scene, camera);
    } else {
      frame = requestAnimationFrame(tick);
    }

    return () => {
      cancelAnimationFrame(frame);
      piece.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) o.geometry.dispose();
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [part.shape, part.x, part.y, part.color]);

  return <div ref={host} className="bs-holo-canvas" aria-hidden />;
}
