import assert from 'node:assert/strict';
import { test } from 'node:test';
import { predictRoute, trainRouter } from './router.ts';
import type { RouterExample } from './types.ts';

const hard = ['refund the discounted order minus the opened lamp', 'partial refund with final sale and discount', 'refund opened items minus discount', 'how much refund for my mixed order with a discount'];
const easy = ['where is my order', 'when will my parcel arrive', 'what is the status of my order', 'track my delivery please'];

function examples(): RouterExample[] {
  const make = (text: string, needsStrong: boolean, i: number): RouterExample => ({
    id: `${needsStrong ? 'h' : 'e'}${i}`,
    text,
    needsStrong,
    reason: needsStrong ? 'measured_failure' : null,
    split: i === 3 ? 'val' : 'train',
    easyTraceId: 'x',
    hardTraceId: 'y',
    easyPassed: !needsStrong,
    hardPassed: true,
  });
  return [...hard.map((t, i) => make(t, true, i)), ...easy.map((t, i) => make(t, false, i))];
}

test('router learns a separable toy set and the loss falls', () => {
  const model = trainRouter(examples());
  const curve = model.metrics.lossCurve;
  assert.equal(curve.length, 200);
  assert.ok(curve.at(-1)! < curve[0]!);
  assert.equal(model.metrics.trainSize, 6);
  assert.equal(model.metrics.valSize, 2);
  assert.equal(model.metrics.trainAccuracy, 1);
  assert.equal(model.metrics.valAccuracy, 1);
  assert.deepEqual([model.metrics.trainPositives, model.metrics.valPositives, model.metrics.valRecall], [3, 1, 1]);
  assert.equal(predictRoute(model, 'refund with discount please').needsStrong, true);
  assert.equal(predictRoute(model, 'where is my parcel').needsStrong, false);
});

test('router training is deterministic', () => {
  const a = trainRouter(examples(), { createdAt: 't' });
  const b = trainRouter(examples(), { createdAt: 't' });
  assert.deepEqual(a, b);
});

test('recall is null when validation holds no request that needed the strong model', () => {
  const model = trainRouter(examples().map((e) => (e.needsStrong && e.split === 'val' ? { ...e, split: 'train' as const } : e)));
  assert.deepEqual([model.metrics.trainPositives, model.metrics.valPositives, model.metrics.valRecall], [4, 0, null]);
});
