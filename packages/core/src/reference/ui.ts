import type { Client } from './client.js';
import type { Contracts } from './contracts.js';
import type { Projection } from './projection.js';
export namespace UI {
  export type RenderTarget = 'chat' | 'inspector' | 'document' | 'overlay' | string;
  export interface RenderContext {
    readonly controller: Client.Controller;
    readonly target: RenderTarget;
    readonly itemId: string;
  }
  export interface Renderer<T, View> {
    readonly id: string;
    readonly type: string;
    readonly schemaVersions: readonly number[];
    readonly target: RenderTarget;
    render(item: Projection.Item<T>, context: RenderContext): View;
  }
  export interface RendererRegistry<View> {
    resolve(
      item: Projection.Item,
      target: RenderTarget,
    ): Contracts.Result<Renderer<Contracts.Json, View>>;
  }
  export interface SlotContribution<View> {
    readonly id: string;
    readonly slot: string;
    readonly before?: readonly string[];
    readonly after?: readonly string[];
    render(context: RenderContext): View;
  }
  export interface Draft {
    readonly text: string;
    readonly references: readonly Contracts.DataRef[];
    readonly revision: number;
  }
  export interface ComposerController {
    getDraft(): Draft;
    setDraft(draft: Draft): void;
    setComposing(active: boolean): void;
    submit(origin: 'enter' | 'button' | 'api'): Promise<Client.CommandDelivery>;
    canSubmit(): { readonly allowed: boolean; readonly reason?: string };
  }
  export interface ScrollState {
    readonly anchoredItemId?: string;
    readonly following: boolean;
    readonly hasNewContent: boolean;
  }
  export interface ScrollController {
    getState(): ScrollState;
    onUserScroll(distanceFromLatest: number): void;
    followLatest(): void;
    preserveAnchor(itemId: string): void;
  }
  export interface Parts {
    readonly Message: unknown;
    readonly Composer: unknown;
    readonly ToolDetails: unknown;
    readonly Fallback: unknown;
  }
  export interface ChatOptions<View> {
    readonly client: Client.Controller;
    readonly ownsClient?: boolean;
    readonly renderers?: readonly Renderer<Contracts.Json, View>[];
    readonly slots?: readonly SlotContribution<View>[];
    readonly components?: Partial<Parts>;
    readonly className?: string;
    readonly theme?: Readonly<Record<string, string>>;
  }
  /** Framework binding supplies actual React/Vue/etc. component/ref/event types; not fixed here. */
  export interface HeadlessBinding<View> {
    readonly contractVersion: number;
    createChat(options: ChatOptions<View>): View;
  }
}
