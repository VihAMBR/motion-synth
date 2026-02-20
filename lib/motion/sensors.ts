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

export async function startMotion(onMotion: MotionHandler) {
  const anyOrientation = DeviceOrientationEvent as unknown as {
    requestPermission?: () => Promise<string>;
  };

  if (typeof anyOrientation?.requestPermission === "function") {
    const res = await anyOrientation.requestPermission();
    if (res !== "granted") {
      throw new Error("Motion permission not granted");
    }
  }

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
