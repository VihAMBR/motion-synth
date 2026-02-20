"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AudioEngine } from "../lib/audio/engine";
import { requestMotionPermission, listenMotion } from "../lib/motion/sensors";

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
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const [activePads, setActivePads] = useState<Set<number>>(new Set());

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

    // Step 1: Request motion permission FIRST — must happen synchronously
    // in the user-gesture call stack before any other awaits.
    setMotionStatus("requesting permission...");
    const permResult = await requestMotionPermission();

    // Step 2: Start audio (this can be async, gesture context already used above)
    try {
      await engine.start();
      setStarted(true);
    } catch (e) {
      setErrorMsg(`Audio failed: ${e instanceof Error ? e.message : e}`);
      setMotionStatus("error");
      return;
    }

    // Step 3: Attach motion listener based on permission result
    switch (permResult) {
      case "granted":
      case "not-needed": {
        const cleanup = listenMotion((tiltX, tiltY) => {
          engine.setMotion(tiltX, tiltY);
          setTilt({ x: tiltX, y: tiltY });
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

          <div className="debug">
            <div className="tilt-display">
              <div className="tilt-bar-group">
                <label>Tilt X (vibrato)</label>
                <div className="tilt-bar-track">
                  <div
                    className="tilt-bar-fill x"
                    style={{
                      width: `${(Math.abs(tilt.x) * 50).toFixed(1)}%`,
                      left: tilt.x < 0 ? undefined : "50%",
                      right: tilt.x < 0 ? "50%" : undefined,
                    }}
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
                    style={{
                      width: `${(Math.abs(tilt.y) * 50).toFixed(1)}%`,
                      left: tilt.y < 0 ? undefined : "50%",
                      right: tilt.y < 0 ? "50%" : undefined,
                    }}
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
