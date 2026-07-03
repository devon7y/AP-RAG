"use client";

import { useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Billboard, Line, OrbitControls, Text } from "@react-three/drei";
import * as THREE from "three";
import HDRCanvas from "@/components/atlas/HDRCanvas";
import { useAtlasStore } from "@/lib/atlas/store";
import type { Corridor, Floor, Room } from "./types";

/**
 * The floor plan in 3D: rooms are lit platforms, corridors are the actual KG
 * relations, the boss chamber burns orange at the far end. Fog of war — only
 * rooms you've visited (or that adjoin one) are drawn. Emissive intensities
 * scale with hdrBoost so cores overshoot 1.0 on a true-HDR canvas.
 */

const ACCENT = "#d95926"; // dungeon orange (hub card accent)
const ACCENT_HOT = "#ffb38a";

const TYPE_COLORS: Record<string, string> = {
  concept: "#3987e5",
  method: "#199e70",
  dataset: "#c98500",
  theory: "#d95926",
  finding: "#008300",
  result: "#008300",
  brainregion: "#d55181",
};

function roomColor(room: Room): string {
  if (room.isBoss) return ACCENT;
  if (room.isEntrance) return "#c3c2b7";
  return TYPE_COLORS[room.entity?.type ?? ""] ?? "#898781";
}

/* ── a single room platform ─────────────────────────────────────────────── */

function RoomNode({
  room,
  state,
  movable,
  isCurrent,
  bossUnsealed,
  onClick,
}: {
  room: Room;
  state: "visited" | "seen";
  movable: boolean;
  isCurrent: boolean;
  bossUnsealed: boolean;
  onClick: () => void;
}) {
  const boost = useAtlasStore((s) => s.hdrBoost);
  const ring = useRef<THREE.Mesh>(null);
  const core = useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = useState(false);

  const radius = room.isBoss ? 5.2 : room.isEntrance ? 2.4 : 3.1;
  const dim = state === "seen" && !room.isBoss;
  const color = roomColor(room);

  const { ringColor, coreColor } = useMemo(() => {
    const base = new THREE.Color(color);
    const k = boost * (isCurrent || hovered ? 1.5 : 1.0) * (dim ? 0.25 : 0.8);
    return {
      ringColor: base.clone().multiplyScalar(k),
      coreColor: new THREE.Color(room.isBoss ? ACCENT_HOT : color).multiplyScalar(boost * (dim ? 0.3 : 1.1)),
    };
  }, [color, boost, isCurrent, hovered, dim, room.isBoss]);

  useFrame((s) => {
    const t = s.clock.elapsedTime;
    if (ring.current && (isCurrent || room.isBoss)) {
      const pulse = 1 + 0.06 * Math.sin(t * (room.isBoss ? 2.2 : 3));
      ring.current.scale.setScalar(pulse);
    }
    if (core.current && room.isBoss) {
      core.current.position.y = 3.4 + Math.sin(t * 1.4) * 0.5;
      core.current.rotation.y = t * 0.6;
      core.current.scale.setScalar(bossUnsealed ? 1 + 0.15 * Math.sin(t * 2.6) : 0.7);
    }
  });

  const [x, z] = room.pos;
  const label = room.isEntrance ? "Stairwell" : room.entity?.id ?? room.id;

  return (
    <group position={[x, 0, z]}>
      {/* platform */}
      <mesh position={[0, -0.3, 0]} receiveShadow>
        <cylinderGeometry args={[radius, radius * 1.12, 0.6, room.isBoss ? 8 : 24]} />
        <meshStandardMaterial
          color={dim ? "#141412" : "#1c1b19"}
          roughness={0.9}
          metalness={0.1}
        />
      </mesh>

      {/* emissive perimeter ring */}
      <mesh ref={ring} position={[0, 0.06, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[radius * 0.82, radius * 0.96, room.isBoss ? 8 : 48]} />
        <meshBasicMaterial
          color={ringColor}
          transparent
          opacity={dim ? 0.4 : 0.85}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>

      {/* boss chamber: spire + burning core */}
      {room.isBoss && (
        <>
          <mesh position={[0, 5.5, 0]}>
            <coneGeometry args={[radius * 0.55, 11, 8, 1, true]} />
            <meshBasicMaterial
              color={ringColor}
              transparent
              opacity={dim ? 0.1 : 0.22}
              blending={THREE.AdditiveBlending}
              side={THREE.DoubleSide}
              depthWrite={false}
            />
          </mesh>
          <mesh ref={core} position={[0, 3.4, 0]}>
            <icosahedronGeometry args={[0.9, 1]} />
            <meshBasicMaterial color={coreColor} toneMapped={false} />
          </mesh>
        </>
      )}

      {/* non-boss marker gem */}
      {!room.isBoss && !room.isEntrance && (
        <mesh position={[0, 0.75, 0]}>
          <octahedronGeometry args={[0.45, 0]} />
          <meshBasicMaterial color={coreColor} toneMapped={false} transparent opacity={dim ? 0.35 : 1} />
        </mesh>
      )}

      {/* hit target */}
      <mesh
        position={[0, 1.2, 0]}
        onPointerOver={(e) => {
          e.stopPropagation();
          if (movable) {
            setHovered(true);
            document.body.style.cursor = "pointer";
          }
        }}
        onPointerOut={() => {
          setHovered(false);
          document.body.style.cursor = "auto";
        }}
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
      >
        <cylinderGeometry args={[radius + 0.6, radius + 0.6, 5, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      {/* label */}
      <Billboard position={[0, room.isBoss ? 10.5 : 2.4, 0]}>
        <Text
          fontSize={room.isBoss ? 1.7 : 1.0}
          color={dim ? "#6b6a64" : room.isBoss ? ACCENT_HOT : "#e8e6dd"}
          anchorX="center"
          anchorY="bottom"
          outlineWidth={0.035}
          outlineColor="#0a0908"
          maxWidth={18}
          textAlign="center"
        >
          {label}
        </Text>
        {room.isBoss && (
          <Text
            position={[0, -0.35, 0]}
            fontSize={0.75}
            color={bossUnsealed ? ACCENT : "#6b6a64"}
            anchorX="center"
            anchorY="top"
            letterSpacing={0.18}
          >
            {bossUnsealed ? "BOSS · GATE OPEN" : "BOSS · SEALED"}
          </Text>
        )}
      </Billboard>
    </group>
  );
}

/* ── corridors ──────────────────────────────────────────────────────────── */

function CorridorLine({
  corridor,
  rooms,
  visible,
  active,
  bossUnsealed,
}: {
  corridor: Corridor;
  rooms: Map<string, Room>;
  visible: boolean;
  active: boolean;
  bossUnsealed: boolean;
}) {
  const a = rooms.get(corridor.a);
  const b = rooms.get(corridor.b);
  if (!a || !b || !visible) return null;
  const sealed = corridor.bossGate && !bossUnsealed;
  const color = corridor.bossGate ? (sealed ? "#7a3a24" : ACCENT) : active ? "#e8e6dd" : "#4a4944";
  return (
    <Line
      points={[
        [a.pos[0], 0.15, a.pos[1]],
        [b.pos[0], 0.15, b.pos[1]],
      ]}
      color={color}
      lineWidth={active || corridor.bossGate ? 2.2 : 1.2}
      dashed={sealed}
      dashSize={1.1}
      gapSize={0.8}
      transparent
      opacity={active ? 0.95 : 0.5}
    />
  );
}

/* ── player token ───────────────────────────────────────────────────────── */

function Player({ room }: { room: Room }) {
  const boost = useAtlasStore((s) => s.hdrBoost);
  const group = useRef<THREE.Group>(null);
  const orb = useRef<THREE.Mesh>(null);
  const target = useMemo(() => new THREE.Vector3(room.pos[0], 0, room.pos[1]), [room]);

  useFrame((s, dt) => {
    const g = group.current;
    if (!g) return;
    g.position.x = THREE.MathUtils.damp(g.position.x, target.x, 4, dt);
    g.position.z = THREE.MathUtils.damp(g.position.z, target.z, 4, dt);
    if (orb.current) orb.current.position.y = 1.7 + Math.sin(s.clock.elapsedTime * 2.2) * 0.18;
  });

  const orbColor = useMemo(
    () => new THREE.Color("#cde2fb").multiplyScalar(1.2 * boost),
    [boost],
  );

  return (
    <group ref={group} position={[room.pos[0], 0, room.pos[1]]}>
      <mesh ref={orb} position={[0, 1.7, 0]}>
        <icosahedronGeometry args={[0.4, 2]} />
        <meshBasicMaterial color={orbColor} toneMapped={false} />
      </mesh>
      <pointLight position={[0, 2.4, 0]} intensity={26} distance={22} color="#9ec5f4" />
      <mesh position={[0, 0.12, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.55, 0.75, 32]} />
        <meshBasicMaterial
          color="#9ec5f4"
          transparent
          opacity={0.7}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

/* ── camera rig: orbit controls whose target trails the player ──────────── */

function CameraRig({ room }: { room: Room }) {
  const controls = useRef<React.ComponentRef<typeof OrbitControls>>(null);
  const target = useMemo(() => new THREE.Vector3(room.pos[0], 1, room.pos[1]), [room]);

  useFrame((_, dt) => {
    const c = controls.current;
    if (!c) return;
    c.target.x = THREE.MathUtils.damp(c.target.x, target.x, 2.5, dt);
    c.target.y = THREE.MathUtils.damp(c.target.y, target.y, 2.5, dt);
    c.target.z = THREE.MathUtils.damp(c.target.z, target.z, 2.5, dt);
    c.update();
  });

  return (
    <OrbitControls
      ref={controls}
      enableDamping
      dampingFactor={0.08}
      minDistance={14}
      maxDistance={130}
      maxPolarAngle={Math.PI / 2.1}
    />
  );
}

/* ── scene root ─────────────────────────────────────────────────────────── */

export default function DungeonScene({
  floor,
  currentId,
  visited,
  bossUnsealed,
  onRoomClick,
}: {
  floor: Floor;
  currentId: string;
  visited: Set<string>;
  bossUnsealed: boolean;
  onRoomClick: (id: string) => void;
}) {
  const roomsById = useMemo(() => new Map(floor.rooms.map((r) => [r.id, r])), [floor]);

  // Fog of war: visited rooms plus anything one corridor away from them.
  const seen = useMemo(() => {
    const s = new Set(visited);
    for (const id of visited) for (const n of floor.adj[id] ?? []) s.add(n);
    return s;
  }, [visited, floor]);

  const movable = useMemo(() => new Set(floor.adj[currentId] ?? []), [floor, currentId]);
  const currentRoom = roomsById.get(currentId) ?? floor.rooms[0];

  return (
    <HDRCanvas
      camera={{ position: [-30, 48, 42], fov: 50, near: 0.1, far: 400 }}
      clearColor={0x0b0807}
    >
      <fog attach="fog" args={[0x0b0807, 80, 220]} />
      <ambientLight intensity={0.35} />
      <directionalLight position={[20, 40, 10]} intensity={0.5} color="#ffd9c0" />

      <group key={floor.index}>
        {floor.corridors.map((c, i) => (
          <CorridorLine
            key={i}
            corridor={c}
            rooms={roomsById}
            visible={seen.has(c.a) && seen.has(c.b)}
            active={c.a === currentId || c.b === currentId}
            bossUnsealed={bossUnsealed}
          />
        ))}
        {floor.rooms.map((room) =>
          seen.has(room.id) ? (
            <RoomNode
              key={room.id}
              room={room}
              state={visited.has(room.id) ? "visited" : "seen"}
              movable={movable.has(room.id)}
              isCurrent={room.id === currentId}
              bossUnsealed={bossUnsealed}
              onClick={() => onRoomClick(room.id)}
            />
          ) : null,
        )}
        <Player room={currentRoom} />
      </group>

      <gridHelper args={[220, 44, 0x2c2c2a, 0x171613]} position={[0, -0.65, 0]} />
      <CameraRig room={currentRoom} />
    </HDRCanvas>
  );
}
