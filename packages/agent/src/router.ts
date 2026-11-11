import type { RouterExample, RouterModel } from './types.ts';

export interface TrainRouterOptions {
  epochs?: number;
  learningRate?: number;
  l2?: number;
  threshold?: number;
  id?: string;
  createdAt?: string;
}

export function tokenize(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z0-9']+/g) ?? [])];
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

function features(vocabulary: string[], text: string): number[] {
  const words = new Set(tokenize(text));
  return vocabulary.map((w) => (words.has(w) ? 1 : 0));
}

function score(weights: number[], bias: number, x: number[]): number {
  return sigmoid(x.reduce((sum, xi, i) => sum + xi * weights[i]!, bias));
}

export function predictRoute(router: RouterModel, text: string): { score: number; needsStrong: boolean } {
  const s = score(router.weights, router.bias, features(router.vocabulary, text));
  return { score: s, needsStrong: s >= router.threshold };
}

// Plain batch gradient descent on log loss, starting from zero weights, so the same examples always give the same model.
export function trainRouter(examples: RouterExample[], options: TrainRouterOptions = {}): RouterModel {
  const { epochs = 200, learningRate = 0.5, l2 = 0.001, threshold = 0.5 } = options;
  const train = examples.filter((e) => e.split === 'train');
  const val = examples.filter((e) => e.split === 'val');
  const vocabulary = [...new Set(train.flatMap((e) => tokenize(e.text)))].sort();
  const xs = train.map((e) => features(vocabulary, e.text));
  const ys = train.map((e) => (e.needsStrong ? 1 : 0));
  const weights = vocabulary.map(() => 0);
  let bias = 0;
  const lossCurve: number[] = [];

  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradW = weights.map(() => 0);
    let gradB = 0;
    let loss = 0;
    xs.forEach((x, n) => {
      const p = score(weights, bias, x);
      const y = ys[n]!;
      loss -= y * Math.log(p + 1e-12) + (1 - y) * Math.log(1 - p + 1e-12);
      const err = p - y;
      x.forEach((xi, i) => (gradW[i]! += err * xi));
      gradB += err;
    });
    const n = Math.max(xs.length, 1);
    lossCurve.push(loss / n);
    weights.forEach((w, i) => (weights[i] = w - learningRate * (gradW[i]! / n + l2 * w)));
    bias -= (learningRate * gradB) / n;
  }

  const model: RouterModel = {
    id: options.id ?? `router-${hash(JSON.stringify(examples.map((e) => [e.text, e.needsStrong, e.split])))}`,
    createdAt: options.createdAt ?? new Date().toISOString(),
    vocabulary,
    weights,
    bias,
    threshold,
    metrics: {
      trainSize: train.length,
      valSize: val.length,
      trainAccuracy: 0,
      valAccuracy: 0,
      lossCurve,
      trainPositives: train.filter((e) => e.needsStrong).length,
      valPositives: 0,
      valRecall: null,
    },
  };
  model.metrics.trainAccuracy = accuracy(model, train);
  model.metrics.valAccuracy = accuracy(model, val);
  const valStrong = val.filter((e) => e.needsStrong);
  model.metrics.valPositives = valStrong.length;
  model.metrics.valRecall = valStrong.length ? valStrong.filter((e) => predictRoute(model, e.text).needsStrong).length / valStrong.length : null;
  return model;
}

function accuracy(model: RouterModel, examples: RouterExample[]): number {
  if (!examples.length) return 0;
  return examples.filter((e) => predictRoute(model, e.text).needsStrong === e.needsStrong).length / examples.length;
}

function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}
