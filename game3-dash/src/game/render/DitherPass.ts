import * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

export const DitherShader = {
  name: 'DitherShader',

  uniforms: {
    tDiffuse: { value: null },
    enabled: { value: 0 },
    strength: { value: 0.35 },
    dotStrength: { value: 0.25 },
    resolution: { value: new THREE.Vector2(1024, 1024) },
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
    uniform float enabled;
    uniform float strength;
    uniform float dotStrength;
    uniform vec2 resolution;

    varying vec2 vUv;

    float bayer4(vec2 p) {
      int x = int(mod(p.x, 4.0));
      int y = int(mod(p.y, 4.0));
      int i = y * 4 + x;
      if (i == 0) return 0.0 / 16.0;
      if (i == 1) return 8.0 / 16.0;
      if (i == 2) return 2.0 / 16.0;
      if (i == 3) return 10.0 / 16.0;
      if (i == 4) return 12.0 / 16.0;
      if (i == 5) return 4.0 / 16.0;
      if (i == 6) return 14.0 / 16.0;
      if (i == 7) return 6.0 / 16.0;
      if (i == 8) return 3.0 / 16.0;
      if (i == 9) return 11.0 / 16.0;
      if (i == 10) return 1.0 / 16.0;
      if (i == 11) return 9.0 / 16.0;
      if (i == 12) return 15.0 / 16.0;
      if (i == 13) return 7.0 / 16.0;
      if (i == 14) return 13.0 / 16.0;
      return 5.0 / 16.0;
    }

    void main() {
      vec4 col = texture2D(tDiffuse, vUv);
      if (enabled < 0.5) {
        gl_FragColor = col;
        return;
      }

      vec2 px = gl_FragCoord.xy;
      float threshold = bayer4(floor(px));
      vec3 quantized = floor(col.rgb * 5.0 + threshold * strength) / 5.0;

      vec2 cell = fract(px / 3.0) - 0.5;
      float dotMask = smoothstep(0.36, 0.08, length(cell));
      vec3 dotted = quantized * (1.0 - dotMask * dotStrength);

      col.rgb = mix(col.rgb, dotted, strength);
      gl_FragColor = col;
    }
  `,
};

export class DitherPass extends ShaderPass {
  constructor() {
    super(DitherShader);
    this.setEnabled(false);
    this.setStrength(0.35);
    this.setDotStrength(0.25);
  }

  setEnabled(enabled: boolean): void {
    this.uniforms.enabled!.value = enabled ? 1 : 0;
  }

  setStrength(value: number): void {
    this.uniforms.strength!.value = Math.max(0, Math.min(1, value));
  }

  setDotStrength(value: number): void {
    this.uniforms.dotStrength!.value = Math.max(0, Math.min(1, value));
  }

  override setSize(width: number, height: number): void {
    this.uniforms.resolution!.value.set(width, height);
  }
}
