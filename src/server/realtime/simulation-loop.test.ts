import { describe, expect, it, vi } from 'vitest';
import { SimulationLoop } from './simulation-loop.js';

describe('SimulationLoop', () => {
  it('runs at 60Hz and snapshots every third simulation step', () => {
    const step = vi.fn();
    const snapshot = vi.fn();
    const loop = new SimulationLoop({ clock: () => 0, step, snapshot });

    for (let tick = 1; tick <= 6; tick += 1) loop.advance(tick * (1000 / 60));

    expect(step).toHaveBeenCalledTimes(6);
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it('caps catch-up at five steps and reports discarded whole-step lag', () => {
    const step = vi.fn();
    const onDropped = vi.fn();
    const loop = new SimulationLoop({ clock: () => 0, step, snapshot: vi.fn(), onDropped });

    loop.advance(1000);

    expect(step).toHaveBeenCalledTimes(5);
    expect(onDropped).toHaveBeenCalledOnce();
    expect(onDropped.mock.calls[0]?.[0]).toBeGreaterThan(900);
    expect(onDropped.mock.calls[0]?.[0]).toBeLessThan(1000);
  });

  it('ignores backward time without minting simulation time', () => {
    const step = vi.fn();
    const loop = new SimulationLoop({ clock: () => 100, step, snapshot: vi.fn() });

    loop.advance(90);
    loop.advance(100 + 1000 / 60);

    expect(step).toHaveBeenCalledTimes(1);
  });

  it('keeps fractional remainder across callbacks and stop makes later advances inert', () => {
    const step = vi.fn();
    const snapshot = vi.fn();
    const loop = new SimulationLoop({ clock: () => 0, step, snapshot });

    loop.advance(8);
    expect(step).not.toHaveBeenCalled();
    loop.advance(17);
    expect(step).toHaveBeenCalledOnce();
    loop.stop();
    loop.advance(200);

    expect(step).toHaveBeenCalledOnce();
    expect(snapshot).not.toHaveBeenCalled();
  });
});
