export type MotionHandler = (tiltX: number, tiltY: number) => void;

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function normalize(beta: number | null, gamma: number | null) {
  const b = beta ?? 0;
  const g = gamma ?? 0;

  const tiltY = clamp(b / 45, -1, 1);
  const tiltX = clamp(g / 45, -1, 1);
  return { tiltX, tiltY };
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
  let smoothX = 0;
  let smoothY = 0;
  const alpha = 0.25;

  let last = 0;
  const handler = (e: DeviceOrientationEvent) => {
    const now = performance.now();
    if (now - last < 16) return;
    last = now;

    const { tiltX, tiltY } = normalize(e.beta, e.gamma);

    smoothX += alpha * (tiltX - smoothX);
    smoothY += alpha * (tiltY - smoothY);

    onMotion(smoothX, smoothY);
  };

  window.addEventListener("deviceorientation", handler, true);

  return () => {
    window.removeEventListener("deviceorientation", handler, true);
  };
}
