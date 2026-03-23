export type TemplateType = 'abstract' | 'heart' | 'flower' | 'saturn' | 'fireworks';

export interface ParticleData {
  positions: Float32Array;
  colors:    Float32Array;
  sizes:     Float32Array;
}

// ─── Public API ───────────────────────────────────────────────────────────────
export function generateTemplate(type: TemplateType, count: number): ParticleData {
  const positions = new Float32Array(count * 3);
  const colors    = new Float32Array(count * 3);
  const sizes     = new Float32Array(count);

  switch (type) {

    // ── ❤️  Heart ──────────────────────────────────────────────────────────
    case 'heart': {
      for (let i = 0; i < count; i++) {
        const t     = Math.random() * Math.PI * 2;
        const scale = 0.28 + Math.random() * 0.18; // spread over multiple radii
        const jitter = 0.55;

        // Classic 3-D heart parametric equations
        const x =  16 * Math.pow(Math.sin(t), 3)                              * scale;
        const y = (13 * Math.cos(t) - 5 * Math.cos(2 * t)
                 -  2 * Math.cos(3 * t) - Math.cos(4 * t))                    * scale;
        const z = (Math.random() - 0.5) * 2.5;

        positions[i * 3]     = x + (Math.random() - 0.5) * jitter;
        positions[i * 3 + 1] = y - 1.2 + (Math.random() - 0.5) * jitter; // center
        positions[i * 3 + 2] = z;

        // Warm crimson → deep pink gradient
        const w = Math.random();
        colors[i * 3]     = 0.80 + w * 0.20;
        colors[i * 3 + 1] = 0.08 + w * 0.22;
        colors[i * 3 + 2] = 0.20 + Math.random() * 0.30;

        sizes[i] = 0.22 + Math.random() * 0.42;
      }
      break;
    }

    // ── 🌸  Flower ─────────────────────────────────────────────────────────
    case 'flower': {
      for (let i = 0; i < count; i++) {
        // 6-petal polar rose: r = a·|cos(3θ)|
        const theta  = Math.random() * Math.PI * 2;
        const r      = 9.5 * Math.pow(Math.abs(Math.cos(3 * theta)), 0.6);
        const noiseR = r + (Math.random() - 0.5) * 1.8;

        positions[i * 3]     = noiseR * Math.cos(theta);
        positions[i * 3 + 1] = noiseR * Math.sin(theta);
        positions[i * 3 + 2] = (Math.random() - 0.5) * 2.5;

        // Magenta → soft lavender
        const h = 0.80 + Math.random() * 0.15;
        const [r2, g, b] = hslToRgb(h, 0.85, 0.55 + Math.random() * 0.25);
        colors[i * 3]     = r2;
        colors[i * 3 + 1] = g;
        colors[i * 3 + 2] = b;

        sizes[i] = 0.18 + Math.random() * 0.32;
      }
      break;
    }

    // ── 🪐  Saturn ────────────────────────────────────────────────────────
    case 'saturn': {
      const sphereCount = Math.floor(count * 0.35);
      const ringCount   = count - sphereCount;

      // Planet body – Fibonacci sphere for uniform coverage
      for (let i = 0; i < sphereCount; i++) {
        const idx   = i + 0.5;
        const phi   = Math.acos(1 - 2 * idx / sphereCount);
        const theta = Math.PI * (1 + Math.sqrt(5)) * idx;
        const r     = 4.2 + Math.random() * 0.35;

        positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
        positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
        positions[i * 3 + 2] = r * Math.cos(phi);

        colors[i * 3]     = 0.86 + Math.random() * 0.14;
        colors[i * 3 + 1] = 0.64 + Math.random() * 0.20;
        colors[i * 3 + 2] = 0.28 + Math.random() * 0.15;

        sizes[i] = 0.18 + Math.random() * 0.24;
      }

      // Three ring bands at different radii + tilt
      const RINGS = [
        { inner: 5.5, outer: 6.8, brightness: 0.9 },
        { inner: 7.2, outer: 8.6, brightness: 0.75 },
        { inner: 9.0, outer: 10.5, brightness: 0.6 },
      ];
      const tilt = 0.38; // ring-plane tilt in radians

      for (let i = 0; i < ringCount; i++) {
        const idx    = sphereCount + i;
        const band   = RINGS[i % RINGS.length];
        const r      = band.inner + Math.random() * (band.outer - band.inner);
        const theta  = Math.random() * Math.PI * 2;

        const flatX  = r * Math.cos(theta);
        const flatY  = r * Math.sin(theta);

        positions[idx * 3]     = flatX;
        positions[idx * 3 + 1] = flatY * Math.cos(tilt) + (Math.random() - 0.5) * 0.12;
        positions[idx * 3 + 2] = flatY * Math.sin(tilt) * 2.8; // depth stretch

        const b = band.brightness;
        colors[idx * 3]     = b * (0.75 + Math.random() * 0.25);
        colors[idx * 3 + 1] = b * (0.55 + Math.random() * 0.25);
        colors[idx * 3 + 2] = b * (0.18 + Math.random() * 0.18);

        sizes[idx] = 0.10 + Math.random() * 0.18;
      }
      break;
    }

    // ── 🎆  Fireworks ──────────────────────────────────────────────────────
    case 'fireworks': {
      const BURST_CENTERS = Array.from({ length: 8 }, () => ({
        x: (Math.random() - 0.5) * 22,
        y:  2 + Math.random() * 9,
        z: (Math.random() - 0.5) * 8,
      }));

      for (let i = 0; i < count; i++) {
        const burst = BURST_CENTERS[i % BURST_CENTERS.length];
        const phi   = Math.random() * Math.PI * 2;
        const theta = Math.random() * Math.PI;
        const r     = Math.random() * 5.5;

        positions[i * 3]     = burst.x + r * Math.sin(theta) * Math.cos(phi);
        positions[i * 3 + 1] = burst.y + r * Math.cos(theta);
        positions[i * 3 + 2] = burst.z + r * Math.sin(theta) * Math.sin(phi);

        const h = (i / count + Math.random() * 0.04) % 1.0;
        const [r2, g, b] = hslToRgb(h, 1.0, 0.62 + Math.random() * 0.22);
        colors[i * 3]     = r2;
        colors[i * 3 + 1] = g;
        colors[i * 3 + 2] = b;

        sizes[i] = 0.18 + Math.random() * 0.52;
      }
      break;
    }

    // ── ✨  Abstract (default) ──────────────────────────────────────────────
    case 'abstract':
    default: {
      for (let i = 0; i < count; i++) {
        let x: number, y: number, z: number;
        const roll = Math.random();

        if (roll < 0.55) {
          // Outer Fibonacci sphere
          const idx   = i + 0.5;
          const phi   = Math.acos(1 - 2 * idx / count);
          const theta = Math.PI * (1 + Math.sqrt(5)) * idx;
          const r     = 7.5 + Math.random() * 3.0;
          x = r * Math.sin(phi) * Math.cos(theta);
          y = r * Math.sin(phi) * Math.sin(theta);
          z = r * Math.cos(phi);
        } else if (roll < 0.82) {
          // Triple spiral arms
          const t       = Math.random() * Math.PI * 8;
          const arm     = Math.floor(Math.random() * 3);
          const armBase = arm * (Math.PI * 2 / 3);
          const sr      = (t / (Math.PI * 8)) * 10.5;
          x = sr * Math.cos(t + armBase) + (Math.random() - 0.5) * 1.4;
          y = sr * Math.sin(t + armBase) + (Math.random() - 0.5) * 1.4;
          z = (Math.random() - 0.5) * 3.5;
        } else {
          // Inner nebula cloud
          x = (Math.random() - 0.5) * 5;
          y = (Math.random() - 0.5) * 5;
          z = (Math.random() - 0.5) * 5;
        }

        positions[i * 3]     = x;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = z;

        // Cyan → blue → purple spectrum
        const h = 0.50 + Math.random() * 0.22;
        const [r2, g, b] = hslToRgb(h, 0.80, 0.45 + Math.random() * 0.30);
        colors[i * 3]     = r2;
        colors[i * 3 + 1] = g;
        colors[i * 3 + 2] = b;

        sizes[i] = 0.18 + Math.random() * 0.38;
      }
      break;
    }
  }

  return { positions, colors, sizes };
}

// ─── HSL → RGB helper ────────────────────────────────────────────────────────
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  let r: number, g: number, b: number;

  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p: number, q: number, t: number): number => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }

  return [r, g, b];
}
