"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ViolinEngine,
  SCALE_MIDI,
  MIDI_LOW,
  MIDI_HIGH,
  midiToNoteName,
  yNormToMidi,
  midiToYNorm,
} from "../lib/audio/engine";
import {
  requestAllPermissions,
  listenSensors,
  captureCalibration,
  Calibration,
  SensorState,
} from "../lib/motion/sensors";

export default function Home() {
  const engineRef = useRef<ViolinEngine | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const fingerboardRef = useRef<HTMLDivElement>(null);
  const touchIndicatorRef = useRef<HTMLDivElement>(null);
  const touchActiveRef = useRef(false);
  const calibrationRef = useRef<Calibration | null>(null);

  const [phase, setPhase] = useState<"start" | "playing">("start");
  const [motionStatus, setMotionStatus] = useState("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [quantized, setQuantized] = useState(true);
  const [invertBow, setInvertBow] = useState(false);
  const [currentNote, setCurrentNote] = useState<string | null>(null);
  const [bowState, setBowState] = useState({ energy: 0, direction: 1 });
  const [tiltState, setTiltState] = useState({ beta: 0, gamma: 0 });

  useEffect(() => {
    engineRef.current = new ViolinEngine();
    return () => {
      engineRef.current?.allOff();
      cleanupRef.current?.();
    };
  }, []);

  const isSecure =
    typeof window !== "undefined" &&
    (window.isSecureContext ||
      location.protocol === "https:" ||
      location.hostname === "localhost");

  // --- Start ---
  const handleStart = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine || engine.isStarted()) return;
    setErrorMsg(null);

    // Permissions first (must be in gesture call stack)
    setMotionStatus("requesting...");
    const perms = await requestAllPermissions();

    try {
      await engine.start();
    } catch (e) {
      setErrorMsg(`Audio failed: ${e instanceof Error ? e.message : e}`);
      return;
    }

    setPhase("playing");

    if (perms.motion && perms.orientation) {
      startSensorLoop(engine);
    } else if (perms.orientation) {
      setMotionStatus("orientation only (no bow)");
      startSensorLoop(engine);
    } else {
      setMotionStatus("denied");
      setErrorMsg(
        "Motion permission denied. On iOS: Settings → Safari → Motion & Orientation Access → ON, then reload."
      );
    }
  }, []);

  const startSensorLoop = useCallback(
    (engine: ViolinEngine) => {
      cleanupRef.current?.();
      const cleanup = listenSensors(
        (s: SensorState) => {
          engine.setBow(s.bowEnergy, s.bowDirection);
          engine.setBrightness((s.beta + 1) * 0.5);
          engine.setVibratoDepth(s.gamma);
          if (s.bowOnset) engine.triggerOnset();
          setBowState({ energy: s.bowEnergy, direction: s.bowDirection });
          setTiltState({ beta: s.beta, gamma: s.gamma });
        },
        calibrationRef.current,
        invertBow,
      );
      cleanupRef.current = cleanup;
      setMotionStatus("active");
    },
    [invertBow],
  );

  // --- Calibrate ---
  const handleCalibrate = useCallback(async () => {
    const cal = await captureCalibration();
    calibrationRef.current = cal;
    const engine = engineRef.current;
    if (engine?.isStarted()) startSensorLoop(engine);
  }, [startSensorLoop]);

  // --- Invert bow ---
  const toggleInvertBow = useCallback(() => {
    setInvertBow((prev) => {
      const next = !prev;
      const engine = engineRef.current;
      if (engine?.isStarted()) {
        cleanupRef.current?.();
        const cleanup = listenSensors(
          (s: SensorState) => {
            engine.setBow(s.bowEnergy, s.bowDirection);
            engine.setBrightness((s.beta + 1) * 0.5);
            engine.setVibratoDepth(s.gamma);
            if (s.bowOnset) engine.triggerOnset();
            setBowState({ energy: s.bowEnergy, direction: s.bowDirection });
            setTiltState({ beta: s.beta, gamma: s.gamma });
          },
          calibrationRef.current,
          next,
        );
        cleanupRef.current = cleanup;
      }
      return next;
    });
  }, []);

  // --- Fingerboard pointer handling ---

  const quantizedRef = useRef(quantized);
  quantizedRef.current = quantized;

  const getYNorm = useCallback((clientY: number) => {
    const rect = fingerboardRef.current?.getBoundingClientRect();
    if (!rect) return 0.5;
    return Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
  }, []);

  const handleFingerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      touchActiveRef.current = true;

      const yNorm = getYNorm(e.clientY);
      const midi = yNormToMidi(yNorm, quantizedRef.current);
      engineRef.current?.setPitch(midi);
      engineRef.current?.setGate(true);
      setCurrentNote(midiToNoteName(midi));

      if (touchIndicatorRef.current) {
        const displayY = quantizedRef.current
          ? midiToYNorm(midi) * 100
          : yNorm * 100;
        touchIndicatorRef.current.style.top = `${displayY}%`;
        touchIndicatorRef.current.style.opacity = "1";
      }
    },
    [getYNorm],
  );

  const handleFingerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!touchActiveRef.current) return;
      const yNorm = getYNorm(e.clientY);
      const midi = yNormToMidi(yNorm, quantizedRef.current);
      engineRef.current?.setPitch(midi);
      setCurrentNote(midiToNoteName(midi));

      if (touchIndicatorRef.current) {
        const displayY = quantizedRef.current
          ? midiToYNorm(midi) * 100
          : yNorm * 100;
        touchIndicatorRef.current.style.top = `${displayY}%`;
      }
    },
    [getYNorm],
  );

  const handleFingerUp = useCallback(() => {
    touchActiveRef.current = false;
    engineRef.current?.setGate(false);
    setCurrentNote(null);
    if (touchIndicatorRef.current) {
      touchIndicatorRef.current.style.opacity = "0";
    }
  }, []);

  // --- Render ---

  if (phase === "start") {
    return (
      <div className="container start-screen">
        <h1 className="title">Motion Violin</h1>
        <p className="subtitle">
          Touch the string. Bow with your phone.
        </p>
        {!isSecure && (
          <div className="warning">
            Not on HTTPS — motion sensors will not work.
            <br />
            Deploy to Vercel or use ngrok.
          </div>
        )}
        <button className="start-btn" onClick={handleStart}>
          Tap to Start
        </button>
        {errorMsg && <div className="error-msg">{errorMsg}</div>}
      </div>
    );
  }

  const bowPct = (bowState.energy * 100).toFixed(0);
  const bowArrow = bowState.direction > 0 ? "→" : "←";

  return (
    <div className="container playing">
      {/* --- Top bar --- */}
      <div className="top-bar">
        <div className="note-display">
          <span className="note-name">{currentNote ?? "—"}</span>
          <span className="bow-dir">{bowArrow}</span>
        </div>
        <div className="status-row">
          <span
            className={`dot ${
              motionStatus === "active"
                ? "green"
                : motionStatus === "denied"
                  ? "red"
                  : "yellow"
            }`}
          />
          <span className="status-text">{motionStatus}</span>
        </div>
      </div>

      {errorMsg && <div className="error-banner">{errorMsg}</div>}

      {/* --- Bow energy bar --- */}
      <div className="bow-bar-container">
        <div
          className="bow-bar-fill"
          style={{ width: `${bowPct}%` }}
        />
        <span className="bow-bar-label">Bow {bowPct}%</span>
      </div>

      {/* --- Fingerboard --- */}
      <div
        ref={fingerboardRef}
        className="fingerboard"
        onPointerDown={handleFingerDown}
        onPointerMove={handleFingerMove}
        onPointerUp={handleFingerUp}
        onPointerCancel={handleFingerUp}
      >
        {/* Scale markers */}
        {quantized &&
          SCALE_MIDI.map((midi) => {
            const y = midiToYNorm(midi) * 100;
            return (
              <div
                key={midi}
                className="scale-marker"
                style={{ top: `${y}%` }}
              >
                <span className="marker-label">
                  {midiToNoteName(midi)}
                </span>
                <div className="marker-line" />
              </div>
            );
          })}

        {/* Touch indicator */}
        <div ref={touchIndicatorRef} className="touch-indicator" />
      </div>

      {/* --- Tilt readouts --- */}
      <div className="tilt-row">
        <div className="tilt-item">
          <span className="tilt-label">↕ Brightness</span>
          <div className="tilt-mini-bar">
            <div
              className="tilt-mini-fill bright"
              style={{ width: `${((tiltState.beta + 1) * 50).toFixed(0)}%` }}
            />
          </div>
        </div>
        <div className="tilt-item">
          <span className="tilt-label">↔ Vibrato</span>
          <div className="tilt-mini-bar">
            <div
              className="tilt-mini-fill vib"
              style={{ width: `${(Math.abs(tiltState.gamma) * 100).toFixed(0)}%` }}
            />
          </div>
        </div>
      </div>

      {/* --- Bottom controls --- */}
      <div className="bottom-bar">
        <button
          className={`ctrl-btn ${quantized ? "active" : ""}`}
          onClick={() => setQuantized((q) => !q)}
        >
          {quantized ? "Quantized" : "Continuous"}
        </button>
        <button className="ctrl-btn" onClick={handleCalibrate}>
          Calibrate
        </button>
        <button
          className={`ctrl-btn ${invertBow ? "active" : ""}`}
          onClick={toggleInvertBow}
        >
          Invert Bow
        </button>
        <button
          className="ctrl-btn danger"
          onClick={() => engineRef.current?.allOff()}
        >
          All Off
        </button>
      </div>
    </div>
  );
}
