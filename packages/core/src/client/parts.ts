import { canonical } from '../contracts/index.js';
export const partKey = (itemId: string, partId: string) => canonical([itemId, partId]);
