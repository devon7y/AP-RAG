# Manifest author mismatches — records whose author disagrees with their filename

_Generated 2026-08-02 from `data/papers_metadata.json` (10,779 entries). Regenerate with the script embedded at the bottom._

## What this is

`papers_metadata.json` maps **PDF filename → bibliographic record**, and `apa_citations.py`
uses it to rewrite the answer LLM's numeric citations into APA7. When a record is wrong, the
chatbot cites a **real paper that is not the one it actually retrieved** — a silent, high-cost
failure, because the answer text stays plausible.

Corpus PDFs follow an `Author_Year.pdf` / `Author_Etal_Year.pdf` / `Author1_Author2_Year.pdf`
scheme that was normalised and human-reviewed (`scripts/verify_pdf_names.py`, `llm_rename.py`,
~7,161 renames applied). **The filename is therefore the more trustworthy side**, and a
disagreement between filename and record almost always means the record is wrong.

## Detection rule

A record is flagged when the surname token leading the filename appears **nowhere** in the
record's author list, after Unicode-accent stripping and German/Scandinavian transliteration
folding (`oe→o`, `ue→u`, `ae→a`, `ss→s`). Substring matching in both directions is allowed, so
`DellaSala` vs `Della Sala` and `Saint-Aubin` vs `SaintAubin` do **not** flag.

This deliberately does **not** flag author-order differences: if the filename's surname appears
anywhere in the list (e.g. as second author), the record is accepted. Those were counted
separately and judged benign.

## Scale and the measured root cause

| | count | share |
|---|---|---|
| manifest entries | 10,779 | |
| **flagged (author absent from record)** | **129** | **1.20%** |
| records with no author field at all | 30 | 0.28% |
| of the flagged: name is mojibake (record likely correct) | 4 | |

The error rate splits sharply by provenance. The manifest is built by
`scripts/build_apa_manifest.py` using Crossref lookup, falling back to LLM extraction from the
PDF when no DOI is found:

| record source | flagged | total | rate |
|---|---|---|---|
| has DOI (Crossref) | 53 | 9,323 | **0.57%** |
| no DOI (LLM extraction) | 76 | 1,456 | **5.22%** |

**A DOI-less record is ~9× more likely to be wrong.** The LLM fallback is the dominant
source of bad citations, so repair effort should concentrate there.

Worked example — `Cunningham_Picking_2012.pdf`:

```
  doi:             (empty)
  title:           "What's so funny?"
  container_title: "Embark (Data Sheet)"      <- nonsense, not a journal
  authors:         Morris, Ryan               <- filename says Cunningham & Picking
```

No DOI, so the LLM read metadata off the page and picked up the wrong name. The garbage
`container_title` is a useful tell for this failure mode.

## Known false-positive categories (do not 'fix' these)

1. **Mojibake** — UTF-8 read as Latin-1, e.g. `Spüler` stored as `SpÃ¼ler`. The record is
   *correct*; only the encoding is broken. Flagged rows are marked in the `Note` column.
2. **OCR letter confusion** — e.g. `Amassian` → `Arnassian` (`m`→`rn`). Record correct, name corrupted.
3. **Author vs editor/translator** — e.g. `Aarsleff_2001.pdf` → record for `Bonnot de Condillac`.
   Aarsleff edited/translated Condillac's essay; which name belongs in the citation is a
   judgement call, not a scrape error.
4. **Book reviews** — the PDF is a review by X of a book by Y; the record describes the book.

The unambiguous errors are **off-domain**: this is a psycholinguistics / cognitive-science
corpus, so records about silkworm genomics, deep-sea hydrothermal vents or TEM nanoparticle
imaging are certainly wrong.

## What to do with each row

For each entry below, decide one of:

- **REPAIR** — re-resolve against Crossref by `filename author + filename year + title`, and
  replace the record. Highest priority where `DOI` is empty and the subject is off-domain.
- **ENCODING** — record is right, fix only the mangled name (mojibake / OCR).
- **ACCEPT** — author-vs-editor or review-of-book; the record is defensible.
- **UNRESOLVABLE** — no confident Crossref match; drop the record so the citation falls back to
  the filename rather than asserting a wrong paper.

The last option matters: **a missing record is much safer than a wrong one**, because a wrong
record produces a confident, incorrect citation.

## The 129 flagged records

`FN year` is parsed from the filename; `Rec year` is from the record. `Note` marks detected
mojibake. Titles are truncated to 150 chars.

| # | Filename | FN year | Record first author | Rec year | DOI? | Record title | Container | Note |
|---:|---|---:|---|---:|:---:|---|---|---|
| 1 | `APA_2025.pdf` | 2025 | American Psychological Association | 2025 | **no** | Artificial Intelligence: Redefining the Future of Psychology |  |  |
| 2 | `Aarsleff_2001.pdf` | 2001 | Bonnot de Condillac | 2001 | **no** | Etienne Bonnot De Condillac: Essay on the Origin of Human Knowledge |  |  |
| 3 | `Abbri_1992.pdf` | 1992 | Merrell | 1992 | **no** | Peirce, Signs, and Meaning |  |  |
| 4 | `Agarwal_Etal_2014.pdf` | 2014 | Boston | 2014 | yes | In Situ TEM Observation of a Microcrucible Mechanism of Nanowire Growth | Science |  |
| 5 | `AlfordDuguid_2020.pdf` | 2020 | Shojaee | 2020 | **no** | The Illusion of Thinking: Understanding the Strengths and Limitations of Reasoning Models via the Lens of Problem Complexity |  |  |
| 6 | `Amassian_Etal_1993.pdf` | 1993 | Arnassian | 1993 | **no** | Measurement of information processing delays in human visual cortex with repetitive magnetic coil stimulation | Brain Research |  |
| 7 | `Ashby_Etal_1993.pdf` | 1993 | Asiny | 1993 | **no** | Response Time Distributions in Memory Scanning | JOURNAL OF MATHEMATICAL PSYCHOLOGY |  |
| 8 | `Bialek_DeNeys_2017.pdf` | 2017 | Białek | 2017 | yes | Dual processes and moral conﬂict: Evidence for deontological reasoners’ intuitive utilitarian sensitivity | Judgment and Decision Making |  |
| 9 | `Bloom_2001.pdf` | 2001 | Westbury | 2001 | yes | A multiplicity of constraints: How children learn word meaning | Behavioral and Brain Sciences |  |
| 10 | `Blum_1977.pdf` | 1977 | J. J. | 1977 | **no** | On the Geometry of Fourdimensions and the Relationship Between Metabolism and Body Mass | Journal of Theoretical Biology |  |
| 11 | `Bocker_Etal_1994.pdf` | 1994 | Bbcker | 1994 | **no** | A Spatiotemporal Dipole Model of the Stimulus Preceding Negativity (SPN) Priorto Feedback Stimuli | Brain Topography |  |
| 12 | `Bota_Etal_2018.pdf` | 2018 | Czerwinski | 2018 | **no** | Toward Characterizing the Productivity Benefits of Very Large Displays |  |  |
| 13 | `Boya_Etal_2026.pdf` | 2026 | Yanitski | 2026 | **no** | Semantic Universalization in Large Language Models: A Pilot Test of Kantian Coherence |  |  |
| 14 | `Brankazk_Etal_1996.pdf` | 1996 | Brankatzk | 1996 | **no** | Task-Relevant Late Positive ComDonent in Rats: Is it Related to Hippocampal Theta Rhthm? | Hippocampus |  |
| 15 | `Brazdil_Etal_2001.pdf` | 2001 | BraÂzdil | 2001 | **no** | Intracerebral event-related potentials to subthreshold target stimuli | Clinical Neurophysiology | mojibake |
| 16 | `Brosnan_DeWaal_2003.pdf` | 2003 | Sheppard | 2003 | yes |  | Nature |  |
| 17 | `Buzsaki_1998.pdf` | 1998 | BuzsaÂki | 1998 | **no** | Memory consolidation during sleep: a neurophysiological perspective | Journal of Sleep Research | mojibake |
| 18 | `Carpenter_Barry_2016.pdf` | 2016 | Rognini | 2016 | yes | Distorted grids as a spatial label and metric | Trends in Cognitive Sciences |  |
| 19 | `Chesler_Etal_1995.pdf` | 1995 | Caplan | 1995 | yes | "Weak Ego Boundaries": One Developing Feminist's Story | Feminist Foremothers in Women’s Studies, Psychology, and Men |  |
| 20 | `Cofer_Etal_1967.pdf` | 1967 | Gofer | 1967 | **no** | COMPARISON OF ANTICIPATION AND RECALL METHODS IN PAIRED-ASSOCIATE LEARNING | Journal of Experimental Psychology |  |
| 21 | `Conrad_1962.pdf` | 1962 | Holmberc | 1962 | **no** |  | Nature |  |
| 22 | `Crammond_1997.pdf` | 1997 | Uliman | 1997 | **no** | Crete, channels, cells, circuits and computers |  |  |
| 23 | `Crowley_2013.pdf` | 2013 | Bush | 2013 | yes | Cognitive and emotional influences in anterior cingulate cortex |  |  |
| 24 | `Cunningham_Picking_2012.pdf` | 2012 | Morris | 2012 | **no** | What’s so funny? | Embark (Data Sheet) |  |
| 25 | `DeBeni_Etal_1988.pdf` | 1988 | De Benta | 1988 | **no** | Imagery Limitations in Totally Congenitally Blind Subjects | Journal of Experimental Psychology: Learning, Memory, and Co |  |
| 26 | `Deng_Etal_2026.pdf` | 2026 | Qwen Team | 2026 | yes | Qwen-Scope: Turning Sparse Features into Development Tools for Large Language Models | arXiv cs.CL |  |
| 27 | `Deng_Etal_2026a.pdf` | 2026 | Qwen Team | 2026 | yes | Qwen-Scope: Turning Sparse Features into Development Tools for Large Language Models | arXiv cs.CL |  |
| 28 | `Devillis_2017.pdf` | 2017 | DeVellis | 2017 | yes | Scale Development: Theory and Applications |  |  |
| 29 | `Diosady_1984.pdf` | 1984 | Berlyne | 1984 | **no** | AESTHETIICS AND PSYCHOBIOLOGY |  |  |
| 30 | `Dobson_2006.pdf` | 2006 | Hunsley | 2006 | **no** | Introduction to Clinical Psychology |  |  |
| 31 | `Dumpelmann_Elger_1999.pdf` | 1999 | Diimpelmann | 1999 | **no** | Visual and Automatic Investigation of Epileptiform Spikes in Intracranial EEG Recordings | Epilepsia |  |
| 32 | `Dzhafarov_Bockenholt_1995.pdf` | 1995 | Dzhafaroy | 1995 | **no** | Decomposition of Recurrent Choices into Stachastically Independent Counts | Journal of Mathematical Psychology |  |
| 33 | `EGI_2018.pdf` | 2018 | Electrical Geodesics, Inc. | 2018 | **no** | Geodesic Sensor Nets™ Approved Germicide Disinfectants: Preparation and Storage Instructions |  |  |
| 34 | `Enquist_Etal_1999.pdf` | 1999 | Cox | 1999 | yes | Acceleration of global warming due to carbon-cycle feedbacks in a coupled climate model | Nature |  |
| 35 | `Eslinger_Grattan_1994.pdf` | 1994 | Eslincer | 1994 | **no** | ALTERED SERIAL POSITION LEARNING AFTER FRONTAL LOBE LESION | Neuropsychologia |  |
| 36 | `FiveGracesGroup_2009.pdf` | 2009 | Beckner | 2009 | yes | Language Is a Complex Adaptive System: Position Paper | Language Learning |  |
| 37 | `Flaherty_Lefcourt_2002.pdf` | 2002 | Lefcourt | 2002 | yes | Humor: The Psychology of Living Buoyantly |  |  |
| 38 | `Frank_Etal_2004.pdf` | 2004 | Goldsmith | 2004 | yes | THE GENETICS AND GENOMICS OF THE SILKWORM, <i>BOMBYX MORI</i> | Annual Review of Entomology |  |
| 39 | `Freeman_1969.pdf` | 1969 | Gibson | 1969 | **no** | The Senses Considered as Perceptual Systems |  |  |
| 40 | `Frostig_Etal_1990.pdf` | 1990 | Frostic | 1990 | **no** | Cortical functional architecture and local coupling between neuronal activity and the microcirculation revealed by in vivo high-resolution optical ima | Proceedings of the National Academy of Sciences of the Unite |  |
| 41 | `Fulawka_Etal_2026.pdf` | 2026 | Fuławka | 2026 | yes | Large language models accurately identify decision reasons in verbal reports | Proceedings of the National Academy of Sciences of the Unite |  |
| 42 | `Garcia-Larrea_Cezanne-Bert_1998.pdf` | 1998 | Garcı́a-Larrea | 1998 | yes | P3, Positive slow wave and working memory load: a study on the functional correlates of slow wave activity | Electroencephalography and clinical Neurophysiology |  |
| 43 | `Gelinas_Desrochers_1993.pdf` | 1993 | G61inas | 1993 | **no** | Positive and negative instructions in symbolic paired comparisons with the months of the year | Psychological Research (Psychologische Forschung) |  |
| 44 | `Gibbs_1998.pdf` | 1998 | Watanabe | 1998 | yes | Explaining Religion without Explaining It Away: Trust, Truth, and the Evolution of Cooperation in Roy A. Rappaport's "The Obvious Aspects of Ritual" |  |  |
| 45 | `Gleissner_Etal_1998.pdf` | 1998 | Gleiβner | 1998 | yes | Right hippocampal contribution to visual memory: a presurgical and postsurgical study in patients with temporal lobe epilepsy | J Neurol Neurosurg Psychiatry |  |
| 46 | `Glenn_Etal_2009.pdf` | 2009 | Tassy | 2009 | yes | Increased DLPFC activity during moral decision-making in psychopathy | Molecular Psychiatry |  |
| 47 | `Grastyan_Etal_1959.pdf` | 1959 | GRASTY~N | 1959 | **no** | HIPPOCAMPAL ELECTRICAL ACTIVITY DURING THE DEVELOPMENT OF CONDITIONED REFLEXES | ELECTR0 ENCEPHAL0 GRAPHY AND CLINICAL NEUROPHYSIOLOGY |  |
| 48 | `Grun_Etal_2001.pdf` | 2001 | Grucn | 2001 | **no** | Unitary Events in Multiple Single-Neuron Spiking Activity: I. Detection and Significance | Neural Computation |  |
| 49 | `Guerard_Saint-Aubin_2012.pdf` | 2012 | Guéard | 2012 | yes | Assessing the Effect of Lexical Variables in Backward Recall | Journal of Experimental Psychology: Learning, Memory, and Co |  |
| 50 | `Gunther_Etal_1993.pdf` | 1993 | Giinther | 1993 | **no** | Findings of Electroencephalographic Brain Mapping in Mild to Moderate Dementia of the Alrheimer Type During Resting, Motor, and Music-Perception Condi | Psychiatry Research: Neuroimaging |  |
| 51 | `Guo_Etal_2021.pdf` | 2021 | Wanjia | 2021 | yes | Abrupt hippocampal remapping signals resolution of memory interference | Nature Communications |  |
| 52 | `Hanlon_2020.pdf` | 2020 | Takahashi | 2020 | **no** | A psychophysical theory of Shannon entropy |  |  |
| 53 | `Harris_Etal_2003.pdf` | 2003 | Bergman | 2003 | yes | Evolutionary capacitance as a general feature of complex gene networks | Nature |  |
| 54 | `Hautus_Etal_2021.pdf` | 2021 | Macmillan | 2021 | **no** | Detection Theory: A User’s Guide |  |  |
| 55 | `Holland_1990.pdf` | 1990 | Hollis | 1990 | **no** | A Model of Knowledge Representation for Pavlovian Conditioning |  |  |
| 56 | `Horwich_2003.pdf` | 2003 | Putnam | 2003 | **no** | The Meaning of "Meaning" |  |  |
| 57 | `Hurst_Volpe_1982.pdf` | 1982 | Hirst | 1982 | **no** | Temporal Order Judgments with Amnesia | Brain and Cognition |  |
| 58 | `Hyona_Pollatsek_1998.pdf` | 1998 | Hy6nii | 1998 | **no** | Reading Finnish Compound Words: Eye Fixations Are Affected by Component Morphemes | Journal of Experimental Psychology: Human Perception and Per |  |
| 59 | `Jjm_cogsci_2016.pdf` | 2016 | Johns | 2016 | **no** | Experience as a Free Parameter in the Cognitive Modeling of Language |  |  |
| 60 | `Jolicoeur_DellAcqua_1998.pdf` | 1998 | Jolicœur | 1998 | yes | The Demonstration of Short-Term Consolidation | Cognitive Psychology |  |
| 61 | `Katz_1966.pdf` | 1966 | Kate | 1966 | **no** | AMOUNT OF REWARD AND RELATIVE FREQUENCY OF AMOUNT OF REWARD IN PAIRED-ASSOCIATE LEARNING | Canadian Journal of Psychology / Revue canadienne de psychol |  |
| 62 | `Keller_Etal_1965.pdf` | 1965 | Killer | 1965 | **no** | Valuation of Trial Outcome and Information in Paired-Associate Learning | Psychological Monographs: General and Applied (Whole No. 605 |  |
| 63 | `Kilic_Etal_2017.pdf` | 2017 | Kılıç | 2017 | yes | Models that allow us to perceive the world more accurately also allow us to remember past events more accurately via differentiation | Cognitive Psychology |  |
| 64 | `Kilic_Etal_2021.pdf` | 2021 | Kılıç | 2021 | yes | The Moderating Role of Feedback on Forgetting in Item Recognition | Computational Brain & Behavior |  |
| 65 | `Kilic_Oztekin_2014.pdf` | 2014 | Kılıç | 2014 | yes | Retrieval dynamics of the strength based mirror effect in recognition memory | Journal of Memory and Language |  |
| 66 | `Kluetsch_2012.pdf` | 2012 | Kllitsch | 2012 | **no** | INFORMATION AESTHETICS AND THE STUTTGART SCHOOL | MAINFRAME EXPERIMENTALISM: Early Computing and the Foundatio |  |
| 67 | `Kolers_1976a.pdf` | 1976 | Carpenter | 1976 | **no** | Pattern-Analyzing Memory | Science |  |
| 68 | `Konig_Etal_1996.pdf` | 1996 | Kiinig | 1996 | **no** | Integrator or coincidence detector? The role of the cortical neuron revisited | Trends in Neurosciences |  |
| 69 | `Kotynski_Demaree_2017.pdf` | 2017 | Vygotsky | 2017 | yes | The Problem and the Approach | Thought and Language |  |
| 70 | `Kubik_Fenton_2005.pdf` | 2005 | Kubı́k | 2005 | yes | Behavioral Evidence That Segregation and Representation Are Dissociable Hippocampal Functions | The Journal of Neuroscience |  |
| 71 | `Kwong_Etal_1992.pdf` | 1992 | Kwona?l | 1992 | **no** | Dynamic magnetic resonance imaging of human brain activity during primary sensory stimulation | Proceedings of the National Academy of Sciences of the Unite |  |
| 72 | `Kyllingsbaek_Etal_2014.pdf` | 2014 | Kyllingsbæk | 2014 | yes | Automatic attraction of visual attention by supraletter features of former target strings | Frontiers in Psychology |  |
| 73 | `Lachmann_2020.pdf` | 2020 | Langer | 2020 | **no** | About This Book |  |  |
| 74 | `Lampe_2017.pdf` | 2017 | Camus | 2017 | yes | The Myth of Sisyphus |  |  |
| 75 | `Lim_Etal_2017.pdf` | 2017 | Pinheiro | 2017 | **no** | Linear and Nonlinear Mixed Effects Models |  |  |
| 76 | `Lund_2013.pdf` | 2013 | Wallace | 2013 | **no** | The Anatomy of A.L.I.C.E. |  |  |
| 77 | `MacNeilage_1964.pdf` | 1964 | MacNeilace | 1964 | **no** | TYPING ERRORS AS CLUES TO SERIAL ORDERlNG MECHANISMS IN LANGUAGE BEHAVIOUR |  |  |
| 78 | `Martinez-Montes_Etal_2004.pdf` | 2004 | Martı́nez-Montes | 2004 | yes | Concurrent EEG/fMRI analysis by multiway Partial Least Squares | NeuroImage |  |
| 79 | `Martinez_Etal_2001a.pdf` | 2001 | Martı́nez | 2001 | yes | Putting spatial attention on the map: timing and localization of stimulus selection processes in striate and extrastriate visual areas | Vision Research |  |
| 80 | `McClaughlin_Eysenck_1967.pdf` | 1967 | Jeremy | 1967 | **no** | Extraversion, Neuroticism and Paired-Associates Learning | Journal of Experimental Research in Personality |  |
| 81 | `Mignon_2003.pdf` | 2003 | Marelli | 2003 | **no** | Affixation in Semantic Space: Modeling Morpheme Meanings with Compositional Distributional Semantics | Psychological Review |  |
| 82 | `Milad_Quirk_2002.pdf` | 2002 | Jinks | 2002 | yes | Adaptive visual metamorphosis in a deep-sea hydrothermal vent crab | Nature |  |
| 83 | `Mizrak_Oberauer_2021.pdf` | 2021 | Mızrak | 2021 | yes | What Is Time Good for in Working Memory? | Psychological Science |  |
| 84 | `Mizrak_Oztekin_2016.pdf` | 2016 | Mızrak | 2016 | yes | Working memory capacity and controlled serial memory search | Cognition |  |
| 85 | `Mohammed_Etal_2022.pdf` | 2022 | Shahmohammadi | 2022 | yes | Visual Grounding of Inter-lingual Word-Embeddings |  |  |
| 86 | `Moharram-nejaifard_Etal_2020.pdf` | 2020 | Moharram-nejadifard | 2020 | yes | The Effect of Cognitive Behavioural Group Therapy on the Workplace and Decisional Procrastination of Midwives: A Randomized Controlled Trial | Iranian Journal of Nursing and Midwifery Research |  |
| 87 | `Mona_2014.pdf` | 2014 | Shell | 2014 | **no** | Make a Note of It: Comparison in Longhand, Keyboard, and Stylus Note-Taking Techniques |  |  |
| 88 | `Morup_Etal_2006.pdf` | 2006 | Mørup | 2006 | yes | Parallel Factor Analysis as an exploratory tool for wavelet transformed event-related EEG | NeuroImage |  |
| 89 | `MoscosodelPradoMartin_Etal_2004.pdf` | 2004 | Moscoso del Prado Mart edn | 2004 | yes | Putting the bits together: an information theoretical perspective on morphological processing | Cognition |  |
| 90 | `Murdock_1995b.pdf` | 1995 | Murpock | 1995 | **no** | Similarity in a Distributed Memory Model | Journal of Mathematical Psychology |  |
| 91 | `Nairne_Neumann_1993.pdf` | 1993 | Naime | 1993 | **no** | Enhancing Effects of Similarity on Long-Term Memory for Order | Journal of Experimental Psychology: Learning, Memory, and Co |  |
| 92 | `Narasimhamurthy_2023.pdf` | 2023 | Dyson | 2023 | yes | Remote experiential learning and the replication crisis: Assessing the replicability of Cognitive Psychology via remote experiential learning |  |  |
| 93 | `Noble_Fuchs_1959.pdf` | 1959 | Sokoloff | 1959 | **no** | Effects of thyroxin on DL-leucine-1-C14 incorporation into protein of rat-liver homogenates |  |  |
| 94 | `Overveldvan_2016.pdf` | 2016 | van Overveld | 2016 | yes | The anticue task: no effect of working memory load on inhibitory control | MaRBLe Research Papers |  |
| 95 | `Pala_Etal_2025.pdf` | 2025 | Guenole | 2025 | **no** | Enhancing Scale Development: Pseudo Factor Analysis of Language Embedding Similarity Matrices |  |  |
| 96 | `Pallies_2022.pdf` | 2022 | Kaufman | 2022 | yes | Contemporary Theories of Intelligence |  |  |
| 97 | `Peirce_1931.pdf` | 1931 | Deely | 1931 | **no** | Editorial Introduction to the electronic edition of The Collected Papers of Charles Sanders Peirce (Membra Ficte Disjecta: A Disordered Array of Sever | The Collected Papers of Charles Sanders Peirce (electronic e |  |
| 98 | `Perlmuter_Etal_1971.pdf` | 1971 | Perlmutter | 1971 | **no** | EFFECT OF CHOICE ON PAIRED-ASSOCIATE LEARNING | Journal of Experimental Psychology |  |
| 99 | `Pinxten_1991.pdf` | 1991 | Kozlowski | 1991 | yes | The Geometry of Culture: Analyzing Meaning through Word Embeddings |  |  |
| 100 | `Polyn_Etal_2005.pdf` | 2005 | Vabulas | 2005 | yes | Protein Synthesis upon Acute Nutrient Restriction Relies on Proteasome Function | Science |  |
| 101 | `Rawlins_1999.pdf` | 1999 | Zuber | 1999 | **no** | News and views | Nature |  |
| 102 | `Rodden_2011.pdf` | 2011 | Hurley | 2011 | **no** | Inside Jokes: Using Humor to Reverse-Engineer the Mind |  |  |
| 103 | `Rogers_2006.pdf` | 2006 | Mandera | 2006 | yes | Explaining human performance in psycholinguistic tasks with models of semantic similarity based on prediction and counting: A review and empirical val |  |  |
| 104 | `Roschke_Etal_1993.pdf` | 1993 | R6schke | 1993 | **no** | The calculation of the first positive Lyapunov exponent in sleep EEG data | Electroencephalography and clinical Neurophysiology |  |
| 105 | `Rose_Weaver_1975.pdf` | 1975 | Rosk | 1975 | **no** | STIMULUS ENCODING AND RETROACTIVE INHIBITION | The Journal of General Psychology |  |
| 106 | `Rosler_Etal_1995.pdf` | 1995 | Rbsler | 1995 | **no** | Exploring Memory Functions by Means of Brain Electrical Topography: A Review | Brain Topography |  |
| 107 | `Scarfa_Etal_2016.pdf` | 2016 | Scarfe | 2016 | **no** | Orthographic processing in pigeons (Columba livia) | Proceedings of the National Academy of Sciences |  |
| 108 | `Schoeneman_1987.pdf` | 1987 | Sch6nemann | 1987 | **no** | Some Algebraic Relations Between Involutions, Convolutions, and Correlations, with Applications to Holographic Memories | Biological Cybernetics |  |
| 109 | `Shern_Etal_2024.pdf` | 2024 | Chan | 2024 | **no** | MLE- BENCH : E VALUATING M ACHINE L EARNING AGENTS ON M ACHINE L EARNING E NGINEERING |  |  |
| 110 | `Skocik_Etal_2016.pdf` | 2016 | Powell | 2016 | yes | I TRIED A BUNCH OF THINGS: THE DANGERS OF UNEXPECTED OVERFITTING IN CLASSIFICATION |  |  |
| 111 | `Slawinska_Kasicki_1995.pdf` | 1995 | Stawifiska | 1995 | **no** | Theta-like rhythm in depth EEG activity of hypothalamic areas during spontaneous or electrically induced locomotion in the rat | Brain Research |  |
| 112 | `Slawinska_Kasicki_1998.pdf` | 1998 | Sławinska | 1998 | **no** | The frequency of rat’s hippocampal theta rhythm is related to the speed of locomotion | Brain Research |  |
| 113 | `Snefjella_Blank_2021.pdf` | 2021 | Snejfella | 2021 | **no** | Computational Estimation of Lexical Semantic Norms: A New Framework |  |  |
| 114 | `Spuler_Etal_2015.pdf` | 2015 | SpÃ¼ler | 2015 | yes | Error-related potentials during continuous feedback: using EEG to detect errors of different type and severity | Frontiers in Human Neuroscience | mojibake |
| 115 | `Stancak_Etal_2000.pdf` | 2000 | StancÏaÂk Jr. | 2000 | **no** | Oscillatory cortical activity and movement-related potentials in proximal and distal movements | Clinical Neurophysiology | mojibake |
| 116 | `Stewart_2001.pdf` | 2001 | Rayner | 2001 | **no** | news and views | Nature |  |
| 117 | `Stump_2019.pdf` | 2019 | Quine | 2019 | yes | Ontological Relativity |  |  |
| 118 | `Talmi_Frith_2007.pdf` | 2007 | Zamore | 2007 | **no** | piRNA-mediated silencing of transposons | Nature |  |
| 119 | `TestUsage_2000.pdf` | 2000 | Camara | 2000 | yes | Psychological Test Usage: Implications in Professional Psychology | Professional Psychology: Research and Practice |  |
| 120 | `Tom_Etal_2007.pdf` | 2007 | Márquez | 2007 | yes | A Virus in a Fungus in a Plant: Three-Way Symbiosis Required for Thermal Tolerance | Science |  |
| 121 | `Tsuei_1996.pdf` | 1996 | Tuell | 1996 | **no** | The Science of Acupuncture: Theory and Practice — I Introduction | IEEE Engineering in Medicine and Biology |  |
| 122 | `Waldman_1989.pdf` | 1989 | Holzer | 1989 | **no** | Money Creates Taste |  |  |
| 123 | `Wickelgren_1967.pdf` | 1967 | Wicrelgren | 1967 | **no** | REHEARSAL GROUPING AND HIERARCHICAL ORGANIZATION OF SERIAL POSITION CUES IN SHORT-TERM MEMORY | THE QUARTERLY JOURNAL OF EXPERIMENTAL PSYCHOLOGY |  |
| 124 | `Wienker_Etal_1983.pdf` | 1983 | PfHRSON | 1983 | **no** | MAPS or [XP[RI[N([	Object and Meaning |  |  |
| 125 | `Wiese_1994.pdf` | 1994 | Yanitski | 1994 | **no** | Reassessing Choice-Framed Cognitive Dissonance in Large Language Models: A Multi-Model Replication of the GPT-4o Follow-Up Study |  |  |
| 126 | `Woods_2020.pdf` | 2020 | Gendlin | 2020 | yes | IMPLICIT PRECISION |  |  |
| 127 | `Wozniak_Gorzelanczyk_1994.pdf` | 1994 | Woiniak | 1994 | yes | Optimization of repetition spacing in the practice of learning | Acta Neurobiologiae Experimentalis |  |
| 128 | `Xiong_Etal_2014.pdf` | 2014 | Shi | 2014 | yes | Working memory training using EEG neurofeedback in normal young adults | Bio-Medical Materials and Engineering |  |
| 129 | `Yang_Lim_2011.pdf` | 2011 | Grabner | 2011 | **no** | Measuring Cognitive Ability |  |  |

## Records with no author field (30)

These cannot be checked by the rule above and produce `(n.d.)`-style citations. Listed for completeness.

```
ACL_2016.pdf
Allan_2013.pdf
Baroni_Etal_2008.pdf
Chapman_Foot_1976.pdf
Desjardins_Etal_2021.pdf
Dinneen_1966.pdf
Epstein_Etal_2009.pdf
Fisher_ODonohue_2006.pdf
Gelbukh_2002.pdf
Glock_1996.pdf
Goertzel_Etal_2014.pdf
Johnson_1970.pdf
Krantz_Etal_1974.pdf
Libben_Etal_2021.pdf
Lovell_1946.pdf
McCrae_2002.pdf
McGhee_Goldstein_1983.pdf
NAACL_HLT_2013.pdf
Nugent_2016.pdf
Pfaff_2013.pdf
Raskin_2008.pdf
Sai_2024.pdf
Shaoul_Westbury_2012.pdf
Sharifian_2016.pdf
Sharifian_2017.pdf
Simmel_1968.pdf
Sternberg_1999.pdf
Streib_Klein_2018.pdf
Willis_Etal_2013.pdf
Wrathall_2013b.pdf
```

## Reproducing / re-checking

```python
import json, re, unicodedata

def norm(s):
    s = unicodedata.normalize('NFKD', str(s or ''))
    s = ''.join(c for c in s if not unicodedata.combining(c)).lower()
    for a, b in (('oe','o'), ('ue','u'), ('ae','a'), ('ss','s')):
        s = s.replace(a, b)
    return re.sub(r'[^a-z]', '', s)

m = json.load(open('data/papers_metadata.json'))
for fn, r in sorted(m.items()):
    fams = [a.get('family','') for a in (r.get('authors') or [])
            if isinstance(a, dict) and a.get('family')]
    if not fams:
        continue
    fa = norm(fn.rsplit('.pdf', 1)[0].split('_')[0])
    if not any(fa == norm(f) or fa in norm(f) or norm(f) in fa for f in fams):
        print(fn, '->', fams[0], '| doi:', repr(r.get('doi')))
```

## Context

- Manifest builder: `scripts/build_apa_manifest.py` (Crossref-full + LLM extraction).
- Consumer: `apa_citations.py`, called by `query_server.py` `/query`.
- `data/` is **gitignored**, so the manifest is not version-controlled. The live copy is
  `C:\rag_server\papers_metadata.json` on the serving PC; a pre-merge backup sits beside it
  as `papers_metadata.json.pre_merge`.
- This file was generated after merging the repo and PC manifests, which had diverged
  (812 repo-only keys, 417 PC-only, 1,571 conflicting). The merge preferred DOI-backed records
  and lifted corpus coverage from 95.5% to 99.5%. It could not repair records that were wrong
  in *both* copies — which is exactly what remains here.
- 52 corpus PDFs still have no manifest record at all (separate issue from this list).
