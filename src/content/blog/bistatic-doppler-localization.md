---
title: "Bistatic Doppler Localization with Physics-Aware Attention"
description: "Four transmitters, a moving target, and an inverse problem. The static formulation hits a 35% ceiling. Temporal observations break through for fixed velocity. Variable velocity needs something more: a Transformer that tokens by (timestep, transmitter) reaches 60% exact / 85% within one pixel."
pubDate: "Apr 19 2026"
---

## Introduction

In a bistatic radar system, transmitters and receivers sit at different locations. A transmitter illuminates a target, the target reflects the signal, and the receiver measures the returned frequency. Because the target is moving, the returned frequency is Doppler-shifted from the transmitted frequency. With multiple transmitters at known positions, the collection of Doppler shifts encodes the target's position and velocity through a nonlinear geometric relationship. A real tracking radar inverts this relationship to estimate target state.

The question I wanted to answer: how well can a neural network learn this inverse mapping, and what inductive biases does it need? The short answer is that the naive formulation (single-shot Doppler → position) hits an information ceiling around 35%. Moving to a time-series formulation with a sequence-aware model (GRU) breaks through to 59% exact position match when target velocity is fixed. Variable velocity is much harder: 4-parameter inverse problem, catastrophic overfitting with a few thousand samples. A **physics-aware Transformer** that tokenizes by (timestep, transmitter) solves it, reaching 60% exact / 85% within one pixel on the full variable-velocity task, matching fixed-velocity performance with a 1M-parameter model.

PaRa designed the bistatic geometry and the data encoding. I implemented the dataset pipelines, loss function exploration, training infrastructure, architecture search, and analysis. The dataset was originally built for a genetic algorithm-driven neural architecture search project that evolves MLP, Transformer, and KAN architectures. This post documents the baselines I built to validate the task itself, independent of the NAS framework.

## The Task

Four transmitters sit at the corners of a 100 km × 100 km square that contains the target region:

```python
self.transmitters = torch.tensor([
    [-36000, -36000, 140e6],  # bottom left
    [ 64000, -36000, 140e6],  # bottom right
    [-36000,  64000, 140e6],  # top left
    [ 64000,  64000, 140e6],  # top right
])
```

Each transmitter broadcasts at 140 MHz. A target at position `(x, y)` moving with velocity `(vx, vy)` produces a Doppler shift relative to each transmitter:

```python
n1 = vx * x + vy * y
n2 = vx * (x - xn) + vy * (y - yn)
d1 = torch.sqrt(x**2 + y**2)
d2 = torch.sqrt((x - xn)**2 + (y - yn)**2)
m = -(F / C) * (n1 / d1 + n2 / d2)
```

The shift is quantized into a 1000-bin vector, giving a per-transmitter histogram that spikes at the bin corresponding to the shift frequency. The full input is a `(4, 1000)` tensor: four Doppler spectra, one per transmitter.

![Four Doppler spectra, one per transmitter, for a single target sample](/bistatic-input-spectra.png)

The target output is a 28 × 28 image with a single 1.0 pixel at the target's position, flattened to a 784-class label. The task is cross-entropy classification over 784 pixel positions.

## Static Baseline: a 35% Ceiling

The simplest setup: single-shot observation, fixed velocity (both `vx` and `vy` in [50, 150] per-dimension, all positive), 10,000 training samples, validation on 512 held-out samples.

I spent longer than I should have on loss function experiments before realizing a simpler truth: **cross-entropy is the right baseline for a 784-class classification problem.** Every attempt at a multi-term loss (MSE + peak magnitude + shift argmax + softmax center-of-mass + background suppression) either tied itself in knots around bad gradient paths or converged to a local minimum that produced a sharp peak in a default location regardless of input. The softmax-weighted spatial term turned out to be mathematically degenerate: softmax of a 0/1 target vector is nearly uniform, so the "center of mass" loss collapses to a constant regardless of where the actual target is.

With a straightforward MLP and `F.cross_entropy`:

```python
model = nn.Sequential(
    nn.Linear(4000, 512), nn.BatchNorm1d(512), nn.ReLU(),
    nn.Linear(512, 512),  nn.BatchNorm1d(512), nn.ReLU(),
    nn.Linear(512, 256),  nn.BatchNorm1d(256), nn.ReLU(),
    nn.Linear(256, 784),
)
loss = F.cross_entropy(model(x), target.argmax(dim=-1))
```

The result: **35% exact match, 68% within 1 pixel, mean error 2.9 pixels.** Training acc ≈ validation acc throughout (no overfitting). Scaling experiments showed this ceiling is independent of model capacity, depth, dropout, activation, or regularization. The 4 peak-bin indices contain enough information to get roughly-right, but not enough to disambiguate all 784 positions. The bottleneck is the input encoding itself.

## Temporal Observations Break the Ceiling

Real tracking radars don't work from single-shot snapshots. They aggregate observations over time. A target moving with constant velocity produces a *different* Doppler shift at each timestep as the target-transmitter geometry changes. Over T timesteps you have 4T Doppler measurements for 4 unknowns `(x0, y0, vx, vy)`, substantially overdetermined.

I rebuilt the dataset as a time series: sample initial position `(x0, y0)` and velocity `(vx, vy)`, simulate linear motion for T=5 timesteps at dt=10 seconds, compute bistatic Doppler at each timestep. Input shape is `(T, 4, 1000)` = 20,000 features per sample.

The first experiment used fixed velocity `(75, 75)`, the same 2-parameter task as the static baseline, just with more observations. A GRU over the T=5 sequence:

```python
class GRUModel(nn.Module):
    def __init__(self, hidden=256):
        super().__init__()
        self.input_proj = nn.Linear(4 * 1000, hidden)
        self.gru = nn.GRU(hidden, hidden, batch_first=True, num_layers=2)
        self.head = nn.Sequential(
            nn.Linear(hidden, 256), nn.ReLU(),
            nn.Linear(256, 784),
        )

    def forward(self, x):
        B, T, _, _ = x.shape
        x = self.input_proj(x.view(B, T, -1))
        out, _ = self.gru(x)
        return self.head(out[:, -1])
```

Result: **59% exact / 87% within 1 pixel / 94% within 2 pixels.** A clean +24 points on exact match over the static baseline, from nothing but more observations and a sequential model to aggregate them.

This matches the Kalman filter prior: the right way to invert bistatic Doppler is to integrate observations over time, not to solve a single-shot snapshot. A GRU's sequential state update is structurally similar to the state propagation in a Kalman filter, minus the explicit motion model.

A flattened MLP on the same time-series data scored 1% exact. Treating `(T, 4, 1000)` as a 20,000-dim flat input throws away the temporal structure the GRU exploits. A 1D convolution across time also failed at 1%: the convolutional receptive field over T=5 is too small to aggregate meaningfully.

## Variable Velocity: The Task Gets Harder

The fixed-velocity result is nice but narrow. Real targets don't move at `(75, 75)` with zero variance. I re-enabled variable velocity (both components independent in [50, 150]) and ran the same GRU on 8k samples:

**3% exact. 10% within 1 pixel. 100% train accuracy.**

Classic pure overfitting. The model can memorize 8k training trajectories perfectly but cannot generalize. The `(x0, y0, vx, vy)` parameter space has 4 dimensions, and 8000 samples is sparse enough that the model never sees nearby points at test time.

The scaling curve shows the transition:

| Samples | Train acc | Exact | Within 1 px |
|---------|-----------|-------|-------------|
| 5k | 100% | 0.6% | 3% |
| 10k | ~100% | 5.6% | 20% |
| 20k | 84% | 27% | 60% |
| 50k | 64% | 51% | 77% |
| 100k | 96% | 44% | 74% |

At 50k–100k samples the model starts generalizing, but progress plateaus. Getting to the fixed-velocity ceiling with a GRU on variable velocity would require hundreds of thousands of samples, and even then, the model needs to simultaneously learn 2D position inference AND velocity inference from the same input representation.

## Physics-Aware Attention

The GRU's representation collapses all 4 transmitters into a single vector per timestep:

```python
x = x.view(B, T, -1)         # (B, T, 4, 1000) → (B, T, 4000)
x = self.input_proj(x)       # (B, T, hidden)
```

Every transmitter's Doppler is mixed into a single hidden vector. The model has to infer, through training data alone, which part of the vector corresponds to which transmitter, and then figure out the geometric relationship between them.

This throws away two kinds of structural information the problem has for free:

1. **Transmitter identity.** Transmitter 0 is always at (-36000, -36000). There's no reason to make the model discover that from data; it's a static configuration.
2. **Temporal structure.** Timestep 0 is always earliest, timestep 4 is always latest. Again, known.

A Transformer encoder over a grid of (timestep, transmitter) tokens gives attention direct access to these factors. Each token represents one transmitter's observation at one timestep. There are `T × 4 = 20` tokens for T=5. Attention over this grid can independently learn:

- **Cross-transmitter attention within a single timestep:** triangulation. Four simultaneous Doppler measurements constrain target position through the geometry.
- **Cross-timestep attention within a single transmitter:** kinematic inference. How does that transmitter's Doppler shift over time? That's velocity.

Each token gets a learned transmitter embedding, a learned timestep embedding, and a projection of the actual transmitter `(x, y)` coordinates:

```python
class PhysicsTransformer(nn.Module):
    def __init__(self, d_model=256, nhead=8, num_layers=4):
        super().__init__()
        self.input_proj = nn.Linear(1000, d_model)
        self.tx_emb = nn.Embedding(4, d_model)
        self.time_emb = nn.Embedding(5, d_model)
        self.register_buffer("tx_coords", TX_COORDS / 50000.0)
        self.tx_coord_proj = nn.Linear(2, d_model)
        layer = nn.TransformerEncoderLayer(
            d_model, nhead, d_model * 4,
            batch_first=True, dropout=0.0, norm_first=True,
        )
        self.encoder = nn.TransformerEncoder(layer, num_layers)
        self.head = nn.Sequential(
            nn.Linear(d_model, 256), nn.ReLU(),
            nn.Linear(256, 784),
        )

    def forward(self, x):
        B, T, N, D = x.shape
        x = x.view(B, T * N, D)                              # 20 tokens per sample
        x = self.input_proj(x)
        tx_ids = torch.arange(N, device=x.device).repeat(T).unsqueeze(0).expand(B, -1)
        time_ids = (
            torch.arange(T, device=x.device)
            .unsqueeze(1).expand(-1, N).reshape(-1).unsqueeze(0).expand(B, -1)
        )
        x = (
            x
            + self.tx_emb(tx_ids)
            + self.time_emb(time_ids)
            + self.tx_coord_proj(self.tx_coords)[tx_ids]
        )
        x = self.encoder(x)
        return self.head(x.mean(dim=1))
```

Trained with AdamW, lr=3e-4, 500 warmup steps + cosine decay, 30 epochs on 100k samples. 3.7M parameters:

![Training and validation accuracy for the Physics Transformer over 30 epochs](/bistatic-training-curves.png)

**Final: 60.5% exact / 85.4% within 1 pixel / 93.9% within 2 pixels. Mean error 0.65 pixels. Median error 0.**

That matches or exceeds the fixed-velocity GRU result (59% / 87%), on the full variable-velocity task.

## Ablation: Tokens vs. Coordinates

Is the win architectural, or am I just handing the model more information (transmitter coordinates)? A 2×2 ablation:

| Tokenization | Coords | Exact | Within 1 px |
|--------------|--------|-------|-------------|
| flat per-timestep (GRU-style) | NO | 22.7% | 39.1% |
| flat per-timestep | WITH coords | 28.6% | 43.9% |
| per-(t, tx) (Transformer) | NO | 56.7% | 81.9% |
| per-(t, tx) | **WITH coords** | **60.5%** | **85.4%** |

The tokenization structure contributes **+34 percentage points** on exact match. Adding transmitter coordinates on top of the right tokenization contributes only **+4 points**. The dominant effect is architectural. Handing attention the problem's factorization lets it learn triangulation and velocity inference as separate relationships. Coordinate features help further but aren't the main lever.

The per-token tokenization is the kind of inductive bias that mirrors how a radar engineer would write this problem. Triangulation happens across transmitters at a single time; velocity estimation happens across times at a single transmitter. Giving the attention operator those axes explicitly lets it learn the two patterns independently, rather than having to disentangle them from a collapsed representation.

## Sample Efficiency

The Physics Transformer isn't just more accurate; it's more sample-efficient:

| Samples | GRU exact | Physics exact | Ratio |
|---------|-----------|---------------|-------|
| 10k | 2% | 6% | 3× |
| 20k | 13% | 27% | 2× |
| 50k | 27% | 51% | 1.9× |
| 100k | 44% | 60% | 1.4× |

Roughly 2–3× less data to reach the same accuracy, with the gap closing at the top of the scaling curve. Below ~10k both architectures fail: the 4-parameter task needs some minimum sample density regardless of inductive bias. Above that, the Physics Transformer scales faster.

## Analysis: Where Does It Work, Where Does It Fail?

The model hits exact match on **58% of validation samples**:

![Best predictions, pixel-perfect match between predicted and actual target](/bistatic-best-predictions.png)

Another 28% are off by one pixel. The prediction peaks are slightly softer but still on target. Median error is **0 pixels**.

![Median predictions, also exact on most samples](/bistatic-median-predictions.png)

The tail is more interesting. About 5% of validation samples have error >5 pixels, and the worst cases are all the same pattern: **the prediction is in the diagonally opposite corner from the target**.

![Worst predictions, prediction in diagonally opposite corner from target](/bistatic-worst-predictions.png)

This is a geometric ambiguity in the bistatic Doppler equations. For certain combinations of position and velocity, a target moving *away from* the transmitter array in one corner produces a nearly-identical Doppler trajectory to a target moving *toward* the array from the opposite corner. Four transmitters are enough to disambiguate position + velocity under most geometries, but not at the extreme corners of the target grid.

The error distribution confirms this is a bimodal failure mode rather than general imprecision:

![Error distribution and CDF showing long tail of corner-flip failures](/bistatic-error-distribution.png)

58% exact + 28% within 1 px + 7% in the 2–5 px range + 5% tail of corner flips. Mean error is dragged up by the tail; median is 0.

The spatial heatmap shows the tail concentrates near the grid boundaries:

![Spatial error heatmap showing failures concentrate near corners](/bistatic-spatial-error.png)

Targets in the interior of the grid have near-zero mean error. A handful of cells near the edges show 10–14 pixel mean error: those are the corner-flip failures. This is a physically motivated failure mode, not noise.

## Diverse Frequencies Fix the Corner Flips

A closer look at the failure mode points at a design choice in the dataset. All four transmitters share the same 140 MHz carrier frequency. That can't happen in a real bistatic radar: if every transmitter broadcasts on the same frequency, the receiver can't separate which reflection came from which transmitter. Real systems use FDMA, with one carrier per transmitter, and channelize the receiver to split them apart.

Using a single carrier for all transmitters also preserves the geometric symmetries of the array. With 4 identical transmitters arranged as a square, mirror-image target configurations produce the same Doppler pattern because the `F/C` scaling is uniform across all observations. Each transmitter's Doppler magnitude is just a range-rate in the same units, and the network can't tell a target-moving-northeast-from-corner-A apart from a target-moving-southwest-from-corner-C.

Adding distinct frequencies breaks this. Change the dataset so transmitter `i` broadcasts at `140 + 5i` MHz:

```python
self.tx_frequencies = torch.tensor(
    [140e6, 145e6, 150e6, 155e6],
    dtype=self.dtype, device=self.device,
)
# Doppler equation then uses per-transmitter F:
m = -(F / self.C_T) * (n1 / d1 + n2 / d2)
```

Retraining the Physics Transformer from scratch on this FDMA dataset:

| Metric | Uniform 140 MHz | Diverse 140–155 MHz |
|--------|-----------------|---------------------|
| Exact match | 60.5% | 58.5% |
| Within 1 px | 85.4% | 83.2% |
| Within 2 px | 93.9% | 92.3% |
| Mean error | 0.65 px | 0.83 px |
| **Failures >10 px** | **~5%** | **1.1%** |

Slightly lower overall accuracy (≈2 points on exact match), but the catastrophic failure rate drops by 5×. The remaining large errors are no longer clean diagonal flips. They're scattered geometric ambiguities that 4 transmitters can't fully resolve.

This is a useful radar engineering trade-off to surface. For a surveillance application where "mostly right, never catastrophically wrong" matters more than average accuracy, FDMA across transmitters is a much better design than maximizing the average case with a uniform-carrier array. More transmitters or asymmetric placement would push further in the same direction. The physics-aware attention architecture reads the resulting FDMA signal correctly because each (timestep, transmitter) token has its own embedding and coordinates: the model never assumed the transmitters were interchangeable.

## Attention Structure

The attention weights across the four encoder layers show a clear specialization pattern:

![Attention weights across four encoder layers](/bistatic-attention.png)

- **Layer 0**: diffuse attention with scattered spikes. The initial mixing layer.
- **Layer 1**: sparser, structure starting to form.
- **Layer 2**: strongly sparse, with a prominent "information sink" at token 19 (the last transmitter at the last timestep). Many queries route through this single summary token.
- **Layer 3**: vertical stripes. Most query tokens attend to a few "hub" key tokens in the middle of the time series. These become the pooled representation that the classification head reads.

I'd expected, going in, that the model would cleanly separate "same-timestep across transmitters" (triangulation) from "same-transmitter across time" (velocity) attention. What actually happened is more pragmatic: the model learns a few information-aggregation hubs and routes most of the signal through them. Less pure than the physics motivation, more like what Transformers typically learn on any structured task, but the inductive bias of the tokenization still provides the critical scaffolding.

## What the Model Actually Needs

The Physics Transformer gives attention several signals: Doppler vectors projected through `input_proj`, transmitter identity via `tx_emb(i)`, timestep identity via `time_emb(t)`, and transmitter coordinates via `tx_coord_proj([xn, yn])`. Which of these are doing real work? A full ablation over a fresh 100k-sample variable-velocity run:

| Identity features | Exact | Within 1 px | Failures >10 px |
|-------------------|-------|-------------|-----------------|
| tx_emb + fixed coords | 58.5% | 83.2% | 11 |
| tx_emb only, no coords | 56.7% | 81.9% | ~20 |
| Learnable coords + tx_emb | 58.3% | 84.2% | ~10 |
| Learnable coords, no tx_emb | 56.1% | 83.0% | 11 |
| **No transmitter identity at all** | **39.1%** | **57.7%** | **140** |
| Fully anonymous (no time_emb either) | 37.9% | 58.2% | 139 |

Three conclusions:

**Transmitter identity is essential.** Removing it drops exact match from 58% to 39% and increases catastrophic failures by 12×. The model can still extract *some* structure from anonymous Doppler vectors, but without knowing which transmitter observed which vector, it can't triangulate. Identity is the single most important inductive bias in the architecture.

**Time ordering is free.** Removing `time_emb` makes almost no difference (39% → 38%). The temporal structure is already implicit in how the data is laid out as `(T, 4, 1000)` tokens, and mean-pooling at the end is order-invariant anyway. A small architectural simplification that costs nothing.

**Identity is interchangeable; physical coordinates are not required.** Either a learned `tx_emb(i)` or a coordinate projection works. They produce redundant signals; the model uses whichever gets easier gradient flow. I tried making `tx_coords` learnable with random initialization, hoping the model would recover the true transmitter positions from the Doppler data (a physics-informed parallel to NeRF learning camera poses). It didn't. When `tx_emb` was present, the learnable coords stayed near their random initialization because `tx_emb` was carrying all the identity signal. When `tx_emb` was removed, the coords spread into four distinct points that were not the true corner positions: the model only needs distinct per-transmitter values, not physically correct ones.

![Learned transmitter coordinates (stars) versus true positions (squares), with tx_emb present](/bistatic-learned-coords.png)

For the model to actually recover the geometry, the architecture would need to use coordinates in a physics-constrained computation (e.g. explicitly computing target-to-transmitter distance and backpropagating through the Doppler equation). As additive embeddings, coordinates are just another identity feature. That's a research direction for a follow-up post: bistatic self-calibration from Doppler alone, which is closer to passive radar using transmitters of opportunity than to a fixed surveyed array.

## Implementation Notes

The code is a small Python package (~600 lines across datasets, loss, and inference utilities). The time-series dataset generates synthetic trajectories on-GPU: 100k samples pre-allocated as a `(100000, 5, 4, 1000)` float32 tensor, about 8 GB. Normalization is chunked in-place to avoid allocating a same-size temporary.

```
src/bdl/
├── datasets/
│   ├── interface.py          # abstract dataset + DataLoader adapter
│   ├── doppler.py            # static single-shot dataset
│   └── doppler_timeseries.py # time-series variant with linear motion
├── loss.py                   # custom_doppler_loss (exploration only)
├── inference.py              # visualization and accuracy metrics
└── constants.py
```

Training runs on a Radeon RX 6700 XT via ROCm 6.4 nightly PyTorch. The whole 100k-sample Physics Transformer training takes about 20 minutes.

The code is at [github.com/igoforth/bistatic-doppler-localization](https://github.com/igoforth/bistatic-doppler-localization).

## What I Learned

**The right inductive bias is worth more than the right hyperparameters.** I spent days tuning the static-baseline loss function before realizing the task was information-limited no matter what I did. The time-series reformulation plus a sequence-aware model delivered a 24-point accuracy jump with zero additional hyperparameter work.

**Architecture choice and tokenization matter more than parameter count.** The 1M-parameter Physics Transformer outperformed a 15M-parameter standard Transformer by 57× on exact match. Standard Transformers on this task collapsed to 0.3% accuracy because they tokenized by timestep instead of by (timestep, transmitter). One small structural change was the entire difference between "completely broken" and "state of the art for this problem."

**Failure modes reveal problem structure.** The worst-case corner-flip errors directly visualized a geometric ambiguity in the bistatic Doppler equations. Four identical-frequency transmitters arranged as a square preserve too much symmetry; mirror-image target configurations produce the same Doppler pattern. The fix was not algorithmic but physical: one carrier per transmitter, which a real radar would do anyway to separate receiver channels. Turning "we observed a failure mode" into "we diagnosed its physical cause and fixed it with a standard radar engineering trick" took a one-line dataset change.

**Metric design matters.** An early version of this project reported "99.7% pixel accuracy" using a per-pixel threshold `|pred − target| ≤ 0.01`. For a 28×28 image where 783 of 784 pixels are zero, that metric is satisfied by a model that outputs all zeros (783/784 = 99.87%). I was celebrating a metric hallucination for longer than I'd like to admit. Argmax-based metrics (exact match, distance-to-target) gave an honest read: the model wasn't learning anything.
