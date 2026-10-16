import metadataJson from './generated/retro/manifest.json';
import atlas0 from './generated/retro/atlas-0.png?url';
import atlas1 from './generated/retro/atlas-1.png?url';
import background from './generated/retro/art-background.png?url';
import finish from './generated/retro/art-finish.png?url';
import gateClosed from './generated/retro/art-gate-closed.png?url';
import gateOpen from './generated/retro/art-gate-open.png?url';
import plateIdle from './generated/retro/art-plate-idle.png?url';
import plateActive from './generated/retro/art-plate-active.png?url';
import giftA from './generated/retro/art-gift-a.png?url';
import giftB from './generated/retro/art-gift-b.png?url';
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
