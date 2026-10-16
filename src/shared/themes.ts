import type { ThemeId } from './model.js';

export const ThemeCatalog: Record<ThemeId, { title: string; description: string }> = {
  'first-date': {
    title: 'Первое свидание',
    description: 'Тёплая история о встрече и первом совместном приключении.',
  },
  retro: {
    title: 'Ретро',
    description: 'Мультяшное приключение в кафе с атмосферой 1950-х.',
  },
  winter: {
    title: 'Зимнее свидание',
    description: 'Заснеженный вечер, который пара проходит вместе.',
  },
};
