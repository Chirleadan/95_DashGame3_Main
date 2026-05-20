/** Menu cassette art under `public/assets/tapes/`. */
export const TAPE_CASSETTE_LOCKED_IMAGE_URL = '/assets/tapes/locked.webp';

export type TapeCassetteEntry = {
  id: string;
  imageUrl: string;
  trackId: string;
};

export const TAPE_CASSETTES: readonly TapeCassetteEntry[] = [
  {
    id: 'tape-1',
    imageUrl: '/assets/tapes/1.webp',
    trackId: 'track-1',
  },
  {
    id: 'tape-2',
    imageUrl: '/assets/tapes/2.webp',
    trackId: 'track-2',
  },
  {
    id: 'tape-3',
    imageUrl: '/assets/tapes/3.webp',
    trackId: 'track-3',
  },
];

export function getTapeCassetteImageUrl(trackId: string): string | null {
  return TAPE_CASSETTES.find((tape) => tape.trackId === trackId)?.imageUrl ?? null;
}
