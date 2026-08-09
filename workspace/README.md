# workspace/ — artifacts written by agents

Every file here was produced by LLM agents inside the marketplace: they wrote the code
via the sandbox's `build(path, content)` function, and which features got built was
decided by market prices rather than by a human prompt. Nothing here was hand-written.

Open any `.html` directly in a browser.

| File | What it is |
|---|---|
| `forest.html` | First-person forest scene, ~308 lines, animation loop |
| `tree-climber.html`, `fractal-tree-climber.html`, `tree-climbing-game.html`, `tree_climbing_game.html` | Four independent takes on the same climbing game |
| `ball-game.html`, `click-the-bouncing-ball*.html`, `bouncing_ball_test.html`, `output.html` | Five variants of a bouncing-ball game |
| `runs/` | Timestamped snapshot of a generated build |

## Why the duplicates are worth keeping

Four tree games and five ball games is not an accident — it is the clearest evidence in
the repository for a specific design claim: **a generative system with no similarity
measure pays full price for redundancy.** The agents had no way to notice that a
near-identical artifact already existed, so effort and tokens went into variants instead
of variety. This is the empirical case for diversity-weighted scoring
(`FINDINGS.md` §3.1 and §5).

Kept as evidence, not as a portfolio.
