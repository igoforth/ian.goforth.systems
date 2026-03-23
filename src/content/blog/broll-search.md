---
title: "Multi-Modal Video Search with pgvector and Three Embedding Columns"
description: "Building a B-roll search system where scenes are searchable as soon as they have any embedding, using decoupled AI pipelines and GREATEST() across pgvector columns."
pubDate: "Feb 3 2026"
---

## The Problem

Someone close to me edits videos in CapCut. She used their smart search feature constantly for finding B-roll: type a description or drop in a reference image, get matching clips from her library. Then CapCut removed it. She went back to scrubbing through hundreds of clips by hand, trying to remember where she saw the shot she needed.

I knew a bit about AI models and full stack architectures. The core idea seemed straightforward: embed video scenes and text queries into the same vector space, then find the closest match. I figured I'd give it a shot.

It turned out to be more interesting than I expected. The hard part isn't any single model. It's wiring four different AI models into a search pipeline that stays useful while it's still processing, and returning results across three different modalities (what's *said* in a scene, what's *shown*, and what the keyframe *looks like*) without requiring all of them to finish first.

I built [broll-search](https://github.com/igoforth/broll-search) over a few weeks. This post covers the design decisions that weren't obvious.

## Three Embeddings Per Scene

Every scene gets up to three embedding vectors, all 1024-dimensional from Jina CLIP v2:

- `transcript_embedding`: the spoken words, from soft subtitles or Voxtral Mini 3B
- `caption_embedding`: a visual description from Molmo 2, normalized to structured tags
- `image_embedding`: the keyframe image encoded directly by CLIP's vision encoder

The schema:

```sql
CREATE TABLE scenes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id UUID REFERENCES videos(id) ON DELETE CASCADE,
    scene_index INTEGER NOT NULL,
    start_time FLOAT NOT NULL,
    end_time FLOAT NOT NULL,
    keyframe_path TEXT,
    transcript TEXT,
    caption TEXT,
    transcript_embedding vector(1024),
    caption_embedding vector(1024),
    image_embedding vector(1024),
    processing_tags text[] DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON scenes USING hnsw (transcript_embedding vector_cosine_ops);
CREATE INDEX ON scenes USING hnsw (caption_embedding vector_cosine_ops);
CREATE INDEX ON scenes USING hnsw (image_embedding vector_cosine_ops);
CREATE INDEX ON scenes USING gin (processing_tags);
```

Three HNSW indexes, one per column. The `processing_tags` array tracks which embeddings exist: `['transcript', 'caption', 'image']`. More on why this matters below.

## The Search Query

When you search for "person walking through office hallway," the query text gets embedded once by Jina CLIP's text encoder. Then it's compared against all three columns:

```sql
SELECT s.*, v.filename,
    GREATEST(
        1 - (s.transcript_embedding <=> CAST(:embedding AS vector)),
        1 - (s.caption_embedding <=> CAST(:embedding AS vector)),
        1 - (s.image_embedding <=> CAST(:embedding AS vector))
    ) AS similarity
FROM scenes s
JOIN videos v ON s.video_id = v.id
WHERE (
    1 - (s.transcript_embedding <=> :embedding) > :threshold
    OR 1 - (s.caption_embedding <=> :embedding) > :threshold
    OR 1 - (s.image_embedding <=> :embedding) > :threshold
)
ORDER BY similarity DESC
LIMIT :limit;
```

`<=>` is pgvector's cosine distance. Subtracting from 1 gives similarity. `GREATEST` picks the best-matching column per row. If a column is NULL (not yet processed), the expression returns NULL, and `GREATEST` in PostgreSQL skips NULLs. A scene with only a transcript embedding and no caption or image embedding is still searchable, and it returns a score based on whatever it has.

This is the key design decision. Scenes don't wait for all three pipelines to finish. They become searchable the moment the first embedding lands.

## Image Search and the Mixed Query Editor

Image search falls out of the same architecture for free. When you drop in a reference image instead of typing text, it goes through Jina CLIP's vision encoder instead of the text encoder. Same vector space, same 1024 dimensions. The query hits only `image_embedding` since comparing a photo against a transcript doesn't make sense, but the mechanics are identical.

What makes this work well in practice is the search UI. The input is a WYSIWYG editor (Tiptap) where you can type text and drop images inline, in any order. The frontend serializes this into a `queries` array:

```json
[
  {"type": "text", "text": "person walking through office"},
  {"type": "image"},
  {"type": "text", "text": "close-up of laptop screen"}
]
```

Image files are sent as multipart uploads alongside the JSON, matched to image-type query items by position. The backend processes each item according to its type: text items search all three columns via `GREATEST`, image items search only `image_embedding`. The results come back per-item, so you can mix and match freely in a single query.

This mirrors what CapCut's smart search did. You could type a description or drop in a reference frame and get matching clips. Having both in the same editor means you can do things like paste a script for B-roll suggestions and insert a reference photo for a specific shot you want to match visually.

## Decoupled Pipeline

After ingesting a video (scene detection + keyframe extraction), three independent jobs can run:

1. **Transcribe**: extract soft subtitles or run Voxtral Mini 3B on the audio
2. **Caption**: send the video clip to Molmo 2 for visual description, normalize to tags
3. **Embed**: send the keyframe image through Jina CLIP's vision encoder

Each job queries for scenes missing its own tag:

```python
# transcribe.py
scenes = await session.scalars(
    select(Scene)
    .where(~Scene.processing_tags.contains(["transcript"]))
    ...
)
```

SQLAlchemy translates `.contains(["transcript"])` to the PostgreSQL `@>` (array contains) operator. The GIN index on `processing_tags` makes this fast. After processing, each job appends its tag:

```python
scene.processing_tags = scene.processing_tags + ["transcript"]
```

The jobs don't check for each other's tags. Caption doesn't require transcript. Embed doesn't require caption. You can run all three simultaneously and they race to completion, each committing scene-by-scene. If one job fails, the others keep going, and you can retry the failed one without reprocessing anything.

This replaces the alternative I considered first: a `processing_status` enum with values like `pending`, `transcribed`, `captioned`, `embedded`, `complete`. That forces a sequential pipeline and makes partial results invisible. The array-of-tags approach treats each capability as independent, which matches reality. A scene where the captioning API timed out but transcription succeeded should still be searchable by transcript.

## The Captioning Pipeline

Molmo 2 runs through OpenRouter (or optionally a self-hosted vLLM instance). The captioning is two stages.

Stage 1 generates a free-form prose description:

```python
CAPTION_PROMPT = """Describe what's happening in this clip. No speculation."""

CAPTION_PROMPT_WITH_AUDIO = """Describe what's happening in this clip. No speculation.
Audio transcript: "{transcript}" """
```

"No speculation" matters for search. Hallucinated content pollutes the embedding space. If the model invents a dog in a scene where there's no dog, future searches for "dog" return garbage.

Stage 2 normalizes the prose description into structured tags via a separate model call with JSON schema enforcement. The stored caption is always a comma-separated tag string, not free-form text. This means the `caption_embedding` is always encoding the same style of input regardless of which captioning model generated the prose. You can swap Molmo 2 for something else and the embeddings stay in the same region of the vector space.

## B-Roll Suggestions

The feature I actually built this for. You paste a script, and the system suggests B-roll for each sentence.

The search endpoint accepts `segment=true` and `unique_scenes=true`. With segmentation enabled, the input text gets split on sentence boundaries:

```python
segments = re.split(r"(?<=[.!?])\s+", transcript.strip())
```

Each sentence gets searched independently. But without deduplication, the same great scene shows up as the top result for half your sentences. The unique mode fixes this.

The deduplication runs in Python, not SQL. For each segment, I fetch `limit * 3` candidates (over-fetching for a bigger pool). Then I build a global assignment:

```python
scene_best: dict[str, tuple[int, float, dict]] = {}

for seg_idx, candidates in enumerate(all_candidates):
    for scene in candidates:
        sid = scene["scene_id"]
        score = scene["similarity_score"]
        if sid not in scene_best or score > scene_best[sid][1]:
            scene_best[sid] = (seg_idx, score, scene)
```

Each scene ends up in whichever segment it scored highest against. If a scene is the best match for segment 3 and the second-best match for segment 7, segment 3 gets it and segment 7 gets its next-best candidate. This greedy assignment isn't optimal (you could formulate it as a bipartite matching problem) but it's fast and good enough. Scripts are usually 10-30 sentences, not thousands.

## The Transcription Fast Path

Most professional footage has soft subtitles baked in. Extracting them is nearly instant compared to running speech-to-text. The transcription job checks for subtitle streams first:

```python
_TEXT_SUBTITLE_CODECS = {"srt", "subrip", "ass", "ssa", "mov_text", "webvtt", "text"}
```

Bitmap subtitle formats (VOBSUB, PGS) are excluded since they can't be extracted as text. When subtitles exist, the job skips the AI model entirely and commits the text inline. Only scenes without subtitles go through the Voxtral inference path.

The AI path uses a producer/consumer pattern with `asyncio.TaskGroup`. The producer extracts audio from scenes via ffmpeg and puts work items on a queue with `maxsize=3`. This backpressure limit prevents ffmpeg processes from piling up in memory while the GPU is busy. The consumer runs inference and writes results.

```python
async with asyncio.TaskGroup() as tg:
    tg.create_task(_producer(scenes, audio_queue, session, job, results))
    tg.create_task(_consumer(audio_queue, session, job, results))
```

Exception handling uses Python 3.11's `except*` to correctly propagate cancellation through the structured concurrency boundary. Without it, a `JobCancelledError` from either task gets wrapped in an `ExceptionGroup` and the job queue's cancellation logic can't catch it.

## Job Recovery

Jobs are stored in PostgreSQL. On startup, any jobs left in `queued` or `running` state get re-enqueued:

```python
async def _recover_jobs(self):
    async with async_session() as session:
        stale = await session.scalars(
            select(Job).where(Job.status.in_(["queued", "running"]))
        )
        for job in stale:
            await self._queue.put((job.id, job.type, self._handlers[job.type], {}))
```

During shutdown, running jobs are left in `running` state intentionally. The next startup picks them up. This is a leave-dirty-for-recovery design: it's simpler than checkpointing mid-job, and since each job's unit of work is a single scene commit, the worst case is reprocessing a few scenes that already completed but whose job-level progress wasn't synced to the database yet.

One known issue: recovered jobs lose their original parameters. A job submitted with `video_id="abc"` (to scope processing to one video) recovers as an unscoped job that processes all pending scenes. For my use case this is fine because I usually process everything, but it's wrong in general.

## What I'd Change

The search query casts the same embedding literal nine times (three in `GREATEST`, three in the threshold `WHERE`, three more in the column-specific threshold checks). A CTE would compute it once. This is a readability issue more than a performance issue since HNSW indexes make each scan fast, but it's ugly.

The unique-mode deduplication does sequential database queries, one per segment. For a 20-sentence script, that's 20 round-trips. They could run concurrently with `asyncio.gather`. I haven't hit a performance wall with it yet, but it's obviously suboptimal.

The greedy scene assignment for deduplication could be replaced with proper bipartite matching (Hungarian algorithm or similar). In practice the greedy approach produces good results because most sentences in a script are different enough to want different scenes, but there's room for improvement on scripts with repetitive phrasing.

The project is [on GitHub](https://github.com/igoforth/broll-search).
