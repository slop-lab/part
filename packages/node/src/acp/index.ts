import { startJsonRpcPeer } from './peer.js';
import type { AcpStdioOptions } from './types.js';
export { AcpRpcError } from './types.js';
export type { AcpHandler, AcpPeer, AcpStdioOptions } from './types.js';

/** Connect a host-provided ACP agent to newline-delimited JSON-RPC stdio. */
export function startAcpStdio(options: AcpStdioOptions) {
  return startJsonRpcPeer(options);
}
