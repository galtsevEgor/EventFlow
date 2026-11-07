import { Container, Graphics, Text } from 'pixi.js';
import { seatRadius } from '@eventflow/event-contracts';
import { categoryColor } from './presentation.js';
import type { Point, Rect, VenueMapViewProps, Viewport } from './types.js';

export type SceneState = {
  props: VenueMapViewProps;
  view: Viewport;
  preview?: { ids: string[]; delta: Point };
  box?: Rect;
};

function buildWorld(props: VenueMapViewProps): {
  world: Container;
  nodes: Map<string, Container>;
  box: Graphics;
} {
  const world = new Container();
  const nodes = new Map<string, Container>();
  const background = new Graphics()
    .rect(0, 0, props.map.width, props.map.height)
    .fill(0xf8fafc)
    .stroke({ color: 0xcbd5e1, width: 1 });
  world.addChild(background);
  for (const feature of props.map.features) {
    const graphic = new Graphics()
      .roundRect(feature.x, feature.y, feature.width, feature.height, 5)
      .fill({
        color: feature.kind === 'stage' ? 0x334155 : feature.kind === 'aisle' ? 0xe2e8f0 : 0xdbeafe,
        alpha: feature.kind === 'sector' ? 0.35 : 1,
      })
      .stroke({ color: 0x94a3b8, width: 1 });
    world.addChild(graphic);
    const label = new Text({
      text: feature.label,
      style: {
        fontFamily: 'sans-serif',
        fontSize: 14,
        fill: feature.kind === 'stage' ? 0xffffff : 0x334155,
        wordWrap: true,
        wordWrapWidth: Math.max(20, feature.width - 8),
      },
    });
    label.anchor.set(0.5);
    label.position.set(feature.x + feature.width / 2, feature.y + feature.height / 2);
    world.addChild(label);
  }
  const metadata = new Map(props.seats.map((seat) => [seat.seatId, seat]));
  const selected = new Set(props.selectedIds);
  for (const seat of props.map.seats) {
    const info = metadata.get(seat.seatId);
    const group = new Container();
    group.position.set(seat.x, seat.y);
    group.rotation = (seat.rotation * Math.PI) / 180;
    const available = info?.state === 'AVAILABLE';
    const color = available
      ? categoryColor(info.categoryId)
      : info?.state === 'HELD'
        ? 0xf59e0b
        : info?.state === 'SOLD'
          ? 0x64748b
          : 0xcbd5e1;
    const graphic = new Graphics()
      .circle(0, 0, seatRadius)
      .fill(color)
      .stroke({
        color: selected.has(seat.seatId) ? 0x0f172a : 0xffffff,
        width: selected.has(seat.seatId) ? 4 : 1,
      });
    graphic.moveTo(-6, -10).lineTo(6, -10).stroke({ color: 0xffffff, width: 2 });
    if (info?.state === 'SOLD' || info?.state === 'DISABLED')
      graphic
        .moveTo(-5, -4)
        .lineTo(5, 4)
        .moveTo(5, -4)
        .lineTo(-5, 4)
        .stroke({ color: 0xffffff, width: 1.5 });
    group.addChild(graphic);
    const number = new Text({
      text: String(info?.number ?? seat.seatId.split('-s')[1]),
      style: {
        fontFamily: 'sans-serif',
        fontSize: 10,
        fontWeight: 'bold',
        fill: available ? 0xffffff : 0x0f172a,
      },
    });
    number.anchor.set(0.5);
    number.y = 3;
    group.addChild(number);
    world.addChild(group);
    nodes.set(seat.seatId, group);
  }
  const box = new Graphics();
  world.addChild(box);
  return { world, nodes, box };
}

/** Reuse seat/text objects while panning, zooming and previewing a group drag. */
export function createScene(stage: Container): (state: SceneState) => void {
  let scene: ReturnType<typeof buildWorld> | undefined;
  let previous: VenueMapViewProps | undefined;
  return (state) => {
    const { props, view } = state;
    if (
      !scene ||
      previous?.map !== props.map ||
      previous.seats !== props.seats ||
      previous.selectedIds !== props.selectedIds
    ) {
      for (const child of stage.removeChildren()) child.destroy({ children: true });
      scene = buildWorld(props);
      stage.addChild(scene.world);
      previous = props;
    }
    scene.world.position.set(view.x, view.y);
    scene.world.scale.set(view.scale);
    const moving = new Set(state.preview?.ids);
    for (const seat of props.map.seats) {
      const delta = moving.has(seat.seatId) ? state.preview?.delta : undefined;
      scene.nodes
        .get(seat.seatId)
        ?.position.set(seat.x + (delta?.x ?? 0), seat.y + (delta?.y ?? 0));
    }
    scene.box.clear();
    if (state.box)
      scene.box
        .rect(state.box.x, state.box.y, state.box.width, state.box.height)
        .fill({ color: 0x2563eb, alpha: 0.1 })
        .stroke({ color: 0x2563eb, width: 1.5 / view.scale });
  };
}
