import * as THREE from 'three';

const loader = new THREE.TextureLoader();
const textures = new Map<string, THREE.Texture>();

function configureSpriteTexture(texture: THREE.Texture): void {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
}

/** Shared textures — do not dispose; reused across runs. */
export function getGameTexture(url: string): THREE.Texture {
  let texture = textures.get(url);
  if (!texture) {
    texture = loader.load(url);
    configureSpriteTexture(texture);
    textures.set(url, texture);
  }
  return texture;
}

export function isCachedGameTexture(texture: THREE.Texture | null | undefined): boolean {
  if (!texture) return false;
  for (const cached of textures.values()) {
    if (cached === texture) return true;
  }
  return false;
}

/** Detach shared maps before disposing materials so textures survive between runs. */
export function detachCachedTextureFromMaterial(mat: THREE.Material): void {
  if (!(mat instanceof THREE.MeshBasicMaterial)) return;
  if (isCachedGameTexture(mat.map)) {
    mat.map = null;
  }
}
