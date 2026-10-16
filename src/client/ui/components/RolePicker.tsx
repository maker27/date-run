import type { Role } from '../../../shared/model.js';

export function RolePicker({ value, disabled = false, onChange }: { value: Role; disabled?: boolean; onChange: (role: Role) => void }) {
  return <fieldset class="role-picker" role="radiogroup" aria-label="Стартовая сторона" disabled={disabled}>
    <legend>Стартовая сторона</legend>
    <div class="role-grid">
      <label><input type="radio" name="role" value="a" checked={value === 'a'} disabled={disabled} onChange={() => onChange('a')} /><span><span aria-hidden="true">← </span>Слева</span></label>
      <label><input type="radio" name="role" value="b" checked={value === 'b'} disabled={disabled} onChange={() => onChange('b')} /><span>Справа<span aria-hidden="true"> →</span></span></label>
    </div>
  </fieldset>;
}
