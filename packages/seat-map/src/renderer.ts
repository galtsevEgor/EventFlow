import { Application, isWebGLSupported } from 'pixi.js';
import { createScene, type SceneState } from './draw.js';
import { fitViewport, zoomViewport } from './geometry.js';
import { bindInteractions } from './interactions.js';
import type { VenueMapViewProps } from './types.js';

export type MapRenderer = {
  update: (props: VenueMapViewProps) => void;
  fit: () => void;
  zoom: (factor: number) => void;
  destroy: () => void;
};

export async function createRenderer(
  host: HTMLElement,
  initial: VenueMapViewProps,
  hover: (text: string) => void,
  lost: () => void,
  signal: AbortSignal,
): Promise<MapRenderer> {
  if (!isWebGLSupported()) throw new Error('WebGL недоступен');
  const app = new Application();
  const dispose = () => {
    // Initialization may fail before all plugins have been created.
    try {
      app.destroy(true, { children: true });
    } catch {
      try {
        app.renderer?.destroy(true);
      } catch {
        /* Partially initialized renderer. */
      }
    }
  };
  try {
    await app.init({
      width: Math.max(1, host.clientWidth),
      height: Math.max(1, host.clientHeight),
      preference: 'webgl',
      resolution: Math.min(2, window.devicePixelRatio || 1),
      autoDensity: true,
      autoStart: false,
      sharedTicker: false,
      antialias: true,
      background: 0xf1f5f9,
    });
  } catch (error) {
    dispose();
    throw error;
  }
  if (signal.aborted) {
    dispose();
    throw new Error('Unmounted');
  }
  let destroyed = false,
    contextLost = false;
  const state: SceneState = {
    props: initial,
    view: fitViewport(initial.map, host.clientWidth, host.clientHeight),
  };
  const paint = createScene(app.stage);
  const draw = () => {
    if (!destroyed && !contextLost) {
      paint(state);
      app.render();
    }
  };
  const canvas = app.canvas;
  const onLost = (event: Event) => {
    event.preventDefault();
    contextLost = true;
    lost();
  };
  let unbind: (() => void) | undefined;
  let resize: ResizeObserver | undefined;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    resize?.disconnect();
    unbind?.();
    canvas.removeEventListener('webglcontextlost', onLost);
    dispose();
  };
  const fit = () => {
    state.view = fitViewport(state.props.map, host.clientWidth, host.clientHeight);
    draw();
  };
  try {
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.addEventListener('webglcontextlost', onLost);
    host.appendChild(canvas);
    unbind = bindInteractions(host, { get: () => state, draw, hover });
    resize = new ResizeObserver(() => {
      if (destroyed || contextLost) return;
      app.renderer.resize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight));
      fit();
    });
    resize.observe(host);
    draw();
    return {
      update(props) {
        const resized =
          props.map.width !== state.props.map.width || props.map.height !== state.props.map.height;
        state.props = props;
        if (resized) fit();
        else draw();
      },
      fit,
      zoom(factor) {
        state.view = zoomViewport(state.view, factor, {
          x: host.clientWidth / 2,
          y: host.clientHeight / 2,
        });
        draw();
      },
      destroy,
    };
  } catch (error) {
    destroy();
    throw error;
  }
}
