# Manifest mismatch repair — results & review list

_2026-08-02. Companion to [MANIFEST_AUTHOR_MISMATCHES.md](MANIFEST_AUTHOR_MISMATCHES.md). Produced by `scripts/repair_manifest_mismatches.py`._

## What was done

Of the 129 author-mismatch flags: **56 auto-repaired**, **15 confirmed correct** (left untouched), **58 left for manual review**.

Each flagged record was re-resolved from its own PDF: the record's own DOI -> Crossref, then any DOI printed in the PDF -> Crossref, then a Crossref author+year search. A repair was **applied only when the new record's author matched the (trustworthy) filename AND the new title overlapped the PDF text** (>=0.95 when the original already had a DOI, else >=0.75). Records that could not be confidently resolved were left untouched (policy: keep, don't drop).

- Backup of the pre-repair manifest: `data/backups/papers_metadata.pre_repair_*.json`
- Live manifest updated and staged to the PC (server **not** restarted).

## 56 auto-repaired  (old author -> new author)

`verify` marks lower-confidence applies worth a spot-check: a search match below 0.95 overlap, or a repair whose lead author differs from the filename (a co-author/reviewer lead).

| Filename | Old author | New author | Evidence | verify |
|---|---|---|---|:---:|
| `Aarsleff_2001.pdf` | Bonnot de Condillac | De Condillac | search ov=1.00 | yes |
| `Agarwal_Etal_2014.pdf` | Boston | Nukala | search ov=1.00 | yes |
| `Amassian_Etal_1993.pdf` | Arnassian | Amassian | search ov=1.00 |  |
| `Ashby_Etal_1993.pdf` | Asiny | Ashby | search ov=1.00 |  |
| `Bloom_2001.pdf` | Westbury | Bloom | search ov=1.00 |  |
| `Blum_1977.pdf` | J. J. | Blum | search ov=0.88 | yes |
| `Brosnan_DeWaal_2003.pdf` | Sheppard | Brosnan | pdf-doi 10.1038/nature01963 ov=1.00 |  |
| `Carpenter_Barry_2016.pdf` | Rognini | Carpenter | search ov=1.00 |  |
| `Cofer_Etal_1967.pdf` | Gofer | Cofer | search ov=1.00 |  |
| `Conrad_1962.pdf` | Holmberc | Conrad | search ov=1.00 |  |
| `Crammond_1997.pdf` | Uliman | Crammond | search ov=1.00 |  |
| `Crowley_2013.pdf` | Bush | Crowley | search ov=1.00 |  |
| `Diosady_1984.pdf` | Berlyne | Diosady | search ov=1.00 |  |
| `Dobson_2006.pdf` | Hunsley | Dobson | search ov=1.00 |  |
| `Dzhafarov_Bockenholt_1995.pdf` | Dzhafaroy | Dzhafarov | search ov=1.00 |  |
| `Enquist_Etal_1999.pdf` | Cox | Enquist | search ov=1.00 |  |
| `Eslinger_Grattan_1994.pdf` | Eslincer | Eslinger | search ov=1.00 |  |
| `Flaherty_Lefcourt_2002.pdf` | Lefcourt | Flaherty | own-doi 10.2307/3089411 ov=1.00 |  |
| `Frostig_Etal_1990.pdf` | Frostic | Frostig | search ov=1.00 |  |
| `Gleissner_Etal_1998.pdf` | Gleiβner | Gleissner | search ov=1.00 |  |
| `Glenn_Etal_2009.pdf` | Tassy | Glenn | search ov=1.00 |  |
| `Gunther_Etal_1993.pdf` | Giinther | Gunther | search ov=1.00 |  |
| `Guo_Etal_2021.pdf` | Wanjia | Guo | search ov=1.00 |  |
| `Hanlon_2020.pdf` | Takahashi | Hanlon | search ov=1.00 |  |
| `Hautus_Etal_2021.pdf` | Macmillan | Hautus | search ov=1.00 |  |
| `Horwich_2003.pdf` | Putnam | Horwich | search ov=1.00 |  |
| `Hurst_Volpe_1982.pdf` | Hirst | Hurst | search ov=1.00 |  |
| `Katz_1966.pdf` | Kate | Katz | search ov=1.00 |  |
| `Keller_Etal_1965.pdf` | Killer | Keller | search ov=0.88 | yes |
| `Kolers_1976a.pdf` | Carpenter | Kolers | search ov=1.00 |  |
| `Kwong_Etal_1992.pdf` | Kwona?l | Kwong | search ov=1.00 |  |
| `Lachmann_2020.pdf` | Langer | Lachmann | search ov=1.00 |  |
| `Lampe_2017.pdf` | Camus | Lampe | search ov=1.00 |  |
| `Lund_2013.pdf` | Wallace | Lund | search ov=1.00 |  |
| `MacNeilage_1964.pdf` | MacNeilace | MacNeilage | search ov=1.00 |  |
| `Mignon_2003.pdf` | Marelli | Mignon | search ov=0.75 | yes |
| `Milad_Quirk_2002.pdf` | Jinks | Milad | search ov=1.00 |  |
| `Mohammed_Etal_2022.pdf` | Shahmohammadi | Mohammed | own-doi 10.18653/v1/2022.umios-1.3 ov=1.00 |  |
| `Mona_2014.pdf` | Shell | Mona | search ov=1.00 |  |
| `Murdock_1995b.pdf` | Murpock | Murdock | search ov=1.00 |  |
| `Nairne_Neumann_1993.pdf` | Naime | Nairne | search ov=1.00 |  |
| `Noble_Fuchs_1959.pdf` | Sokoloff | Noble | pdf-doi 10.1126/science.129.3348.570 ov=1.00 |  |
| `Overveldvan_2016.pdf` | van Overveld | Overveld, van | own-doi 10.26481/marble.2015.v6.386 ov=1.00 |  |
| `Perlmuter_Etal_1971.pdf` | Perlmutter | Perlmuter | search ov=1.00 |  |
| `Polyn_Etal_2005.pdf` | Vabulas | Polyn | search ov=1.00 |  |
| `Rawlins_1999.pdf` | Zuber | Rawlins | search ov=1.00 |  |
| `Rodden_2011.pdf` | Hurley | Rodden | search ov=0.75 | yes |
| `Rose_Weaver_1975.pdf` | Rosk | Rose | search ov=1.00 |  |
| `Spuler_Etal_2015.pdf` | SpÃ¼ler | Spüler | name-decode(mojibake) |  |
| `Stewart_2001.pdf` | Rayner | Stewart | search ov=1.00 |  |
| `Stump_2019.pdf` | Quine | Stump | search ov=1.00 |  |
| `Talmi_Frith_2007.pdf` | Zamore | Talmi | search ov=1.00 |  |
| `Tsuei_1996.pdf` | Tuell | Tsuei | search ov=0.80 | yes |
| `Wickelgren_1967.pdf` | Wicrelgren | Wickelgren | search ov=1.00 |  |
| `Wiese_1994.pdf` | Yanitski | Wiese | search ov=0.75 | yes |
| `Xiong_Etal_2014.pdf` | Shi | Xiong | search ov=1.00 |  |

## 15 confirmed correct — detector false-positives, no change

Author names with a special char the detector didn't fold (Polish l, Turkish i, ligatures, diacritics). The DOI-backed records are correct as stored.

> `Bialek_DeNeys_2017.pdf` (Białek), `Fulawka_Etal_2026.pdf` (Fuławka), `Garcia-Larrea_Cezanne-Bert_1998.pdf` (Garcı́a-Larrea), `Jolicoeur_DellAcqua_1998.pdf` (Jolicœur), `Kilic_Etal_2017.pdf` (Kılıç), `Kilic_Etal_2021.pdf` (Kılıç), `Kilic_Oztekin_2014.pdf` (Kılıç), `Kubik_Fenton_2005.pdf` (Kubı́k), `Kyllingsbaek_Etal_2014.pdf` (Kyllingsbæk), `Martinez-Montes_Etal_2004.pdf` (Martı́nez-Montes), `Martinez_Etal_2001a.pdf` (Martı́nez), `Mizrak_Oberauer_2021.pdf` (Mızrak), `Mizrak_Oztekin_2016.pdf` (Mızrak), `Morup_Etal_2006.pdf` (Mørup), `Slawinska_Kasicki_1998.pdf` (Sławinska)

## 58 to review (manual)

### WRONG_UNRESOLVED (39) — record is a DIFFERENT paper; could not be auto-resolved (needs a manual Crossref/lookup, or drop the record so the citation falls back to the filename)

| Filename | Record author | DOI | Record title |
|---|---|---|---|
| `Abbri_1992.pdf` | Merrell | - | Peirce, Signs, and Meaning |
| `AlfordDuguid_2020.pdf` | Shojaee | - | The Illusion of Thinking: Understanding the Strengths and Limitations of Reasoning Models via the Lens of Prob |
| `Bota_Etal_2018.pdf` | Czerwinski | - | Toward Characterizing the Productivity Benefits of Very Large Displays |
| `Brankazk_Etal_1996.pdf` | Brankatzk | - | Task-Relevant Late Positive ComDonent in Rats: Is it Related to Hippocampal Theta Rhthm? |
| `Chesler_Etal_1995.pdf` | Caplan | 10.1300/j015v17n01_12 | "Weak Ego Boundaries": One Developing Feminist's Story |
| `Cunningham_Picking_2012.pdf` | Morris | - | What’s so funny? |
| `Devillis_2017.pdf` | DeVellis | 10.2307/2075704 | Scale Development: Theory and Applications |
| `Dumpelmann_Elger_1999.pdf` | Diimpelmann | - | Visual and Automatic Investigation of Epileptiform Spikes in Intracranial EEG Recordings |
| `FiveGracesGroup_2009.pdf` | Beckner | 10.1111/j.1467-9922.2009.00533.x | Language Is a Complex Adaptive System: Position Paper |
| `Frank_Etal_2004.pdf` | Goldsmith | 10.1146/annurev.ento.50.071803.130456 | THE GENETICS AND GENOMICS OF THE SILKWORM, <i>BOMBYX MORI</i> |
| `Gibbs_1998.pdf` | Watanabe | 10.1525/aa.1999.101.1.98 | Explaining Religion without Explaining It Away: Trust, Truth, and the Evolution of Cooperation in Roy A. Rappa |
| `Grun_Etal_2001.pdf` | Grucn | - | Unitary Events in Multiple Single-Neuron Spiking Activity: I. Detection and Significance |
| `Guerard_Saint-Aubin_2012.pdf` | Guéard | 10.1037/a0025481 | Assessing the Effect of Lexical Variables in Backward Recall |
| `Harris_Etal_2003.pdf` | Bergman | 10.1038/nature01765 | Evolutionary capacitance as a general feature of complex gene networks |
| `Holland_1990.pdf` | Hollis | - | A Model of Knowledge Representation for Pavlovian Conditioning |
| `Jjm_cogsci_2016.pdf` | Johns | - | Experience as a Free Parameter in the Cognitive Modeling of Language |
| `Kluetsch_2012.pdf` | Kllitsch | - | INFORMATION AESTHETICS AND THE STUTTGART SCHOOL |
| `Konig_Etal_1996.pdf` | Kiinig | - | Integrator or coincidence detector? The role of the cortical neuron revisited |
| `Kotynski_Demaree_2017.pdf` | Vygotsky | 10.1037/11193-001 | The Problem and the Approach |
| `McClaughlin_Eysenck_1967.pdf` | Jeremy | - | Extraversion, Neuroticism and Paired-Associates Learning |
| `Moharram-nejaifard_Etal_2020.pdf` | Moharram-nejadifard | 10.4103/ijnmr.ijnmr_206_19 | The Effect of Cognitive Behavioural Group Therapy on the Workplace and Decisional Procrastination of Midwives: |
| `Narasimhamurthy_2023.pdf` | Dyson | 10.31234/osf.io/4pyqn | Remote experiential learning and the replication crisis: Assessing the replicability of Cognitive Psychology v |
| `Pala_Etal_2025.pdf` | Guenole | - | Enhancing Scale Development: Pseudo Factor Analysis of Language Embedding Similarity Matrices |
| `Pallies_2022.pdf` | Kaufman | 10.1093/oxfordhb/9780195376746.013.0051 | Contemporary Theories of Intelligence |
| `Peirce_1931.pdf` | Deely | - | Editorial Introduction to the electronic edition of The Collected Papers of Charles Sanders Peirce (Membra Fic |
| `Pinxten_1991.pdf` | Kozlowski | 10.1177/0003122419877135 | The Geometry of Culture: Analyzing Meaning through Word Embeddings |
| `Rogers_2006.pdf` | Mandera | 10.1016/j.jml.2016.04.001 | Explaining human performance in psycholinguistic tasks with models of semantic similarity based on prediction  |
| `Rosler_Etal_1995.pdf` | Rbsler | - | Exploring Memory Functions by Means of Brain Electrical Topography: A Review |
| `Shern_Etal_2024.pdf` | Chan | - | MLE- BENCH : E VALUATING M ACHINE L EARNING AGENTS ON M ACHINE L EARNING E NGINEERING |
| `Skocik_Etal_2016.pdf` | Powell | 10.1101/078816 | I TRIED A BUNCH OF THINGS: THE DANGERS OF UNEXPECTED OVERFITTING IN CLASSIFICATION |
| `Slawinska_Kasicki_1995.pdf` | Stawifiska | - | Theta-like rhythm in depth EEG activity of hypothalamic areas during spontaneous or electrically induced locom |
| `Snefjella_Blank_2021.pdf` | Snejfella | - | Computational Estimation of Lexical Semantic Norms: A New Framework |
| `TestUsage_2000.pdf` | Camara | 10.1037//0735-7028.31.2.141 | Psychological Test Usage: Implications in Professional Psychology |
| `Tom_Etal_2007.pdf` | Márquez | 10.1126/science.1136237 | A Virus in a Fungus in a Plant: Three-Way Symbiosis Required for Thermal Tolerance |
| `Waldman_1989.pdf` | Holzer | - | Money Creates Taste |
| `Wienker_Etal_1983.pdf` | PfHRSON | - | MAPS or [XP[RI[N([	Object and Meaning |
| `Woods_2020.pdf` | Gendlin | 10.1057/9780230368064_8 | IMPLICIT PRECISION |
| `Wozniak_Gorzelanczyk_1994.pdf` | Woiniak | 10.55782/ane-1994-1003 | Optimization of repetition spacing in the practice of learning |
| `Yang_Lim_2011.pdf` | Grabner | - | Measuring Cognitive Ability |

### GARBLED_NAME (13) — correct paper, but the author name is garbled and not cleanly recoverable — suggested fix = the filename surname (loses diacritics)

| Filename | Garbled author | Suggested surname | Record title |
|---|---|---|---|
| `Bocker_Etal_1994.pdf` | Bbcker | Bocker | A Spatiotemporal Dipole Model of the Stimulus Preceding Negativity (SPN) Priorto Feedback Stimuli |
| `Boya_Etal_2026.pdf` | Yanitski | Boya | Semantic Universalization in Large Language Models: A Pilot Test of Kantian Coherence |
| `Brazdil_Etal_2001.pdf` | BraÂzdil | Brazdil | Intracerebral event-related potentials to subthreshold target stimuli |
| `Buzsaki_1998.pdf` | BuzsaÂki | Buzsaki | Memory consolidation during sleep: a neurophysiological perspective |
| `DeBeni_Etal_1988.pdf` | De Benta | DeBeni | Imagery Limitations in Totally Congenitally Blind Subjects |
| `Gelinas_Desrochers_1993.pdf` | G61inas | Gelinas | Positive and negative instructions in symbolic paired comparisons with the months of the year |
| `Grastyan_Etal_1959.pdf` | GRASTY~N | Grastyan | HIPPOCAMPAL ELECTRICAL ACTIVITY DURING THE DEVELOPMENT OF CONDITIONED REFLEXES |
| `Hyona_Pollatsek_1998.pdf` | Hy6nii | Hyona | Reading Finnish Compound Words: Eye Fixations Are Affected by Component Morphemes |
| `MoscosodelPradoMartin_Etal_2004.pdf` | Moscoso del Prado Mart edn | MoscosodelPradoMartin | Putting the bits together: an information theoretical perspective on morphological processing |
| `Roschke_Etal_1993.pdf` | R6schke | Roschke | The calculation of the first positive Lyapunov exponent in sleep EEG data |
| `Scarfa_Etal_2016.pdf` | Scarfe | Scarfa | Orthographic processing in pigeons (Columba livia) |
| `Schoeneman_1987.pdf` | Sch6nemann | Schoeneman | Some Algebraic Relations Between Involutions, Convolutions, and Correlations, with Applications to Holographic |
| `Stancak_Etal_2000.pdf` | StancÏaÂk Jr. | Stancak | Oscillatory cortical activity and movement-related potentials in proximal and distal movements |

### CORPORATE (5) — author is an organisation/collective — almost certainly correct; leave

| Filename | Record author | DOI | Record title |
|---|---|---|---|
| `APA_2025.pdf` | American Psychological Association | - | Artificial Intelligence: Redefining the Future of Psychology |
| `Deng_Etal_2026.pdf` | Qwen Team | 10.48550/arxiv.2605.11887 | Qwen-Scope: Turning Sparse Features into Development Tools for Large Language Models |
| `Deng_Etal_2026a.pdf` | Qwen Team | 10.48550/arxiv.2605.11887 | Qwen-Scope: Turning Sparse Features into Development Tools for Large Language Models |
| `EGI_2018.pdf` | Electrical Geodesics, Inc. | - | Geodesic Sensor Nets™ Approved Germicide Disinfectants: Preparation and Storage Instructions |
| `Lim_Etal_2017.pdf` | Pinheiro | - | Linear and Nonlinear Mixed Effects Models |

### BOOK_REVIEW (1) — the PDF is a review of another book; the record describing the book is defensible

| Filename | Record author | DOI | Record title |
|---|---|---|---|
| `Freeman_1969.pdf` | Gibson | - | The Senses Considered as Perceptual Systems |

