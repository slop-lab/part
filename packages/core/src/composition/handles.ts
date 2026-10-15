import type { Composition } from '../reference/composition.js';
import type { Contracts } from '../reference/contracts.js';

export type Point = Composition.ExtensionPoint<unknown>;
export type Binding = Composition.Contribution<unknown>;
export interface Plan {
  inspection: Composition.ResolvedComposition;
  components: readonly Composition.ComponentFactory[];
  config: Contracts.Json;
  points: Map<string, Point>;
  bindings: Map<string, Binding[]>;
  factories: Map<string, Composition.ServiceFactory<unknown>>;
  factoryOrder: string[];
}
export const plans = new WeakMap<object, Plan>();
export function isCompositionHandle(value: Composition.CompositionHandle): boolean {
  if (!value || typeof value.localToken !== 'object' || value.localToken === null) return false;
  return plans.get(value.localToken)?.inspection === value.inspection;
}
