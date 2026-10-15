/** @public */
import { fail, ok } from '@slop-lab/part/contracts';
import type { Contracts, UI } from '@slop-lab/part/reference';
/** Highest layer wins; equal-layer collisions fail at installation. */
export function createRendererRegistry<View>(
  layers: readonly (readonly UI.Renderer<Contracts.Json, View>[])[],
): Contracts.Result<UI.RendererRegistry<View>> {
  const registry = new Map<string, UI.Renderer<Contracts.Json, View>>();
  for (const layer of layers) {
    const keys = new Set<string>();
    for (const renderer of layer)
      for (const version of renderer.schemaVersions) {
        const key = `${renderer.target}/${renderer.type}@${version}`;
        if (keys.has(key))
          return fail(
            'ui.renderer-conflict',
            `Equal-priority renderer collision: ${key}`,
            'conflict',
          );
        keys.add(key);
        if (!registry.has(key)) registry.set(key, renderer);
      }
  }
  return ok({
    resolve(item, target) {
      const renderer = registry.get(`${target}/${item.type}@${item.schemaVersion}`);
      return renderer ? ok(renderer) : fail('ui.renderer', 'Renderer not installed', 'unsupported');
    },
  });
}
export function orderSlots<View>(
  slots: readonly UI.SlotContribution<View>[],
): Contracts.Result<readonly UI.SlotContribution<View>[]> {
  const registry = new Map(slots.map((slot) => [slot.id, slot]));
  if (registry.size !== slots.length)
    return fail('ui.slot-conflict', 'Duplicate slot ID', 'conflict');
  const dependencies = new Map(slots.map((slot) => [slot.id, new Set<string>()]));
  for (const slot of slots) {
    for (const id of [...(slot.before ?? []), ...(slot.after ?? [])])
      if (!registry.has(id) || registry.get(id)!.slot !== slot.slot)
        return fail('ui.slot-order', 'Slot ordering target is missing or in a different position');
    for (const id of slot.after ?? []) dependencies.get(slot.id)!.add(id);
    for (const id of slot.before ?? []) dependencies.get(id)!.add(slot.id);
  }
  const remaining = new Set(registry.keys()),
    ordered: UI.SlotContribution<View>[] = [];
  while (remaining.size) {
    const id = [...remaining]
      .sort()
      .find((id) => [...dependencies.get(id)!].every((dependency) => !remaining.has(dependency)));
    if (!id) return fail('ui.slot-cycle', 'Slot ordering cycle', 'conflict');
    ordered.push(registry.get(id)!);
    remaining.delete(id);
  }
  return ok(ordered);
}
