export function TouchControls() {
  return <div class="touch-controls" role="group" aria-label="Управление игрой">
    <div class="movement-controls">
      <button type="button" data-input="left" aria-label="Двигаться влево">←</button>
      <button type="button" data-input="right" aria-label="Двигаться вправо">→</button>
    </div>
    <div class="action-controls">
      <button type="button" data-input="jump">Прыжок</button>
      <button type="button" data-input="interact">Взять подарок</button>
    </div>
  </div>;
}
