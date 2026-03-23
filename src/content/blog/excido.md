---
title: "Generating Fuzzing Harnesses from Clang AST"
description: "Cross-TU type resolution, preprocessor guard balancing, macro dependency analysis, and the other problems you hit when trying to extract a self-contained C file from a large codebase."
pubDate: "Mar 10 2024"
---

## Introduction

A fuzzing harness for a C function is a standalone `.c` file that calls the target with fuzz-generated input. Writing one means pulling in every type definition, struct layout, enum, macro constant, typedef chain, and helper function the target depends on. For a function in a single-file library, you copy a few headers. For a function in a large codebase with dependencies scattered across dozens of files and translation units, it becomes a manual dependency resolution exercise that takes hours and breaks every time the source changes.

I built [excido](https://github.com/igoforth/excido) to automate this. Given a function name and a `compile_commands.json`, it walks the Clang AST, resolves every dependency transitively across translation units, and emits a single self-contained `.c` file with an AFL++ harness skeleton. This post covers every design decision, the problems I ran into, and the workarounds I found. I'll use mbedTLS's X.509 DER certificate parser as the running example, since it pulls in ASN.1 parsing, signature verification, ECC curve arithmetic, and PSA crypto key management across 21 source files.

## Architecture

The tool has five phases:

1. **Function discovery.** `func_scanner` (a C++ preprocessor-based scanner) indexes all function definitions across the compile database
2. **AST parsing.** libclang creates a `TranslationUnit` for the target function's source file
3. **Dependency resolution.** Walk the cursor tree, extract source for each dependency, resolve cross-TU functions iteratively
4. **Macro resolution.** Scan rendered source for macro identifiers, inline their `#define` directives
5. **Harness generation.** Topological sort, render to C, format with clang-format

Each phase has its own problems. The interesting ones are in phases 3 and 4.

## Function Discovery

`func_scanner` is a separate C++ binary that reads `compile_commands.json`, preprocesses each source file (macro expansion, `#include` processing), and scans the expanded token stream for function definitions using a state machine:

```cpp
switch (S) {
    case State::TopLevel:
        if (Tok.is(tok::identifier)) {
            CandidateName = PP.getSpelling(Tok);
            S = State::AfterIdent;
        }
        break;
    case State::AfterIdent:
        if (Tok.is(tok::l_paren)) {
            ParenDepth = 1;
            S = State::Params;
        } else if (Tok.is(tok::identifier)) {
            // another identifier:previous was part of return type
            CandidateName = PP.getSpelling(Tok);
        }
        break;
    case State::Params:
        // balance parens until we see the closing one
        // ...
    case State::AfterParams:
        if (Tok.is(tok::l_brace)) {
            BraceDepth = 1;
            S = State::Body;
        }
        break;
    case State::Body:
        // balance braces; on close, record the function
        // ...
}
```

No AST is built. It runs phases 1-4 of C translation only. This processes mbedTLS's entire compile database in about a second. The output includes `static` functions, which matters. The cross-TU resolver needs to find internal helpers that the linker would normally resolve, not just public API functions.

## Dependency Resolution

This is the core of the tool and where most of the complexity lives.

### The Cursor Walk

Given the target function's cursor, `resolve_deps_graph` calls `walk_preorder()` to visit every node in the AST subtree. A 3-cursor sliding window provides prev/current/next context for disambiguation:

```python
cl: list[Cursor | None] = [None, None, None]

for next_cursor in cursor.walk_preorder():
    if cl[1] is None:
        cl[1] = next_cursor
        continue
    cl[2] = next_cursor
    key = self._process_cursor_graph(cl, graph)
    if key:
        dep_keys.append(key)
    cl[0] = cl[1]
    cl[1] = cl[2]
```

The window is needed because Clang emits adjacent duplicates: a function call shows up as `UNEXPOSED_EXPR` + `DECL_REF_EXPR` + `CALL_EXPR` with the same spelling. Without dedup, the resolver would process each one and potentially add the same symbol three times. The prev/next context detects these pairs and skips the redundant cursors.

`_process_cursor_graph` dispatches on the cursor kind. Only five kinds matter:

```python
if cl[1].kind not in [
    CursorKind.TYPE_REF,
    CursorKind.UNEXPOSED_EXPR,
    CursorKind.FIELD_DECL,
    CursorKind.CALL_EXPR,
    CursorKind.DECL_REF_EXPR,
]:
    return None
```

Everything else (`INTEGER_LITERAL`, `PAREN_EXPR`, `BINARY_OPERATOR`, `IF_STMT`, etc.) is structural syntax that doesn't introduce new type dependencies.

For each relevant cursor, the resolver:
1. Gets the definition via `get_definition()`
2. Checks if the definition is already in the graph (`graph.has()`)
3. If new, extracts source text using the cursor's byte extent
4. Adds it to the graph with dependency edges
5. Recurses into the definition's own subtree

The result is a `DepGraph`, a dict of `(CursorKind, name) → Symbol` with explicit dependency edges for topological sorting:

```python
@dataclass
class Symbol:
    name: str
    kind: _CursorKind
    source: str           # C source text to emit
    deps: list[SymbolKey] # edges for toposort
    size: int = -1        # byte size for VAR_DECL globals
```

### Typedef Promotion

Here's what Clang gives you for `typedef struct mbedtls_asn1_buf { int tag; size_t len; unsigned char *p; } mbedtls_asn1_buf;`:

```
TYPEDEF_DECL mbedtls_asn1_buf
  STRUCT_DECL mbedtls_asn1_buf
    FIELD_DECL tag
    FIELD_DECL len
    FIELD_DECL p
```

The `STRUCT_DECL` is a child of the `TYPEDEF_DECL`, but Clang reports its `semantic_parent` as the translation unit, not the typedef. If the resolver encounters both cursors during the walk, it emits both a `typedef struct mbedtls_asn1_buf { ... } mbedtls_asn1_buf;` *and* a standalone `struct mbedtls_asn1_buf { ... };`, causing a redefinition error.

The fix: when the resolver encounters a bare `STRUCT_DECL` or `ENUM_DECL`, it scans TU-level children for a `TYPEDEF_DECL` whose underlying type has the same cursor hash:

```python
if c_def.kind in (CursorKind.STRUCT_DECL, CursorKind.ENUM_DECL):
    target_hash = c_def.hash
    for tc in self.a_db.tlu.cursor.get_children():
        if tc.kind == CursorKind.TYPEDEF_DECL:
            inner = tc.underlying_typedef_type.get_declaration()
            if inner and inner.hash == target_hash:
                c_def = tc  # promote to typedef
                break
```

If found, it promotes the bare struct to the typedef. The graph gets `typedef struct mbedtls_asn1_buf { ... } mbedtls_asn1_buf;` as one symbol, and the inner struct gets registered as an empty alias to prevent it from being emitted separately.

### Forward-Declared Structs

mbedTLS's PSA crypto layer splits type declarations across headers:

```c
// crypto_types.h:public API
typedef struct psa_key_attributes_s psa_key_attributes_t;

// crypto_struct.h:internal
struct psa_key_attributes_s {
    psa_key_type_t type;
    psa_key_bits_t bits;
    psa_key_lifetime_t lifetime;
    psa_key_policy_t policy;
    mbedtls_svc_key_id_t id;
};
```

Both headers are included by the TU. When the resolver encounters the typedef, it extracts the source: `typedef struct psa_key_attributes_s psa_key_attributes_t;`. Then it checks the inner struct. The old code unconditionally registered it as an empty alias:

```python
# OLD: always alias, never check if it's just a forward decl
inner = c_def.underlying_typedef_type.get_declaration()
if inner and inner.spelling:
    graph.add(Symbol(name=inner.spelling, kind=inner.kind, source=""))
```

The empty alias blocks any future attempt to resolve the struct body, since `graph.has()` returns true. Every function that dereferences `psa_key_attributes_t *` fails with "incomplete type."

The fix checks whether the struct body is physically inside the typedef's extent using byte offsets:

```python
inner_def = inner if inner.is_definition() else inner.get_definition()
typedef_contains_body = (
    inner_def and inner_def.is_definition()
    and inner_def.extent.start.offset >= c_def.extent.start.offset
    and inner_def.extent.end.offset <= c_def.extent.end.offset
)
if typedef_contains_body:
    # struct body is inline:register empty alias
    graph.add(Symbol(name=inner.spelling, kind=inner.kind, source=""))
elif inner_def and inner_def.is_definition():
    # forward-declared typedef:emit struct body separately
    inner_source = self.a_db.get_content_from_ast_api(inner_def)
    inner_sym = Symbol(name=inner.spelling, kind=inner.kind, source=inner_source)
    graph.add(inner_sym)
    inner_sym.deps = self.resolve_deps_graph(inner_def, graph)
```

If the body is at a different offset (the forward-declaration case), it gets emitted as a separate symbol with its own dependency edges and recursive resolution. This change alone eliminated 37 compilation errors.

### Cross-TU Forward-Declaration Post-Pass

Some forward-declared structs can't be resolved from the primary TU at all. `mbedtls_pk_info_t` is defined in `pk_wrap.h`, a private header that `x509_crt.c` never includes. Querying the primary TU:

```python
inner = typedef_cursor.underlying_typedef_type.get_declaration()
defn = inner.get_definition()
# defn is None:the definition isn't visible in this TU
```

But `pk.c` includes `pk_wrap.h`. The cross-TU resolver already created an `AstDatabase` for `pk.c` (to resolve `mbedtls_pk_free`). After cross-TU function resolution completes, excido scans the graph for typedefs with empty aliases and tries each cached TU:

```python
for sym_key, sym in list(graph.symbols.items()):
    if sym.kind != CursorKind.TYPEDEF_DECL:
        continue
    # check if inner struct has an empty alias
    inner_name = re_search(r"\bstruct\s+(\w+)", sym.source).group(1)
    inner_sym = graph.symbols.get((CursorKind.STRUCT_DECL, inner_name))
    if not inner_sym or inner_sym.source.strip():
        continue  # already has a body
    # try each cross-TU database
    for xtu_db in tu_cache.values():
        cursor = xtu_db.find_cursor(
            kind=CursorKind.STRUCT_DECL, term=inner_name, definition=True
        )
        if cursor and cursor.is_definition():
            inner_sym.source = xtu_db.get_content_from_ast_api(cursor)
            inner_sym.deps = DependencyResolver(xtu_db).resolve_deps_graph(cursor, graph)
            break
```

### Source Extraction and Preprocessor Guards

`get_content_from_ast_api` slices the source file bytes using the cursor's extent offsets. For a function wrapped in preprocessor conditionals:

```c
#if defined(__IAR_SYSTEMS_ICC__)
#pragma inline = forced
#elif defined(__GNUC__)
__attribute__((always_inline))
#endif
static inline uint16_t mbedtls_get_unaligned_uint16(const void *p)
{
    uint16_t r;
    memcpy(&r, p, sizeof(r));
    return r;
}
```

Clang parsed the `__GNUC__` branch. The cursor extent starts at `__attribute__((always_inline))`. It captured the attribute and the `#endif` below it, but not the `#if`/`#elif` above. The extracted source looks like:

```c
__attribute__((always_inline))
#endif
static inline uint16_t mbedtls_get_unaligned_uint16(const void *p)
// ...
```

That's `#endif` without a matching `#if`. After extraction, excido counts the imbalance:

```python
@staticmethod
def _count_pp_balance(data: bytes) -> int:
    depth = 0
    min_depth = 0
    for line in data.split(b"\n"):
        if _PP_IF_RE.match(line):
            depth += 1
        elif _PP_ENDIF_RE.match(line):
            depth -= 1
            if depth < min_depth:
                min_depth = depth
    return -min_depth  # number of missing #if directives
```

If unbalanced, it scans backwards in the file bytes from the cursor start, tracking nesting depth to skip nested `#if`/`#endif` pairs, and prepends the missing opening guards:

```python
for line in reversed(preceding_lines):
    if _PP_ENDIF_RE.match(line):
        depth += 1  # nested:need to skip its matching #if
    elif _PP_IF_RE.match(line):
        if depth > 0:
            depth -= 1
        else:
            collected.append(line)
            found += 1
            if found >= needed:
                break
    elif _PP_ELIF_ELSE_RE.match(line):
        if depth == 0:
            collected.append(line)  # part of our block
```

The output becomes:

```c
#if defined(__IAR_SYSTEMS_ICC__)
#elif defined(__GNUC__)
__attribute__((always_inline))
#endif
static inline uint16_t mbedtls_get_unaligned_uint16(const void *p)
// ...
```

### Static Globals and Initializer Walking

mbedTLS uses `static const` arrays for lookup tables like ECC curve parameters, OID registries, and precomputed elliptic curve points:

```c
static const mbedtls_mpi_uint secp256r1_p[] = {
    0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0x00000000,
    0x00000000, 0x00000000, 0x00000001, 0xFFFFFFFF,
};
```

These have definitions visible to `get_definition()`, so the old code saw them as resolved `VAR_DECL`s and silently discarded them. Only `extern` globals (no definition visible) went through `_resolve_global()`.

The `DECL_REF_EXPR` handler now checks whether a resolved `VAR_DECL` is file-scope:

```python
if ref_def.kind == CursorKind.VAR_DECL:
    if (ref_def.semantic_parent
            and ref_def.semantic_parent.kind == CursorKind.TRANSLATION_UNIT):
        return self._resolve_global(ref_def, graph)
    return None  # local variable:skip
```

`_resolve_global` extracts the source, resolves the type (unwrapping pointers, arrays, typedefs to the base type), and walks the initializer for transitive dependencies. That last part matters: an ECC curve point table whose initializer references precomputed X/Y coordinate arrays needs those arrays resolved too.

But the initializer walk needs scoping. Clang's cursor subtree for a global can include nodes from macro expansions at distant file positions. A logging macro that references the global name creates back-references in the AST:

```python
if "=" in source:
    init_start = ref.extent.start.line
    init_end = ref.extent.end.line
    for child in ref.walk_preorder():
        loc = child.location
        if loc.file and (loc.line < init_start or loc.line > init_end):
            continue  # outside the declaration:skip
        # process child normally
```

Without this filter, a 1-byte global like `byte sm_message_as_id = 0;` would pull in the entire trace framework because a logging macro 2,000 lines away happened to reference it.

### Function Pointer References

ECC curve tables in mbedTLS assign modular reduction functions via a token-pasting macro:

```c
#define NIST_MODP(P) grp->modp = ecp_mod_##P;

// expands to:
grp->modp = ecp_mod_p256;
```

The AST for the assignment contains a `DECL_REF_EXPR` to `ecp_mod_p256`, but it's not a `CALL_EXPR`. It's a function pointer being stored. The old code only marked functions as unresolved from `CALL_EXPR` nodes.

```python
# function pointer ref:resolve or mark for cross-TU
if ref_def.kind == CursorKind.FUNCTION_DECL:
    key = (CursorKind.FUNCTION_DECL, ref_def.spelling)
    if graph.has(*key):
        return key
    if not ref_def.is_definition():
        self.unresolved_functions.add(ref_def.spelling)
        return key
    source = self.a_db.get_content_from_ast_api(ref_def)
    if source and source.strip():
        sym = Symbol(name=ref_def.spelling, kind=CursorKind.FUNCTION_DECL, source=source)
        graph.add(sym)
        sym.deps = self.resolve_deps_graph(ref_def, graph)
        return key
```

### Graph-Aware Extern Preservation

`_resolve_global` used to unconditionally strip `extern`:

```python
source = source.replace("extern ", "", 1)  # need actual definition for harness
```

But when the type is opaque in the harness (only forward-declared, no struct body in the graph), stripping `extern` creates a storage-size error. The compiler can't allocate space for `const mbedtls_pk_info_t mbedtls_rsa_info;` when `mbedtls_pk_info_t` is incomplete.

```python
type_complete_in_graph = False
if type_decl and type_decl.spelling:
    for kind in (CursorKind.STRUCT_DECL, CursorKind.TYPEDEF_DECL):
        gkey = (kind, type_decl.spelling)
        if graph.has(*gkey):
            gsym = graph.symbols[gkey]
            if gsym.source.strip() and "{" in gsym.source:
                type_complete_in_graph = True
                break
if type_complete_in_graph:
    source = source.replace("extern ", "", 1)
# else: keep extern:let the linker resolve it
```

### Cross-TU Resolution

When the resolver encounters a `CALL_EXPR` whose `get_definition()` returns `None`, the function is marked as unresolved. After the primary TU pass, the cross-TU loop runs:

```python
while unresolved - resolved_fns:
    batch = unresolved - resolved_fns
    resolved_fns |= batch
    new_unresolved: set[str] = set()
    with ThreadPoolExecutor(max_workers=THREADS) as pool:
        futures = {pool.submit(_resolve_cross_tu_fn, fn): fn for fn in batch}
        for future in as_completed(futures):
            new_unresolved |= future.result()
    unresolved |= new_unresolved - (blacklist or set())
```

Each `_resolve_cross_tu_fn` call:
1. Looks up the function in the `func_scanner` database
2. Creates a new `AstDatabase` for that source file (or reuses from a thread-safe cache)
3. Finds the function cursor via `find_cursor(definition=True)`
4. Extracts its source and resolves its dependencies into the shared graph
5. Returns any new unresolved functions discovered during resolution

For mbedTLS, this converges after resolving 136 functions from 21 translation units. The TU cache prevents re-parsing the same file when multiple functions come from it:`ecp_curves.c` provides 6 different modular reduction functions, all sharing one TU.

### Nested Struct Dedup

Cross-TU resolution can pull in the same struct through different code paths. `struct key_data` is defined inline inside `psa_key_slot_t`:

```c
typedef struct {
    // ... other fields ...
    struct key_data {
        uint8_t *data;
        size_t bytes;
    } key;
} psa_key_slot_t;
```

A cross-TU function that references `struct key_data` resolves it as a standalone symbol. But the `psa_key_slot_t` source text already contains the nested definition. Both end up in the graph.

During `render()`, before emitting a standalone struct, excido pre-scans all symbol sources:

```python
all_other_source = {self._key(sym): sym.source for sym in ordered if sym.source.strip()}

for sym in ordered:
    if sym.kind in (CursorKind.STRUCT_DECL, CursorKind.ENUM_DECL):
        my_key = self._key(sym)
        pattern = re_compile(rf"\bstruct\s+{escape(sym.name)}\s*\{{")
        for other_key, other_src in all_other_source.items():
            if other_key != my_key and pattern.search(other_src):
                continue  # skip:already nested in another symbol
```

### sizeof() Dependency Edges

PSA crypto's persistent key storage format uses `sizeof` in an array dimension:

```c
typedef struct {
    uint8_t magic[PSA_KEY_STORAGE_MAGIC_HEADER_LENGTH];
    uint8_t version[4];
    uint8_t lifetime[sizeof(psa_key_lifetime_t)];
    uint8_t type[2];
    uint8_t policy[sizeof(psa_key_policy_t)];    // <-- needs psa_key_policy_t complete
    uint8_t key_data[];
} psa_persistent_key_storage_format;
```

`sizeof(psa_key_policy_t)` creates a compile-time dependency, but `sizeof` doesn't produce a `TYPE_REF` in the AST. It's evaluated during semantic analysis. The toposort has no edge from this struct to `psa_key_policy_t`, so they can appear in either order.

`resolve_sizeof_graph` scans the rendered source with a regex:

```python
all_source = graph.render_source()
sizeof_refs = findall(r"\bsizeof\s*\(\s*([A-Za-z_]\w*)\s*\)", all_source)

for type_name in set(sizeof_refs):
    type_key_typedef = (CursorKind.TYPEDEF_DECL, type_name)
    if graph.has(*type_key_typedef):
        # find inner struct, add edges from user to typedef + struct
        for sym_key, sym in graph.symbols.items():
            sizeof_pattern = rf"\bsizeof\s*\(\s*{escape(type_name)}\s*\)"
            if search(sizeof_pattern, sym.source):
                if type_key_typedef not in sym.deps:
                    sym.deps.append(type_key_typedef)
```

This also handles the case where a typedef wraps a forward-declared struct and the struct body hasn't been resolved yet. It tries `find_cursor(definition=True)` and fills in the body, checking first that the typedef doesn't already contain the body inline.

## Macro Resolution

C macros live outside the AST. `#define` directives are processed by the preprocessor before parsing, so the cursor tree has no representation of them. excido resolves macros in a separate pass after all types and functions are in the graph.

### The Algorithm

The TU exposes `MACRO_DEFINITION` cursors as top-level children. excido indexes them by name, then iteratively matches against tokens in the graph:

```python
# build initial token set from all graph source (fast concat, no toposort)
all_source = graph.render_source()
tokens = set(findall(r"[A-Za-z_]\w*", all_source))

resolved: set[str] = set()
while True:
    new_count = 0
    new_sources: list[str] = []

    for name, defn in macro_defs.items():
        if name in resolved or name not in tokens:
            continue
        resolved.add(name)
        if name in graph.blacklist:
            continue

        source = self.a_db.get_content_from_ast_api(defn)
        if not source.lstrip().startswith("#define"):
            source = f"#define {source}"

        graph.add(Symbol(name=name, kind=CursorKind.MACRO_DEFINITION, source=source))
        new_count += 1
        new_sources.append(source)

    if new_count == 0:
        break
    # only tokenize NEW macro sources for the next pass
    for src in new_sources:
        tokens.update(findall(r"[A-Za-z_]\w*", src))
```

The incremental tokenization is the key optimization. The naive approach calls `graph.render()` each iteration, which runs `toposort()` (O(V+E)) on the full graph. With 20,000+ macros in the TU index and 7 macro resolution passes, that's 7 full toposorts. The optimized version only re-tokenizes the newly added macro source strings and adds them to the running set.

`render_source()` is a fast path that concatenates all symbol sources without sorting:

```python
def render_source(self) -> str:
    with self._lock:
        return "\n".join(s.source for s in self.symbols.values() if s.source.strip())
```

The full `render()` with toposort, nested struct dedup, and three-bucket segregation is only called for the final output.

### The Three-Bucket Problem

`render()` emits symbols in three groups: macros first, then types/globals, then functions. Within each group, the toposort order is preserved. This works because C macros must be defined before use, and almost every type and function uses macros. Without the three-bucket split, macros end up scattered through the output and the compiler sees undefined identifiers.

The problem: some macros reference non-macro symbols. In mbedTLS:

```c
// ecp.c, line 312
static const mbedtls_ecp_curve_info ecp_supported_curves[] = { ... };

// ecp.c, line 344
#define ECP_NB_CURVES   sizeof(ecp_supported_curves) / sizeof(ecp_supported_curves[0])

// ecp.c, line 347
static mbedtls_ecp_group_id ecp_supported_grp_id[ECP_NB_CURVES];
```

`ECP_NB_CURVES` uses `sizeof(ecp_supported_curves)`, which needs the array declared first. But macros are emitted before types. The array goes in the types bucket, the macro goes in the macros bucket, and the compiler sees `sizeof(ecp_supported_curves)` before the array is declared.

I tried four approaches to fix this:

**Unified toposort.** Remove all buckets, emit everything in toposort order. Broke everything: 4,916 errors. Without explicit edges from types to the macros they use, toposort places macros at arbitrary positions. Almost every type references at least one macro, so almost every type ended up before the macros it needs.

**Bidirectional deps.** Add edges from macros to symbols they reference, AND from symbols to macros they reference. Created cycles everywhere. `MBEDTLS_PRIVATE` is used by 50+ structs. `NULL` is used by everything. Adding those edges makes the graph nearly fully connected.

**Forward declarations.** Emit `extern` declarations for macro-referenced globals before the macro bucket. Failed because `static const` arrays can't have `extern` forward declarations in C. Also, the forward declaration's type might not be declared yet either.

**Deferred macros.** Move macros with non-macro deps to the types bucket. Failed because the types bucket doesn't have edges to macros (that's the bidirectional deps problem), so toposort places the deferred macro after the types that use it.

The solution: handle it in the stubs file. `#define ECP_NB_CURVES 11` in `stubs_mbedtls.h` blacklists the problematic macro and provides a constant value. It's ugly but it works for the one case that hits this pattern.

The right fix would be emitting macros at their original source positions relative to the declarations they're interleaved with, preserving the ordering from the original `.c` file. That requires tracking source file positions through the extraction pipeline, which is on the roadmap for the C++ port.

### Blacklisted Macro Ranges

Embedded firmware is full of logging and assertion macros. The stubs file redefines them:

```c
#define ERR_FATAL(format, xx_arg1, xx_arg2, xx_arg3) do { \
    fprintf(stderr, "ERR_FATAL: " format "\n", ...); \
    abort(); \
} while(0)
```

But when a function calls `ERR_FATAL(...)`, the Clang AST sees the *expanded* version, not the macro call. The expansion produces `CALL_EXPR` nodes to `err_Fatal_internal3()`, `DECL_REF_EXPR` nodes to trace buffer globals, and `UNEXPOSED_EXPR` nodes to diagnostic framework types. Without filtering, the resolver would cross-TU resolve all of them, pulling in the entire error framework, diagnostic subsystem, and trace buffer infrastructure.

excido collects byte offset ranges for all macro instantiations that transitively reference blacklisted macros:

```python
# pre-tokenize macro sources into identifier sets
def_tokens: dict[str, set[str]] = {}
for name, defn in macro_defs.items():
    src = a_db.get_content_from_ast_api(defn)
    if src:
        def_tokens[name] = set(findall(r"[A-Za-z_]\w*", src))

# transitive closure: set intersection instead of regex
suppressed: set[str] = set(blacklist)
changed = True
while changed:
    changed = False
    for name, tokens in def_tokens.items():
        if name not in suppressed and tokens & suppressed:
            suppressed.add(name)
            changed = True

# collect instantiation ranges
ranges = []
for c in a_db.tlu.cursor.get_children():
    if c.kind == CursorKind.MACRO_INSTANTIATION and c.spelling in suppressed:
        ranges.append((c.extent.start.offset, c.extent.end.offset))
```

The transitive closure originally used regex:`re.search(rf"\b{re.escape(bl_name)}\b", src)` for each macro source against each suppressed name. On firmware with 20,000+ macros, this was O(n*m) per iteration of the `while changed` loop. It hung indefinitely. The set intersection approach (pre-tokenize once, then check `tokens & suppressed`) is instant.

During the cursor walk, any node whose offset falls within a blacklisted range is dropped:

```python
if self._blacklisted_macro_ranges and cl[1].kind in (
    CursorKind.CALL_EXPR, CursorKind.DECL_REF_EXPR, CursorKind.UNEXPOSED_EXPR
):
    off = cl[1].extent.start.offset
    for ms, me in self._blacklisted_macro_ranges:
        if ms <= off < me:
            return None
```

The check covers all three cursor kinds, not just `CALL_EXPR`, because the problem isn't limited to function calls. An `UNEXPOSED_EXPR` referencing a trace buffer global inside a `QTRACE` macro would otherwise resolve the global, which resolves its type, which resolves the buffer descriptor struct, which has queue link fields from a platform header the harness can't include. Blocking the initial reference prevents the entire dependency chain.

### Globals from Macro Source Text

Blocking all references inside blacklisted ranges creates a problem:

```c
#define SM_SUB (sm_message_as_id)

// in a function body, inside a blacklisted SM_LOG_HF_ERROR expansion:
SM_LOG_HF_ERROR("SM", SM_SUB, "Invalid field");
```

`sm_message_as_id` appears as a `DECL_REF_EXPR` inside the blacklisted range, so it's dropped. But the harness needs it:`SM_SUB` is a non-blacklisted macro that expands to `(sm_message_as_id)`.

After macro resolution, excido scans non-blacklisted macro source text for TU-scope globals:

```python
# build global name set from cursor index (O(1) per lookup)
self.a_db._build_cursor_index()
tu_globals: dict[str, Cursor] = {}
for (kind, name), cursors in self.a_db._cursor_index.items():
    if kind != CursorKind.VAR_DECL:
        continue
    for c in cursors:
        if c.semantic_parent and c.semantic_parent.kind == CursorKind.TRANSLATION_UNIT:
            tu_globals[name] = c
            break

# intersect macro tokens with global names
all_macro_source = "\n".join(
    sym.source for sym in graph.symbols.values()
    if sym.kind == CursorKind.MACRO_DEFINITION and sym.source.strip()
    and sym.name not in (graph.blacklist or set())
)
macro_idents = set(findall(r"[A-Za-z_]\w*", all_macro_source))
candidates = macro_idents & set(tu_globals.keys())

for name in candidates:
    if not graph.has(CursorKind.VAR_DECL, name) and name not in graph.blacklist:
        self._resolve_global(tu_globals[name], graph)
```

The first implementation did `find_cursor()` for every identifier in macro source text. On firmware with thousands of macros, most identifiers aren't globals. They're parameter names, keywords, operators. Each miss triggered a full TU walk. It took 26 minutes. The fix: build the global name set once from the cursor index, then do set intersection. Same result, sub-second.

## The Stubs File

Each target needs a stubs file that provides libc headers and blacklists platform-specific symbols. For mbedTLS:

```c
/* Stubs for mbedTLS harness:libc and platform dependencies */
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* Blacklist standard types so the dep resolver doesn't pull in
   cross-platform typedefs (Dinkumware/IAR) that conflict with host. */
typedef size_t size_t;
typedef uint32_t uint32_t;
typedef FILE FILE;

/* Blacklist macro that references a global via sizeof() */
#define ECP_NB_CURVES 11

/* Internal GCC/glibc types that leak through cross-compilation headers */
typedef unsigned long long __uint64_t;
```

The blacklist parser creates a `TranslationUnit` from the stubs file and collects all top-level symbol spellings whose source location is in the stubs file itself (skipping symbols from included headers):

```python
tu = TranslationUnit.from_source(str(stubs_path))
for c in tu.cursor.get_children():
    if not c.spelling:
        continue
    if c.location.file and Path(c.location.file.name).resolve() == stubs_resolved:
        names.add(c.spelling)
```

The `typedef size_t size_t;` trick: Clang parses this as a valid `TYPEDEF_DECL` with spelling `size_t`. The blacklist parser sees it in the stubs file and adds `size_t` to the blacklist set. When the resolver encounters `typedef _Sizet size_t;` from the cross-compilation headers, it hits the blacklist check and skips it. No conflicting type definition reaches the harness.

## Topological Sort and Rendering

`toposort()` implements Kahn's algorithm. When cycles exist (common with mutually-referencing structs via pointer fields), it breaks them by picking the lowest in-degree node:

```python
while rem_in:
    queue = [k for k, deg in rem_in.items() if deg == 0]
    if not queue:
        # true cycle:break at lowest in-degree
        min_deg = min(rem_in.values())
        queue = [k for k, deg in rem_in.items() if deg == min_deg][:1]
    # process queue...
```

The three-bucket render emits symbols in order: macros, types/globals (with semicolons appended if the cursor extent excluded them), then functions. Within each bucket, the toposort order is preserved.

## Performance

I profiled with `cProfile`. The mbedTLS run takes ~90 seconds:

| Phase | Time | Notes |
|-------|------|-------|
| TU creation (21x) | ~25s | libclang `from_source` calls |
| AST walk + resolution | ~45s | 54M `walk_preorder` calls |
| Macro resolution | ~10s | 20K+ macro index, 7 passes |
| Coccinelle callers | ~3s | `spatch` for call site context |
| clang-format | ~2s | formatting 15K lines |

The biggest cost is `walk_preorder`:54 million calls through ctypes bindings. The `spelling` property (7.5M accesses, 12s tottime) marshals a C string through the FFI on every access.

One early version spent 50 seconds in `_collect_rw_counts`, an optional analysis that counts pointer dereference reads/writes across the call graph to annotate harness parameters. It's now behind `--rw-analysis` and disabled by default.

Another hotspot was the blacklist early-exit. The graph's `add()` method silently drops blacklisted symbols, but `graph.has()` returns false (since nothing was added). Every subsequent encounter re-extracts the source, re-adds (silently dropped), and re-resolves dependencies. `size_t` alone hit this path 423 times. Adding a blacklist check before the emit section cut resolve time from 102s to 88s:

```python
key = (c_def.kind, c_def.spelling)
if graph.has(*key):
    return key
if c_def.spelling in (graph.blacklist or set()):
    return None  # early exit:don't extract source or recurse
```

## Results

### mbedTLS: `mbedtls_x509_crt_parse_der`

X.509 DER certificate parser. Takes a byte buffer and parses it into a certificate structure.

| Metric | Value |
|--------|-------|
| Output | 14,862 lines |
| Cross-TU functions | 136 from 21 TUs |
| Compilation errors | 0 |
| Macros resolved | ~500 |
| Generation time | ~97 seconds |

The harness includes the full ASN.1 parsing stack, OID matching tables (signature algorithms, hash algorithms, ECC curve identifiers, X.509 extension OIDs), elliptic curve point arithmetic with precomputed tables for 9 curves, multi-precision integer operations, PSA crypto key management, and AES round constant tables. It compiles with `cc -fsyntax-only -std=c11` with zero errors.

For linking, a few manual stubs are needed: `mbedtls_pk_info_t` globals (extern because the struct body comes from a private header resolved after the global was emitted), PSA driver wrappers (generated at build time, not in any source file), and a couple of `static inline` functions caught by a false positive in the macro range check. The type resolution is complete. The linking stubs are the remaining manual step.

### Embedded Firmware

I also tested against an embedded firmware codebase, a NAS protocol message decoder that parses raw bytes from the cellular air interface. Zero compilation errors, 2,474 lines, 5 cross-TU functions. The stubs file handles cross-architecture types (the code was written for a DSP), and the blacklist prevents the trace framework from pulling in queue primitives and buffer descriptors that don't exist on the host.

## What I Learned

**The AST is not the source.** Clang's cursor tree is the parsed, type-checked, macro-expanded result. A 10-line function can have a cursor subtree spanning thousands of lines because a logging macro expanded into trace framework initialization code. A 1-byte global variable's `walk_preorder` can yield nodes at line 2307 because a diagnostic macro 2,000 lines away referenced the variable name.

**Blacklisting is more important than resolving.** The first version resolved everything and produced harnesses with thousands of errors from platform dependencies. The stubs file, what to *not* resolve, is the design that matters. Getting the blacklist right for a new target is the main per-target effort.

**Macros are fundamentally different from other symbols.** They can't participate in the dependency graph because C requires textual definition before use, creating an implicit dependency from every symbol to every macro it references. I spent two days trying to integrate macros into the toposort (unified ordering, bidirectional deps, deferred macros, forward declarations) and reverted every attempt. The three-bucket render is ugly but correct for 99% of cases.

**Set operations beat regex.** The transitive blacklist closure, the macro token scanning, the sizeof reference detection, the global name lookup. Every place I started with regex matching or `find_cursor` slow paths hit O(n^2) on large inputs. Pre-tokenizing into sets and using intersection/lookup is consistently faster by orders of magnitude.

**The Python bindings are the bottleneck.** 54 million `walk_preorder` calls through ctypes. Every `cursor.spelling` access marshals through the C FFI. A C++ port using Clang Tooling directly would eliminate this overhead and enable source-position-aware macro emission, solving the three-bucket problem at the root.

The code is at [github.com/igoforth/excido](https://github.com/igoforth/excido).
