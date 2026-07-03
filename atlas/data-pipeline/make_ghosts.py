"""Fill the void sites with authored 'ghost papers' and emit a CLEAN voids.json.

The pipeline's voids.json carries raw nearChunks prose (verbatim corpus passages —
some read like abuse/security text out of context). This script:
  - dedups the neighbor paper TITLES (clean metadata) per void,
  - attaches an authored ghost paper (the dark-matter paper that WOULD live there),
  - DROPS the raw snippet prose entirely,
so the shipped public/data/voids.json contains no verbatim passage text.

Ghost papers are hand-authored to sit *between* the surrounding literatures
(the research-gap framing), described at a scholarly level. They are clearly
marked hallucinated: every card stamps "GHOST · hallucinated from an empty region."
"""

import json
from pathlib import Path

PUB = Path(__file__).parent.parent / "public" / "data"
src = json.loads((PUB / "voids.json").read_text())

# Authored ghosts, in file order (matches the 10 void sites the pipeline found).
GHOSTS = [
    {  # 0 — cluster 23: clinical LLM diagnostic reasoning
        "title": "The Calibration Gap: When Language Models Should Defer Clinical Judgment",
        "fields": "clinical decision science × model calibration",
        "methods": "selective-prediction curves; abstention thresholds benchmarked against physician second-opinion panels",
        "abstract": "A growing literature shows large language models matching or exceeding physicians on diagnostic-reasoning benchmarks, yet almost none of it models when a model should decline to answer. This absent paper sits between demonstrated accuracy and deployed safety: it would treat clinical LLM use as a selective-prediction problem, characterising the confidence region in which deferral to a human clinician minimises expected harm, and asking whether reasoning-trained models are better calibrated about their own uncertainty than they are accurate.",
    },
    {  # 1 — cluster 28: judicial fairness / legal bias
        "title": "Procedural Justice Without a Judge: Auditing Latent Legal Priors Across Jurisdictions",
        "fields": "computational law × fairness evaluation",
        "methods": "counterfactual jurisdiction swaps; procedural-fairness label taxonomy applied cross-lingually",
        "abstract": "Existing fairness audits of language models in legal settings concentrate on demographic parity in outcomes. The empty region here is procedural: whether a model's implicit priors about evidence, precedent, and burden of proof shift when the same case is framed under different legal traditions. This ghost paper would extend outcome-fairness benchmarks into procedural fairness, measuring how consistently a model reasons about process rather than only how evenly it distributes verdicts.",
    },
    {  # 2 — clusters 24, 46: verbal STM computational models × word/LLM semantics
        "title": "From MINERVA to the Transformer: A Unified Account of Semantic Support in Verbal Short-Term Memory",
        "fields": "computational memory modelling × distributional semantics",
        "methods": "hybrid episodic-echo model with contextual-embedding lexicon; fit to serial-recall semantic-similarity effects",
        "abstract": "Classic simulation models of verbal short-term memory represent word meaning with static semantic spaces, while modern accounts of meaning live in contextual transformer embeddings. Nothing yet occupies the space between them. This absent paper would replace the fixed semantic lexicon of an echo-based memory model with contextual embeddings, asking whether the same architecture that reproduces semantic-similarity effects in serial recall also predicts when meaning helps versus hurts order memory.",
    },
    {  # 3 — cluster 31: cloze / lexical / contextual diversity
        "title": "Contextual Diversity as a Predictor of Cloze Difficulty: A Cross-Corpus Reconciliation",
        "fields": "psycholinguistics × corpus statistics",
        "methods": "mixed-effects models of cloze probability on count-based and embedding-based diversity measures",
        "abstract": "Contextual diversity predicts lexical processing, and cloze tests probe predictability, but the two literatures rarely meet. The gap here would ask whether a word's contextual diversity — how many distinct contexts it appears in — predicts its cloze difficulty better than raw frequency, reconciling count-based and embedding-based diversity measures against human cloze completions across corpora.",
    },
    {  # 4 — cluster 6: emotion lexicons × transformers (EmoAtlas)
        "title": "Beyond the Lexicon: Network-Psychometric Emotion Profiling Meets Contextual Embeddings",
        "fields": "affective science × network psychometrics",
        "methods": "hybrid lexicon-network model scored against transformer emotion classifiers on multilingual sets",
        "abstract": "Interpretable lexicon-and-network tools for emotion profiling and opaque transformer emotion classifiers are usually compared as rivals. This empty region would combine them: using contextual embeddings to weight the edges of a psychological emotion network, testing whether an interpretable network model can inherit transformer accuracy without surrendering its explanatory structure.",
    },
    {  # 5 — cluster 35: test-time memory transformer architectures
        "title": "Do Test-Time Memory Modules Recover Human Serial-Position Curves?",
        "fields": "machine learning architectures × human memory benchmarks",
        "methods": "probing long-term-memory transformer variants with classic list-learning paradigms",
        "abstract": "Recent architectures add long-term memory modules that learn to memorise context at test time, evaluated only on language-modelling and reasoning benchmarks. The absent bridge would run these modules through the paradigms of human memory research — asking whether learned test-time memory reproduces primacy and recency, and whether its failures line up with human forgetting rather than with perplexity.",
    },
    {  # 6 — cluster 35 (deeper): continual memorization vs human forgetting
        "title": "Forgetting Curves in Context: Evaluating Continual Memorization Against Ebbinghaus",
        "fields": "continual learning × mathematical psychology",
        "methods": "retention functions fit to context-window decay; comparison with power-law human forgetting",
        "abstract": "Continual and test-time memorization schemes are measured by downstream accuracy, never by the shape of what they forget. This ghost paper would fit retention functions to how these systems lose information across a context window and compare that decay to the power-law forgetting curves that have anchored human memory research since Ebbinghaus.",
    },
    {  # 7 — cluster 0: orthographic uncertainty / entropy word-form (noisy region)
        "title": "The Typicality Manifold: An Entropy Geometry of Orthographic Word-Forms",
        "fields": "computational orthography × information theory",
        "methods": "entropy-based typicality measures embedded and analysed as a low-dimensional manifold",
        "abstract": "Entropy-based measures of orthographic typicality describe how word-like a letter string is, but treat each word as a scalar. This sparse region — genuinely thin in the corpus — would recast orthographic uncertainty as a geometry, asking whether the typicality of word-forms traces a smooth manifold whose curvature predicts lexical-access difficulty beyond neighbourhood counts.",
    },
    {  # 8 — cluster 48: agent safety / social engineering (the flagged neighborhood)
        "title": "Trust Boundaries for Delegated Agents: A Formal Model of Owner-Delegated Authority",
        "fields": "multi-agent systems × security formalism",
        "methods": "a capability-and-provenance calculus for delegated authority; adversarial case-study replication",
        "abstract": "Empirical work has documented that autonomous agents can be induced to act outside their principal's intent, but the demonstrations outrun the theory. The empty region here is formal rather than empirical: a model of trust boundaries in which an agent's authority is explicitly delegated, provenance-tracked, and revocable, so that whether an action is permitted follows from the delegation graph rather than from persuasion. It would turn scattered failure case studies into a testable specification of what a delegated agent may and may not do.",
    },
    {  # 9 — cluster 11: self-adaptive LLMs / LoRA / MoE
        "title": "Singular-Value Task Arithmetic: Composable Self-Adaptation Without Catastrophic Interference",
        "fields": "parameter-efficient adaptation × task composition",
        "methods": "singular-value expert vectors combined by learned arithmetic; interference measured across held-out tasks",
        "abstract": "Self-adaptive models tune singular-value expert vectors per task, and task-arithmetic composes fine-tuned weights, yet no work composes singular-value experts directly. This absent paper would ask whether expert vectors can be added and subtracted like task vectors — building a model that self-adapts by arithmetic over a library of experts, and measuring when composition stays interference-free versus when experts collide.",
    },
]

out = []
for i, v in enumerate(src):
    titles = []
    for nc in v.get("nearChunks", []):
        t = nc.get("paper", "").strip()
        if t and t not in titles:
            titles.append(t)
    g = GHOSTS[i]
    out.append({
        "pos": v["pos"],
        "area": v["area"],
        "nearClusters": v.get("nearClusters", []),
        "neighbors": titles[:6],       # clean paper titles only
        "ghost": {
            "title": g["title"],
            "fields": g["fields"],
            "methods": g["methods"],
            "abstract": g["abstract"],
            "marker": "GHOST",
        },
    })

(PUB / "voids.json").write_text(json.dumps(out, separators=(",", ":")))
print(f"wrote clean voids.json: {len(out)} ghost papers, raw prose stripped")
# sanity: confirm no flagged tokens survive in the shipped file
shipped = (PUB / "voids.json").read_text().lower()
for tok in ["ssn", "bank account", "social engineering", "suicid", "self-harm", "sexual", "jailbreak"]:
    n = shipped.count(tok)
    print(f"  '{tok}': {n}")
