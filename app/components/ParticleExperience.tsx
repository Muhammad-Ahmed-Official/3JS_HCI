'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { vertexShader, fragmentShader } from './shaders';
import { generateTemplate, TemplateType } from './particleTemplates';

// ── Constants ─────────────────────────────────────────────────────────────────
const PARTICLE_COUNT  = 8_000;  // main particles
const BG_COUNT        = 1_800;  // background star layer
const SPRING_K        = 0.018;  // spring toward template target (per frame)
const DAMPING         = 0.925;  // velocity damping (per frame)
const BURST_COOLDOWN  = 700;    // ms between pinch bursts

type GestureType = 'open' | 'fist' | 'pinch' | 'none';


// ── Per-gesture instruction data ──────────────────────────────────────────────
// Each entry drives the left guide panel + the live feedback card.
const GESTURE_GUIDE = [
  {
    type:       'open' as GestureType,
    icon:       '✋',
    label:      'Open Hand',
    hint:       'Spread all fingers wide',
    action:     'Particles are expanding outward',
    why:        'MediaPipe detects ≥ 3 extended fingers and triggers a radial repulsion force from your palm centre.',
    color:      '#68d391',
    borderGlow: '0 0 14px rgba(104,211,145,0.55)',
  },
  {
    type:       'fist' as GestureType,
    icon:       '✊',
    label:      'Closed Fist',
    hint:       'Curl all fingers inward',
    action:     'Particles are contracting toward you',
    why:        'When ≤ 1 finger is extended, a magnetic attraction force pulls every particle toward your palm.',
    color:      '#fc8181',
    borderGlow: '0 0 14px rgba(252,129,129,0.55)',
  },
  {
    type:       'pinch' as GestureType,
    icon:       '🤌',
    label:      'Pinch',
    hint:       'Touch thumb to index finger',
    action:     'Burst triggered — particles explode!',
    why:        'Thumb–index distance < 5 % of frame width fires an upward impulse across ~40 % of particles.',
    color:      '#fbd38d',
    borderGlow: '0 0 14px rgba(251,211,141,0.55)',
  },
  {
    type:       'none' as GestureType,   // re-used for the "wave" row
    icon:       '〰️',
    label:      'Wave / Swipe',
    hint:       'Move your hand quickly',
    action:     'Particles trail behind your hand',
    why:        'Frame-to-frame palm velocity drags nearby particles in the direction of movement.',
    color:      '#b794f4',
    borderGlow: '0 0 14px rgba(183,148,244,0.55)',
  },
] as const;

// ── Global CSS injected once ──────────────────────────────────────────────────
const GLOBAL_CSS = `
  @keyframes spin      { to { transform: rotate(360deg); } }
  @keyframes fadeSlideIn {
    from { opacity: 0; transform: translateY(10px); }
    to   { opacity: 1; transform: translateY(0);    }
  }
  @keyframes pulse {
    0%,100% { opacity: 1; }
    50%      { opacity: 0.6; }
  }
`;

// ── Component ─────────────────────────────────────────────────────────────────
export default function ParticleExperience() {

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef  = useRef<HTMLVideoElement>(null);

  // ── Three.js refs (never cause re-renders) ────────────────────────────────
  const geometryRef  = useRef<THREE.BufferGeometry | null>(null);
  const animFrameRef = useRef<number>(0);

  // ── Per-particle data (Float32Arrays, mutated every frame) ────────────────
  const positionsRef  = useRef(new Float32Array(PARTICLE_COUNT * 3));
  const velocitiesRef = useRef(new Float32Array(PARTICLE_COUNT * 3));
  const targetsRef    = useRef(new Float32Array(PARTICLE_COUNT * 3));
  const colorsRef     = useRef(new Float32Array(PARTICLE_COUNT * 3));
  const baseColorsRef = useRef(new Float32Array(PARTICLE_COUNT * 3));
  const sizesRef      = useRef(new Float32Array(PARTICLE_COUNT));
  const baseSizesRef  = useRef(new Float32Array(PARTICLE_COUNT));

  // ── Hand-tracking refs ────────────────────────────────────────────────────
  const handLandmarkerRef    = useRef<any>(null);
  const handPositionRef      = useRef<{ x: number; y: number; z: number } | null>(null);
  const prevHandPositionRef  = useRef<{ x: number; y: number } | null>(null);
  const handVelocityRef      = useRef({ x: 0, y: 0 });
  const gestureRef           = useRef<GestureType>('none');
  const lastBurstTimeRef     = useRef(0);

  // ── Sync ref for camera active (avoids stale closure in animation loop) ────
  const cameraActiveRef  = useRef(true);

  // ── React UI state ────────────────────────────────────────────────────────
  const [cameraActive,   setCameraActive]   = useState(true);
  const [gestureType,    setGestureType]    = useState<GestureType>('none');
  const [handDetected,   setHandDetected]   = useState(false);
  const [isLoading,      setIsLoading]      = useState(true);
  const [loadingMessage, setLoadingMessage] = useState('Initializing…');

  // Dedup refs — prevent calling setState 60×/s when value hasn't changed
  const lastHandDetectedRef  = useRef(false);
  const lastGestureTypeRef   = useRef<GestureType>('none');

  // ══════════════════════════════════════════════════════════════════════════
  // Gesture detection from 21 MediaPipe hand landmarks
  // ══════════════════════════════════════════════════════════════════════════
  const detectGesture = useCallback(
    (lm: Array<{ x: number; y: number; z: number }>): GestureType => {
      if (lm.length < 21) return 'none';

      // Landmark indices: thumb tip=4, index tip=8, middle=12, ring=16, pinky=20
      // PIP (middle joint) indices:       index=6, middle=10, ring=14, pinky=18
      const thumbTip  = lm[4];
      const indexTip  = lm[8];
      const middleTip = lm[12];
      const ringTip   = lm[16];
      const pinkyTip  = lm[20];

      const indexPip  = lm[6];
      const middlePip = lm[10];
      const ringPip   = lm[14];
      const pinkyPip  = lm[18];

      // Pinch: thumb tip very close to index tip
      const pinchDist = Math.hypot(thumbTip.x - indexTip.x, thumbTip.y - indexTip.y);
      if (pinchDist < 0.055) return 'pinch';

      // Extended = tip is above (lower y value in image space) its PIP joint
      const ext = [
        indexTip.y  < indexPip.y,
        middleTip.y < middlePip.y,
        ringTip.y   < ringPip.y,
        pinkyTip.y  < pinkyPip.y,
      ];
      const extCount = ext.filter(Boolean).length;

      if (extCount >= 3) return 'open';
      if (extCount <= 1) return 'fist';
      return 'none';
    },
    []
  );

  // ══════════════════════════════════════════════════════════════════════════
  // Process one MediaPipe detection result
  // ══════════════════════════════════════════════════════════════════════════
  const processHandResults = useCallback(
    (results: any) => {
      if (!results?.landmarks?.length) {
        handPositionRef.current = null;
        gestureRef.current      = 'none';
        if (lastHandDetectedRef.current) {
          lastHandDetectedRef.current = false;
          setHandDetected(false);
        }
        if (lastGestureTypeRef.current !== 'none') {
          lastGestureTypeRef.current = 'none';
          setGestureType('none');
        }
        return;
      }

      const hand = results.landmarks[0]; // first detected hand

      // Palm center = mean of wrist (0) + 4 finger bases (5,9,13,17)
      const palmX = (hand[0].x + hand[5].x + hand[9].x + hand[13].x + hand[17].x) / 5;
      const palmY = (hand[0].y + hand[5].y + hand[9].y + hand[13].y + hand[17].y) / 5;
      const palmZ = (hand[0].z + hand[5].z + hand[9].z + hand[13].z + hand[17].z) / 5;

      // Frame-to-frame velocity
      if (prevHandPositionRef.current) {
        handVelocityRef.current = {
          x: palmX - prevHandPositionRef.current.x,
          y: palmY - prevHandPositionRef.current.y,
        };
      }
      prevHandPositionRef.current = { x: palmX, y: palmY };
      handPositionRef.current     = { x: palmX, y: palmY, z: palmZ };

      const gesture = detectGesture(hand);
      gestureRef.current = gesture;

      // Update rich state (deduped)
      if (!lastHandDetectedRef.current) {
        lastHandDetectedRef.current = true;
        setHandDetected(true);
      }
      if (gesture !== lastGestureTypeRef.current) {
        lastGestureTypeRef.current = gesture;
        setGestureType(gesture);
      }
    },
    [detectGesture]
  );

  // ══════════════════════════════════════════════════════════════════════════
  // Apply a template: update target positions, base colors, base sizes
  // ══════════════════════════════════════════════════════════════════════════
  const applyTemplate = useCallback((type: TemplateType) => {
    const data = generateTemplate(type, PARTICLE_COUNT);
    targetsRef.current.set(data.positions);
    baseColorsRef.current.set(data.colors);
    colorsRef.current.set(data.colors);
    baseSizesRef.current.set(data.sizes);
    sizesRef.current.set(data.sizes);
  }, []);

  // ══════════════════════════════════════════════════════════════════════════
  // Per-frame particle physics  (called inside requestAnimationFrame loop)
  // ══════════════════════════════════════════════════════════════════════════
  const updateParticles = useCallback(() => {
    const pos      = positionsRef.current;
    const vel      = velocitiesRef.current;
    const tgt      = targetsRef.current;
    const col      = colorsRef.current;
    const baseCol  = baseColorsRef.current;
    const sz       = sizesRef.current;
    const baseSz   = baseSizesRef.current;

    const gesture  = gestureRef.current;
    const handPos  = handPositionRef.current;
    const handVel  = handVelocityRef.current;

    // Map normalised MediaPipe coords → Three.js world space
    // Webcam is mirrored so we negate the X mapping
    const worldHandX = handPos ? -(handPos.x - 0.5) * 28 : 0;
    const worldHandY = handPos ?  (0.5 - handPos.y) * 20  : 0;

    // Scalar speed for colour-shift and trail strength  (0–1 clamped)
    const handSpeed = handPos
      ? Math.min(Math.hypot(handVel.x, handVel.y) * 55, 1.0)
      : 0;

    // Burst trigger (pinch, but throttled)
    const now      = performance.now();
    const doBurst  = gesture === 'pinch' && now - lastBurstTimeRef.current > BURST_COOLDOWN;
    if (doBurst) lastBurstTimeRef.current = now;

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const p = i * 3;

      // ── Spring toward template target ──────────────────────────────────
      vel[p]     += (tgt[p]     - pos[p])     * SPRING_K;
      vel[p + 1] += (tgt[p + 1] - pos[p + 1]) * SPRING_K;
      vel[p + 2] += (tgt[p + 2] - pos[p + 2]) * SPRING_K;

      // ── Gesture forces ─────────────────────────────────────────────────
      if (handPos) {
        const dx   = pos[p]     - worldHandX;
        const dy   = pos[p + 1] - worldHandY;
        const dist = Math.hypot(dx, dy) + 0.001;

        if (gesture === 'open') {
          // Radial repulsion from palm centre
          const force = Math.max(0, 14 - dist) * 0.075;
          vel[p]     += (dx / dist) * force;
          vel[p + 1] += (dy / dist) * force;

        } else if (gesture === 'fist') {
          // Attraction toward palm centre
          const force = Math.max(0, 22 - dist) * 0.038;
          vel[p]     -= (dx / dist) * force;
          vel[p + 1] -= (dy / dist) * force;
        }

        // ── Motion trail ─────────────────────────────────────────────────
        // Particles near the hand get dragged in the direction of movement
        if (handSpeed > 0.04 && dist < 7) {
          const drag = (1 - dist / 7) * handSpeed * 0.38;
          vel[p]     += -handVel.x * 28 * drag;
          vel[p + 1] +=  handVel.y * 28 * drag; // MediaPipe y is top-down
        }
      }

      // ── Burst (pinch) – scatter ~40 % of particles upward ──────────────
      if (doBurst && i % 5 < 2) {
        vel[p]     += (Math.random() - 0.5) * 3.2;
        vel[p + 1] += (1.5 + Math.random() * 3.5);
        vel[p + 2] += (Math.random() - 0.5) * 2.0;
      }

      // ── Damping + integrate ────────────────────────────────────────────
      vel[p]     *= DAMPING;
      vel[p + 1] *= DAMPING;
      vel[p + 2] *= DAMPING;

      pos[p]     += vel[p];
      pos[p + 1] += vel[p + 1];
      pos[p + 2] += vel[p + 2];

      // ── Colour shift toward orange/white with speed ────────────────────
      if (handSpeed > 0.08) {
        const s = handSpeed * 0.45;
        col[p]     = Math.min(1, baseCol[p]     + s * 0.55);
        col[p + 1] = Math.max(0, baseCol[p + 1] - s * 0.12);
        col[p + 2] = Math.max(0, baseCol[p + 2] - s * 0.28);
      } else {
        col[p]     = baseCol[p];
        col[p + 1] = baseCol[p + 1];
        col[p + 2] = baseCol[p + 2];
      }

      // ── Size modulation by gesture ─────────────────────────────────────
      if (gesture === 'open') {
        sz[i] = baseSz[i] * (1.0 + handSpeed * 1.6);
      } else if (gesture === 'fist') {
        sz[i] = baseSz[i] * 1.5; // denser / brighter
      } else {
        sz[i] = baseSz[i];
      }
    }
  }, []);

  // ══════════════════════════════════════════════════════════════════════════
  // Three.js initialisation  (runs once on mount)
  // ══════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (!canvasRef.current) return;

    const canvas = canvasRef.current;
    const W = window.innerWidth;
    const H = window.innerHeight;

    // ── Scene ──
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x03030f);

    // ── Camera ──
    const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 1000);
    camera.position.set(0, 0, 30);

    // ── Renderer ──
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,           // off for performance
      powerPreference: 'high-performance',
    });
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // ── Main particle geometry ──
    const geometry = new THREE.BufferGeometry();
    geometryRef.current = geometry;

    // Seed particles at their initial template positions
    const initData = generateTemplate('abstract', PARTICLE_COUNT);
    positionsRef.current.set(initData.positions);
    targetsRef.current.set(initData.positions);
    colorsRef.current.set(initData.colors);
    baseColorsRef.current.set(initData.colors);
    sizesRef.current.set(initData.sizes);
    baseSizesRef.current.set(initData.sizes);

    geometry.setAttribute('position',    new THREE.BufferAttribute(positionsRef.current, 3));
    geometry.setAttribute('customColor', new THREE.BufferAttribute(colorsRef.current,    3));
    geometry.setAttribute('size',        new THREE.BufferAttribute(sizesRef.current,     1));

    // ── Shader material (additive blending = natural glow without z-sorting) ──
    const material = new THREE.ShaderMaterial({
      uniforms: {
        time:             { value: 0.0 },
        gestureIntensity: { value: 0.0 },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      blending:    THREE.AdditiveBlending,
      depthWrite:  false,
      depthTest:   false,
    });

    scene.add(new THREE.Points(geometry, material));

    // ── Background star layer ──────────────────────────────────────────────
    const bgGeo    = new THREE.BufferGeometry();
    const bgPos    = new Float32Array(BG_COUNT * 3);
    const bgColors = new Float32Array(BG_COUNT * 3);
    const bgSizes  = new Float32Array(BG_COUNT);

    for (let i = 0; i < BG_COUNT; i++) {
      bgPos[i * 3]     = (Math.random() - 0.5) * 100;
      bgPos[i * 3 + 1] = (Math.random() - 0.5) *  75;
      bgPos[i * 3 + 2] = (Math.random() - 0.5) *  50 - 25;
      bgColors[i * 3]     = 0.28 + Math.random() * 0.18;
      bgColors[i * 3 + 1] = 0.28 + Math.random() * 0.18;
      bgColors[i * 3 + 2] = 0.45 + Math.random() * 0.30;
      bgSizes[i] = 0.08 + Math.random() * 0.12;
    }
    bgGeo.setAttribute('position',    new THREE.BufferAttribute(bgPos,    3));
    bgGeo.setAttribute('customColor', new THREE.BufferAttribute(bgColors, 3));
    bgGeo.setAttribute('size',        new THREE.BufferAttribute(bgSizes,  1));

    const bgMat = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, gestureIntensity: { value: 0 } },
      vertexShader,
      fragmentShader,
      transparent: true,
      blending:   THREE.AdditiveBlending,
      depthWrite: false,
    });
    scene.add(new THREE.Points(bgGeo, bgMat));

    // ── Resize handler ──────────────────────────────────────────────────────
    const onResize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', onResize);

    // ── Animation loop ──────────────────────────────────────────────────────
    const animate = () => {
      animFrameRef.current = requestAnimationFrame(animate);

      const t = performance.now() * 0.001; // seconds

      // Physics
      updateParticles();

      // Upload updated particle data to GPU
      const geo = geometryRef.current!;
      geo.attributes.position.needsUpdate    = true;
      geo.attributes.customColor.needsUpdate = true;
      geo.attributes.size.needsUpdate        = true;

      // Shader uniforms
      material.uniforms.time.value = t;
      material.uniforms.gestureIntensity.value = gestureRef.current === 'none' ? 0.2 : 1.0;

      // Gentle camera bob for cinematic depth
      camera.position.x = Math.sin(t * 0.18) * 1.8;
      camera.position.y = Math.cos(t * 0.13) * 1.0;
      camera.lookAt(0, 0, 0);

      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(animFrameRef.current);
      window.removeEventListener('resize', onResize);
      geometry.dispose();
      material.dispose();
      bgGeo.dispose();
      bgMat.dispose();
      renderer.dispose();
    };
  }, [updateParticles]); // updateParticles is stable (useCallback with [])

  // ══════════════════════════════════════════════════════════════════════════
  // MediaPipe + webcam initialisation  (runs once on mount)
  // ══════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    let stream: MediaStream | null = null;
    let active = true; // flag to abort if component unmounts during async init

    const init = async () => {
      try {
        setLoadingMessage('Loading hand-tracking model…');

        // Dynamic import keeps the heavy MediaPipe WASM out of the SSR bundle
        // @ts-ignore – @mediapipe/tasks-vision exports are resolved correctly by
        // Next.js/webpack at runtime; standalone tsc mis-parses the exports map.
        const { HandLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision') as any;

        // WASM runtime loaded from jsDelivr CDN (matches the installed npm version)
        const vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm'
        );

        const handLandmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          numHands: 1, // 1 hand keeps detection fast
        });

        if (!active) return;
        handLandmarkerRef.current = handLandmarker;

        setLoadingMessage('Requesting camera access…');

        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480, facingMode: 'user' },
          audio: false,
        });

        if (!active) { stream.getTracks().forEach(t => t.stop()); return; }

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await new Promise<void>(resolve => {
            videoRef.current!.onloadedmetadata = () => resolve();
          });
          await videoRef.current.play();
        }

        setIsLoading(false);

        // Detection loop — piggy-backs on the browser's rAF scheduler
        const detect = () => {
          if (!active) return;
          if (
            handLandmarkerRef.current &&
            videoRef.current &&
            videoRef.current.readyState >= 2 &&
            cameraActiveRef.current
          ) {
            const results = handLandmarkerRef.current.detectForVideo(
              videoRef.current,
              performance.now()
            );
            processHandResults(results);
          }
          requestAnimationFrame(detect);
        };
        requestAnimationFrame(detect);

      } catch (err: any) {
        if (!active) return;
        console.error('Hand-tracking init error:', err);

        const msg =
          err?.name === 'NotAllowedError'
            ? 'Camera permission denied — gesture control disabled'
            : `Init error: ${err?.message ?? String(err)}`;

        setLoadingMessage(msg);
        setIsLoading(false); // show the scene even without camera
      }
    };

    init();

    return () => {
      active = false;
      stream?.getTracks().forEach(t => t.stop());
    };
  }, [processHandResults]);

  // ── Camera toggle ────────────────────────────────────────────────────────
  const handleCameraToggle = useCallback(() => {
    setCameraActive(prev => {
      const next = !prev;
      cameraActiveRef.current = next;
      if (!next) {
        handPositionRef.current = null;
        gestureRef.current      = 'none';
        lastHandDetectedRef.current   = false;
        lastGestureTypeRef.current    = 'none';
        setHandDetected(false);
        setGestureType('none');
      }
      return next;
    });
  }, []);

  // ── Reset ────────────────────────────────────────────────────────────────
  const handleReset = useCallback(() => {
    velocitiesRef.current.fill(0);
    applyTemplate('abstract');
    // Snap particles back to template positions immediately
    positionsRef.current.set(targetsRef.current);
  }, [applyTemplate]);

  // ══════════════════════════════════════════════════════════════════════════
  // Derived display data for current gesture
  // ══════════════════════════════════════════════════════════════════════════
  // Find the matching guide entry (for the 'none' / wave row we skip it in the
  // active-feedback card since there is no specific "none" gesture)
  const activeGuide = GESTURE_GUIDE.find(g => g.type === gestureType) ?? null;

  // ══════════════════════════════════════════════════════════════════════════
  // Render
  // ══════════════════════════════════════════════════════════════════════════
  return (
    <div
      style={{
        position: 'relative',
        width:    '100vw',
        height:   '100vh',
        overflow: 'hidden',
        background: '#03030f',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      {/* ── Global CSS ── */}
      <style>{GLOBAL_CSS}</style>

      {/* ── Three.js canvas ── */}
      <canvas
        ref={canvasRef}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
      />

      {/* ════════════════════════════════════════════════════════════════════
          LEFT INSTRUCTION PANEL
          Shows WHY the camera is used + a gesture guide with the active
          gesture highlighted and expanded in real time.
          ════════════════════════════════════════════════════════════════════ */}
      {!isLoading && (
        <div
          style={{
            position:       'absolute',
            left:           16,
            top:            '50%',
            transform:      'translateY(-50%)',
            width:          252,
            zIndex:         10,
            display:        'flex',
            flexDirection:  'column',
            gap:            10,
          }}
        >
          {/* ── Why Camera? box ── */}
          <div
            style={{
              background:     'rgba(3,3,20,0.75)',
              border:         '1px solid rgba(99,179,237,0.25)',
              borderRadius:   12,
              padding:        '12px 14px',
              backdropFilter: 'blur(10px)',
            }}
          >
            <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:6 }}>
              <span style={{ fontSize:16 }}>📷</span>
              <span style={{ color:'#90cdf4', fontSize:12, fontWeight:600, letterSpacing:'0.03em' }}>
                Why is the camera used?
              </span>
            </div>
            <p style={{ margin:0, color:'#94a3b8', fontSize:11, lineHeight:1.6 }}>
              The webcam feeds live video to{' '}
              <span style={{ color:'#63b3ed' }}>MediaPipe AI</span>, which
              maps <span style={{ color:'#63b3ed' }}>21 hand landmarks</span> at
              up to 60 fps. Your hand position and finger angles are converted into
              gestures — no mouse, no touch, no controller needed.
            </p>
            {/* Live tracking status dot */}
            <div style={{ display:'flex', alignItems:'center', gap:5, marginTop:8 }}>
              <div
                style={{
                  width:         7,
                  height:        7,
                  borderRadius:  '50%',
                  background:    handDetected ? '#68d391' : cameraActive ? '#fbd38d' : '#fc8181',
                  animation:     handDetected ? 'pulse 1.2s ease-in-out infinite' : 'none',
                  flexShrink:    0,
                }}
              />
              <span style={{ color:'#718096', fontSize:10 }}>
                {!cameraActive  ? 'Camera off'
                 : handDetected  ? 'Hand detected — tracking active'
                 :                 'Waiting for hand in frame…'}
              </span>
            </div>
          </div>

          {/* ── Gesture Guide ── */}
          <div
            style={{
              background:     'rgba(3,3,20,0.75)',
              border:         '1px solid rgba(255,255,255,0.08)',
              borderRadius:   12,
              padding:        '10px 12px',
              backdropFilter: 'blur(10px)',
              display:        'flex',
              flexDirection:  'column',
              gap:            6,
            }}
          >
            <div style={{ color:'#64748b', fontSize:10, fontWeight:600, letterSpacing:'0.08em', marginBottom:2 }}>
              GESTURE GUIDE
            </div>

            {GESTURE_GUIDE.map((g, idx) => {
              // The 'none' slot in the guide is re-used for the "wave" row
              const isActive    = handDetected && gestureType === g.type && g.type !== 'none';
              const isWaveActive = g.type === 'none' && handDetected && gestureType === 'none';
              const rowActive   = isActive || isWaveActive;
              const stepNum     = idx + 1; // 1-based step number

              return (
                <div
                  key={g.label}
                  style={{
                    borderRadius: 10,
                    border:       rowActive
                                    ? `1px solid ${g.color}60`
                                    : '1px solid rgba(255,255,255,0.06)',
                    background:   rowActive
                                    ? `${g.color}14`
                                    : 'rgba(255,255,255,0.02)',
                    padding:      rowActive ? '10px 10px' : '7px 10px',
                    transition:   'all 0.3s ease',
                    boxShadow:    rowActive ? g.borderGlow : 'none',
                    animation:    rowActive ? 'fadeSlideIn 0.25s ease' : 'none',
                  }}
                >
                  <div style={{ display:'flex', alignItems:'center', gap:8 }}>

                    {/* ── Step number badge ── */}
                    <div
                      style={{
                        width:          22,
                        height:         22,
                        borderRadius:   '50%',
                        background:     rowActive ? g.color : 'rgba(255,255,255,0.07)',
                        color:          rowActive ? '#0a0a1a' : '#4a5568',
                        fontSize:       11,
                        fontWeight:     700,
                        display:        'flex',
                        alignItems:     'center',
                        justifyContent: 'center',
                        flexShrink:     0,
                        transition:     'all 0.25s ease',
                        boxShadow:      rowActive ? `0 0 8px ${g.color}88` : 'none',
                      }}
                    >
                      {stepNum}
                    </div>

                    {/* ── Gesture icon ── */}
                    <span
                      style={{
                        fontSize:   rowActive ? 20 : 17,
                        lineHeight: 1,
                        transition: 'font-size 0.2s',
                        flexShrink: 0,
                      }}
                    >
                      {g.icon}
                    </span>

                    {/* ── Label + hint ── */}
                    <div style={{ flex:1, minWidth:0 }}>
                      <div
                        style={{
                          color:      rowActive ? g.color : '#94a3b8',
                          fontSize:   12,
                          fontWeight: rowActive ? 700 : 400,
                          transition: 'color 0.2s',
                        }}
                      >
                        {g.label}
                      </div>
                      <div style={{ color:'#3d4a5c', fontSize:10, marginTop:1 }}>
                        {g.hint}
                      </div>
                    </div>

                    {/* ── Active pulse dot ── */}
                    {rowActive && (
                      <div
                        style={{
                          width:        8,
                          height:       8,
                          borderRadius: '50%',
                          background:   g.color,
                          flexShrink:   0,
                          animation:    'pulse 0.9s ease-in-out infinite',
                          boxShadow:    `0 0 6px ${g.color}`,
                        }}
                      />
                    )}
                  </div>

                  {/* ── Expanded detail — only when this gesture is active ── */}
                  {rowActive && (
                    <div
                      style={{
                        marginTop:  10,
                        paddingTop: 10,
                        borderTop:  `1px solid ${g.color}30`,
                        animation:  'fadeSlideIn 0.2s ease',
                      }}
                    >
                      <div
                        style={{
                          color:        g.color,
                          fontSize:     11,
                          fontWeight:   600,
                          marginBottom: 5,
                          display:      'flex',
                          alignItems:   'center',
                          gap:          5,
                        }}
                      >
                        <span>▶</span> {g.action}
                      </div>
                      <div style={{ color:'#64748b', fontSize:10, lineHeight:1.65 }}>
                        {g.why}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════
          "SHOW YOUR HAND" PROMPT — centre of screen when no hand detected
          ════════════════════════════════════════════════════════════════════ */}
      {!isLoading && cameraActive && !handDetected && (
        <div
          style={{
            position:       'absolute',
            top:            '50%',
            left:           '50%',
            transform:      'translate(-50%, -50%)',
            textAlign:      'center',
            zIndex:         5,
            pointerEvents:  'none',
            animation:      'fadeSlideIn 0.4s ease',
          }}
        >
          <div style={{ fontSize: 52, lineHeight:1, marginBottom:10, animation:'pulse 2s ease-in-out infinite' }}>
            👋
          </div>
          <div style={{ color:'#cbd5e0', fontSize:16, fontWeight:500, marginBottom:6 }}>
            Show your hand to the camera
          </div>
          <div style={{ color:'#4a5568', fontSize:12 }}>
            Hold it in front of the webcam to start
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════
          ACTIVE GESTURE FEEDBACK CARD
          Appears at the bottom-centre when a specific gesture is active.
          Tells the user exactly what is happening and why it works.
          ════════════════════════════════════════════════════════════════════ */}
      {handDetected && gestureType !== 'none' && activeGuide && (
        <div
          key={gestureType} // remount (re-animate) when gesture changes
          style={{
            position:       'absolute',
            bottom:         72,
            left:           '50%',
            transform:      'translateX(-50%)',
            zIndex:         10,
            background:     'rgba(3,3,20,0.82)',
            border:         `1px solid ${activeGuide.color}55`,
            borderRadius:   16,
            padding:        '14px 22px',
            backdropFilter: 'blur(12px)',
            display:        'flex',
            alignItems:     'center',
            gap:            14,
            maxWidth:       420,
            boxShadow:      activeGuide.borderGlow,
            animation:      'fadeSlideIn 0.25s ease',
          }}
        >
          {/* Big gesture icon */}
          <span style={{ fontSize:36, lineHeight:1, flexShrink:0 }}>{activeGuide.icon}</span>

          <div>
            {/* Gesture name + status */}
            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
              <span style={{ color: activeGuide.color, fontSize:14, fontWeight:700 }}>
                {activeGuide.label}
              </span>
              <span
                style={{
                  background:   `${activeGuide.color}22`,
                  color:        activeGuide.color,
                  fontSize:     10,
                  padding:      '2px 8px',
                  borderRadius: 10,
                  fontWeight:   600,
                  animation:    'pulse 1s ease-in-out infinite',
                }}
              >
                ACTIVE
              </span>
            </div>

            {/* What is happening */}
            <div style={{ color:'#e2e8f0', fontSize:12, fontWeight:500, marginBottom:4 }}>
              ▶ {activeGuide.action}
            </div>

            {/* Why it works */}
            <div style={{ color:'#64748b', fontSize:10, lineHeight:1.6, maxWidth:300 }}>
              {activeGuide.why}
            </div>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════
          WEBCAM PiP + label
          ════════════════════════════════════════════════════════════════════ */}
      <div
        style={{
          position:       'absolute',
          bottom:         72,
          right:          16,
          display:        'flex',
          flexDirection:  'column',
          alignItems:     'center',
          gap:            5,
          zIndex:         10,
          opacity:        cameraActive ? 1 : 0,
          transition:     'opacity 0.3s',
          pointerEvents:  'none',
        }}
      >
        {/* Status label above webcam */}
        <div
          style={{
            background:     'rgba(3,3,20,0.7)',
            border:         `1px solid ${handDetected ? 'rgba(104,211,145,0.35)' : 'rgba(255,255,255,0.08)'}`,
            borderRadius:   10,
            padding:        '3px 10px',
            color:          handDetected ? '#68d391' : '#4a5568',
            fontSize:       10,
            backdropFilter: 'blur(6px)',
            whiteSpace:     'nowrap',
          }}
        >
          {handDetected
            ? `Detected: ${gestureType === 'none' ? 'hand' : gestureType}`
            : 'No hand in frame'}
        </div>

        <video
          ref={videoRef}
          playsInline
          muted
          style={{
            width:        152,
            height:       114,
            objectFit:    'cover',
            borderRadius: 8,
            border:       `1px solid ${handDetected ? 'rgba(104,211,145,0.4)' : 'rgba(255,255,255,0.1)'}`,
            transform:    'scaleX(-1)',
            transition:   'border-color 0.3s',
            display:      'block',
          }}
        />

        {/* "AI tracking" caption below */}
        <div style={{ color:'#2d3748', fontSize:9, letterSpacing:'0.05em' }}>
          MediaPipe · 21 landmarks
        </div>
      </div>

      {/* ════════════════════════════════════════════════════════════════════
          LOADING OVERLAY
          ════════════════════════════════════════════════════════════════════ */}
      {isLoading && (
        <div
          style={{
            position:       'absolute',
            inset:          0,
            display:        'flex',
            flexDirection:  'column',
            alignItems:     'center',
            justifyContent: 'center',
            background:     'rgba(3,3,15,0.88)',
            backdropFilter: 'blur(4px)',
            zIndex:         30,
            gap:            16,
          }}
        >
          <div
            style={{
              width:        44,
              height:       44,
              borderRadius: '50%',
              border:       '3px solid rgba(99,179,237,0.22)',
              borderTop:    '3px solid #63b3ed',
              animation:    'spin 0.9s linear infinite',
            }}
          />
          <p
            style={{
              margin:    0,
              color:     '#90cdf4',
              fontSize:  14,
              maxWidth:  320,
              textAlign: 'center',
            }}
          >
            {loadingMessage}
          </p>
          <p style={{ margin:0, color:'#2d3748', fontSize:11 }}>
            Camera access is needed to track your hand gestures
          </p>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════
          BOTTOM BAR  — camera toggle + reset  (bottom-left)
          ════════════════════════════════════════════════════════════════════ */}
      <div
        style={{
          position: 'absolute',
          bottom:   16,
          left:     16,
          display:  'flex',
          gap:      8,
          zIndex:   10,
        }}
      >
        <button
          onClick={handleCameraToggle}
          style={{
            padding:        '5px 14px',
            borderRadius:   20,
            border:         '1px solid rgba(255,255,255,0.12)',
            background:     cameraActive ? 'rgba(72,187,120,0.18)' : 'rgba(245,101,101,0.18)',
            color:          cameraActive ? '#9ae6b4' : '#fc8181',
            fontSize:       12,
            cursor:         'pointer',
            backdropFilter: 'blur(8px)',
          }}
        >
          {cameraActive ? '📷 ON' : '📷 OFF'}
        </button>

        <button
          onClick={handleReset}
          style={{
            padding:        '5px 14px',
            borderRadius:   20,
            border:         '1px solid rgba(255,255,255,0.12)',
            background:     'rgba(0,0,0,0.45)',
            color:          '#94a3b8',
            fontSize:       12,
            cursor:         'pointer',
            backdropFilter: 'blur(8px)',
          }}
        >
          ↺ Reset
        </button>
      </div>

      {/* ── Student watermark ── */}
      <div
        style={{
          position:  'absolute',
          bottom:    16,
          right:     16,
          color:     'rgba(148,163,184,0.30)',
          fontSize:  10,
          zIndex:    10,
          textAlign: 'right',
          lineHeight:1.5,
        }}
      >
        Mauhmmad Ahmed<br />B23110006082
      </div>
    </div>
  );
}
