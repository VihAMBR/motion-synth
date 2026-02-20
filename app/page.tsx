"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AudioEngine,
  AxisMappings,
  DEFAULT_MAPPINGS,
  BETA_TARGETS,
  GAMMA_TARGETS,
  ALPHA_TARGETS,
  TARGET_LABELS,
  ControlTarget,
} from "../lib/audio/engine";
import {
  requestMotionPermission,
  listenMotion,
  MotionValues,
} from "../lib/motion/sensors";

const NOTE_NAMES = ["C", "D", "E", "F", "G", "A", "B", "C"];
const MIDI_NOTES = [60, 62, 64, 65, 67, 69, 71, 72];
const PAD_COLORS = [
  "#ff6b6b",
  "#ffa94d",
  "#ffd43b",
  "#69db7c",
  "#38d9a9",
  "#4dabf7",
  "#748ffc",
  "#da77f2",
];

function nextTarget(current: ControlTarget, list: ControlTarget[]) {
  const idx = list.indexOf(current);
  return list[(idx + 1) % list.length];
}

export default function Home() {
  const engineRef = useRef<AudioEngine | null>(null);
  const cleanupMotionRef = useRef<(() => void) | null>(null);

  const [started, setStarted] = useState(false);
  const [motionStatus, setMotionStatus] = useState("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [motion, setMotion] = useState<MotionValues>({ alpha: 0, beta: 0, gamma: 0 });
  const [activePads, setActivePads] = useState<Set<number>>(new Set());
  const [mappings, setMappings] = useState<AxisMappings>({ ...DEFAULT_MAPPINGS });

  useEffect(() => {
    engineRef.current = new AudioEngine();
    return () => {
      engineRef.current?.allOff();
      cleanupMotionRef.current?.();
    };
  }, []);

  const isSecureContext =
    typeof window !== "undefined" &&
    (window.isSecureContext || location.protocol === "https:" || location.hostname === "localhost");

  const handleStart = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine || engine.isStarted()) return;
    setErrorMsg(null);

    setMotionStatus("requesting permission...");
    const permResult = await requestMotionPermission();

    try {
      await engine.start();
      setStarted(true);
    } catch (e) {
      setErrorMsg(`Audio failed: ${e instanceof Error ? e.message : e}`);
      setMotionStatus("error");
      return;
    }

    switch (permResult) {
      case "granted":
      case "not-needed": {
        const cleanup = listenMotion((values) => {
          engine.setMotion(values.alpha, values.beta, values.gamma);
          setMotion(values);
        });
        cleanupMotionRef.current = cleanup;
        setMotionStatus("active");
        break;
      }
      case "denied":
        setMotionStatus("denied");
        setErrorMsg(
          "Motion permission denied. On iOS: Settings → Safari → Motion & Orientation Access must be ON. Then reload and tap Start again."
        );
        break;
      case "no-sensor":
        setMotionStatus("unavailable");
        setErrorMsg("No motion sensor detected on this device.");
        break;
    }
  }, []);

  const updateMapping = useCallback(
    (axis: keyof AxisMappings, list: ControlTarget[]) => {
      setMappings((prev) => {
        const next = { ...prev, [axis]: nextTarget(prev[axis], list) };
        engineRef.current?.setMappings(next);
        return next;
      });
    },
    []
  );

  const padDown = useCallback((midi: number) => {
    engineRef.current?.noteOn(midi);
    setActivePads((prev) => new Set(prev).add(midi));
  }, []);

  const padUp = useCallback((midi: number) => {
    engineRef.current?.noteOff(midi);
    setActivePads((prev) => {
      const next = new Set(prev);
      next.delete(midi);
      return next;
    });
  }, []);

  return (
    <div className="synth-container">
      {!started ? (
        <div className="start-screen">
          {!isSecureContext && (
            <div className="warning">
              Not on HTTPS — motion sensors will not work.
              <br />
              Deploy to Vercel or use an ngrok/cloudflared tunnel.
            </div>
          )}
          <button className="start-btn" onClick={handleStart}>
            Tap to Start
          </button>
          {errorMsg && <div className="error-msg">{errorMsg}</div>}
        </div>
      ) : (
        <>
          <div className="header">
            <h1>Motion Synth</h1>
            <div className="status">
              <span
                className={`dot ${
                  motionStatus === "active"
                    ? "green"
                    : motionStatus === "denied" || motionStatus === "error"
                      ? "red"
                      : "yellow"
                }`}
              />
              <span>Motion: {motionStatus}</span>
            </div>
          </div>

          {errorMsg && <div className="error-banner">{errorMsg}</div>}

          <div className="pad-grid">
            {MIDI_NOTES.map((midi, i) => (
              <button
                key={midi}
                className={`pad ${activePads.has(midi) ? "active" : ""}`}
                style={
                  {
                    "--pad-color": PAD_COLORS[i],
                    "--pad-glow": PAD_COLORS[i] + "88",
                  } as React.CSSProperties
                }
                onPointerDown={(e) => {
                  e.preventDefault();
                  padDown(midi);
                }}
                onPointerUp={() => padUp(midi)}
                onPointerLeave={() => padUp(midi)}
                onPointerCancel={() => padUp(midi)}
              >
                <span className="pad-note">{NOTE_NAMES[i]}</span>
                <span className="pad-octave">{midi < 72 ? "4" : "5"}</span>
              </button>
            ))}
          </div>

          <div className="controls-panel">
            <AxisRow
              label="↕ Fwd/Back"
              axis="beta"
              value={motion.beta}
              target={mappings.beta}
              targets={BETA_TARGETS}
              color="#f472b6"
              onCycle={() => updateMapping("beta", BETA_TARGETS)}
            />
            <AxisRow
              label="↔ Left/Right"
              axis="gamma"
              value={motion.gamma}
              target={mappings.gamma}
              targets={GAMMA_TARGETS}
              color="#a78bfa"
              onCycle={() => updateMapping("gamma", GAMMA_TARGETS)}
            />
            <AxisRow
              label="↻ Twist"
              axis="alpha"
              value={motion.alpha}
              target={mappings.alpha}
              targets={ALPHA_TARGETS}
              color="#38bdf8"
              onCycle={() => updateMapping("alpha", ALPHA_TARGETS)}
            />
          </div>
        </>
      )}
    </div>
  );
}

function AxisRow({
  label,
  value,
  target,
  color,
  onCycle,
}: {
  label: string;
  axis: string;
  value: number;
  target: ControlTarget;
  targets: ControlTarget[];
  color: string;
  onCycle: () => void;
}) {
  const pct = Math.abs(value) * 50;
  const isNeg = value < 0;

  return (
    <div className="axis-row">
      <span className="axis-label">{label}</span>
      <div className="axis-bar-track">
        <div
          className="axis-bar-fill"
          style={{
            width: `${pct.toFixed(1)}%`,
            left: isNeg ? undefined : "50%",
            right: isNeg ? "50%" : undefined,
            background: color,
          }}
        />
        <div className="axis-bar-center" />
      </div>
      <span className="axis-val">{value.toFixed(2)}</span>
      <button
        className="axis-target-btn"
        style={{ borderColor: color, color }}
        onClick={onCycle}
      >
        {TARGET_LABELS[target]}
      </button>
    </div>
  );
}
