/**
 * Minimal MLP (Multi-Layer Perceptron) in pure TypeScript.
 *
 * 2 hidden layers with ReLU activation, softmax output.
 * Trained via REINFORCE policy gradient: nabla J = reward * nabla log(pi(action|state)).
 * Xavier weight initialization. No external dependencies — pure Float32Array math.
 *
 * Non-throwing: all public methods catch and return safe defaults on error.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Numerical stability floor for log(p). */
const LOG_EPS = 1e-8;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Xavier / Glorot uniform initialization: U(-limit, +limit) where limit = sqrt(6 / (fanIn + fanOut)). */
function xavierInit(fanIn: number, fanOut: number): Float32Array {
  const limit = Math.sqrt(6.0 / (fanIn + fanOut));
  const w = new Float32Array(fanIn * fanOut);
  for (let i = 0; i < w.length; i++) {
    w[i] = (Math.random() * 2 - 1) * limit;
  }
  return w;
}

/** ReLU activation (in-place). */
function relu(a: Float32Array): Float32Array {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < 0) a[i] = 0;
  }
  return a;
}

/** Softmax (returns new array). Numerically stable via max subtraction. */
function softmax(logits: Float32Array): Float32Array {
  const out = new Float32Array(logits.length);
  let max = -Infinity;
  for (let i = 0; i < logits.length; i++) {
    if (logits[i] > max) max = logits[i];
  }
  let sum = 0;
  for (let i = 0; i < logits.length; i++) {
    out[i] = Math.exp(logits[i] - max);
    sum += out[i];
  }
  if (sum === 0) sum = 1; // degenerate case — uniform
  for (let i = 0; i < out.length; i++) {
    out[i] /= sum;
  }
  return out;
}

/** Matrix-vector multiply: y = W * x + b.  W is [rows x cols], x is [cols]. */
function matVecMul(W: Float32Array, b: Float32Array, x: Float32Array, rows: number, cols: number): Float32Array {
  const y = new Float32Array(rows);
  for (let r = 0; r < rows; r++) {
    let sum = b[r];
    const offset = r * cols;
    for (let c = 0; c < cols; c++) {
      sum += W[offset + c] * x[c];
    }
    y[r] = sum;
  }
  return y;
}

// ---------------------------------------------------------------------------
// SimpleMLP
// ---------------------------------------------------------------------------

export class SimpleMLP {
  // Layer weights [rows x cols] and biases [rows]
  private w1: Float32Array; // [hidden1 x input]
  private b1: Float32Array; // [hidden1]
  private w2: Float32Array; // [hidden2 x hidden1]
  private b2: Float32Array; // [hidden2]
  private w3: Float32Array; // [output x hidden2]
  private b3: Float32Array; // [output]

  readonly inputDim: number;
  readonly hiddenDim: number;
  readonly outputDim: number;

  constructor(inputDim: number, hiddenDim: number, outputDim: number) {
    this.inputDim = inputDim;
    this.hiddenDim = hiddenDim;
    this.outputDim = outputDim;

    // Xavier-initialized weights
    this.w1 = xavierInit(inputDim, hiddenDim);
    this.b1 = new Float32Array(hiddenDim);
    this.w2 = xavierInit(hiddenDim, hiddenDim);
    this.b2 = new Float32Array(hiddenDim);
    this.w3 = xavierInit(hiddenDim, outputDim);
    this.b3 = new Float32Array(outputDim);
  }

  /**
   * Forward pass: input → hidden1(ReLU) → hidden2(ReLU) → softmax output.
   * Returns action probabilities that sum to 1.
   * Non-throwing — returns uniform distribution on error.
   */
  forward(input: Float32Array): Float32Array {
    try {
      // Layer 1: linear + ReLU
      const z1 = matVecMul(this.w1, this.b1, input, this.hiddenDim, this.inputDim);
      const a1 = relu(z1);

      // Layer 2: linear + ReLU
      const z2 = matVecMul(this.w2, this.b2, a1, this.hiddenDim, this.hiddenDim);
      const a2 = relu(z2);

      // Output layer: linear + softmax
      const z3 = matVecMul(this.w3, this.b3, a2, this.outputDim, this.hiddenDim);
      return softmax(z3);
    } catch {
      // Uniform fallback
      const out = new Float32Array(this.outputDim);
      out.fill(1.0 / this.outputDim);
      return out;
    }
  }

  /**
   * REINFORCE policy gradient update.
   *
   * Gradient of log pi(action | state) w.r.t. weights, scaled by reward.
   * Uses cached activations from a fresh forward pass.
   *
   * Non-throwing — silently skips update on error.
   */
  backward(state: Float32Array, action: number, reward: number, learningRate: number): void {
    try {
      // --- Forward pass with cached activations ---
      const z1 = matVecMul(this.w1, this.b1, state, this.hiddenDim, this.inputDim);
      const a1 = new Float32Array(z1.length);
      const relu1Mask = new Float32Array(z1.length);
      for (let i = 0; i < z1.length; i++) {
        relu1Mask[i] = z1[i] > 0 ? 1 : 0;
        a1[i] = z1[i] > 0 ? z1[i] : 0;
      }

      const z2 = matVecMul(this.w2, this.b2, a1, this.hiddenDim, this.hiddenDim);
      const a2 = new Float32Array(z2.length);
      const relu2Mask = new Float32Array(z2.length);
      for (let i = 0; i < z2.length; i++) {
        relu2Mask[i] = z2[i] > 0 ? 1 : 0;
        a2[i] = z2[i] > 0 ? z2[i] : 0;
      }

      const z3 = matVecMul(this.w3, this.b3, a2, this.outputDim, this.hiddenDim);
      const probs = softmax(z3);

      // --- Compute gradient of log pi(action|state) ---
      // d log(pi_a) / d z3_i = (1{i=a} - pi_i) for softmax
      const dz3 = new Float32Array(this.outputDim);
      for (let i = 0; i < this.outputDim; i++) {
        dz3[i] = -probs[i];
      }
      dz3[action] += 1.0; // 1{i=a} - pi_a

      // Scale by reward * learningRate
      const scale = reward * learningRate;

      // --- Update layer 3: dW3 = dz3 * a2^T, db3 = dz3 ---
      for (let r = 0; r < this.outputDim; r++) {
        const grad_r = dz3[r] * scale;
        this.b3[r] += grad_r;
        const offset = r * this.hiddenDim;
        for (let c = 0; c < this.hiddenDim; c++) {
          this.w3[offset + c] += grad_r * a2[c];
        }
      }

      // --- Backprop to layer 2 ---
      // da2 = W3^T * dz3
      const da2 = new Float32Array(this.hiddenDim);
      for (let r = 0; r < this.outputDim; r++) {
        const offset = r * this.hiddenDim;
        for (let c = 0; c < this.hiddenDim; c++) {
          da2[c] += this.w3[offset + c] * dz3[r];
        }
      }
      // dz2 = da2 * relu2Mask
      const dz2 = new Float32Array(this.hiddenDim);
      for (let i = 0; i < this.hiddenDim; i++) {
        dz2[i] = da2[i] * relu2Mask[i];
      }

      // Update layer 2: dW2 = dz2 * a1^T, db2 = dz2
      for (let r = 0; r < this.hiddenDim; r++) {
        const grad_r = dz2[r] * scale;
        this.b2[r] += grad_r;
        const offset = r * this.hiddenDim;
        for (let c = 0; c < this.hiddenDim; c++) {
          this.w2[offset + c] += grad_r * a1[c];
        }
      }

      // --- Backprop to layer 1 ---
      // da1 = W2^T * dz2
      const da1 = new Float32Array(this.hiddenDim);
      for (let r = 0; r < this.hiddenDim; r++) {
        const offset = r * this.hiddenDim;
        for (let c = 0; c < this.hiddenDim; c++) {
          da1[c] += this.w2[offset + c] * dz2[r];
        }
      }
      // dz1 = da1 * relu1Mask
      const dz1 = new Float32Array(this.hiddenDim);
      for (let i = 0; i < this.hiddenDim; i++) {
        dz1[i] = da1[i] * relu1Mask[i];
      }

      // Update layer 1: dW1 = dz1 * state^T, db1 = dz1
      for (let r = 0; r < this.hiddenDim; r++) {
        const grad_r = dz1[r] * scale;
        this.b1[r] += grad_r;
        const offset = r * this.inputDim;
        for (let c = 0; c < this.inputDim; c++) {
          this.w1[offset + c] += grad_r * state[c];
        }
      }
    } catch {
      // Non-throwing — skip update
    }
  }

  /**
   * Serialize all weights + biases into a single ArrayBuffer.
   * Layout: [w1 | b1 | w2 | b2 | w3 | b3] as contiguous Float32 values.
   */
  getWeights(): ArrayBuffer {
    const totalFloats =
      this.w1.length + this.b1.length +
      this.w2.length + this.b2.length +
      this.w3.length + this.b3.length;
    const buffer = new ArrayBuffer(totalFloats * 4);
    const view = new Float32Array(buffer);
    let offset = 0;
    for (const arr of [this.w1, this.b1, this.w2, this.b2, this.w3, this.b3]) {
      view.set(arr, offset);
      offset += arr.length;
    }
    return buffer;
  }

  /**
   * Load weights from a buffer previously produced by getWeights().
   * Non-throwing — leaves weights unchanged if buffer size mismatches.
   */
  loadWeights(buffer: ArrayBuffer): void {
    try {
      const totalFloats =
        this.w1.length + this.b1.length +
        this.w2.length + this.b2.length +
        this.w3.length + this.b3.length;
      if (buffer.byteLength !== totalFloats * 4) return;

      const view = new Float32Array(buffer);
      let offset = 0;
      for (const arr of [this.w1, this.b1, this.w2, this.b2, this.w3, this.b3]) {
        arr.set(view.subarray(offset, offset + arr.length));
        offset += arr.length;
      }
    } catch {
      // Non-throwing
    }
  }
}
