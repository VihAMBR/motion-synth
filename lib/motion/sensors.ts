export type Calibration = {
  betaOffset: number;
  gammaOffset: number;
};

export type SensorState = {
  bowEnergy: number;     // 0..1
  bowDirection: number;  // 1 (down-bow/forward) or -1 (up-bow/back)
  bowOnset: boolean;     // true the frame direction reverses with energy
  beta: number;          // calibrated forward/back tilt, -1..1
  gamma: number;         // calibrated left/right tilt, -1..1
};

export type SensorCallback = (state: SensorState) => void;

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

// --- iOS permission helpers ---

async function requestPermission(EventType: unknown): Promise<boolean> {
  const E = EventType as { requestPermission?: () => Promise<string> };
  if (typeof E?.requestPermission === "function") {
    try {
      return (await E.requestPermission()) === "granted";
    } catch {
      return false;
    }
  }
  return true; // no permission needed (Android / desktop)
}

export async function requestAllPermissions(): Promise<{
  motion: boolean;
  orientation: boolean;
}> {
  const motion = await requestPermission(DeviceMotionEvent);
  const orientation = await requestPermission(DeviceOrientationEvent);
  return { motion, orientation };
}

// --- Bow velocity processor ---

const DAMPING = 0.91;
const DEAD_ZONE = 0.06;
const MAX_VEL = 10;
const MIN_ONSET_GAP_MS = 120;

class BowProcessor {
  private velocity = 0;
  private direction = 1;
  private lastOnsetTime = 0;
  private lastTime = 0;
  invertAxis = false;

  reset() {
    this.velocity = 0;
  }

  /** Feed raw acceleration along bow axis. Returns bow state. */
  update(accel: number): { energy: number; direction: number; onset: boolean } {
    const now = performance.now();
    const dt = this.lastTime ? Math.min((now - this.lastTime) / 1000, 0.05) : 0.016;
    this.lastTime = now;

    const a = this.invertAxis ? -accel : accel;

    this.velocity += a * dt;
    this.velocity *= Math.pow(DAMPING, dt * 60); // frame-rate independent
    this.velocity = clamp(this.velocity, -MAX_VEL, MAX_VEL);

    const absV = Math.abs(this.velocity);
    let energy = absV / MAX_VEL;
    energy = energy < DEAD_ZONE ? 0 : (energy - DEAD_ZONE) / (1 - DEAD_ZONE);
    energy = Math.min(1, energy);

    let onset = false;
    const newDir = this.velocity >= 0 ? 1 : -1;
    if (newDir !== this.direction && energy > 0.12) {
      if (now - this.lastOnsetTime > MIN_ONSET_GAP_MS) {
        onset = true;
        this.lastOnsetTime = now;
      }
      this.direction = newDir;
    }

    return { energy, direction: this.direction, onset };
  }
}

// --- Combined sensor listener ---

export function listenSensors(
  callback: SensorCallback,
  calibration: Calibration | null,
  invertBow: boolean,
): () => void {
  const bow = new BowProcessor();
  bow.invertAxis = invertBow;

  let latestBeta = 0;
  let latestGamma = 0;
  let smoothBeta = 0;
  let smoothGamma = 0;
  const k = 0.2;

  const bOff = calibration?.betaOffset ?? 0;
  const gOff = calibration?.gammaOffset ?? 0;

  // --- Orientation listener ---
  const onOrientation = (e: DeviceOrientationEvent) => {
    latestBeta = (e.beta ?? 0) - bOff;
    latestGamma = (e.gamma ?? 0) - gOff;
  };
  window.addEventListener("deviceorientation", onOrientation, true);

  // --- Motion listener (acceleration for bow) ---
  let lastMotionTime = performance.now();

  const onMotion = (e: DeviceMotionEvent) => {
    lastMotionTime = performance.now();

    // Use pure acceleration if available, else accelerationIncludingGravity
    const acc = e.acceleration?.z ?? e.accelerationIncludingGravity?.z ?? 0;
    const bowState = bow.update(acc);

    // Smooth tilt values
    smoothBeta += k * (clamp(latestBeta / 45, -1, 1) - smoothBeta);
    smoothGamma += k * (clamp(latestGamma / 45, -1, 1) - smoothGamma);

    callback({
      bowEnergy: bowState.energy,
      bowDirection: bowState.direction,
      bowOnset: bowState.onset,
      beta: smoothBeta,
      gamma: smoothGamma,
    });
  };
  window.addEventListener("devicemotion", onMotion, true);

  // --- Safety watchdog: decay bow if no motion events for 400ms ---
  const watchdog = setInterval(() => {
    if (performance.now() - lastMotionTime > 400) {
      bow.reset();
      callback({
        bowEnergy: 0,
        bowDirection: 1,
        bowOnset: false,
        beta: smoothBeta,
        gamma: smoothGamma,
      });
    }
  }, 200);

  return () => {
    window.removeEventListener("deviceorientation", onOrientation, true);
    window.removeEventListener("devicemotion", onMotion, true);
    clearInterval(watchdog);
  };
}

/** Snapshot current orientation for calibration offsets. */
export function captureCalibration(): Promise<Calibration> {
  return new Promise((resolve) => {
    const handler = (e: DeviceOrientationEvent) => {
      window.removeEventListener("deviceorientation", handler, true);
      resolve({
        betaOffset: e.beta ?? 0,
        gammaOffset: e.gamma ?? 0,
      });
    };
    window.addEventListener("deviceorientation", handler, true);

    // Fallback if no event within 500ms
    setTimeout(() => {
      window.removeEventListener("deviceorientation", handler, true);
      resolve({ betaOffset: 0, gammaOffset: 0 });
    }, 500);
  });
}
