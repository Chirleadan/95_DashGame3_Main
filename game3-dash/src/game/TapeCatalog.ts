/** Menu cassette art under `public/assets/tapes/`. */
export type TapeCassetteEntry = {
  id: string;
  imageUrl: string;
  trackId: string;
};

export const TAPE_CASSETTES: readonly TapeCassetteEntry[] = [
  {
    id: 'tape-1',
    imageUrl: '/assets/tapes/1.PNG',
    trackId: 'track-1',
  },
  {
    id: 'tape-2',
    imageUrl: '/assets/tapes/2.PNG',
    trackId: 'track-2',
  },
  {
    id: 'tape-3',
    imageUrl: '/assets/tapes/3.PNG',
    trackId: 'track-3',
  },
];
