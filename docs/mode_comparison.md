# Retrieval mode comparison

Same question answered in each mode, so the cost of `auto`'s choice can be
judged against what the cheaper modes actually produce.

Representative retrieval-only p50: naive 0.31s | local 3.00s | global 3.09s |
hybrid 3.80s. Full `/query` (with answer synthesis) is much slower, so the
mode delta is a smaller share of what a user waits for.

## What predicts how funny a word is?

**`auto` routes to: `global`**

### `hybrid`  — 5.0s, 2 references

## What predicts a word’s funniness?

The strongest predictors are **semantic associations**. Words judged funny tend to be closely associated with categories such as sex, bodily functions, insults, profanity, partying, and animals. Average distance from these “funny” category vectors—especially **Average-CDV** and **Eight-le-CDV**—was the strongest predictor in the final model (Westbury & Hollis, 2019; Westbury Hollis 2019 Supplementary, n.d.).

Several **form- and probability-based features** also matter:

- **Lower word frequency:** uncommon words tend to be judged funnier.
- **Unusual letters and phonemes:** words with less probable letter or sound sequences receive higher humor ratings.
- The letter **k**, the sound **/u/** (“oo”), and consonant-plus-**le** endings are overrepresented among funny words (Westbury & Hollis, 2019; Westbury Hollis 2019 Supplementary, n.d.).
- **Shorter words**, greater **concreteness**, and more positive **valence** are also associated with higher funniness ratings (Westbury & Hollis, 2019).

Overall, semantics were stronger predictors than formal features, although form-related variables contributed substantially. The results are consistent with the idea that humor increases when a word is semantically incongruous or structurally improbable (Westbury & Hollis, 2019; Westbury Hollis 2019 Supplementary, n.d.).

### References

- Westbury, C. F., & Hollis, G. (2019). Wriggly, Squiffy, Lummox, and Boobs: What Makes Some Words Funny?. *Journal of Experimental Psychology: General*, *148*(1), 97-123. https://doi.org/10.1037/xge0000467 — https://drive.google.com/file/d/1d1RvxJJopttUcMCgK1fEx7feNAyewIMF/view?usp=drivesdk
- (n.d.). Westbury Hollis 2019 Supplementary. — https://drive.google.com/file/d/1Ra8_bvtI_trTXE8HRWDiNPh4X4a0wegK/view?usp=drivesdk

### `local`  — 3.2s, 2 references

## What predicts how funny a word is?

The strongest predictors are **semantic associations**: words closer to categories associated with humor—such as insults, sexuality, bodily functions, animals, and partying—tend to be judged funnier. Average-CDV and Eight-le-CDV were the strongest individual predictors (Westbury & Hollis, 2019).

**Form and probability also matter:**

- **Lower word frequency:** rarer words tend to be funnier.
- **Unusual spelling:** low-probability letter combinations predict greater funniness.
- **Unusual sound patterns:** less-common phonemes are associated with higher humor ratings.
- **Specific features:** the phoneme **/u/**, the letters **k** and **y**, and consonant-plus-**le** endings are overrepresented among funny words (Westbury & Hollis, 2019).
- **Shorter length:** shorter words tend to receive slightly higher funniness ratings, although length was excluded from the final model because it overlapped with other predictors (Westbury & Hollis, 2019).

Higher **concreteness** and **positive valence** are also associated with greater funniness (Westbury & Hollis, 2019). Overall, the findings suggest that word humor reflects an interaction between meaning, emotional associations, and violations of expectations in a word’s frequency, spelling, and sound (Westbury Hollis 2019 Supplementary, n.d.).

### References

- Westbury, C. F., & Hollis, G. (2019). Wriggly, Squiffy, Lummox, and Boobs: What Makes Some Words Funny?. *Journal of Experimental Psychology: General*, *148*(1), 97-123. https://doi.org/10.1037/xge0000467 — https://drive.google.com/file/d/1d1RvxJJopttUcMCgK1fEx7feNAyewIMF/view?usp=drivesdk
- (n.d.). Westbury Hollis 2019 Supplementary. — https://drive.google.com/file/d/1Ra8_bvtI_trTXE8HRWDiNPh4X4a0wegK/view?usp=drivesdk

### `global` ← auto's choice  — 3.7s, 3 references

## What predicts word funniness?

Word funniness is predicted by a combination of **semantic** and **form-related** features.

- **Semantic associations:** The strongest predictors are proximity to categories associated with humor—sex, bodily functions, insults, swear words, partying, and animals—measured by **Average-CDV** and **Eight-le-CDV**. Words closer to these categories tend to be rated funnier (Westbury & Hollis, 2019; Westbury Hollis 2019 Supplementary, n.d.).
- **Rarity and improbability:** Less frequent words are judged funnier. Words containing less-probable letters and phonemes also tend to receive higher ratings, consistent with incongruity theory (Westbury & Hollis, 2019; Westbury Hollis 2019 Supplementary, n.d.).
- **Specific forms:** The presence of **/u/**, **k**, **y**, or a final consonant-plus-*le* sequence is associated with greater funniness (Westbury & Hollis, 2019).
- **Affective and lexical properties:** Higher valence and concreteness are weakly associated with higher funniness, while arousal has a more complex relationship (Westbury & Hollis, 2019).
- **Individual differences:** People’s humor preferences differ substantially; word embeddings based on words someone finds funny can predict which new words that person will prefer (Gultchin et al., 2019).

Overall, semantic predictors are generally stronger than information-theoretic form predictors, although both contribute to judgments of word humor (Westbury Hollis 2019 Supplementary, n.d.).

### References

- Gultchin, L., Patterson, G., Baym, N., Swinger, N., & Tauman Kalai, A. (2019). Humor in Word Embeddings: Cockamamie Gobbledegook for Nincompoops. *Proceedings of the 36th International Conference on Machine Learning*, *97*. — https://drive.google.com/file/d/1etdsXCs2aQmhZUSyRGC37uE6rX_8s0RA/view?usp=drivesdk
- Westbury, C. F., & Hollis, G. (2019). Wriggly, Squiffy, Lummox, and Boobs: What Makes Some Words Funny?. *Journal of Experimental Psychology: General*, *148*(1), 97-123. https://doi.org/10.1037/xge0000467 — https://drive.google.com/file/d/1d1RvxJJopttUcMCgK1fEx7feNAyewIMF/view?usp=drivesdk
- (n.d.). Westbury Hollis 2019 Supplementary. — https://drive.google.com/file/d/1Ra8_bvtI_trTXE8HRWDiNPh4X4a0wegK/view?usp=drivesdk

### `naive`  — 3.5s, 2 references

## What predicts a word’s funniness?

The strongest predictors are **semantic**: how closely a word is associated with categories such as **sex, bodily functions, insults, profanity, partying, and animals**. Words with stronger average associations to these categories tend to receive higher funniness ratings (Westbury & Hollis, 2019; Westbury Hollis 2019 Supplementary, n.d.).

Other important predictors concern the word’s **form and probability**:

- **Rarer words** are generally judged funnier than common words.
- Words containing **uncommon letters or phonemes** tend to be funnier.
- Specific features associated with higher ratings include the sound **/u/** (“oo”), **k**, **y**, and consonant-plus-**le** endings.
- **Shorter words** tend to be judged funnier than longer ones (Westbury & Hollis, 2019; Westbury Hollis 2019 Supplementary, n.d.).

A word’s **emotional and semantic properties** also matter. Higher **valence** and **concreteness** are weakly associated with greater funniness, while the interactions among valence, arousal, and dominance also contribute (Westbury & Hollis, 2019).

Overall, semantic associations are substantially stronger predictors than formal features such as spelling, sound, and frequency. A combined model incorporating these factors explained about **42% of the variance** in human funniness judgments (Westbury & Hollis, 2019).

### References

- Westbury, C. F., & Hollis, G. (2019). Wriggly, Squiffy, Lummox, and Boobs: What Makes Some Words Funny?. *Journal of Experimental Psychology: General*, *148*(1), 97-123. https://doi.org/10.1037/xge0000467 — https://drive.google.com/file/d/1d1RvxJJopttUcMCgK1fEx7feNAyewIMF/view?usp=drivesdk
- (n.d.). Westbury Hollis 2019 Supplementary. — https://drive.google.com/file/d/1Ra8_bvtI_trTXE8HRWDiNPh4X4a0wegK/view?usp=drivesdk

---

## How does word frequency affect lexical decision times?

**`auto` routes to: `global`**

### `hybrid`  — 6.2s, 5 references

## Effect of word frequency

Word frequency generally has a **negative relationship** with lexical decision time: **high-frequency words are recognized faster than low-frequency words**. In Experiment 3, high-frequency words elicited responses in **592 ms**, compared with **702 ms** for low-frequency words (Glanzer & Adams, 1990). Similar results were reported after controlling for item length and phonological neighborhood size (Allen & Hulme, 2006).

Word frequency is also a particularly strong predictor of lexical decision performance. In E-Lexicon data, log word frequency alone accounted for **40.5% of the variance** in lexical decision times (Brysbaert et al., 2011). However, the effect can depend on other factors, including neighborhood size, morphemic frequency, contextual measures, and the particular frequency database used (Colé et al., 1997; Keuleers et al., 2015).

### References

- Allen, R. J., & Hulme, C. (2006). Speech and language processing mechanisms in verbal serial recall. *Journal of Memory and Language*, *55*, 64–88. https://doi.org/10.1016/j.jml.2006.02.002 — https://drive.google.com/file/d/1NgrjUcSwNXdiZZZZ65cOlm2Z_RYrMrAG/view?usp=drivesdk
- Brysbaert, M., Buchmeier, M., Conrad, M., Jacobs, A. M., Bölte, J., & Böhl, A. (2011). The Word Frequency Effect: A Review of Recent Developments and Implications for the Choice of Frequency Estimates in German. *Experimental Psychology*. https://doi.org/10.1027/1618-3169/a000123 — https://drive.google.com/file/d/1rzIULzdW7ODXVFrB7wizxusbvptroztK/view?usp=drivesdk
- Colé, P., Segui, J., & Taft, M. (1997). Words and Morphemes as Units for Lexical Access. *Journal of Memory and Language*, *37*, 312-330. — https://drive.google.com/file/d/1t-rsh1osqp7Hkp0Iv312V7om--F_Sr10/view?usp=drivesdk
- Glanzer, M., & Adams, J. K. (1990). The Mirror Effect in Recognition Memory: Data and Theory. *Journal of Experimental Psychology: Learning, Memory, and Cognition*, *16*(1), 5-16. — https://drive.google.com/file/d/1v7kLrwWkdDLaSRHcBm0EatmqMyLmUWw9/view?usp=drivesdk
- Keuleers, E., Stevens, M., Mandera, P., & Brysbaert, M. (2015). Word knowledge in the crowd: Measuring vocabulary size and word prevalence in a massive online experiment. *Quarterly Journal of Experimental Psychology*, *68*(8), 1665-1692. https://doi.org/10.1080/17470218.2015.1022560 — https://drive.google.com/file/d/1h5-ILIPfNqZa_DuEiCZPCn08u7F7DF-Q/view?usp=drivesdk

### `local`  — 4.5s, 5 references

## Effect of word frequency

Word frequency has a strong inverse relationship with lexical decision times: **high-frequency words are generally recognized faster than low-frequency words** (Brysbaert et al., 2011). In Elexicon Project data, word frequency alone accounted for **40.5% of the variance** in lexical decision times (Brysbaert et al., 2011).

This frequency effect is robust across studies and tasks. For example, one experiment found significantly longer responses for low-frequency words, while another reported a substantial frequency effect on both reaction times and errors, with low-frequency words producing more errors (Becker & Killion, 1977; Juhasz et al., 2003).

However, frequency is not the only determinant. Orthographic properties, word length, neighborhood characteristics, prevalence, and contextual factors also contribute; adding other variables can explain additional variance beyond frequency (Brysbaert et al., 2011; Brysbaert et al., 2019; Keuleers et al., 2015).

### References

- Becker, C. A., & Killion, T. H. (1977). Interaction of Visual and Cognitive Effects in Word Recognition. *Journal of Experimental Psychology: Human Perception and Performance*, *3*(3), 389-401. https://doi.org/10.1037//0096-1523.3.3.389 — https://drive.google.com/file/d/19Y9MO52rOHh0zdjv6tLdHiT6czhYEgL_/view?usp=drivesdk
- Brysbaert, M., Buchmeier, M., Conrad, M., Jacobs, A. M., Bölte, J., & Böhl, A. (2011). The Word Frequency Effect: A Review of Recent Developments and Implications for the Choice of Frequency Estimates in German. *Experimental Psychology*. https://doi.org/10.1027/1618-3169/a000123 — https://drive.google.com/file/d/1rzIULzdW7ODXVFrB7wizxusbvptroztK/view?usp=drivesdk
- Brysbaert, M., Mandera, P., McCormick, S. F., & Keuleers, E. (2019). Word prevalence norms for 62,000 English lemmas. *Behavior Research Methods*, *51*, 467-479. https://doi.org/10.3758/s13428-018-1077-9 — https://drive.google.com/file/d/1CJJqgyRCU6e88qDVwj7ZJnjqpXaf753z/view?usp=drivesdk
- Juhasz, B. J., Starr, M. S., Inhoff, A. W., & Placke, L. (2003). The effects of morphology on the processing of compound words: Evidence from naming, lexical decisions and eye fixations. *British Journal of Psychology*, *94*, 223-244. https://doi.org/10.1348/000712603321661903 — https://drive.google.com/file/d/1Xsc_GfdrLnEwG5rmz3mXdQ9o1mvD0AIE/view?usp=drivesdk
- Keuleers, E., Stevens, M., Mandera, P., & Brysbaert, M. (2015). Word knowledge in the crowd: Measuring vocabulary size and word prevalence in a massive online experiment. *Quarterly Journal of Experimental Psychology*, *68*(8), 1665-1692. https://doi.org/10.1080/17470218.2015.1022560 — https://drive.google.com/file/d/1h5-ILIPfNqZa_DuEiCZPCn08u7F7DF-Q/view?usp=drivesdk

### `global` ← auto's choice  — 3.4s, 5 references

## Effect of word frequency

Word frequency generally has an **inverse relationship** with lexical decision time: participants decide more quickly that a high-frequency string is a word, while low-frequency words produce slower responses (Brysbaert et al., 2011; Jones et al., 2017).

For example, one experiment found mean reaction times of **592 ms for high-frequency words** versus **702 ms for low-frequency words** (Glanzer & Adams, 1990). Another reported **618 ms** for high-frequency words and **671 ms** for low-frequency words, with nonwords taking **840 ms** (Glanzer & Adams, 1990). Frequency remains a significant predictor even after controlling for item length and phonological-neighborhood size (Allen & Hulme, 2006).

Word frequency is considered one of the strongest predictors of lexical decision performance. Log-transformed frequency explained about **40.5% of the variance** in lexical decision times in one large dataset (Brysbaert et al., 2011). However, contextual diversity and other lexical variables can also contribute to, or partly explain, the frequency effect (Adelman et al., 2006).

### References

- Adelman, J. S., Brown, G. D. A., & Quesada, J. F. (2006). Contextual Diversity, Not Word Frequency, Determines Word-Naming and Lexical Decision Times. *Psychological Science*, *17*, 814-823. https://doi.org/10.1111/j.1467-9280.2006.01787.x — https://drive.google.com/file/d/1mgcDoIj5NTnpGTbdVgMWiQWnciq7uDK-/view?usp=drivesdk
- Allen, R. J., & Hulme, C. (2006). Speech and language processing mechanisms in verbal serial recall. *Journal of Memory and Language*, *55*, 64–88. https://doi.org/10.1016/j.jml.2006.02.002 — https://drive.google.com/file/d/1NgrjUcSwNXdiZZZZ65cOlm2Z_RYrMrAG/view?usp=drivesdk
- Brysbaert, M., Buchmeier, M., Conrad, M., Jacobs, A. M., Bölte, J., & Böhl, A. (2011). The Word Frequency Effect: A Review of Recent Developments and Implications for the Choice of Frequency Estimates in German. *Experimental Psychology*. https://doi.org/10.1027/1618-3169/a000123 — https://drive.google.com/file/d/1rzIULzdW7ODXVFrB7wizxusbvptroztK/view?usp=drivesdk
- Glanzer, M., & Adams, J. K. (1990). The Mirror Effect in Recognition Memory: Data and Theory. *Journal of Experimental Psychology: Learning, Memory, and Cognition*, *16*(1), 5-16. — https://drive.google.com/file/d/1v7kLrwWkdDLaSRHcBm0EatmqMyLmUWw9/view?usp=drivesdk
- Jones, M. N., Dye, M., & Johns, B. T. (2017). Context as an Organizing Principle of the Lexicon. In. — https://drive.google.com/file/d/1iuX7YgKT_dyDXH3GNOhB0LGb7RsJ00vD/view?usp=drivesdk

### `naive`  — 2.5s, 4 references

## Effect of word frequency

Word frequency has a strong inverse relationship with lexical decision time: **high-frequency words are recognized and responded to faster than low-frequency words**. In one experiment, high-frequency words averaged 592 ms, compared with 702 ms for low-frequency words (Glanzer & Adams, 1990). Across six experiments, response times increased and accuracy declined as frequency decreased (Ratcliff et al., 2004).

Word frequency is also the strongest predictor of lexical decision times in Elexicon Project data, accounting for **40.5% of the variance** (Brysbaert et al., 2011). Its effect can be influenced by other factors: for example, frequency differences were larger when nonwords were pseudowords than when they were random letter strings (Ratcliff et al., 2004), and low-frequency words showed stronger effects of neighborhood size (Allen & Hulme, 2006).

In diffusion-model terms, higher-frequency words produce faster information accumulation, or higher **drift rates**, leading to quicker and generally more accurate decisions (Ratcliff et al., 2004).

### References

- Allen, R. J., & Hulme, C. (2006). Speech and language processing mechanisms in verbal serial recall. *Journal of Memory and Language*, *55*, 64–88. https://doi.org/10.1016/j.jml.2006.02.002 — https://drive.google.com/file/d/1NgrjUcSwNXdiZZZZ65cOlm2Z_RYrMrAG/view?usp=drivesdk
- Brysbaert, M., Buchmeier, M., Conrad, M., Jacobs, A. M., Bölte, J., & Böhl, A. (2011). The Word Frequency Effect: A Review of Recent Developments and Implications for the Choice of Frequency Estimates in German. *Experimental Psychology*. https://doi.org/10.1027/1618-3169/a000123 — https://drive.google.com/file/d/1rzIULzdW7ODXVFrB7wizxusbvptroztK/view?usp=drivesdk
- Glanzer, M., & Adams, J. K. (1990). The Mirror Effect in Recognition Memory: Data and Theory. *Journal of Experimental Psychology: Learning, Memory, and Cognition*, *16*(1), 5-16. — https://drive.google.com/file/d/1v7kLrwWkdDLaSRHcBm0EatmqMyLmUWw9/view?usp=drivesdk
- Ratcliff, R., Thapar, A., & McKoon, G. (2004). A diffusion model analysis of the effects of aging on recognition memory. *Journal of Memory and Language*, *50*(4), 408-424. https://doi.org/10.1016/j.jml.2003.11.002 — https://drive.google.com/file/d/17iDZlORzN57xTHxBaxqIEFDsMlx-JQC1/view?usp=drivesdk

---

## What is semantic diversity and how is it measured?

**`auto` routes to: `global`**

### `hybrid`  — 6.9s, 4 references

## Semantic diversity

**Semantic diversity** is a lexical measure of how varied the linguistic contexts are in which a word appears. Words used in specialized, semantically similar contexts have low semantic diversity; words occurring across many unrelated contexts have high semantic diversity. It therefore captures contextual variability and semantic ambiguity more precisely than simply counting a word’s number of senses or the documents containing it (Hoffman, 2016; Jones et al., 2017).

## How it is measured

A common approach uses **corpus-based distributional analysis**:

1. Collect the contexts in which a target word occurs.
2. Represent each context as a vector using **Latent Semantic Analysis (LSA)**.
3. Compute the cosine similarity or distance between every pair of context vectors.
4. Aggregate these pairwise values—typically by calculating the mean similarity or mean distance—to produce the word’s semantic-diversity score (Hoffman, 2016; Norman et al., 2025).

Measures can also weight the number of contexts by their **semantic distinctiveness**: contexts with little information overlap contribute more than repeated or highly redundant contexts (Jones et al., 2012; Jones et al., 2017). Thus, semantic diversity distinguishes many occurrences in similar contexts from occurrences distributed across genuinely different contexts.

Higher semantic diversity generally predicts faster and more accurate lexical access than raw frequency or document counts alone; words occurring in less-overlapping contexts have been identified approximately 200 ms faster in lexical-decision tasks (Jones et al., 2017).

### References

- Hoffman, P. (2016). The meaning of ‘life’ and other abstract words: Insights from neuropsychology. *Journal of Neuropsychology*, *10*, 317-343. https://doi.org/10.1111/jnp.12065 — https://drive.google.com/file/d/1G2V9RX5hng1ukZPcGY8oYLQkMIRnbp96/view?usp=drivesdk
- Jones, M. N., Johns, B. T., & Recchia, G. (2012). The Role of Semantic Diversity in Lexical Organization. *Canadian Journal of Experimental Psychology / Revue canadienne de psychologie expérimentale*, *66*(2), 115–124. https://doi.org/10.1037/a0026727 — https://drive.google.com/file/d/1rqTh1XqSTMXauYZLHiyfY20P0tQ-T777/view?usp=drivesdk
- Jones, M. N., Dye, M., & Johns, B. T. (2017). Context as an Organizing Principle of the Lexicon. In. — https://drive.google.com/file/d/1iuX7YgKT_dyDXH3GNOhB0LGb7RsJ00vD/view?usp=drivesdk
- Norman, R., Taylor, J. S. H., & Rodd, J. M. (2025). The effects of contextual diversity on lexical processing: A scoping review. *Psychonomic Bulletin & Review*, *32*, 2763-2806. https://doi.org/10.3758/s13423-025-02761-y — https://drive.google.com/file/d/1zgQf8q7fSv84nVreubvTJkqx0RWZ7_EN/view?usp=drivesdk

### `local`  — 5.1s, 3 references

## Semantic diversity

**Semantic diversity** is a word-level measure of how varied the semantic or linguistic contexts are in which a word appears. Words used across many distinct topics and meanings have high semantic diversity; words restricted to specialized, similar contexts have low semantic diversity (Jones et al., 2017).

Unlike simple contextual-diversity measures, which count the documents containing a word, semantic diversity accounts for the **information overlap among those contexts**. Repeated occurrences in highly similar contexts contribute less than occurrences across substantially different contexts (Jones et al., 2012; Jones et al., 2017).

## How it is measured

A common operationalization uses **Latent Semantic Analysis (LSA)**:

1. Construct a word-by-context co-occurrence matrix from a corpus.
2. Use LSA to extract a vector representing each context in which the target word occurs.
3. Calculate the cosine similarity between every pair of context vectors.
4. Aggregate these similarities—Hoffman et al.’s measure defines semantic diversity as the **mean pairwise cosine similarity** among the word’s context vectors (Norman et al., 2025).

The measure is therefore corpus-derived and reflects the semantic variability of a word’s usage. Other approaches, such as the Semantic Distinctiveness Model, weight contexts according to their uniqueness or semantic distinctiveness rather than merely counting them (Jones et al., 2012; Norman et al., 2025).

### References

- Jones, M. N., Johns, B. T., & Recchia, G. (2012). The Role of Semantic Diversity in Lexical Organization. *Canadian Journal of Experimental Psychology / Revue canadienne de psychologie expérimentale*, *66*(2), 115–124. https://doi.org/10.1037/a0026727 — https://drive.google.com/file/d/1rqTh1XqSTMXauYZLHiyfY20P0tQ-T777/view?usp=drivesdk
- Jones, M. N., Dye, M., & Johns, B. T. (2017). Context as an Organizing Principle of the Lexicon. In. — https://drive.google.com/file/d/1iuX7YgKT_dyDXH3GNOhB0LGb7RsJ00vD/view?usp=drivesdk
- Norman, R., Taylor, J. S. H., & Rodd, J. M. (2025). The effects of contextual diversity on lexical processing: A scoping review. *Psychonomic Bulletin & Review*, *32*, 2763-2806. https://doi.org/10.3758/s13423-025-02761-y — https://drive.google.com/file/d/1zgQf8q7fSv84nVreubvTJkqx0RWZ7_EN/view?usp=drivesdk

### `global` ← auto's choice  — 5.1s, 4 references

## Semantic diversity

**Semantic diversity** is a measure of how varied the linguistic contexts are in which a word appears. Words used in highly similar, specialized contexts have low semantic diversity, whereas words used across unrelated contexts have high semantic diversity (Hoffman, 2016; Jones et al., 2017).

Unlike simple contextual diversity, which counts the number of documents containing a word, semantic diversity considers the **semantic overlap** among those contexts. Repeated occurrences in redundant contexts contribute less than occurrences across genuinely different contexts (Jones et al., 2012; Jones et al., 2017).

## How it is measured

A common approach uses **Latent Semantic Analysis (LSA)**:

1. Construct a word-by-context co-occurrence matrix.
2. Represent each context as a vector using LSA.
3. Calculate cosine similarity between every pair of contexts in which the target word occurs.
4. Aggregate the pairwise similarities—typically by taking their mean—to obtain the word’s semantic-diversity value (Norman et al., 2025).

Semantic diversity can also be computed as a **weighted context count**. Contexts are compared for dissimilarity based on their word overlap; a word’s contexts receive greater weight when they are semantically distinct, and the resulting values are combined with the number of contexts in which the word appears (Jones et al., 2012).

Thus, semantic diversity captures both **how often** a word occurs and **how different the surrounding contexts are**, making it more informative than raw frequency or document counts for predicting lexical processing (Jones et al., 2012; Jones et al., 2017).

### References

- Hoffman, P. (2016). The meaning of ‘life’ and other abstract words: Insights from neuropsychology. *Journal of Neuropsychology*, *10*, 317-343. https://doi.org/10.1111/jnp.12065 — https://drive.google.com/file/d/1G2V9RX5hng1ukZPcGY8oYLQkMIRnbp96/view?usp=drivesdk
- Jones, M. N., Johns, B. T., & Recchia, G. (2012). The Role of Semantic Diversity in Lexical Organization. *Canadian Journal of Experimental Psychology / Revue canadienne de psychologie expérimentale*, *66*(2), 115–124. https://doi.org/10.1037/a0026727 — https://drive.google.com/file/d/1rqTh1XqSTMXauYZLHiyfY20P0tQ-T777/view?usp=drivesdk
- Jones, M. N., Dye, M., & Johns, B. T. (2017). Context as an Organizing Principle of the Lexicon. In. — https://drive.google.com/file/d/1iuX7YgKT_dyDXH3GNOhB0LGb7RsJ00vD/view?usp=drivesdk
- Norman, R., Taylor, J. S. H., & Rodd, J. M. (2025). The effects of contextual diversity on lexical processing: A scoping review. *Psychonomic Bulletin & Review*, *32*, 2763-2806. https://doi.org/10.3758/s13423-025-02761-y — https://drive.google.com/file/d/1zgQf8q7fSv84nVreubvTJkqx0RWZ7_EN/view?usp=drivesdk

### `naive`  — 3.1s, 4 references

## Semantic diversity

**Semantic diversity** measures how varied the meanings or linguistic contexts are in which a word appears. Unlike a simple document count, it considers the **information overlap between contexts**: repeated occurrences in highly similar documents contribute less than occurrences in semantically distinct documents (Jones et al., 2017).

A word has **high semantic diversity** when it occurs in many contexts that differ substantially in content; it has low semantic diversity when its contexts are largely redundant (Jones et al., 2012).

## How it is measured

Common computational approaches include:

- **Latent Semantic Analysis (LSA):** Contexts containing a word are represented as vectors. Cosine similarities are calculated between pairs of context vectors, and semantic diversity is derived from their average similarity or distance (Norman et al., 2025).
- **Semantic Distinctiveness Model (SDM):** Contexts are compared according to their proportion of overlapping words. A word’s semantic distinctiveness is the mean comparison across its contexts; lower overlap indicates greater semantic distinctiveness (Norman et al., 2025).
- **Semantic Distinctiveness Count (SD_Count):** Document occurrences are weighted by the semantic uniqueness of their contexts. Two words occurring in the same number of documents can therefore receive different scores if one appears in more varied contexts (Jones et al., 2012).
- **Composite measures:** Some measures combine document counts, LSA-based similarity, and topic-modeling variables into a single semantic-variability score (Musz & Thompson-Schill, 2015).

Overall, semantic diversity is intended to capture not merely **how often** or **in how many documents** a word occurs, but **how different those contexts are in meaning** (Jones et al., 2017).

### References

- Jones, M. N., Johns, B. T., & Recchia, G. (2012). The Role of Semantic Diversity in Lexical Organization. *Canadian Journal of Experimental Psychology / Revue canadienne de psychologie expérimentale*, *66*(2), 115–124. https://doi.org/10.1037/a0026727 — https://drive.google.com/file/d/1rqTh1XqSTMXauYZLHiyfY20P0tQ-T777/view?usp=drivesdk
- Jones, M. N., Dye, M., & Johns, B. T. (2017). Context as an Organizing Principle of the Lexicon. In. — https://drive.google.com/file/d/1iuX7YgKT_dyDXH3GNOhB0LGb7RsJ00vD/view?usp=drivesdk
- Musz, E., & Thompson-Schill, S. L. (2015). Semantic variability predicts neural variability of object concepts. *Neuropsychologia*, *76*, 41-51. https://doi.org/10.1016/j.neuropsychologia.2014.11.029 — https://drive.google.com/file/d/1rHlv0T02fSz1sNGwSpd-Z65jYhigmraw/view?usp=drivesdk
- Norman, R., Taylor, J. S. H., & Rodd, J. M. (2025). The effects of contextual diversity on lexical processing: A scoping review. *Psychonomic Bulletin & Review*, *32*, 2763-2806. https://doi.org/10.3758/s13423-025-02761-y — https://drive.google.com/file/d/1zgQf8q7fSv84nVreubvTJkqx0RWZ7_EN/view?usp=drivesdk

---

## How does age of acquisition influence word recognition?

**`auto` routes to: `global`**

### `hybrid`  — 5.5s, 4 references

## Age of acquisition and word recognition

Age of acquisition (AoA)—the age at which a word is learned—influences word-recognition performance, including lexical-decision speed and naming latency. Words learned earlier are generally accessed and processed faster than later-acquired words. AoA can explain additional variance in lexical-decision times beyond frequency, word length, and orthographic similarity (Kuperman et al., 2012).

AoA is strongly correlated with word frequency, since frequent words tend to be learned earlier. However, evidence indicates that AoA can contribute independently: words learned first may have representations that are easier to activate, not merely greater overall exposure (Kuperman et al., 2012).

The influence differs by task. In oral naming, AoA appears particularly related to retrieving and executing phonological representations: early-acquired words are pronounced faster, consistent with more complete phonological representations (Gerhand & Barry, 1998). In recognition memory, however, later-acquired words have sometimes produced better recognition, especially in recollection-based “remember” responses, possibly because their semantic representations are more distinctive (Cortese et al., 2015; Dewhurst et al., 1998).

Thus, AoA is an important predictor of word recognition, but its effect depends on the processing stage and task, and it should generally be controlled separately from word frequency.

### References

- Cortese, M. J., McCarty, D. P., & Schock, J. (2015). A mega recognition memory study of 2897 disyllabic words. *The Quarterly Journal of Experimental Psychology*, *68*(8), 1489–1501. https://doi.org/10.1080/17470218.2014.945096 — https://drive.google.com/file/d/13cKo8dtCu1deUoMIIC1QMby_Z6dkGEJ9/view?usp=drivesdk
- Dewhurst, S. A., Hitch, G. J., & Barry, C. (1998). Separate Effects of Word Frequency and Age of Acquisition in Recognition and Recall. *Journal of Experimental Psychology: Learning, Memory, and Cognition*, *24*(2), 284-298. https://doi.org/10.1037//0278-7393.24.2.284 — https://drive.google.com/file/d/1xKyFfIANAmE0iHuqxyaljAiXOMgUOq3p/view?usp=drivesdk
- Gerhand, S., & Barry, C. (1998). Word Frequency Effects in Oral Reading Are Not Merely Age-of-Acquisition Effects in Disguise. *Journal of Experimental Psychology: Learning, Memory, and Cognition*, *24*(2), 267-283. https://doi.org/10.1037/0278-7393.24.2.267 — https://drive.google.com/file/d/1y5VEKmXYZ-JPap4n4Q_EGW-49ixm4Zuj/view?usp=drivesdk
- Kuperman, V., Stadthagen-Gonzalez, H., & Brysbaert, M. (2012). Age-of-acquisition ratings for 30,000 English words. *Behavior Research Methods*, *44*, 978-990. https://doi.org/10.3758/s13428-012-0210-4 — https://drive.google.com/file/d/1pEE7490uwe_e08p-9mPweaiWDxDadvVn/view?usp=drivesdk

### `local`  — 4.0s, 4 references

## Influence of age of acquisition on word recognition

Age of acquisition (AoA)—the age at which a word is learned—strongly influences lexical processing. **Early-acquired words are generally recognized and retrieved more quickly** than later-acquired words, including in lexical decision, naming, and word-identification tasks (Gerhand & Barry, 1998; Kuperman et al., 2012). AoA can explain additional variance in lexical-decision times even after word frequency is controlled; for English monosyllabic words, it explained up to **5% more variance** (Kuperman et al., 2012).

AoA is closely related to word frequency, since early-learned words tend to be more frequent. However, evidence indicates that AoA can contribute independently: frequency primarily affects access to written word representations, whereas AoA may influence the retrieval or execution of stored phonological representations (Gerhand & Barry, 1998).

The effect also depends on the task. In recognition memory, **late-acquired words can sometimes be recognized better**, particularly in recollection-based responses, possibly because their episodic or semantic representations are more distinctive (Cortese et al., 2015; Dewhurst et al., 1998). Thus, early acquisition generally benefits rapid word recognition and production, while later acquisition may benefit certain forms of episodic recognition.

### References

- Cortese, M. J., McCarty, D. P., & Schock, J. (2015). A mega recognition memory study of 2897 disyllabic words. *The Quarterly Journal of Experimental Psychology*, *68*(8), 1489–1501. https://doi.org/10.1080/17470218.2014.945096 — https://drive.google.com/file/d/13cKo8dtCu1deUoMIIC1QMby_Z6dkGEJ9/view?usp=drivesdk
- Dewhurst, S. A., Hitch, G. J., & Barry, C. (1998). Separate Effects of Word Frequency and Age of Acquisition in Recognition and Recall. *Journal of Experimental Psychology: Learning, Memory, and Cognition*, *24*(2), 284-298. https://doi.org/10.1037//0278-7393.24.2.284 — https://drive.google.com/file/d/1xKyFfIANAmE0iHuqxyaljAiXOMgUOq3p/view?usp=drivesdk
- Gerhand, S., & Barry, C. (1998). Word Frequency Effects in Oral Reading Are Not Merely Age-of-Acquisition Effects in Disguise. *Journal of Experimental Psychology: Learning, Memory, and Cognition*, *24*(2), 267-283. https://doi.org/10.1037/0278-7393.24.2.267 — https://drive.google.com/file/d/1y5VEKmXYZ-JPap4n4Q_EGW-49ixm4Zuj/view?usp=drivesdk
- Kuperman, V., Stadthagen-Gonzalez, H., & Brysbaert, M. (2012). Age-of-acquisition ratings for 30,000 English words. *Behavior Research Methods*, *44*, 978-990. https://doi.org/10.3758/s13428-012-0210-4 — https://drive.google.com/file/d/1pEE7490uwe_e08p-9mPweaiWDxDadvVn/view?usp=drivesdk

### `global` ← auto's choice  — 3.5s, 2 references

## Influence of age of acquisition on word recognition

**Age of acquisition (AoA)**—the age at which a word is learned—predicts word-recognition performance beyond standard lexical variables such as frequency, length, and orthographic similarity. Adding AoA explained about **4% of additional variance in lexical-decision reaction times** and nearly **10% in accuracy** (Kuperman et al., 2012).

Generally, **early-acquired words are accessed and processed faster** than late-acquired words. AoA may influence how easily lexical representations are activated, while word frequency may affect access to orthographic representations; these effects can therefore be partly independent (Gerhand & Barry, 1998).

AoA is strongly correlated with word frequency, making the two difficult to separate. Nevertheless, studies using controls or factorial designs report an independent AoA contribution to recognition and naming performance (Gerhand & Barry, 1998; Kuperman et al., 2012). The effect may also be stronger for low-frequency words.

### References

- Gerhand, S., & Barry, C. (1998). Word Frequency Effects in Oral Reading Are Not Merely Age-of-Acquisition Effects in Disguise. *Journal of Experimental Psychology: Learning, Memory, and Cognition*, *24*(2), 267-283. https://doi.org/10.1037/0278-7393.24.2.267 — https://drive.google.com/file/d/1y5VEKmXYZ-JPap4n4Q_EGW-49ixm4Zuj/view?usp=drivesdk
- Kuperman, V., Stadthagen-Gonzalez, H., & Brysbaert, M. (2012). Age-of-acquisition ratings for 30,000 English words. *Behavior Research Methods*, *44*, 978-990. https://doi.org/10.3758/s13428-012-0210-4 — https://drive.google.com/file/d/1pEE7490uwe_e08p-9mPweaiWDxDadvVn/view?usp=drivesdk

### `naive`  — 2.8s, 4 references

## Age of acquisition and word recognition

**Age of acquisition (AoA)**—the age at which a word is learned—predicts word-recognition performance beyond frequency, length, and similarity to other words. Earlier-acquired words are generally easier to access and produce faster lexical decisions, while later-acquired words tend to require more processing time (Kuperman et al., 2012).

AoA may capture more than cumulative word frequency: the order in which words are learned can affect how easily their representations are activated. Early-learned words may therefore have more accessible or strongly established representations (Kuperman et al., 2012).

However, the effect depends on the task. In **reading aloud, lexical decision, and picture naming**, early-acquired words typically have an advantage (Cortese et al., 2015; Gerhand & Barry, 1998). In **recognition memory**, the pattern can reverse: later-acquired words have sometimes produced better recognition, particularly in “remember” rather than “know” responses. This may reflect greater semantic distinctiveness of later-acquired words (Cortese et al., 2015; Dewhurst et al., 1998).

AoA also appears to influence different stages of processing from frequency. In word naming, AoA is associated especially with retrieving or executing a word’s phonological representation, whereas frequency may affect access to orthographic representations or connections from recognition to phonology (Gerhand & Barry, 1998).

### References

- Cortese, M. J., McCarty, D. P., & Schock, J. (2015). A mega recognition memory study of 2897 disyllabic words. *The Quarterly Journal of Experimental Psychology*, *68*(8), 1489–1501. https://doi.org/10.1080/17470218.2014.945096 — https://drive.google.com/file/d/13cKo8dtCu1deUoMIIC1QMby_Z6dkGEJ9/view?usp=drivesdk
- Dewhurst, S. A., Hitch, G. J., & Barry, C. (1998). Separate Effects of Word Frequency and Age of Acquisition in Recognition and Recall. *Journal of Experimental Psychology: Learning, Memory, and Cognition*, *24*(2), 284-298. https://doi.org/10.1037//0278-7393.24.2.284 — https://drive.google.com/file/d/1xKyFfIANAmE0iHuqxyaljAiXOMgUOq3p/view?usp=drivesdk
- Gerhand, S., & Barry, C. (1998). Word Frequency Effects in Oral Reading Are Not Merely Age-of-Acquisition Effects in Disguise. *Journal of Experimental Psychology: Learning, Memory, and Cognition*, *24*(2), 267-283. https://doi.org/10.1037/0278-7393.24.2.267 — https://drive.google.com/file/d/1y5VEKmXYZ-JPap4n4Q_EGW-49ixm4Zuj/view?usp=drivesdk
- Kuperman, V., Stadthagen-Gonzalez, H., & Brysbaert, M. (2012). Age-of-acquisition ratings for 30,000 English words. *Behavior Research Methods*, *44*, 978-990. https://doi.org/10.3758/s13428-012-0210-4 — https://drive.google.com/file/d/1pEE7490uwe_e08p-9mPweaiWDxDadvVn/view?usp=drivesdk

---

## What does the lab's work say about humour and emotion?

**`auto` routes to: `global`**

### `hybrid`  — 6.6s, 3 references

## Humour and emotion

The lab’s work presents humour as closely connected to emotion regulation. In particular, Samson and Gross found that **positive, good-natured humour** was more effective than negative, mean-spirited humour at increasing positive emotions and reducing negative emotions (Samson & Gross, 2012).

Their findings suggest that humour may regulate emotion through several mechanisms:

- **Reappraisal:** humour can reinterpret a negative event as less threatening.
- **Distancing:** it can create psychological distance from a distressing situation.
- **Distraction:** processing humour may divert attention from negative feelings.
- **Positive emotional change:** amusement may help “undo” negative emotions (Samson & Gross, 2012).

More broadly, humour appears to involve coordinated **cognitive, emotional, social, and motor processes**, rather than being purely cognitive or purely emotional (Martin & Ford, 2018). It may also signal that an unexpected event is safe or non-threatening, supporting play, creativity, and social bonding (Greenberg, 2020).

### References

- Greenberg, E. (2020). Humour as a threat-coding mechanism. *The European Journal of Humour Research*, *8*(1), 14-28. https://doi.org/10.7592/ejhr2020.8.1.greenberg — https://drive.google.com/file/d/1wcQ6PAtcB3KI5MN08C4SaPd9xXWheKY4/view?usp=drivesdk
- Martin, R. A., & Ford, T. E. (2018). The Physiological Psychology of Humor and Laughter. In *The Psychology of Humor* (pp. 173-204). Elsevier. https://doi.org/10.1016/b978-0-12-812143-6.00006-0 — https://drive.google.com/file/d/1PvN265zRuHZ1eL18V6O6nlNoYoX6jfHQ/view?usp=drivesdk
- Samson, A. C., & Gross, J. J. (2012). Humour as emotion regulation: The differential consequences of negative versus positive humour. *Cognition and Emotion*, *26*(2), 375-384. https://doi.org/10.1080/02699931.2011.585069 — https://drive.google.com/file/d/1uG5Bi_-boVZla8ITTvZDebJd2Sw-1tvI/view?usp=drivesdk

### `local`  — 5.1s, 2 references

## Humour and emotion

The lab’s work presents humour as closely intertwined with emotion: it can involve emotional experience, regulate affect, and signal that an unexpected event is non-threatening (Greenberg, 2020).

Its clearest finding is that **humour’s emotional effects depend on its type**. In Samson and Gross’s studies, both positive and negative humour reduced negative emotions and increased positive emotions compared with simply watching negative pictures. However, **positive, good-natured humour was significantly more effective** than negative, mean-spirited humour in both respects (Samson & Gross, 2012).

The proposed mechanisms include:

- **Reappraisal:** positive humour can reinterpret a negative event from a less threatening perspective.
- **Distraction:** producing humour requires attentional resources that may reduce attention available for negative emotion.
- **Emotional undoing:** the positive emotions accompanying humour may help counteract negative emotions (Samson & Gross, 2012).

The findings were not explained by differences in task difficulty, participants’ expectations, or social desirability. Overall, the work suggests that positive humour may be an effective emotion-regulation strategy, while the emotional consequences of humour are not uniformly beneficial and depend on how humour is used (Samson & Gross, 2012).

### References

- Greenberg, E. (2020). Humour as a threat-coding mechanism. *The European Journal of Humour Research*, *8*(1), 14-28. https://doi.org/10.7592/ejhr2020.8.1.greenberg — https://drive.google.com/file/d/1wcQ6PAtcB3KI5MN08C4SaPd9xXWheKY4/view?usp=drivesdk
- Samson, A. C., & Gross, J. J. (2012). Humour as emotion regulation: The differential consequences of negative versus positive humour. *Cognition and Emotion*, *26*(2), 375-384. https://doi.org/10.1080/02699931.2011.585069 — https://drive.google.com/file/d/1uG5Bi_-boVZla8ITTvZDebJd2Sw-1tvI/view?usp=drivesdk

### `global` ← auto's choice  — 4.9s, 3 references

## Humour and emotion

The lab’s work presents humour as closely intertwined with emotion and cognition. Humour and laughter involve coordinated cognitive, emotional, and behavioural processes rather than simple amusement alone (Martin & Ford, 2018).

A central finding is that **humour can regulate emotion, but its effects depend on the type of humour**. In Samson and Gross’s studies, positive, good-natured humour was more effective than negative, mean-spirited humour at increasing positive emotions and reducing negative emotions after participants viewed disturbing images (Samson & Gross, 2012). These results were replicated even when difficulty, expectations, and social desirability were controlled (Samson & Gross, 2012).

The proposed mechanisms include **reappraising a negative event from a less threatening perspective**, creating psychological distance, and possibly diverting attention away from the negative event. However, the studies did not establish which mechanism is definitively responsible (Samson & Gross, 2012).

Overall, the work suggests that positive humour may be an adaptive emotion-regulation strategy, while negative humour can have different—and potentially less beneficial—emotional consequences. Humour may also signal that an unexpected event is non-threatening (Greenberg, 2020).

### References

- Greenberg, E. (2020). Humour as a threat-coding mechanism. *The European Journal of Humour Research*, *8*(1), 14-28. https://doi.org/10.7592/ejhr2020.8.1.greenberg — https://drive.google.com/file/d/1wcQ6PAtcB3KI5MN08C4SaPd9xXWheKY4/view?usp=drivesdk
- Martin, R. A., & Ford, T. E. (2018). The Physiological Psychology of Humor and Laughter. In *The Psychology of Humor* (pp. 173-204). Elsevier. https://doi.org/10.1016/b978-0-12-812143-6.00006-0 — https://drive.google.com/file/d/1PvN265zRuHZ1eL18V6O6nlNoYoX6jfHQ/view?usp=drivesdk
- Samson, A. C., & Gross, J. J. (2012). Humour as emotion regulation: The differential consequences of negative versus positive humour. *Cognition and Emotion*, *26*(2), 375-384. https://doi.org/10.1080/02699931.2011.585069 — https://drive.google.com/file/d/1uG5Bi_-boVZla8ITTvZDebJd2Sw-1tvI/view?usp=drivesdk

### `naive`  — 2.8s, 5 references

## Humour and emotion

The lab’s work presents humour as closely connected to emotion in several ways:

- **Humour can involve a distinct pleasurable emotion**, often described as *mirth*, amusement, or humour appreciation. This emotional response follows the perception that something is incongruously funny and is typically associated with positive affect (Martin & Ford, 2018; Weisfeld, 1993).
- **Humour may function as emotion regulation.** Experiments found that positive, good-natured humour both increased positive emotion and reduced negative emotion more effectively than negative, mean-spirited humour (Samson & Gross, 2012).
- Possible mechanisms include **reappraising a stressful situation**, creating psychological distance, distracting attention from negative material, and allowing positive feelings to counteract negative emotions (Samson & Gross, 2012).
- Humour is also described as capable of **modifying behaviour and affecting fitness**, supporting play, creativity, safety signalling, and social bonding (Greenberg, 2020).
- The relationship is not entirely settled: some scholars argue that amusement does not meet the motivational and physiological criteria of standard emotions, while others regard humour as an emotion or emotional regulator (Greenberg, 2020; Raskin, 2008).

Overall, the work suggests that humour is not merely a cognitive process or form of laughter: it combines cognitive appraisal, pleasurable emotion, bodily expression, and potential social and adaptive functions.

### References

- Greenberg, E. (2020). Humour as a threat-coding mechanism. *The European Journal of Humour Research*, *8*(1), 14-28. https://doi.org/10.7592/ejhr2020.8.1.greenberg — https://drive.google.com/file/d/1wcQ6PAtcB3KI5MN08C4SaPd9xXWheKY4/view?usp=drivesdk
- Martin, R. A., & Ford, T. E. (2018). Introduction to the Psychology of Humor. In *The Psychology of Humor* (pp. 1-32). Elsevier. https://doi.org/10.1016/b978-0-12-812143-6.00001-1 — https://drive.google.com/file/d/1wNxVRcg4Ue932XFAyCMWQ3VEIkOH6Jrt/view?usp=drivesdk
- (2008). *The Primer of Humor Research*. Mouton de Gruyter. — https://drive.google.com/file/d/1IBt9o_8emnOwm3lVaZRBr5qnziNx1HkB/view?usp=drivesdk
- Samson, A. C., & Gross, J. J. (2012). Humour as emotion regulation: The differential consequences of negative versus positive humour. *Cognition and Emotion*, *26*(2), 375-384. https://doi.org/10.1080/02699931.2011.585069 — https://drive.google.com/file/d/1uG5Bi_-boVZla8ITTvZDebJd2Sw-1tvI/view?usp=drivesdk
- Weisfeld, G. E. (1993). The Adaptive Value of Humor and Laughter. *Ethology and Sociobiology*, *14*, 141-169. https://doi.org/10.1016/0162-3095(93)90012-7 — https://drive.google.com/file/d/1LOPpX6hyCX-SA2PR8Hv8sm9pTP8KXSx1/view?usp=drivesdk

---

## How is entropy used in studies of semantic memory?

**`auto` routes to: `global`**

### `hybrid`  — 7.7s, 4 references

## Entropy in semantic-memory research

Entropy is used to quantify **uncertainty, unpredictability, or information content** in semantic representations and memory-related distributions. In information theory, it represents the expected surprisal of possible outcomes; higher entropy generally means that probability is spread across more alternatives or that outcomes are less predictable (Dasgupta & Griffiths, 2022; Mansfield, 2020).

In studies of **semantic vectors**, researchers transform vector coordinates into nonnegative proportions that sum to one, then calculate Shannon entropy:

\[
H=-\sum_i p_i\log(p_i)
\]

A highly entropic semantic vector has information distributed relatively uniformly across semantic dimensions or topics, indicating greater uncertainty about which domains carry a stimulus’s meaning (Bonandrini et al., 2023). Such entropy has been used to study the meaningfulness of affixed pseudo-words and semantic processing in lexical-decision tasks; more uniformly distributed vectors have been associated with lower perceived meaningfulness (Bonandrini et al., 2023).

Entropy is also used to examine **contextual uncertainty during language processing**, which is relevant to how semantic information is accessed. Trial-level entropy has been positively correlated with semantic similarity and associated with faster reading times, supporting an account in which greater entropy activates stronger semantic features (Karimi et al., 2024). By contrast, item-level entropy showed no significant effect in the reported analysis (Karimi et al., 2024).

In broader semantic-memory research, entropy can also characterize the **complexity or informational cost of representations**: zero entropy corresponds to a distribution concentrated on one outcome, whereas higher entropy reflects a more diverse and costly-to-represent distribution (Dasgupta & Griffiths, 2022). It therefore provides a quantitative way to compare semantic uncertainty, topic-specificity, representational complexity, and the effects of context on memory and lexical processing.

### References

- Bonandrini, R., Amenta, S., Sulpizio, S., Tettamanti, M., Mazzucchelli, A., & Marelli, M. (2023). Form to meaning mapping and the impact of explicit morpheme combination in novel word processing. *Cognitive Psychology*, *145*, 101594. https://doi.org/10.1016/j.cogpsych.2023.101594 — https://drive.google.com/file/d/1uf-PGSYlM5_sWOP5p4TH3DwrfQ323i19/view?usp=drivesdk
- Dasgupta, I., & Griffiths, T. L. (2022). Clustering and the efficient use of cognitive resources. *Journal of Mathematical Psychology*, *109*, 102675. https://doi.org/10.1016/j.jmp.2022.102675 — https://drive.google.com/file/d/1Tnq8Gc9QZx2W8Q_3U0SKT0CK67F6wdl9/view?usp=drivesdk
- Karimi, H., Weber, P., & Zinn, J. (2024). Information entropy facilitates (not impedes) lexical processing during language comprehension. *Psychonomic Bulletin & Review*, *31*, 2102–2117. https://doi.org/10.3758/s13423-024-02463-x — https://drive.google.com/file/d/1ostews8h5I9Esk0IhOrJ8OG-fbNbWR5C/view?usp=drivesdk
- Mansfield, J. (2020). The word as a unit of internal predictability. *Linguistics (to appear)*. https://doi.org/10.31234/osf.io/wg5n9 — https://drive.google.com/file/d/1z4OqaAS2kV1j7pGoaskhGI27ACW8OoXS/view?usp=drivesdk

### `local`  — 8.5s, 3 references

## Entropy in semantic-memory studies

Entropy is used to quantify **uncertainty, information content, and representational complexity** in semantic memory. In a distribution of possible meanings or semantic features, higher entropy indicates that information is spread more uniformly across alternatives, making the stimulus’s meaning less specific or predictable (Bonandrini et al., 2023).

Researchers apply entropy to **semantic vectors** by transforming vector values into nonnegative proportions that sum to one, then calculating Shannon entropy:

\[
H=-\sum_i d_i\log(d_i)
\]

This estimates the uncertainty over the semantic dimensions or “topics” carrying a stimulus’s meaning. A highly entropic semantic vector indicates uncertainty about which semantic domains are most relevant (Bonandrini et al., 2023).

Entropy is also used to study **perceived meaningfulness and lexical decisions**. More uniformly distributed—or more entropic—semantic representations have been associated with lower perceived meaningfulness in affixed pseudo-words. Such variables can be included in models predicting participants’ word/non-word decisions and response times (Bonandrini et al., 2023).

More broadly, entropy provides a single measure of the **search or discrimination problem** involved in retrieving semantic or lexical information. When many alternatives are possible, entropy is higher, increasing the information-processing demands of recognition and recall (Dye et al., 2017; Ramscar et al., 2014). It can therefore help researchers examine how semantic distributions affect accessibility, memory load, and retrieval difficulty.

### References

- Bonandrini, R., Amenta, S., Sulpizio, S., Tettamanti, M., Mazzucchelli, A., & Marelli, M. (2023). Form to meaning mapping and the impact of explicit morpheme combination in novel word processing. *Cognitive Psychology*, *145*, 101594. https://doi.org/10.1016/j.cogpsych.2023.101594 — https://drive.google.com/file/d/1uf-PGSYlM5_sWOP5p4TH3DwrfQ323i19/view?usp=drivesdk
- Dye, M., Milin, P., Futrell, R., & Ramscar, M. (2017). A Functional Theory of Gender Paradigms. In F. Kiefer, J. Blevins, & H. Bartos (Eds.), *Perspectives on Morphological Organization: Data and Analyses*. Brill. https://doi.org/10.1163/9789004342934_011 — https://drive.google.com/file/d/1Io0S-cnv3oWwwzc7-O2LZ87FNcWV_EJN/view?usp=drivesdk
- Ramscar, M., Hendrix, P., Shaoul, C., Milin, P., & Baayen, H. (2014). The Myth of Cognitive Decline: Non-Linear Dynamics of Lifelong Learning. *Topics in Cognitive Science*, 1-38. https://doi.org/10.1111/tops.12078 — https://drive.google.com/file/d/1mZSFgcFiCjPe8RHzXWZXTOSZo1buaqTb/view?usp=drivesdk

### `global` ← auto's choice  — 4.5s, 1 references

## Entropy in semantic-memory research

Entropy is used as a measure of **uncertainty or variability** in the semantic possibilities associated with a context. In one lexical-processing study, **trial entropy** quantified the breadth of responses produced for a sentence context, while **item entropy** was calculated from responses to individual items (Karimi et al., 2024).

Researchers use entropy to test how broadly activated semantic features influence processing. Trial entropy was positively correlated with semantic similarity (*r* = .52), and greater semantic similarity between a target word and other responses predicted faster reading times. This supported a semantic-feature-activation account of trial entropy’s facilitative effect (Karimi et al., 2024).

Entropy can also be incorporated into regression models as a predictor of reading times. Trial entropy produced faster reading on the target word, whereas item entropy showed no reliable effect when examined alone and an unstable inhibitory effect in a model containing both entropy measures (Karimi et al., 2024).

Thus, entropy is used to distinguish **broad semantic activation across possible responses** from **competition among specific lexical items**, helping researchers investigate how semantic representations are activated and accessed.

### References

- Karimi, H., Weber, P., & Zinn, J. (2024). Information entropy facilitates (not impedes) lexical processing during language comprehension. *Psychonomic Bulletin & Review*, *31*, 2102–2117. https://doi.org/10.3758/s13423-024-02463-x — https://drive.google.com/file/d/1ostews8h5I9Esk0IhOrJ8OG-fbNbWR5C/view?usp=drivesdk

### `naive`  — 3.3s, 4 references

## Entropy in semantic-memory research

Entropy is used to quantify **uncertainty or dispersion in semantic information**. In semantic-vector models, vectors can be transformed into probability-like distributions across semantic dimensions, after which Shannon entropy is calculated. High entropy indicates greater uncertainty about which semantic domains or “topics” carry a stimulus’s meaning; low entropy indicates greater topic specificity (Bonandrini et al., 2023).

Entropy is also used to characterize **semantic structure and similarity**. Distributional semantic models represent words as vectors based on their patterns of use, with semantically similar words located near one another in semantic space. These representations can support analyses of how meanings are organized and retrieved (Gatti et al., 2025).

In free-recall studies, semantic memory is often modeled spatially: words judged to be more similar are placed closer together, and recall sequences are treated as paths through this space. Shorter-than-chance paths indicate semantic clustering, meaning that people tend to recall semantically related items successively (Romney et al., 1993).

Entropy further serves as a measure of **lexical or semantic predictability during processing**. Trial-level entropy captures the uncertainty across possible responses in a context. Higher trial entropy has been associated with faster processing, apparently because it activates a broader or stronger set of semantic features; the effect was positively related to semantic similarity, whereas orthographic similarity did not explain the facilitation (Karimi et al., 2024).

### References

- Bonandrini, R., Amenta, S., Sulpizio, S., Tettamanti, M., Mazzucchelli, A., & Marelli, M. (2023). Form to meaning mapping and the impact of explicit morpheme combination in novel word processing. *Cognitive Psychology*, *145*, 101594. https://doi.org/10.1016/j.cogpsych.2023.101594 — https://drive.google.com/file/d/1uf-PGSYlM5_sWOP5p4TH3DwrfQ323i19/view?usp=drivesdk
- Gatti, D., Petilli, M. A., Marchetti, M., Vecchi, T., Mazzoni, G., Rinaldi, L., & Marelli, M. (2025). False memories from nowhere: Humans falsely recognize words that are not attested in their vocabulary. *Psychonomic Bulletin &amp; Review*, *32*(4), 1922-1931. https://doi.org/10.3758/s13423-025-02677-7 — https://drive.google.com/file/d/1NF0OfENnjWVW8wuqAYIK_pRXaZiDXwH-/view?usp=drivesdk
- Karimi, H., Weber, P., & Zinn, J. (2024). Information entropy facilitates (not impedes) lexical processing during language comprehension. *Psychonomic Bulletin & Review*, *31*, 2102–2117. https://doi.org/10.3758/s13423-024-02463-x — https://drive.google.com/file/d/1ostews8h5I9Esk0IhOrJ8OG-fbNbWR5C/view?usp=drivesdk
- Romney, A. K., Brewer, D. D., & Batchelder, W. H. (1993). Predicting Clustering from Semantic Structure. *Psychological Science*, *4*(1). https://doi.org/10.1111/j.1467-9280.1993.tb00552.x — https://drive.google.com/file/d/18caaFF2LALAH98FWussVFfl7O-_WKFEt/view?usp=drivesdk

---
