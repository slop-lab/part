import { canonical } from '../contracts/index.js';
import type { Client } from '../reference/client.js';
export const partKey = (itemId: string, partId: string) => canonical([itemId, partId]);

export function clearItemParts(parts: Map<string, Client.StreamPartSnapshot>, id: string) {
  for (const [key, part] of parts) if (part.itemId === id) parts.delete(key);
}
