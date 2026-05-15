import * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

/** Radial barrel-style distortion + light vignette; `distortionAmount` 0 = none, ~0.15 subtle, ~0.4 strong. */
export const LensDistortionShader = {
  name: 'LensDistortionShader',

  uniforms: {
    tDiffuse: { value: null },
    distortionAmount: { value: 0.15 },
    resolution: { value: new THREE.Vector2(1024, 1024) },
    vignetteStrength: { value: 0.14 },
    /** Render frustum scale vs gameplay camera; >1 crops center in shader (overscan). */
    overscan: { value: 2 },
  },

  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float distortionAmount;
    uniform vec2 resolution;
    uniform float vignetteStrength;
    uniform float overscan;

    varying vec2 vUv;

    void main() {
      vec2 uv = vUv;
      vec2 centered = uv * 2.0 - 1.0;
      float aspect = resolution.x / max(resolution.y, 1.0);
      vec2 d = centered * vec2(aspect, 1.0);
      float r2 = dot(d, d);
      d *= 1.0 + distortionAmount * r2;
      centered = d / vec2(max(aspect, 1e-4), 1.0);

      vec2 sampleUv = vec2(0.5) + centered / (2.0 * max(overscan, 1e-4));
      vec2 clamped = clamp(sampleUv, vec2(0.001), vec2(0.999));
      vec4 col = texture2D(tDiffuse, clamped);

      float oob =
        max(max(-sampleUv.x, sampleUv.x - 1.0), max(max(-sampleUv.y, sampleUv.y - 1.0), 0.0));
      col.rgb *= mix(1.0, 0.82, smoothstep(0.0, 0.08, oob));

      vec2 vc = vUv * 2.0 - 1.0;
      float vig = 1.0 - vignetteStrength * dot(vc, vc);
      col.rgb *= vig;

      gl_FragColor = col;
    }
  `,
};

export class LensDistortionPass extends ShaderPass {
  constructor() {
    super(LensDistortionShader);
    this.setAmount(0.15);
    this.setOverscan(2);
  }

  setAmount(value: number): void {
    const v = Math.max(0, Math.min(0.5, value));
    this.uniforms.distortionAmount!.value = v;
  }

  setOverscan(value: number): void {
    const v = Math.max(1, Math.min(2, value));
    this.uniforms.overscan!.value = v;
  }

  override setSize(width: number, height: number): void {
    this.uniforms.resolution!.value.set(width, height);
  }
}
