export type MotionValues = {
  alpha: number; // twist / compass — normalized to -1..1
  beta: number;  // forward-back tilt — normalized to -1..1
  gamma: number; // left-right tilt — normalized to -1..1
};

export type MotionHandler = (values: MotionValues) => void;

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

/**
 * Must be called synchronously inside a user-gesture handler (tap/click)
 * BEFORE any awaits, otherwise iOS will silently block the permission dialog.
 */
export async function requestMotionPermission(): Promise<
  "granted" | "denied" | "not-needed" | "no-sensor"
> {
  if (typeof window === "undefined") return "no-sensor";

  const DOE = DeviceOrientationEvent as unknown as {
    requestPermission?: () => Promise<string>;
  };

  if (typeof DOE.requestPermission === "function") {
    try {
      const result = await DOE.requestPermission();
      return result === "granted" ? "granted" : "denied";
    } catch {
      return "denied";
    }
  }

  if ("DeviceOrientationEvent" in window) {
    return "not-needed";
  }

  return "no-sensor";
}

export function listenMotion(onMotion: MotionHandler): () => void {
  let smoothAlpha = 0;
  let smoothBeta = 0;
  let smoothGamma = 0;
  const k = 0.25; // smoothing factor

  // Alpha (compass heading 0..360) needs special handling:
  // we track it as a delta from a baseline to get -1..1
  let alphaBaseline: number | null = null;

  let last = 0;
  const handler = (e: DeviceOrientationEvent) => {
    const now = performance.now();
    if (now - last < 16) return;
    last = now;

    // Beta: -180..180, most useful range ≈ -45..45
    const rawBeta = clamp((e.beta ?? 0) / 45, -1, 1);
    // Gamma: -90..90, most useful range ≈ -45..45
    const rawGamma = clamp((e.gamma ?? 0) / 45, -1, 1);

    // Alpha: 0..360 compass heading → normalize as offset from initial position
    let rawAlpha = 0;
    if (e.alpha !== null) {
      if (alphaBaseline === null) alphaBaseline = e.alpha;
      let delta = e.alpha - alphaBaseline;
      // Wrap to -180..180
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      rawAlpha = clamp(delta / 45, -1, 1);
    }

    smoothAlpha += k * (rawAlpha - smoothAlpha);
    smoothBeta += k * (rawBeta - smoothBeta);
    smoothGamma += k * (rawGamma - smoothGamma);

    onMotion({
      alpha: smoothAlpha,
      beta: smoothBeta,
      gamma: smoothGamma,
    });
  };

  window.addEventListener("deviceorientation", handler, true);

  return () => {
    window.removeEventListener("deviceorientation", handler, true);
  };
}
