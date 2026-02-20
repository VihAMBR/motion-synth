"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AudioEngine } from "../lib/audio/engine";
import { startMotion } from "../lib/motion/sensors";

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

export default function Home() {
  const engineRef = useRef<AudioEngine | null>(null);
  const cleanupMotionRef = useRef<(() => void) | null>(null);

  const [started, setStarted] = useState(false);
  const [motionStatus, setMotionStatus] = useState("idle");
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const [activePads, setActivePads] = useState<Set<number>>(new Set());

  useEffect(() => {
    engineRef.current = new AudioEngine();
    return () => {
      engineRef.current?.allOff();
      cleanupMotionRef.current?.();
    };
  }, []);

  const handleStart = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine || engine.isStarted()) return;

    try {
      await engine.start();
      setStarted(true);
    } catch {
      setMotionStatus("audio failed");
      return;
    }

    try {
      setMotionStatus("requesting...");
      const cleanup = await startMotion((tiltX, tiltY) => {
        engine.setMotion(tiltX, tiltY);
        setTilt({ x: tiltX, y: tiltY });
      });
      cleanupMotionRef.current = cleanup;
      setMotionStatus("active");
    } catch {
      setMotionStatus("no motion (desktop?)");
    }
  }, []);

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
        <button className="start-btn" onClick={handleStart}>
          Tap to Start
        </button>
      ) : (
        <>
          <div className="header">
            <h1>Motion Synth</h1>
            <div className="status">
              <span className={`dot ${motionStatus === "active" ? "green" : "yellow"}`} />
              <span>Motion: {motionStatus}</span>
            </div>
          </div>

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

          <div className="debug">
            <div className="tilt-display">
              <div className="tilt-bar-group">
                <label>Tilt X (vibrato)</label>
                <div className="tilt-bar-track">
                  <div
                    className="tilt-bar-fill x"
                    style={{ width: `${(Math.abs(tilt.x) * 50).toFixed(1)}%`, left: tilt.x < 0 ? undefined : "50%", right: tilt.x < 0 ? "50%" : undefined }}
                  />
                  <div className="tilt-bar-center" />
                </div>
                <span className="tilt-val">{tilt.x.toFixed(2)}</span>
              </div>
              <div className="tilt-bar-group">
                <label>Tilt Y (filter)</label>
                <div className="tilt-bar-track">
                  <div
                    className="tilt-bar-fill y"
                    style={{ width: `${(Math.abs(tilt.y) * 50).toFixed(1)}%`, left: tilt.y < 0 ? undefined : "50%", right: tilt.y < 0 ? "50%" : undefined }}
                  />
                  <div className="tilt-bar-center" />
                </div>
                <span className="tilt-val">{tilt.y.toFixed(2)}</span>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
