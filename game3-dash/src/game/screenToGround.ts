import * as THREE from 'three';

const ndc = new THREE.Vector2();
const raycaster = new THREE.Raycaster();
const plane = new THREE.Plane();

/**
 * Converts screen (client) coordinates to a hit point on the horizontal plane y = planeY.
 * Uses the orthographic camera and the canvas element's bounding rect for NDC.
 * @returns true if the ray intersects the plane (almost always for a top-down camera).
 */
export function screenToGroundXZ(
  clientX: number,
  clientY: number,
  domElement: HTMLElement,
  camera: THREE.OrthographicCamera,
  planeY: number,
  out: THREE.Vector3,
): boolean {
  const rect = domElement.getBoundingClientRect();
  const w = Math.max(1, rect.width);
  const h = Math.max(1, rect.height);
  ndc.x = ((clientX - rect.left) / w) * 2 - 1;
  ndc.y = -((clientY - rect.top) / h) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  plane.set(new THREE.Vector3(0, 1, 0), -planeY);
  const hit = raycaster.ray.intersectPlane(plane, out);
  return hit !== null;
}
