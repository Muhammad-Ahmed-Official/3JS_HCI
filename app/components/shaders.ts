// ─── Vertex Shader ────────────────────────────────────────────────────────────
export const vertexShader = /* glsl */ `
  // Per-particle custom attributes (set on BufferGeometry)
  attribute float size;
  attribute vec3  customColor;

  varying vec3  vColor;
  varying float vDepthFade;

  uniform float time;
  uniform float gestureIntensity; // 0–1, driven by gesture strength

  void main() {
    vColor = customColor;

    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);

    // Gentle size pulse keyed to time + position (gives organic feel)
    float pulse = 1.0 + 0.12 * sin(time * 3.5 + position.x * 0.6 + position.y * 0.4)
                      * gestureIntensity;

    // Perspective-correct point size: bigger when closer to camera
    gl_PointSize  = size * pulse * (380.0 / -mvPosition.z);
    gl_Position   = projectionMatrix * mvPosition;

    // Depth fade: particles far from camera become subtler
    vDepthFade = clamp(1.0 - (-mvPosition.z - 10.0) / 60.0, 0.3, 1.0);
  }
`;

// ─── Fragment Shader ──────────────────────────────────────────────────────────
export const fragmentShader = /* glsl */ `
  varying vec3  vColor;
  varying float vDepthFade;

  void main() {
    // gl_PointCoord is 0–1 across the point sprite
    vec2  center = gl_PointCoord - vec2(0.5);
    float r      = length(center);

    // Hard clip beyond unit circle
    if (r > 0.5) discard;

    // Bright inner core + soft outer glow
    float core  = 1.0 - smoothstep(0.0,  0.18, r); // sharp center
    float glow  = 1.0 - smoothstep(0.18, 0.50, r); // wide halo

    float alpha = (core * 0.95 + glow * 0.30) * vDepthFade;

    // Slightly brighten the center
    vec3  color = vColor * vDepthFade + vec3(core * 0.22);

    gl_FragColor = vec4(color, alpha);
  }
`;
