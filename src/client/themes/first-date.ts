import metadataJson from './generated/first-date/manifest.json';
import atlas0 from './generated/first-date/atlas-0.png?url';
import atlas1 from './generated/first-date/atlas-1.png?url';
import background from './generated/first-date/art-background.png?url';
import finish from './generated/first-date/art-finish.png?url';
import gateClosed from './generated/first-date/art-gate-closed.png?url';
import gateOpen from './generated/first-date/art-gate-open.png?url';
import plateIdle from './generated/first-date/art-plate-idle.png?url';
import plateActive from './generated/first-date/art-plate-active.png?url';
import giftA from './generated/first-date/art-gift-a.png?url';
import giftB from './generated/first-date/art-gift-b.png?url';
import { releaseThemeSchema } from './theme-schema.js';

export const manifest = releaseThemeSchema.parse(metadataJson);
export const metadata = manifest;
export const urls = {
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
