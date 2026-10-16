import type { ThemeId } from '../../../shared/model.js';
import firstDate from '../../themes/assets/first-date/thumbnail.png?url';
import retro from '../../themes/assets/retro/thumbnail.png?url';
import winter from '../../themes/assets/winter/thumbnail.png?url';

export const themes: readonly { id: ThemeId; label: string; image: string }[] = [
  { id: 'first-date', label: 'Первое свидание', image: firstDate },
  { id: 'retro', label: 'Ретро', image: retro },
  { id: 'winter', label: 'Зимнее свидание', image: winter },
];

export function ThemePicker({ value, disabled = false, onChange }: { value: ThemeId; disabled?: boolean; onChange: (theme: ThemeId) => void }) {
  return <fieldset class="theme-picker" role="radiogroup" aria-label="Тема игры" disabled={disabled}>
    <legend>Тема игры</legend>
    <div class="theme-grid">{themes.map((theme) => <label class="theme-choice" key={theme.id}>
      <input type="radio" name="theme" value={theme.id} checked={value === theme.id} onChange={() => onChange(theme.id)} disabled={disabled} />
      <img src={theme.image} alt="" width="240" height="160" />
      <span>{theme.label}</span>
    </label>)}</div>
  </fieldset>;
}
