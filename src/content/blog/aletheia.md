---
title: "Designing an AI Decompiler Around MLIR"
description: "Why the hard part of AI decompilation isn't the model. It's the training data, the target representation, and the decision to keep the AI away from C."
pubDate: "Feb 26 2026"
---

## Introduction

Most AI decompilers I've looked at train a model to go from binary to C. The model learns what C looks like and generates plausible code that compiles to something different from the input. The BLEU scores look great in the paper [1, 2]. The output tends to be wrong in ways that matter. Even LLM4Decompile [3], which moved to re-executability as a metric, found only 21% of decompiled functions pass all tests at best.

The underlying problem is that binary-to-C is a many-to-many mapping with no clean loss signal. Different source compiles to identical binaries. The same source with different compiler flags produces different binaries. Variable names, formatting, typedef choices are all erased at compile time. The model has to hallucinate them. And "does this look like real C" is a fundamentally different question from "is this semantically correct."

I think the better approach is to stop asking the model to produce C at all. Factor the problem into two stages: a learned translation from binary to a structured intermediate representation, and a deterministic compiler pass from that IR to C. The model never sees C. It learns a constrained mapping between two IRs. Deterministic tooling handles the rest.

This post describes the architecture I'm building, the working pieces so far, and how a fuzzing harness generator I wrote earlier turns out to be the training data pipeline.

## Why Not an LLM

The autoregressive framing seems like a poor fit for decompilation. Optimized code reorders aggressively: instruction scheduling moves operations far from where they'd appear in source order, loop-invariant code motion pulls computations out of loops, inlining copies function bodies into callers. A model generating C token-by-token from binary read left-to-right would need to constantly jump around the binary while emitting source in declaration order. Attention can handle this in principle, but you're working against the sequential generation order.

There's also a capacity problem. LLMs are general-purpose. They spend capacity learning what C looks like, what reasonable variable names are, what coding style is common on GitHub. That's not obviously helpful for semantic correctness. My intuition is that a small task-specific model trained on well-structured data should outperform a large general-purpose model trying to "understand" assembly. The hard part isn't the model architecture. It's the training data.

If a domain expert can shape unbiased training pairs, that's most of the battle. The model learns a mapping between two well-defined representation spaces.

## The Target: SCF + arith + memref

MLIR [7] (Multi-Level Intermediate Representation) is a compiler framework with a dialect system that separates concerns into composable layers. Three dialects form the target representation:

**SCF** (Structured Control Flow): `scf.for`, `scf.while`, `scf.if`. These map 1:1 to C control structures. The model outputs structured loops and conditionals, not a flat CFG with branch instructions.

**arith**: Typed arithmetic. `arith.addi`, `arith.mulf`, `arith.cmpi`. Portable, explicit about integer width, signedness, and float vs int.

**memref**: Typed memory access. `memref.load` and `memref.store` with type information. `memref<?xi32>` is a dynamic array of 32-bit integers. The type system carries what the binary erases.

This level seems like the right tradeoff. Lower than this (LLVM dialect) loses structure, you're back to basic blocks and explicit branches, which is the flat CFG problem that makes traditional decompilation hard. Higher than this (linalg, tensor) requires inferring high-level intent, which probably reintroduces hallucination.

Here's what Polygeist [8] (cgeist) produces from a conditional sum function in C:

```mlir
func.func @conditional_sum(
    %arg0: memref<?xi32>, %arg1: i32, %arg2: i32) -> i32 {
  %c0 = arith.constant 0 : index
  %c1 = arith.constant 1 : index
  %c0_i32 = arith.constant 0 : i32
  %0 = arith.index_cast %arg1 : i32 to index
  %1 = scf.for %arg3 = %c0 to %0 step %c1
      iter_args(%arg4 = %c0_i32) -> (i32) {
    %2 = memref.load %arg0[%arg3] : memref<?xi32>
    %3 = arith.cmpi sgt, %2, %arg2 : i32
    %4 = scf.if %3 -> (i32) {
      %5 = memref.load %arg0[%arg3] : memref<?xi32>
      %6 = arith.addi %arg4, %5 : i32
      scf.yield %6 : i32
    } else {
      scf.yield %arg4 : i32
    }
    scf.yield %4 : i32
  }
  return %1 : i32
}
```

The for loop, the conditional, the accumulator pattern are all explicit in the structure. SSA form means no variable naming decisions. No style choices. No ambiguity about what's a loop vs a branch. A model producing this representation is solving a constrained translation problem rather than a generation problem.

MLIR is also architecture-independent. The same SCF output works whether the input binary came from x86, ARM, or Hexagon. The architecture-specific complexity lives in the model. The deterministic lowering to C should be write-once.

## Two Pipelines

The architecture has two output paths from the model's MLIR. Both are deterministic, no AI involved.

### Pipeline A: Verification (MLIR to Binary)

```
SCF MLIR
  -> mlir-opt (--convert-scf-to-cf --convert-cf-to-llvm ...)
  -> mlir-translate (--mlir-to-llvmir)
  -> llc (-filetype=obj)
  -> ELF x86-64 object
```

Compile the model's predicted MLIR to a binary and diff against the input. If they match, the decompilation is likely semantically correct. No human in the loop, no fuzzy metrics. This is the kind of evaluation path that BLEU-score papers don't have.

"Same binary" is too strict in practice (register allocation, instruction scheduling vary), so you need approximate binary similarity. But the pipeline exists and runs end-to-end today.

### Pipeline B: Decompilation Output (MLIR to C)

```
SCF MLIR
  -> shim (memref -> ptr, scf.while -> emitc equiv)
  -> mlir-translate (--mlir-to-cpp)
  -> C code
```

EmitC is an MLIR dialect designed for C code emission. A thin deterministic shim converts SCF+memref to EmitC, then `mlir-translate` outputs C. The generated code for the conditional sum:

```c
int32_t conditional_sum(int32_t* v1, size_t v2, int32_t v3) {
  int32_t v4 = 0;
  for (size_t v8 = 0; v8 < v2; v8 += 1) {
    int32_t v10 = v1[v8];
    if (v10 > v3) {
      v4 = v4 + v10;
    }
  }
  return v4;
}
```

Variable names are `vN` (SSA values), types are explicit, casts are verbose. But the structure is correct and the code compiles. A cleanup pass could improve readability. The semantics are what matter at this stage.

### MLIR Gaps

Three limitations in the current MLIR toolchain:

1. `scf.while` doesn't lower to EmitC. The `convert-scf-to-emitc` pass handles `scf.for` and `scf.if` but not `scf.while`. Workaround: convert while loops to bounded for loops before EmitC translation.

2. Dynamic memref doesn't lower to EmitC. `convert-memref-to-emitc` only handles static shapes (`memref<10xi32>`, not `memref<?xi32>`). The shim converts dynamic memrefs to `!emitc.ptr` before the standard pipeline.

3. There's no automatic raise from LLVM dialect to SCF. That's the whole point of the AI model.

These are all toolchain limitations rather than architectural problems. The model would target full SCF with dynamic memrefs and while loops. Pipeline A (verification) handles all of these today. Pipeline B (C emission) needs the shim to work around the EmitC gaps.

## p-code as Input

Feeding raw binary to the model wastes capacity on solved problems. Instruction decoding, section header parsing, ELF metadata, alignment padding, PLT stubs, CRT startup code. Ghidra already handles all of this.

Ghidra's p-code [9] is a production-grade, architecture-independent IL. Every supported architecture (x86, ARM, MIPS, PowerPC, SPARC, AVR, Hexagon, dozens more) gets mechanically translated to the same p-code via SLEIGH specs. The vocabulary is small and regular, which should make it a reasonable tokenizer target.

The pipeline becomes:

```
Binary -> Ghidra (headless) -> p-code -> AI model -> SCF MLIR -> C
```

One model, one input format, every architecture Ghidra supports. No per-ISA binary encoder. No custom tokenizer for raw bytes. The model learns p-code to SCF: recover structured control flow from a CFG, and recover typed memory access from raw loads and stores. Both are well-studied compiler problems, just usually solved with hand-written rules rather than learned from data.

The alternative I considered was preprocessing raw binary into a canonical instruction set, collapsing idioms (`xor eax, eax` becomes `mov eax, 0`), normalizing addressing modes into explicit pointer arithmetic, decomposing complex instructions. This is essentially what Hex-Rays's microcode does, and it took them years. Projects like McSema and RetDec that tried binary-to-LLVM-IR lifting ran into fundamental limitations around indirect jumps, function pointers, and incomplete disassembly [6]. p-code gets most of it for free.

Another alternative: skip MLIR entirely, go p-code to C directly. Fewer pipeline stages, less error propagation. But you lose the verification path (Pipeline A) and the separation between the learned stage and the deterministic stage. If the model produces wrong C, you have no easy way to check except reading it. If the model produces wrong MLIR, you can compile it and diff the binary.

## Training Data

### The Problem

The obvious training pair is (binary, source), but the mapping is many-to-many. Different source compiles to identical binaries. The same source with different flags produces different binaries. Most published datasets [4, 5] are heavily skewed toward GCC/Linux/x86-64 at -O0, which is almost trivially decompilable. Real targets are -O2 or higher, from various compilers, often cross-compiled.

Training on -O0 gives you great metrics and a model that probably falls apart on real targets. Training on -O2 means dealing with inlining, loop transforms, vectorization, and all the other optimizations that destroy the 1:1 mapping between source and binary.

### Shaping the Pairs

For each open-source project (targeting CMake projects for reliable `compile_commands.json`):

1. Compile at -O0, -O1, -O2, -O3. Each gives a different binary from the same source.
2. Compile with GCC and Clang. Different codegen for the same target.
3. Strip, run through Ghidra headless to get p-code.
4. Source side: strip comments, normalize with clang-format, standardize symbol names to v1, v2, etc.

Each (optimization level x compiler) combination gives a different (p-code, source) pair from the same function. The model sees the same C target paired with multiple p-code variants and learns that they're equivalent. That's the invariance you want.

### excido as Training Data Generator

[excido](https://ian.goforth.systems/blog/excido) is a fuzzing harness generator I built that, given a function name and a `compile_commands.json`, walks the Clang AST and produces a single self-contained C file with every transitive dependency resolved: every type definition, struct layout, enum, macro, typedef chain, and called function the target depends on.

One function with its full dependency closure maps well to the training unit this decompiler needs. The p-code for that function is the input. The self-contained source file is the target.

The interesting benefit is dense type supervision. When the model sees p-code that accesses memory at offsets 0, 4, 8 from a base pointer, the training target isn't just the function body. It includes `struct employee { int id; int age; int salary; }` right there in the same file. The model gets direct supervision on type recovery because the types are part of the target, not something it has to infer separately.

For training data specifically, excido would run in a mode that pulls in transitive type dependencies and function declarations but stops at function implementations (signatures only for callees). This keeps targets compact while preserving full type context. The dependency depth is bounded by the type graph rather than the call graph.

There's one exception. If a callee is inlined by the compiler, its implementation appears in the caller's p-code directly (not as a CALL instruction). The training target should include the inlined function's body so the model can learn to recognize inlined code. This is detectable from debug info before stripping.

### Polygeist for MLIR Ground Truth

For training the MLIR output side specifically, Polygeist [8] (cgeist) compiles C directly to SCF-level MLIR without going through LLVM IR:

```
source.c --+-- cgeist ---------> SCF MLIR (target)
            |
            +-- clang -O2 -----> binary -> Ghidra -> p-code (input)
```

This gives matched (p-code, SCF MLIR) pairs. The model can train against either representation: MLIR for the structured IR path, C source for the end-to-end path. Having both lets you compare approaches.

Polygeist builds against its own bundled LLVM (currently pinned to LLVM 18), so it doesn't conflict with system packages.

## Type Recovery

The model should probably recover what's mechanically justifiable from p-code and not much more:

**Recover** (clear evidence, clean training signal): integer width (operand sizes explicit in p-code), signedness (INT_SEXT vs INT_ZEXT), float vs int (FLOAT_ADD vs INT_ADD), pointer vs scalar (LOAD/STORE usage), array access patterns (sequential offsets from a base), function signatures.

**Attempt with uncertainty**: struct layout from consistent field access patterns, string types from usage in string operations.

**Don't attempt**: meaningful names, enum recovery, union disambiguation, typedef reconstruction. These are erased at compile time. Different training examples would produce conflicting gradients, and the model would likely learn noise.

The excido training format should handle this reasonably well. The model doesn't have to infer struct definitions from access patterns alone. It sees the definition alongside the function that uses it. When access patterns at offsets 0, 4, 8, 12 from a base consistently appear with `struct player { int x; int y; int health; int score; }` in the training target, the model can learn the correspondence. When the same offset pattern appears without a struct (four unrelated locals the compiler placed contiguously), the training target has four separate variables and the model can learn that distinction too.

## What's Not Built

Both pipelines work end-to-end. The forward path (C → SCF MLIR via Polygeist) generates the target representation, Pipeline A compiles it to x86, and Pipeline B lowers EmitC to C. Three test functions: conditional sum, matrix multiply, fibonacci.

What doesn't exist yet:

- The p-code extraction pipeline (Ghidra headless scripting)
- Training data generation at scale (the GitHub scraping + compilation + excido integration)
- The model itself
- Evaluation framework beyond Pipeline A

The model architecture is still an open question. I've been thinking about autoencoders (encode source and binary into latent spaces, learn the translation in latent space) and sequence-to-sequence (p-code tokens to MLIR tokens). The autoencoder approach could sidestep function boundary detection and file boundary alignment by operating on whole-binary representations. The sequence-to-sequence approach is simpler but requires clean function segmentation as input.

I'm likely starting with sequence-to-sequence on per-function pairs because the training data pipeline (excido + Ghidra) naturally produces function-level units. The autoencoder approach is the more ambitious direction if seq2seq works out.

## Why Now

AI decompilation papers keep getting published with BLEU scores on -O0 binaries and no semantic evaluation. As far as I can tell, the field is stuck on the wrong metrics, the wrong optimization levels, and the wrong target representation.

MLIR seems mature enough to use as a real target (the toolchain handles SCF-to-C lowering, minus the gaps noted above). Ghidra's p-code normalizes the input across architectures. And I happened to build a training data generator while making a fuzzing tool.

Whether the model architecture works out is an open question. But the representation choices and the training data pipeline are where I think the leverage is, and those are the parts I'm most confident about.

The code is at [github.com/igoforth/aletheia](https://github.com/igoforth/aletheia).

## References

1. Fu et al., ["N-Bref: A High-fidelity Decompiler Exploiting Programming Structures"](https://openreview.net/forum?id=6GkL6qM3LV) (ICLR 2021 submission). Trained on synthetic programs at -O0, evaluated with token accuracy.
2. Hosseini & Dolan-Gavitt, ["Beyond the C: Retargetable Decompilation using Neural Machine Translation"](https://arxiv.org/abs/2212.08950) (NDSS BAR 2023). Trained on -O0, argues BLEU is inappropriate for code.
3. Tan et al., ["LLM4Decompile: Decompiling Binary Code with Large Language Models"](https://arxiv.org/abs/2403.05286) (EMNLP 2024). Moved to re-executability as metric.
4. da Silva et al., ["AnghaBench: A Suite with One Million Compilable C Benchmarks"](https://github.com/brenocfg/AnghaBench) (CGO 2021). All GCC, all x86-64.
5. Armengol-Estape et al., ["ExeBench: An ML-Scale Dataset of Executable C Functions"](https://huggingface.co/datasets/jordiae/exebench) (MAPS at PLDI 2022). Average cyclomatic complexity 2.1 vs 3.6 for general GitHub C.
6. Liu et al., ["SoK: Demystifying Binary Lifters Through the Lens of Downstream Applications"](https://ieeexplore.ieee.org/document/9833799) (IEEE S&P 2022).
7. Lattner et al., ["MLIR: Scaling Compiler Infrastructure for Domain Specific Computation"](https://ieeexplore.ieee.org/document/9370308/) (CGO 2021).
8. Moses et al., ["Polygeist: Raising C to Polyhedral MLIR"](https://dl.acm.org/doi/10.1109/PACT52795.2021.00011) (PACT 2021).
9. NSA, [Ghidra SLEIGH specification](https://github.com/NationalSecurityAgency/ghidra/blob/master/GhidraDocs/languages/html/sleigh.html) (open-sourced 2019). Formal semantics: Naus et al., ["A Formal Semantics for P-Code"](https://link.springer.com/chapter/10.1007/978-3-031-25803-9_7) (VSTTE 2022).
