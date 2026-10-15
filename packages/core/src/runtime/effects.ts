import type { Contracts } from '../reference/contracts.js';
export function combineEffects(
  a: Contracts.EffectState,
  b: Contracts.EffectState,
): Contracts.EffectState {
  if (a === 'unknown' || b === 'unknown') return 'unknown';
  if (a === 'partially-applied' || b === 'partially-applied') return 'partially-applied';
  if (a === 'applied' || b === 'applied') return 'applied';
  return a === 'not-attempted' ? b : a;
}
