import metadataJson from './generated/winter/manifest.json';
import atlas0 from './generated/winter/atlas-0.png?url';
import atlas1 from './generated/winter/atlas-1.png?url';
import background from './generated/winter/art-background.png?url';
import finish from './generated/winter/art-finish.png?url';
import gateClosed from './generated/winter/art-gate-closed.png?url';
import gateOpen from './generated/winter/art-gate-open.png?url';
import plateIdle from './generated/winter/art-plate-idle.png?url';
import plateActive from './generated/winter/art-plate-active.png?url';
import giftA from './generated/winter/art-gift-a.png?url';
import giftB from './generated/winter/art-gift-b.png?url';
import { releaseThemeSchema } from './theme-schema.js';

export const manifest = releaseThemeSchema.parse(metadataJson);
export const metadata = manifest;
export const urls: Readonly<Record<string, string>> = {
  'atlas-0': atlas0,
  'atlas-1': atlas1,
  'art-background': background,
  'art-finish': finish,
  'art-gate-closed': gateClosed,
  'art-gate-open': gateOpen,
  'art-plate-idle': plateIdle,
  'art-plate-active': plateActive,
  'art-gift-a': giftA,
  'art-gift-b': giftB,
};
