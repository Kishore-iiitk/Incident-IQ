/**
 * Helper to compute confusion matrix and classification metrics.
 */
export function computeClassificationMetrics(actuals, predictions, labels = ['P1', 'P2', 'P3', 'P4']) {
  const n = actuals.length;
  if (n === 0) return { accuracy: 0, macro_f1: 0, per_class: {}, confusion_matrix: {} };

  // Initialize confusion matrix: [actual][predicted]
  const matrix = {};
  for (const a of labels) {
    matrix[a] = {};
    for (const p of labels) {
      matrix[a][p] = 0;
    }
  }

  let correct = 0;
  for (let i = 0; i < n; i++) {
    const act = actuals[i];
    const pred = predictions[i];
    if (matrix[act] && matrix[act][pred] !== undefined) {
      matrix[act][pred]++;
    }
    if (act === pred) correct++;
  }

  const accuracy = correct / n;
  const perClass = {};
  let sumF1 = 0;

  for (const label of labels) {
    let tp = matrix[label][label];
    let fp = 0;
    let fn = 0;

    for (const other of labels) {
      if (other !== label) {
        fp += matrix[other][label];
        fn += matrix[label][other];
      }
    }

    const precision = (tp + fp) > 0 ? tp / (tp + fp) : 0;
    const recall = (tp + fn) > 0 ? tp / (tp + fn) : 0;
    const f1 = (precision + recall) > 0 ? (2 * precision * recall) / (precision + recall) : 0;

    perClass[label] = {
      precision: Number(precision.toFixed(4)),
      recall: Number(recall.toFixed(4)),
      f1: Number(f1.toFixed(4)),
      support: tp + fn
    };
    sumF1 += f1;
  }

  const macroF1 = sumF1 / labels.length;

  return {
    accuracy: Number(accuracy.toFixed(4)),
    macro_f1: Number(macroF1.toFixed(4)),
    per_class: perClass,
    confusion_matrix: matrix
  };
}
