import { expect } from '@playwright/test';

const nextFrame = (page) =>
  page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
const percentile = (values, ratio) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * ratio) - 1];
export async function measureVenueEditor(page, cdp) {
  await cdp.send('Performance.enable');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const started = performance.now();
  await page.getByRole('button', { name: 'Настроить продажи', exact: true }).click();
  const canvas = page.locator('canvas');
  await expect(canvas).toHaveCount(1);
  await canvas.scrollIntoViewIfNeeded();
  await nextFrame(page);
  await nextFrame(page);
  const openToPaintMs = performance.now() - started;
  await page.getByLabel('Инструмент плана', { exact: true }).selectOption('pan');
  await canvas.scrollIntoViewIfNeeded();
  const bounds = await canvas.boundingBox();
  await canvas.locator('..').evaluate((host) => {
    const samples = [];
    const capture = (event) => {
      if (!event.isTrusted || event.buttons !== 1) return;
      const sample = { start: performance.now(), handlerMs: 0, nextFrameMs: 0 };
      samples.push(sample);
      requestAnimationFrame(() => {
        sample.nextFrameMs = performance.now() - sample.start;
      });
    };
    const after = (event) => {
      if (event.isTrusted && event.buttons === 1 && samples.length)
        samples.at(-1).handlerMs = performance.now() - samples.at(-1).start;
    };
    host.addEventListener('pointermove', capture, true);
    host.addEventListener('pointermove', after);
    window.__venueStopPan = () => {
      host.removeEventListener('pointermove', capture, true);
      host.removeEventListener('pointermove', after);
      delete window.__venueStopPan;
      return samples;
    };
  });
  const frames = [];
  let previous = await page.evaluate(() => performance.now());
  await page.mouse.move(bounds.x + 30, bounds.y + 100);
  await page.mouse.down();
  for (let i = 1; i <= 30; i++) {
    await page.mouse.move(bounds.x + 30 + i * 3, bounds.y + 100 + i);
    await nextFrame(page);
    const now = await page.evaluate(() => performance.now());
    frames.push(now - previous);
    previous = now;
  }
  await page.mouse.up();
  await nextFrame(page);
  await nextFrame(page);
  const samples = await page.evaluate(() => window.__venueStopPan());
  const context = await canvas.evaluate((canvas) => {
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      version: gl.getParameter(gl.VERSION),
      renderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : 'unavailable',
      width: canvas.width,
      height: canvas.height,
      dpr: devicePixelRatio,
    };
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const heap = [];
  for (let i = 0; i < 6; i++) {
    await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await expect(canvas).toHaveCount(0);
    await cdp.send('HeapProfiler.collectGarbage');
    const metrics = await cdp.send('Performance.getMetrics');
    heap.push(metrics.metrics.find((metric) => metric.name === 'JSHeapUsedSize').value);
    if (i < 5) {
      await page.getByRole('button', { name: 'Настроить продажи', exact: true }).click();
      await expect(canvas).toHaveCount(1);
      await nextFrame(page);
    }
  }
  return {
    seats: 1000,
    cpuThrottlingRate: 4,
    viewport: page.viewportSize(),
    context,
    openToPaintMs,
    measurement: 'Trusted pointer capture to next RAF; timings collected entirely in browser',
    deliveredPointerEvents: samples.length,
    panSamples: samples.map(({ handlerMs, nextFrameMs }) => ({ handlerMs, nextFrameMs })),
    protocolStepSamplesMs: frames,
    panP50Ms: percentile(
      samples.map((s) => s.nextFrameMs),
      0.5,
    ),
    panP95Ms: percentile(
      samples.map((s) => s.nextFrameMs),
      0.95,
    ),
    postUnmountHeapBytes: heap,
    heapGrowthAfterWarmupBytes: heap.at(-1) - heap[1],
    domCanvasesAfterUnmount: await canvas.count(),
  };
}

export async function pinchVenue(page, cdp) {
  const canvas = page.locator('canvas');
  await canvas.scrollIntoViewIfNeeded();
  await nextFrame(page);
  const bounds = await canvas.boundingBox(),
    x = bounds.x + bounds.width / 2,
    y = bounds.y + bounds.height / 2;
  const before = await canvas.screenshot();
  const points = (distance) => [
    { id: 1, x: x - distance, y },
    { id: 2, x: x + distance, y },
  ];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(30) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(80) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await nextFrame(page);
  return !before.equals(await canvas.screenshot());
}
